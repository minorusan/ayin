/**
 * ChatLog — the scrollable message area + the thinking indicator line.
 *
 * Owns the message list and how each role renders. Content is bottom-anchored (padded to
 * the box height) so the newest message sits just above the input, chat-app style.
 * No mouse tracking (see screen.ts copy-paste contract); scrolling is PgUp/PgDn.
 */

import blessed from 'blessed';
import { renderMarkdown } from '../../markdown.js';
import { HEADLESS, noopBox } from '../headless.js';
import { screen, render } from '../screen.js';
import { theme } from '../theme.js';
import { ThinkingIndicator, type AgentState } from './thinking.js';
import { getGoal, onGoalChange } from '../../goal.js';

/**
 * Indentation, in one place so the transcript has a consistent left rhythm.
 * `GUTTER` aligns wrapped speaker text under its glyph; `TOOL_INDENT` is a tab-width step further in
 * for machine output (tool cards), which reads as subordinate instead of competing with the
 * conversation at the same margin.
 */
const GUTTER = '  ';
const TOOL_INDENT = '    ';

/** Does this tool message OPEN a card (the `▸ tool · params` header) rather than continue one?
 *  Matched on the glyph after any leading blessed tags, which is what the header always starts with. */
function startsToolCard(content: string): boolean {
  return content.replace(/^(?:\{[^}]*\})+/, '').startsWith('▸');
}

/** OBJECTIVE card: label + how many wrapped rows of goal text it may grow to. */
const TITLE = 'OBJECTIVE';
const MAX_CARD_ROWS = 3;

/**
 * Put the goal in the TERMINAL TAB. With several ayin sessions open, the tab bar is the only place
 * you can tell them apart without switching — so the tab carries what this session is for, and
 * falls back to the bare name when there's no goal yet.
 *
 * blessed emits the OSC title sequence when `screen.title` is assigned. Some terminals only honour
 * it if the shell isn't rewriting the title on every prompt.
 */
function syncTerminalTitle(): void {
  if (HEADLESS) return;
  const goal = getGoal();
  try {
    screen.title = goal ? `ayin · ${goal.length > 60 ? `${goal.slice(0, 59)}…` : goal}` : 'ayin';
  } catch { /* a terminal that refuses the title is not worth an exception */ }
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
}

export class ChatLog {
  readonly box: blessed.Widgets.BoxElement;
  readonly indicator: ThinkingIndicator;
  private messages: Message[] = [];
  // Follow the live bottom until the user scrolls up; re-engages when they scroll back to the bottom.
  // Without this, every redraw (new message, goal change, thinking-indicator tick) snapped to the
  // bottom and it was nearly impossible to scroll up while anything was happening.
  private stick = true;

  constructor() {
    this.box = HEADLESS
      ? noopBox
      : blessed.box({
        parent: screen,
        top: 0, left: 0, right: 0, bottom: 4,
        scrollable: true, alwaysScroll: true,
        scrollbar: { style: { bg: 'grey' } },
        // NO mouse:true — keeps terminal-native text selection/copy working.
        tags: true,
        padding: { left: 1, right: 1, top: 0, bottom: 0 },
        style: { fg: theme.text, bg: theme.bg },
      });
    this.indicator = new ThinkingIndicator(() => this.redraw());
    onGoalChange(() => {
      this.redraw(); // the goal display lives in this box
      syncTerminalTitle(); // …and in the terminal tab, so the goal is readable from the tab bar
    });
    syncTerminalTitle();
  }

  /**
   * How the session goal is displayed. Switchable at runtime (`AYIN_GOAL_VIEW`) so the treatments
   * can be compared without a rebuild:
   *
   *   card       a bordered OBJECTIVE panel above the input        (default)
   *   watermark  a faint ᵍᵒᵃˡ line above every assistant turn
   *   both       card + watermark  ← what's on now
   *   line       the original one-line Unicode math-italic cursive
   *   off        no goal display (the terminal tab still carries it)
   */
  private goalView(): 'card' | 'watermark' | 'both' | 'line' | 'off' {
    const v = (process.env.AYIN_GOAL_VIEW ?? 'both').toLowerCase();
    return v === 'card' || v === 'watermark' || v === 'line' || v === 'off' ? v : 'both';
  }

  /** The original treatment: one cursive+dim line. blessed has no italic attribute (its attr model
   *  has no italic bit), so "cursive" is a Unicode Mathematical-Italic transform — a real slant with
   *  no terminal support needed. Truncated by RAW length (pre-transform) because each italic glyph
   *  is a surrogate pair, so String#length would over-count. */
  private goalLine(): string | null {
    const goal = getGoal();
    if (!goal) return null;
    const maxCols = Math.max(12, Number(screen.width ?? 80) - 3);
    let raw = `Goal: ${goal}`;
    if (raw.length > maxCols) raw = raw.slice(0, maxCols - 1) + '…';
    return ` {${theme.muted}-fg}${escapeBlessedTags(toItalic(raw))}{/}`;
  }

