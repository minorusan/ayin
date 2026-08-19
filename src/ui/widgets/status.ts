/**
 * GLYPH RULE — read before adding any symbol to this bar.
 * Only BMP characters with `Emoji_Presentation=false` are allowed. blessed reports
 * `strWidth` 1 for a padlock (U+1F512) while every modern terminal draws it 2 cells wide, so ONE emoji makes this
 * one-row box overflow, wrap, and then smartCSR's cell diff re-emits shifted rows — the visible
 * result is the input bar swallowing the thinking line and fragments appearing duplicated. It has
 * bitten this file twice: U+1F512 (a padlock) and U+23F3 (hourglass, for the queue), now
 * U+26BF and U+29D7. `npm run check:glyphs` enforces the rule so there is no third time.
 *
 * StatusBar — the one-row bar at the very bottom:
 *   connection · model · gpu · tokens · llm phase · update hint  ⟩⟩  cwd (branch)
 *
 * `model` and `gpu` are always-on facts fed by the llm-status poll (src/llm-status.ts) — you should
 * never have to ask which model is answering you or whether the card is busy. Both segments hide
 * themselves when unknown rather than showing a stale or fake value.
 */

import blessed from 'blessed';
import { HEADLESS, noopBox } from '../headless.js';
import { screen, render } from '../screen.js';
import { theme } from '../theme.js';
import { onTick } from '../ticker.js';
import { gitBranch } from '../../git.js';

export type LlmPhaseName =
  | 'swapping' | 'preprocessing' | 'responding' | 'postprocessing' // live phases (animated)
  | 'done' | 'warning';                                            // transient event blips (ttl)

export interface StatusState {
  connection: 'connected' | 'disconnected' | 'connecting';
  /**
   * The context meter. `estimated` marks a GUESS (characters ÷ 4) as one — rendered with a leading `~`.
   *
   * It was a guess for its whole life, silently: almost nothing serves `/api/estimate`, so the fallback
   * WAS the meter. The runtime reports the real prompt size on every reply (`prompt_eval_count`), so
   * after the first call of a turn this is the model's own count and the tilde disappears.
   */
  tokens: { used: number; total: number; estimated?: boolean } | null;
  cwd: string;
  update: string | null; // e.g. "v1.0.30 available"
  /** live LLM phase from the backend llm resource event stream (null = idle, segment hidden).
   *  ttlMs makes it a transient blip that auto-clears (event acknowledgements). */
  llm: { phase: LlmPhaseName; detail?: string; ttlMs?: number } | null;
  /** The model serving this session. `booked` = we hold the llm authority (/model).
   *  `swapping` = the backend is mid-reload, so `name` is the TARGET and `loaded` is what is
   *  actually in VRAM — both are shown, because naming only the target reads as "all good, qwen"
   *  while gemma is still the thing answering (or nothing is, for the next minute). */
  model: { name: string; loaded?: string; booked: boolean; swapping: boolean } | null;
  /** Shared-GPU telemetry from the backend host (null = unknown / no card → segment hidden). */
  gpu: { util: number; usedMiB: number; totalMiB: number; tempC: number } | null;
  /** A named phase of the loop that is not the plain agent turn — plan mode, a QA pass. Driven by
   *  `activity.ts`. It stays lit for the whole phase, including the gaps between LLM calls where
   *  nothing narrates, so "ayin is spending your GPU on a review right now" is always visible. */
  gate: { label: string; detail?: string } | null;
  /** The backend's single-slot LLM scheduler: what holds the GPU and how many calls wait behind
   *  it, plus OUR OWN place in line when a request of ours is queued. Shown so a slow turn reads as
   *  "#4 of 6, behind book_writer", not "ayin is slow". */
  queue: { running: string | null; runningForMs: number; depth: number; ownPosition?: number; ownOf?: number; ownRunning?: boolean } | null;
  /** Who owns the llm resource — the AUTHORITY, which decides the model, NOT queue priority.
   *  `mine` = an ayin-family holder (our launcher, the watcher, or a dispatched code agent). */
  authority: { holder: string; expiresInMs: number; mine: boolean } | null;
}

/** Each phase owns its animation: frames + how many base ticks (80ms) per frame + color.
 *  A new phase = one entry here. */
