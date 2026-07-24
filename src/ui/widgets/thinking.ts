/**
 * ThinkingIndicator — the animated agent-status line shown under the newest chat message.
 *
 * A small state machine: each AgentState owns its animation (frames, speed, color) so new
 * states are one entry in STATE_SPECS, not new plumbing. The indicator renders to a tagged
 * string; the chat widget appends it while rendering and subscribes to ticks for animation.
 *
 * Anatomy of the line:
 *   ▍ ⠹ Thinking··   12s
 *   │ │  │       │    └ elapsed, dim
 *   │ │  │       └ animated ellipsis (breathes 0→3 dots)
 *   │ │  └ label, pulsing between state color and bright
 *   │ └ spinner frames of the current state
 *   └ state-colored gutter bar
 */

import { theme } from '../theme.js';

export type AgentState = 'idle' | 'thinking' | 'tool' | 'explaining' | 'summarizing';

interface StateSpec {
  frames: string[];
  color: string;       // state color (gutter + spinner)
  pulse?: string;      // label pulses color ↔ pulse (defaults to no pulse)
  intervalMs: number;  // frame duration
  dots: boolean;       // animated ellipsis after the label
}

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const STATE_SPECS: Record<Exclude<AgentState, 'idle'>, StateSpec> = {
  thinking:    { frames: BRAILLE, color: theme.thinking, pulse: theme.accentBright, intervalMs: 80, dots: true },
  tool:        { frames: ['◢', '◣', '◤', '◥'], color: theme.tool, intervalMs: 120, dots: false },
  explaining:  { frames: BRAILLE, color: theme.explaining, pulse: theme.accentBright, intervalMs: 80, dots: true },
  summarizing: { frames: ['◐', '◓', '◑', '◒'], color: theme.summarizing, intervalMs: 140, dots: true },
};

/** Compat inference so plain setAgentStatus(text) picks a sensible state from its phrasing. */
export function inferState(text: string): Exclude<AgentState, 'idle'> {
  if (/^running /i.test(text)) return 'tool';
  if (/^explaining/i.test(text)) return 'explaining';
  if (/^summariz/i.test(text)) return 'summarizing';
  return 'thinking';
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export class ThinkingIndicator {
  private state: AgentState = 'idle';
  private label = '';
  private tick = 0;
  private startTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onTick: () => void;

  constructor(onTick: () => void) {
    this.onTick = onTick;
  }

  /** Explicit state + label. Same state keeps the clock; a new state restarts it. */
  set(state: AgentState, label?: string): void {
    if (state === 'idle') {
      this.stop();
      return;
    }
    const restart = state !== this.state;
    this.state = state;
    // The ellipsis is ours to animate — drop a static one at the end OR before a trailing
    // parenthetical ("Thinking... (round 2)" → "Thinking (round 2)").
    this.label = (label ?? this.label).replace(/\.{2,}(\s*\([^)]*\))?\s*$/, '$1');
    if (restart) {
      this.tick = 0;
      this.startTime = Date.now();
      this.rearm();
    }
    this.onTick();
  }

  /** Compat shim for setAgentStatus(text): '' clears, otherwise state is inferred. */
  setFromText(text: string): void {
    if (!text) { this.stop(); return; }
    this.set(inferState(text), text);
  }

  stop(): void {
    this.state = 'idle';
    this.label = '';
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.onTick();
  }

  active(): boolean {
    return this.state !== 'idle';
  }

  /** The rendered line (blessed tags), or null when idle. */
  line(): string | null {
    if (this.state === 'idle') return null;
    const spec = STATE_SPECS[this.state];
    const frame = spec.frames[this.tick % spec.frames.length];
    // label pulse: a slow breathe between the state color and its bright variant
    const labelColor = spec.pulse && Math.floor(this.tick / 6) % 2 === 1 ? spec.pulse : spec.color;
    // ellipsis breathes 0→3 dots at a fraction of the frame rate
    const dots = spec.dots ? '·'.repeat(Math.floor(this.tick / 4) % 4) : '';
    const elapsed = formatElapsed(Date.now() - this.startTime);
    return `{${spec.color}-fg}▍ ${frame}{/} {${labelColor}-fg}${this.label}{/}{${theme.dim}-fg}${dots}   ${elapsed}{/}`;
  }

  destroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private rearm(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.state === 'idle') return;
    const spec = STATE_SPECS[this.state];
    this.timer = setInterval(() => {
      this.tick++;
      this.onTick();
    }, spec.intervalMs);
  }
}