  /**
   * The OBJECTIVE card — a bordered panel just above the input. Sized to the goal (wrapped, up to
   * MAX_CARD_ROWS lines) and never wider than the chat, so a long goal grows the box instead of
   * being clipped mid-word.
   */
  private goalCard(): string[] {
    const goal = getGoal();
    if (!goal) return [];
    const avail = Math.max(24, Number(screen.width ?? 80) - 6);
    const inner = Math.min(avail, 76);
    const words = goal.split(/\s+/);
    const rows: string[] = [];
    let line = '';
    for (const w of words) {
      const word = w.length > inner ? w.slice(0, inner) : w;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= inner) line += ` ${word}`;
      else { rows.push(line); line = word; }
      if (rows.length >= MAX_CARD_ROWS) break;
    }
    if (line && rows.length < MAX_CARD_ROWS) rows.push(line);
    if (!rows.length) return [];
    // Width is driven by the longest wrapped row, so a short goal gets a short card.
    const w = Math.max(...rows.map((r) => r.length), TITLE.length + 4);
    const frame = (s: string) => ` {${theme.accentDim}-fg}${s}{/}`;
    // Border arithmetic, spelled out because an off-by-one here is visible as a ragged card:
    // body is "│ " + w + " │" = w+4 cells, so the top must be "╭─ TITLE " (TITLE+3+1) + fill + "╮".
    const out = [frame(`╭─ ${TITLE} ${'─'.repeat(Math.max(0, w - TITLE.length - 1))}╮`)];
    for (const r of rows) {
      const pad = ' '.repeat(Math.max(0, w - r.length));
      out.push(`${frame('│')} {${theme.subtle}-fg}${escapeBlessedTags(r)}{/}${pad} ${frame('│').trim()}`);
    }
    out.push(frame(`╰${'─'.repeat(w + 2)}╯`));
    return out;
  }

  /** The watermark — a faint `ᵍᵒᵃˡ …` line above an assistant turn, so the anchor is visible at the
   *  moment of READING, not only while typing. One line, hard-truncated: it must never push the
   *  answer down the screen. */
  private goalWatermark(): string | null {
    const goal = getGoal();
    if (!goal) return null;
    const maxCols = Math.max(20, Math.min(Number(screen.width ?? 80) - 8, 72));
    const text = goal.length > maxCols ? `${goal.slice(0, maxCols - 1)}…` : goal;
    return `  {${theme.faint}-fg}ᵍᵒᵃˡ ${escapeBlessedTags(text)}{/}`;
  }

  add(role: MessageRole, content: string): void {
    if (HEADLESS) {
      if (role === 'assistant') process.stdout.write(content + '\n');
      else process.stderr.write(`[${role}] ${content}\n`);
      return;
    }
    this.messages.push({ role, content });
    this.redraw();
  }

  updateLastAssistant(content: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        this.messages[i].content = content;
        this.redraw();
        return;
      }
    }
    this.add('assistant', content);
  }

  clear(): void {
    this.messages.length = 0;
    this.indicator.stop();
    this.redraw();
  }

  setAgentStatus(text: string): void {
    if (HEADLESS) return;
    this.indicator.setFromText(text);
  }

  setAgentState(state: AgentState, label?: string): void {
    if (HEADLESS) return;
    this.indicator.set(state, label);
  }

  setBottom(row: number): void {
    this.box.bottom = row;
  }

  /** True when the view is following live output: either the content fits (nothing to scroll) or
   *  we're at the bottom. Content-fits must count as "at bottom" — else getScrollPerc returns 0 and
   *  we'd wrongly disengage follow on a short transcript. */
  private atBottom(): boolean {
    const b = this.box as unknown as { getScrollPerc?: () => number; getScrollHeight?: () => number; height?: number; iheight?: number };
    const viewH = (Number(b.height ?? 0)) - (Number(b.iheight ?? 0));
    if ((b.getScrollHeight?.() ?? 0) <= viewH) return true; // fits → always following
    return (b.getScrollPerc?.() ?? 100) >= 99;
  }

  scrollHalfPage(dir: 1 | -1): void {
    this.box.scroll(dir * Math.floor((this.box.height as number) / 2));
    this.stick = this.atBottom(); // re-engage follow ONLY when scrolled back to the bottom
    render();
  }

  /** Line-granular scroll (Shift+↑/↓). */
  scrollLine(dir: 1 | -1): void {
    this.box.scroll(dir);
    this.stick = this.atBottom();
    render();
  }

  /** Jump to the newest message and resume following live output. */
  scrollToBottom(): void {
    this.box.setScrollPerc(100);
    this.stick = true;
    render();
  }

  redraw(): void {
    if (HEADLESS) return;
    const chatHeight = Number(this.box.height ?? 20) - 1;
    const lines: string[] = [];

    // Every speaker gets a distinct left-edge anchor, so the eye can parse the transcript
    // by the gutter alone:
    //   ▌ bold        — the user (indigo bar)
    //   ◉ text        — ayin speaking (ayin = "eye"; accent glyph on the first line)
    //   ▸ │ ╰ cards   — tool calls (indented one step under the flow, amber frame)
    //   · dim         — system notices (quietest thing on screen)
    // VERTICAL RHYTHM. A turn is prompt → tool cards → answer, and with everything one line apart it
    // read as one wall of text. A SPEAKER CHANGE earns a blank line (two before a user prompt, which
    // starts a new exchange); consecutive tool messages do NOT, because a call and its result are
    // separate messages that must stay one visually contiguous card.
    let prevRole: MessageRole | null = null;
    for (const msg of this.messages) {
      const speakerChanged = prevRole !== msg.role;
      prevRole = msg.role;

      if (msg.role === 'user') {
        lines.push('', ''); // a new exchange starts — the widest gap in the transcript
        for (const line of msg.content.split('\n')) {
          lines.push(`{${theme.accent}-fg}▌{/} {bold}${escapeBlessedTags(line)}{/bold}`);
        }
      } else if (msg.role === 'assistant') {
        lines.push('');
        // The goal watermark rides above the answer, so the anchor is in view while READING it.
        const view = this.goalView();
        if (view === 'watermark' || view === 'both') {
          const wm = this.goalWatermark();
          if (wm) lines.push(wm);
        }
        const rendered = renderMarkdown(msg.content).split('\n');
        rendered.forEach((line, i2) => {
          lines.push(i2 === 0 ? `{${theme.accent}-fg}◉{/} ${line}` : `${GUTTER}${line}`);
        });
      } else if (msg.role === 'tool') {
        // Tool cards sit a tab in from the edge, so machine output is visibly subordinate to the
        // conversation rather than competing with it at the same margin.
        //
        // A card is TWO messages (the ▸ call, then the result+footer), so role alone can't tell a new
        // card from the tail of the current one — separating on every tool message would split cards
        // down the middle. The ▸ header is the card boundary: blank before it, nothing before a result.
        if (startsToolCard(msg.content)) lines.push('');
        for (const line of msg.content.split('\n')) {
          lines.push(`${TOOL_INDENT}${line}`);
        }
      } else {
        if (speakerChanged) lines.push(''); // system notices shouldn't crowd the answer above them
        msg.content.split('\n').forEach((line, i) => {
          lines.push(`${GUTTER}{${theme.dim}-fg}${i === 0 ? '· ' : '  '}${line}{/}`);
        });
      }
    }

    // The goal and the thinking indicator live at the very BOTTOM of the chat, just above the
    // input — goal first, indicator under it — so both stay in the user's eyeline.
    const view = this.goalView();
    const indicatorLine = this.indicator.line();
    const tail: string[] = [];
    if (view === 'card' || view === 'both') tail.push(...this.goalCard());
    else if (view === 'line') { const l = this.goalLine(); if (l) tail.push(l); }
    if (indicatorLine) tail.push(` ${indicatorLine}`);
    if (tail.length) lines.push('', ...tail);

    const padLines = Math.max(0, chatHeight - lines.length);
    const b = this.box as unknown as { childBase?: number; scroll?: (n: number) => void };
    const prevBase = b.childBase ?? 0; // the top visible line BEFORE content changes
    this.box.setContent([...Array(padLines).fill(''), ...lines].join('\n'));
    if (this.stick) {
      this.box.setScrollPerc(100); // following live → snap to newest
    } else {
      // Scrolled up: keep the user exactly where they were. Restore childBase DIRECTLY (not via
      // scrollTo, whose alwaysScroll math fought the user under frequent redraws) then clamp.
      b.childBase = prevBase;
      b.scroll?.(0);
    }
    render();
  }

  destroy(): void {
    this.indicator.destroy();
  }
}