const LLM_PHASE_LOOK: Record<LlmPhaseName, { frames: string[]; every: number; color: string }> = {
  swapping:       { frames: ['⇆', '⇄'], every: 4, color: theme.warn },              // arrows trading places
  preprocessing:  { frames: ['◔', '◑', '◕', '●', '◕', '◑'], every: 2, color: theme.accent }, // context filling up
  responding:     { frames: ['▸▹▹', '▹▸▹', '▹▹▸', '▹▹▹'], every: 1, color: theme.ok },       // tokens flowing out
  postprocessing: { frames: ['◇', '◈', '◆', '◈'], every: 3, color: theme.summarizing },      // reply crystallizing
  done:           { frames: ['✓'], every: 1, color: theme.ok },
  warning:        { frames: ['⚠', '⚠', ' '], every: 3, color: theme.err },                   // blink — look at me
};

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export class StatusBar {
  readonly box: blessed.Widgets.BoxElement;
  private state: StatusState = {
    connection: 'disconnected',
    tokens: null,
    cwd: process.cwd(),
    update: null,
    llm: null,
    model: null,
    gpu: null,
    queue: null,
    authority: null,
    gate: null,
  };

  constructor() {
    this.box = HEADLESS
      ? noopBox
      : blessed.box({
        parent: screen,
        bottom: 0, left: 0, right: 0, height: 1,
        tags: true,
        style: { fg: theme.statusFg, bg: theme.statusBg },
        padding: { left: 1, right: 1 },
      });
  }

  private tick = 0;
  private unTick: (() => void) | null = null;
  private blipTimer: ReturnType<typeof setTimeout> | null = null;

  set(partial: Partial<StatusState>): void {
    if (HEADLESS) return;
    Object.assign(this.state, partial);

    // Animate only while an LLM phase is moving; the ticker stops itself when nothing is —
    // idle costs zero CPU.
    const wantsTicker = !!this.state.llm;
    if (wantsTicker && !this.unTick) {
      this.unTick = onTick((t) => { this.tick = t; this.redraw(); });
    } else if (!wantsTicker && this.unTick) {
      this.unTick();
      this.unTick = null;
    }

    if ('llm' in partial) {
      // Transient blips (✓ done / ⚠ warning) clear themselves — unless something replaced them.
      if (this.blipTimer) { clearTimeout(this.blipTimer); this.blipTimer = null; }
      if (this.state.llm?.ttlMs) {
        const shown = this.state.llm;
        this.blipTimer = setTimeout(() => {
          if (this.state.llm === shown) this.set({ llm: null });
        }, shown.ttlMs);
        this.blipTimer.unref?.();
      }
    }

    this.redraw();
  }

  tokensDisplay(): string {
    if (!this.state.tokens) return 'tokens: unknown';
    // NO WINDOW REPORTED → say so. A percentage needs a denominator, and inventing one is what this
    // bar did for its whole life: a flat 65536 that matched no model and no setting, so a 16k session
    // read as 25% full when it was already overflowing. `used` is still real and still worth showing.
    const tilde = this.state.tokens.estimated ? '~' : '';
    if (!(this.state.tokens.total > 0)) return `${tilde}${formatTokens(this.state.tokens.used)} tokens / window unknown`;
    const pct = Math.round((this.state.tokens.used / this.state.tokens.total) * 100);
    return `${tilde}${formatTokens(this.state.tokens.used)} / ${formatTokens(this.state.tokens.total)} tokens (${pct}%)`
      + (this.state.tokens.estimated ? ' — estimated (characters ÷ 4); the runtime has not reported a prompt size yet' : ' — measured by the model');
  }

  getHeight(): number {
    return 1;
  }

  setBottom(row: number): void {
    this.box.bottom = row;
  }

  redraw(): void {
    if (HEADLESS) return;
    const parts: string[] = [];

    if (this.state.connection === 'connected') parts.push(`{${theme.ok}-fg}●{/} connected`);
    else if (this.state.connection === 'connecting') parts.push(`{${theme.warn}-fg}◐{/} connecting`);
    else parts.push(`{${theme.err}-fg}●{/} disconnected`);

    // A named phase goes FIRST after the connection dot, because it changes what everything else on
    // this bar means: the tokens and the GPU load you are looking at belong to a review or a planning
    // pass, not to the answer you asked for. ▣ = ayin is working on its own initiative.
    if (this.state.gate) {
      const g = this.state.gate;
      const narrow = (screen.width as number) < 100;
      const detail = !narrow && g.detail ? ` {${theme.muted}-fg}${g.detail}{/}` : '';
      parts.push(`{${theme.accent}-fg}▣ ${g.label}{/}${detail}`);
    }

    // The model is a permanent fact of the session, not an event: always shown once known.
    // ⬡ = the model being served · ⇆ = mid-swap.
    if (this.state.model) {
      const m = this.state.model;
      const narrow = (screen.width as number) < 100;
      const short = (n: string) => (narrow ? n.replace(/:.*$/, '') : n); // qwen3-coder:30b → qwen3-coder
      const glyph = m.swapping ? '⇆' : m.booked ? '⬢' : '⬡';
      const color = m.swapping ? theme.warn : m.booked ? theme.accent : theme.muted;
      // Mid-swap, say it as a transition — "gemma4:26b→qwen3.6:27b loading" — so the bar can never
      // claim a model that isn't serving you yet.
      const label = m.swapping && m.loaded
        ? `${short(m.loaded)}→${short(m.name)} loading`
        : short(m.name);
      parts.push(`{${color}-fg}${glyph} ${label}{/}`);
    }

    // Shared-GPU load — util, VRAM, temp. Colored by VRAM pressure (the thing that OOMs a swap).
    if (this.state.gpu) {
      const g = this.state.gpu;
      const vramPct = g.totalMiB > 0 ? Math.round((g.usedMiB / g.totalMiB) * 100) : 0;
      const color = vramPct > 90 ? theme.err : vramPct > 75 ? theme.warn : theme.ok;
      const vram = `${(g.usedMiB / 1024).toFixed(1)}/${(g.totalMiB / 1024).toFixed(0)}G`;
      const temp = (screen.width as number) < 100 ? '' : ` ${g.tempC}°C`;
      parts.push(`{${color}-fg}gpu ${g.util}% ${vram}${temp}{/}`);
    }

    if (this.state.tokens) {
      // An unknown window gets no percentage and no colour scale — see tokensDisplay(). The `?`
      // is the honest denominator: it prompts the question the invented 65536 suppressed.
      // A tilde is the whole difference between "your prompt is 12.4k tokens" and "something divided
      // your characters by four". One character, and it is the one that decides whether the number can
      // be acted on.
      const t = this.state.tokens.estimated ? '~' : '';
      if (!(this.state.tokens.total > 0)) {
        parts.push(`{${theme.warn}-fg}${t}${formatTokens(this.state.tokens.used)}/? tokens{/}`);
      } else {
        const pct = Math.round((this.state.tokens.used / this.state.tokens.total) * 100);
        const color = pct > 80 ? theme.err : pct > 60 ? theme.warn : theme.ok;
        parts.push(`{${color}-fg}${t}${formatTokens(this.state.tokens.used)}/${formatTokens(this.state.tokens.total)} tokens{/}`);
      }
    }

    if (this.state.llm) {
      const look = LLM_PHASE_LOOK[this.state.llm.phase];
      const frame = look.frames[Math.floor(this.tick / look.every) % look.frames.length];
      const label = this.state.llm.phase === 'done' || this.state.llm.phase === 'warning'
        ? '' : ` ${this.state.llm.phase}`;
      const detail = this.state.llm.detail ? ` {${theme.muted}-fg}${this.state.llm.detail}{/}` : '';
      parts.push(`{${look.color}-fg}${frame}${label}{/}${detail}`);
    }

    // Why your reply is slow: the shared GPU slot is busy and you may be behind N other calls.
    // ayin's own calls are LOW priority on that scheduler, so waiting is normal, not a hang —
    // seeing `⧗ embed +3` beats staring at an indistinguishable spinner.
    // Authority first: it answers "who decides the model", which is NOT the same question as "why
    // is this slow" — conflating them is exactly the confusion this pair of segments exists to end.
    const auth = this.state.authority;
    if (auth) {
      const mins = Math.max(0, Math.round(auth.expiresInMs / 60000));
      const color = auth.mine ? theme.accent : theme.muted;
      parts.push(`{${color}-fg}⚑ ${auth.holder}${mins > 0 ? ` ${mins}m` : ''}{/}`);
    }

    const q = this.state.queue;
    if (q && (q.running || q.depth > 0)) {
      // Our own position when we have a request in flight — the honest answer to "am I stuck?".
      if (q.ownRunning) {
        parts.push(`{${theme.ok}-fg}▸ generating{/}`);
      } else if (q.ownPosition) {
        const color = q.ownPosition > 2 ? theme.err : theme.warn;
        parts.push(`{${color}-fg}⧗ you: #${q.ownPosition}/${q.ownOf}{/}`);
      } else {
        const held = q.running ? `${q.running}${q.runningForMs > 3000 ? ` ${Math.round(q.runningForMs / 1000)}s` : ''}` : 'idle';
        const behind = q.depth > 0 ? ` +${q.depth}` : '';
        const color = q.depth > 2 ? theme.err : q.depth > 0 ? theme.warn : theme.muted;
        parts.push(`{${color}-fg}⧗ ${held}${behind}{/}`);
      }
    }


    if (this.state.update) parts.push(`{${theme.warn}-fg}↑ ${this.state.update}{/}`);

    const cwdMax = Math.floor((screen.width as number) * 0.35);
    let cwd = this.state.cwd;
    if (cwd.length > cwdMax) cwd = '…' + cwd.slice(cwd.length - cwdMax + 1);

    // A git repo? Show the current branch next to the path. Cached (git.ts) so this is cheap
    // even though redraw runs on every animation tick. Braces stripped defensively — a ref
    // name with a '{' would otherwise corrupt the blessed tag stream.
    const branch = gitBranch(this.state.cwd);
    const loc = branch
      ? `${cwd} {${theme.faint}-fg}(${branch.replace(/[{}]/g, '')}){/}`
      : cwd;

    this.box.setContent(`${parts.join(` {${theme.faint}-fg}│{/} `)}{|}${loc}`);
    render();
  }
}