// ── tool-result decoration ────────────────────────────────────────────

function escapeBlessedTags(text: string): string {
  // blessed's escape syntax is {open}/{close} — NOT backslashes (those render literally).
  // Single pass so the '}' of an inserted '{open}' is never re-escaped.
  return text.replace(/[{}]/g, m => (m === '{' ? '{open}' : '{close}'));
}

/** Fake italic for a blessed TUI (which has no italic attribute — see docs): map ASCII letters
 *  to their Unicode Mathematical-Italic glyphs. Digits, spaces, and punctuation stay upright
 *  (Unicode has no italic digit block). Small 'h' is the one hole in the block — it lives at
 *  U+210E (ℎ, PLANCK CONSTANT) rather than the contiguous slot. Non-letters pass through, so
 *  the result is still safe to feed through escapeBlessedTags afterwards. */
export function toItalic(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (ch === 'h') out += String.fromCodePoint(0x210e);
    else if (c >= 0x61 && c <= 0x7a) out += String.fromCodePoint(0x1d44e + (c - 0x61)); // a–z
    else if (c >= 0x41 && c <= 0x5a) out += String.fromCodePoint(0x1d434 + (c - 0x41)); // A–Z
    else out += ch;
  }
  return out;
}

/** How many output lines each tool's chat card shows before truncating. */
const PREVIEW_LINES: Record<string, number> = { bash: 6, grep: 6, read_file: 4 };
const DEFAULT_PREVIEW_LINES = 2;

/** Styled tool-call header shown when a tool starts: `▸ bash · cat package.json` */
export function formatToolCallForChat(tool: string, params: string): string {
  const p = params ? ` {${theme.muted}-fg}· ${escapeBlessedTags(params)}{/}` : '';
  return `{${theme.tool}-fg}▸{/} {bold}{${theme.accent}-fg}${tool}{/${theme.accent}-fg}{/bold}${p}`;
}

function formatToolMs(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** Card footer: `╰ ✓ 0.4s` (green) or `╰ ✗ 12.0s` (red) when the result smells like an error. */
function toolFooter(content: string, elapsedMs?: number): string {
  if (elapsedMs === undefined) return '';
  const failed = /^error[:\s]/i.test(content.trim())
    || /^command exited with code/i.test(content.trim())
    || content.includes('(exit code ')
    || content.includes('(timeout after')
    || content.includes('(command failed');
  const mark = failed ? `{${theme.err}-fg}✗{/}` : `{${theme.ok}-fg}✓{/}`;
  return `\n{${theme.faint}-fg}╰{/} ${mark} {${theme.dim}-fg}${formatToolMs(elapsedMs)}{/}`;
}

/**
 * Render a tool result for the chat. write_file gets the diff card; every other tool gets a
 * gutter-block preview with blessed tags ESCAPED — raw output full of `{`/`}` (JSON, code)
 * used to be fed to blessed as markup, which silently ate or garbled it. When elapsedMs is
 * given, the card closes with a ✓/✗ + duration footer.
 */
export function formatToolResultForChat(tool: string, content: string, elapsedMs?: number): string {
  if (tool !== 'write_file') {
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      return elapsedMs === undefined
        ? `{${theme.dim}-fg}(no output){/}`
        : `{${theme.faint}-fg}╰{/} {${theme.ok}-fg}✓{/} {${theme.dim}-fg}${formatToolMs(elapsedMs)} · no output{/}`;
    }
    const max = PREVIEW_LINES[tool] ?? DEFAULT_PREVIEW_LINES;
    const shown = lines.slice(0, max).map(l => {
      const cut = l.length > 200 ? l.slice(0, 200) + '…' : l;
      return `{${theme.faint}-fg}│{/} {${theme.diffCtx}-fg}${escapeBlessedTags(cut)}{/}`;
    });
    const more = lines.length > max
      ? `\n{${theme.faint}-fg}│{/} {${theme.dim}-fg}… ${lines.length - max} more lines — Ctrl+O to browse{/}`
      : '';
    return shown.join('\n') + more + toolFooter(content, elapsedMs);
  }

  const rendered: string[] = [];
  for (const line of content.split('\n')) {
    const escaped = escapeBlessedTags(line);
    if (line.startsWith('File: ')) {
      rendered.push(`{bold}{${theme.diffFileFg}-fg}{${theme.diffFileBg}-bg} ${escaped} {/${theme.diffFileBg}-bg}{/}`);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('@@')) {
      rendered.push(`{${theme.diffHunkFg}-fg}{${theme.diffHunkBg}-bg} ${escaped} {/${theme.diffHunkBg}-bg}{/}`);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      rendered.push(`{${theme.diffAddFg}-fg}{${theme.diffAddBg}-bg} ${escaped} {/${theme.diffAddBg}-bg}{/}`);
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      rendered.push(`{${theme.diffDelFg}-fg}{${theme.diffDelBg}-bg} ${escaped} {/${theme.diffDelBg}-bg}{/}`);
      continue;
    }
    if (line.startsWith(' ')) {
      rendered.push(`{${theme.diffCtx}-fg}${escaped}{/}`);
      continue;
    }
    rendered.push(escaped);
  }
  return rendered.join('\n') + toolFooter(content, elapsedMs);
}
