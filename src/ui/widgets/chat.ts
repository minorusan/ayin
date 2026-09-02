/**
 * ChatLog — the scrollable message area + the thinking indicator line.
 *
 * Owns the message list and how each role renders. Content is bottom-anchored (padded to
 * the box height) so the newest message sits just above the input, chat-app style.
 * No mouse tracking (see screen.ts copy-paste contract); scrolling is PgUp/PgDn.
 */

import blessed from 'blessed';
import { inlineFormat, renderMarkdownWrapped } from '../../markdown.js';
import { wrapPlain } from '../../dialog.js';
import { HEADLESS, noopBox } from '../headless.js';
import { screen, render } from '../screen.js';
import { bleachTags, bleached, blend, theme } from '../theme.js';
import { ThinkingIndicator, type AgentState } from './thinking.js';
import { getGoal, onGoalChange } from '../../goal.js';
import { launchTip } from '../../help.js';

/**
 * Indentation, in one place so the transcript has a consistent left rhythm.
 * `GUTTER` aligns wrapped speaker text under its glyph; `TOOL_INDENT` is a tab-width step further in
 * for machine output (tool cards), which reads as subordinate instead of competing with the
 * conversation at the same margin.
 */
const GUTTER = '  ';
const TOOL_INDENT = '    ';

/**
 * THE TRANSCRIPT WRAPS ITSELF. Blessed cannot, because blessed does not know about the gutter.
 *
 * A box with `tags` wraps at its own edge, and every wrapped continuation line starts at column 0 —
 * while the line it continues started two to six columns in, behind the speaker glyph or TOOL_INDENT.
 * On a wide terminal a paragraph rarely reaches the edge and nobody notices. On a phone every
 * paragraph does, and the left margin alternates down the whole screen.
 *
 * So the width is computed here and every line type is wrapped to what is actually available before
 * its gutter goes on. `renderMarkdownWrapped` already existed for exactly this and was used only by
 * the dialog; the transcript was calling the unwrapped `renderMarkdown`.
 *
 * `screen.width - 3` is the box's usable width — the same figure the OBJECTIVE card computes: one
 * column of padding each side plus the scrollbar. Read at DRAW time, so a resize reflows (the screen's
 * `resize` handler already calls `redraw`).
 */
function usableCols(): number {
  return Math.max(12, Number(screen.width ?? 80) - 3);
}

/**
 * Hard-wrap PREFORMATTED text — tool output, code, JSON, diffs — continuation marked with a arrow.
 *
 * Deliberately not `wrapPlain`: that reflows on whitespace, which is right for prose and destroys an
 * aligned table or a diff. This only breaks a line genuinely too long to fit, and marks the break so a
 * continuation is not misread as a new record.
 */
/**
 * Hard-wrap a preformatted line, NEVER through the middle of a character.
 *
 * `slice()` cuts code UNITS, so an emoji \u2014 a surrogate pair \u2014 landing on the boundary was split in
 * half, and the two halves paint as replacement characters on separate rows. Cutting on code points
 * fixes that; a `[...line]` array is also the only honest thing to index when the line may contain
 * astral characters at all.
 *
 * THE BUDGET IS STILL CODE-UNIT LENGTH, on purpose, and it is not an oversight. The line arrives
 * carrying blessed tags (`{green-fg}\u2026{/}`) which occupy no cells, so the count already over-estimates
 * and this wraps earlier than it strictly must. Erring toward a shorter line is the safe direction \u2014
 * a line that stops before the edge cannot spill past it \u2014 and a surrogate pair counting 2 happens to
 * be exactly what a terminal paints for an emoji. Making the budget "accurate" would have to strip
 * tags first, which lengthens every line in the transcript: a layout change for every message, to
 * gain nothing this function needs.
 */
function wrapPre(line: string, width: number): string[] {
  const w = Math.max(8, Math.floor(width) || 8);
  if (line.length <= w) return [line];
  const cps = [...line];
  /** Take code points until their combined code-unit length would exceed `budget`. */
  const take = (from: number, budget: number): { text: string; next: number } => {
    let used = 0;
    let i = from;
    for (; i < cps.length; i++) {
      const size = cps[i].length;               // 2 for a surrogate pair, 1 otherwise
      if (used + size > budget) break;
      used += size;
    }
    return { text: cps.slice(from, i).join(''), next: i };
  };
  const first = take(0, w);
  const out: string[] = [first.text];
  for (let i = first.next; i < cps.length;) {
    const chunk = take(i, w - 2);
    // A budget too small for even one character would loop forever; take one and move on.
    if (chunk.next === i) {
      out.push('\u21B3 ' + cps[i]);
      i++;
      continue;
    }
    out.push('\u21B3 ' + chunk.text);
    i = chunk.next;
  }
  return out;
}
/**
 * How far mid-turn prose is washed toward `subtle`. Read on a real terminal against the answer above it:
 * enough that the eye goes to the answer first, not so much that the words have to be looked for.
 */
const INTERIM_BLEACH = 0.6;

/**
 * Does this tool message OPEN a card (the `⌕ tool · params` header) rather than continue one?
 *
 * Exported for `tool/check-tool-icons.mjs`. Nothing else calls it from outside — but the pairing it
 * guards (header format ↔ detector) is invisible when it breaks, so a gate has to be able to see it.
 */
export function startsToolCard(content: string): boolean {
  return TOOL_HEADER.test(content);
}

/**
 * A call header, by its SHAPE rather than by its glyph.
 *
 * This used to be `startsWith('▸')`, which was exact while every card opened with the same character.
 * Per-tool icons ended that: a `\u2315 grep …` header is still a header, and a detector keyed to one
 * glyph would have quietly stopped seeing them — costing the blank line before each card AND
 * misattributing the token-cost label, which skips a header and lands on the result (see `takeCost`).
 * Neither failure throws; both just look like the layout got worse.
 *
 * So the test is the markup only a header has: the tool colour, exactly one character, closed, then
 * the bold tool name. `formatToolCallForChat` is the sole producer, three lines below.
 */
// `u` AND `{1,2}`: `[^{}]` matches one UTF-16 code UNIT, so an emoji icon — a surrogate pair — stopped
// being recognised as a header the moment icons could be emoji. Two code points also covers a
// pictograph carrying a variation selector. Same fix, same reason, as `HEADLESS_TOOL_HEADER`.
const TOOL_HEADER = new RegExp(`^\\{${theme.tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-fg\\}[^{}]{1,2}\\{/\\} \\{bold\\}`, 'u');

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
  /**
   * MID-TURN prose: what the model says on its way somewhere, not its answer.
   *
   * The pre-tool sentence ("let me check the mapper first") and the answer used to render identically —
   * same glyph, same margin, same white — so a turn with six tool calls put seven things on screen that
   * all looked like conclusions, and the actual conclusion was the one that happened to be last. This
   * is the same text, set one tab further in and paler: still readable, visibly on the way.
   */
  interim?: boolean;
  /**
   * What this message cost, in tokens, as the SERVER counted them — never an estimate.
   *
   * On a reply it is the call that produced it: the whole prompt the model read, and what it generated.
   * On a tool result it is what that result added to the next prompt, measured when the next call comes
   * back (see `TurnUsage.growth`). Absent means "not reported", which a reader must be able to tell from
   * zero — so nothing is printed rather than a 0.
   */
  cost?: string;
}

export class ChatLog {
  readonly box: blessed.Widgets.BoxElement;
  readonly indicator: ThinkingIndicator;
  private messages: Message[] = [];
  // Follow the live bottom until the user scrolls up. Once they do, NOTHING moves the view until
  // they scroll back to the bottom, press End, or type a character — every redraw (new message, goal
  // change, thinking-indicator tick) leaves it exactly where it was. See atBottom() for the rounding
  // bug that used to defeat this.
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
    // Before a goal is set the line is dead space, so it carries one tip instead — chosen once per
    // launch, in the row the goal will occupy the moment there is one. This is the only place a
    // feature nobody has typed a slash for can introduce itself. Only the LINE does this: a tip in
    // the objective card or the per-turn watermark would be shouting, not offering.
    const raw0 = goal ? `Goal: ${goal}` : (() => { const t = launchTip(); return t ? `Tip: ${t}` : ''; })();
    if (!raw0) return null;
    const maxCols = Math.max(12, Number(screen.width ?? 80) - 3);
    let raw = raw0;
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

  add(role: MessageRole, content: string, interim = false): void {
    if (HEADLESS) {
      // Strip TUI markup here, at the one place headless output is written, rather than asking every
      // call site to know which mode it is in. The widget owns how a message looks; in headless, how
      // it looks is plain text.
      const plain = stripBlessedTags(content);
      if (role === 'assistant') process.stdout.write(plain + '\n');
      else process.stderr.write(`[${role}] ${plain}\n`);
      return;
    }
    const cost = this.takePendingCost(role, content);
    this.messages.push({ role, content, ...(interim ? { interim: true } : {}), ...(cost ? { cost } : {}) });
    this.redraw();
  }

  /**
   * The price of the call that just returned, waiting for the message it produced.
   *
   * PENDING, not retroactive: the usage is known when `generate` resolves, which is BEFORE the round's
   * reply is parsed and printed. The first version walked backwards from the end and found the previous
   * round's tool card, so every answer went unpriced — visible the first time it was painted in a real
   * terminal. Whatever this round prints next takes the label: an interim sentence, the answer, or the
   * tool-call card of a round that said nothing else.
   */
  private pendingCost: string | null = null;

  noteCost(label: string): void {
    this.pendingCost = label;
  }

  /**
   * Price the tool results of the PREVIOUS round, now that the next call has reported its prompt size.
   * Every unpriced result since the last call shares one measurement, so the label goes on the last of
   * them and says what it covers.
   */
  setLastToolCost(label: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== 'tool') { if (m.role === 'user') return; continue; }
      if (m.cost?.includes('into the prompt')) return;   // already priced
      // The round's own cost may already be here (the call that produced this result). Both facts belong
      // on one line: what the round cost, and what its result will cost every round after it.
      m.cost = m.cost ? `${m.cost} · ${label}` : label;
      this.redraw();
      return;
    }
  }

  /**
   * Who gets the pending price: the prose a round produced, or — when it produced none — the tool CALL
   * card, which is the round's only visible output. A tool RESULT never takes it: a result is priced by
   * what it adds to the next prompt (`setLastToolCost`), and the same round would otherwise be counted
   * twice on two adjacent lines.
   */
  private takePendingCost(role: MessageRole, content: string): string | null {
    if (!this.pendingCost) return null;
    // A tool card is TWO messages: the `▸ call` header and the result. The price goes on the RESULT, so
    // it prints under the card's footer with the growth measured next round — putting it on the header
    // wedged a line between a card's title and its body, which is where it first landed and read wrong.
    const takes = role === 'assistant' || (role === 'tool' && !startsToolCard(content));
    if (!takes) return null;
    const label = this.pendingCost;
    this.pendingCost = null;
    return label;
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

  /**
   * True when the view is at the live bottom — measured in LINES, never in percent.
   *
   * `getScrollPerc()` was the bug that made the transcript feel unscrollable. blessed computes it as
   * `childBase / (total - height)`, so on a long transcript one wheel notch is a fraction of a
   * percent: scrolling up three lines out of a thousand still reported 99.7, the `>= 99` test read
   * that as "at the bottom", follow stayed engaged, and the very next redraw — a thinking-indicator
   * tick, which happens several times a second — snapped the view back. The user could not out-scroll
   * the rounding. A line comparison has no threshold to be wrong about.
   *
   * Content that FITS counts as at-bottom: there is nothing to scroll, so follow should stay on.
   */
  private atBottom(): boolean {
    const b = this.box as unknown as { getScrollHeight?: () => number; childBase?: number; height?: number; iheight?: number };
    const viewH = Number(b.height ?? 0) - Number(b.iheight ?? 0);
    const total = b.getScrollHeight?.() ?? 0;
    if (total <= viewH) return true;
    return Number(b.childBase ?? 0) >= total - viewH;
  }

  /**
   * Scrolling UP disengages follow unconditionally and the view then STAYS put — no redraw may move
   * it again. Only arriving back at the true bottom re-engages, so live output resumes exactly when
   * the user has asked to see it and never a moment before.
   */
  private moveBy(delta: number, dir: 1 | -1): void {
    this.box.scroll(delta);
    this.stick = dir > 0 ? this.atBottom() : false;
    render();
  }

  scrollHalfPage(dir: 1 | -1): void {
    this.moveBy(dir * Math.floor((this.box.height as number) / 2), dir);
  }

  /** Line-granular scroll: Shift+↑/↓ moves one line, a wheel notch moves `lines`. */
  scrollLine(dir: 1 | -1, lines = 1): void {
    this.moveBy(dir * Math.max(1, lines), dir);
  }

  /** Is the view currently parked away from the bottom? The key router asks before snapping back,
   *  so an ordinary keystroke in an already-followed transcript costs no scroll work at all. */
  isScrolledUp(): boolean {
    return !this.stick;
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
    //   · subtle      — system notices (quiet, but still readable — see the note at the branch)
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
        // Wrapped like everything else: a pasted paragraph is the commonest long line on a phone,
        // and its continuation used to start at column 0 while the glyph sat two columns in.
        for (const line of wrapPlain(msg.content, usableCols() - 2)) {
          lines.push(`{${theme.accent}-fg}▌{/} {bold}${escapeBlessedTags(line)}{/bold}`);
        }
      } else if (msg.role === 'assistant' && msg.interim) {
        /**
         * ON THE WAY, NOT THE ANSWER: a tab in from the answer's margin (level with the tool cards it
         * introduces, because that is what it is about) and BLEACHED.
         *
         * Bleached, not flattened. The first version replaced every colour with one grey and rendered no
         * markdown, which threw away what the renderer had just worked out — a code fence, a heading and
         * an inline literal all came out identical, in the place a reader most needs a hint of structure.
         * Now the markdown IS rendered and every foreground colour is mixed toward the panel background
         * (`bleachTags`): the code blue stays recognisably the code blue, three-fifths of the way to the
         * paper. Hues survive, contrast does not — which is what bleach does to a printed page.
         */
        lines.push('');
        const rendered = renderMarkdownWrapped(msg.content, usableCols() - TOOL_INDENT.length - 2, wrapPlain);
        rendered.forEach((line, i2) => {
          const glyph = i2 === 0 ? `{${bleached(theme.accent, 0.5)}-fg}\u25E6{/} ` : '  ';
          lines.push(`${TOOL_INDENT}${glyph}{${bleached(theme.text, INTERIM_BLEACH)}-fg}${bleachTags(line, INTERIM_BLEACH)}{/}`);
        });
        if (msg.cost) lines.push(`${TOOL_INDENT}  {${bleached(theme.subtle, INTERIM_BLEACH)}-fg}${msg.cost}{/}`);
      } else if (msg.role === 'assistant') {
        lines.push('');
        // The goal watermark rides above the answer, so the anchor is in view while READING it.
        const view = this.goalView();
        if (view === 'watermark' || view === 'both') {
          const wm = this.goalWatermark();
          if (wm) lines.push(wm);
        }
        const rendered = renderMarkdownWrapped(msg.content, usableCols() - GUTTER.length, wrapPlain);
        rendered.forEach((line, i2) => {
          lines.push(i2 === 0 ? `{${theme.accent}-fg}◉{/} ${line}` : `${GUTTER}${line}`);
        });
        // The price, under the answer and quiet: the number is worth having on every message and worth
        // nobody's attention while reading one.
        if (msg.cost) lines.push(`${GUTTER}{${theme.subtle}-fg}${msg.cost}{/}`);
      } else if (msg.role === 'tool') {
        // Tool cards sit a tab in from the edge, so machine output is visibly subordinate to the
        // conversation rather than competing with it at the same margin.
        //
        // A card is TWO messages (the ▸ call, then the result+footer), so role alone can't tell a new
        // card from the tail of the current one — separating on every tool message would split cards
        // down the middle. The ▸ header is the card boundary: blank before it, nothing before a result.
        if (startsToolCard(msg.content)) lines.push('');
        for (const raw of msg.content.split('\n')) {
          for (const line of wrapPre(raw, usableCols() - TOOL_INDENT.length)) {
            lines.push(`${TOOL_INDENT}${line}`);
          }
        }
        if (msg.cost) lines.push(`${TOOL_INDENT}{${theme.subtle}-fg}${msg.cost}{/}`);
      } else {
        if (speakerChanged) lines.push(''); // system notices shouldn't crowd the answer above them
        // `subtle`, not `dim`. These were the quietest thing on screen by design, and it went too far:
        // dim is #59685f against a #0d1411 panel, which reads as black on a real terminal — the version
        // line, every `/set` confirmation and every "not configured, run X" instruction were all but
        // invisible. A notice nobody can read is not quiet, it is missing. Quietness comes from the `·`
        // gutter and the lack of a speaker glyph; it does not need to come from contrast too.
        wrapPlain(msg.content, usableCols() - GUTTER.length - 2).forEach((line, i) => {
          lines.push(`${GUTTER}{${theme.subtle}-fg}${i === 0 ? '· ' : '  '}${line}{/}`);
        });
      }
    }

    // The goal and the thinking indicator live at the very BOTTOM of the chat, just above the
    // input — goal first, indicator under it — so both stay in the user's eyeline.
    const view = this.goalView();
    const indicatorLine = this.indicator.line();
    const tail: string[] = [];
    // With no goal yet, the card renders nothing — so the tip line stands in for it under every
    // view that would have shown a goal. Without this the tip is invisible on the default view,
    // which is the only view almost anyone runs.
    if (view === 'card' || view === 'both') {
      const card = this.goalCard();
      if (card.length) tail.push(...card);
      else { const l = this.goalLine(); if (l) tail.push(l); }
    } else if (view === 'line') { const l = this.goalLine(); if (l) tail.push(l); }
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

export function escapeBlessedTags(text: string): string {
  // blessed's escape syntax is {open}/{close} — NOT backslashes (those render literally).
  // Single pass so the '}' of an inserted '{open}' is never re-escaped.
  return text.replace(/[{}]/g, m => (m === '{' ? '{open}' : '{close}'));
}

/**
 * The inverse, for output that is NOT going to a blessed screen.
 *
 * Headless (`-p`) writes straight to stdout/stderr, but the strings it is handed were already
 * formatted for the TUI by `formatToolResultForChat` and friends at the call site. The result was raw
 * markup in a script's output — `{#eafff1-fg}{#173d2d-bg} + const int RED_PIN = 9; {/#173d2d-bg}{/}`
 * — and worse, every literal brace in the source code being written showed up as `{open}`/`{close}`,
 * so a C++ function body read as `void setup() {open} … {close}`. Anything parsing that output (a
 * script, `ayin watch`, a benchmark log) sees garbage. Found while reading a benchmark run's log.
 *
 * ORDER MATTERS. `{open}`/`{close}` are themselves tag-shaped, so they are lifted out to sentinels
 * before tags are stripped and restored afterwards — otherwise the brace-strip eats them and the code
 * loses its braces entirely, which is worse than the markup.
 */
export function stripBlessedTags(text: string): string {
  const OPEN = '\u0000AYIN_OPEN\u0000';
  const CLOSE = '\u0000AYIN_CLOSE\u0000';
  return text
    .replace(/\{open\}/g, OPEN)
    .replace(/\{close\}/g, CLOSE)
    // A style tag: `{bold}`, `{/}`, `{#aabbcc-fg}`, `{red-bg}`, `{/#aabbcc-bg}`. Never a bare `{`.
    .replace(/\{\/?[a-zA-Z#][\w#-]*\}|\{\/\}/g, '')
    .replace(new RegExp(OPEN, 'g'), '{')
    .replace(new RegExp(CLOSE, 'g'), '}');
}

/** Fake italic for a blessed TUI (which has no italic attribute — see docs): map ASCII letters
 *  to their Unicode Mathematical-Italic glyphs. Digits, spaces, and punctuation stay upright
 *  (Unicode has no italic digit block). Small 'h' is the one hole in the block — it lives at
 *  U+210E (ℎ, PLANCK CONSTANT) rather than the contiguous slot. Non-letters pass through, so
 *  the result is still safe to feed through escapeBlessedTags afterwards. */
/**
 * A `!<command>` passthrough, rendered so it cannot be mistaken for the agent talking.
 *
 * Everything here is BOLD on purpose: the operator asked for a visible difference, and the whole
 * point of the feature is that no model was involved — the output is the machine's own words, not
 * something an agent decided to tell you. Bold is the cheapest signal that carries across every
 * terminal (blessed has no italic bit, and colour alone is what every other card already uses).
 *
 * Output is escaped BEFORE the bold tags go on: a command that prints `{bold}` or a JSON blob full
 * of braces would otherwise be interpreted as markup and corrupt the panel.
 */
export function formatShellForChat(
  command: string,
  output: string,
  meta: { exitCode: number | null; ms: number; timedOut: boolean; cancelled: boolean },
): string {
  const lines: string[] = [];
  lines.push(`{${theme.tool}-fg}${'$'}{/} {bold}{${theme.text}-fg}${escapeBlessedTags(command)}{/${theme.text}-fg}{/bold}`);
  if (output) {
    for (const line of output.split('\n')) {
      lines.push(`{bold}{${theme.text}-fg}${escapeBlessedTags(line)}{/${theme.text}-fg}{/bold}`);
    }
  }
  const secs = (meta.ms / 1000).toFixed(1);
  const ok = meta.exitCode === 0 && !meta.timedOut && !meta.cancelled;
  const why = meta.cancelled ? 'cancelled' : meta.timedOut ? 'timed out' : `exit ${meta.exitCode ?? '?'}`;
  const colour = ok ? theme.ok : theme.err;
  const mark = ok ? '\u2713' : '\u2717';
  const tail = ok ? `${secs}s` : `${secs}s \u00b7 ${why}`;
  lines.push(`{${colour}-fg}${mark}{/} {${theme.muted}-fg}${tail}${output ? '' : ' \u00b7 no output'}{/}`);
  return lines.join('\n');
}

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
/** Lines of a write_file diff worth showing before the card starts drowning the transcript. */
const DIFF_PREVIEW_LINES = 34;
/** Lines kept from the END of a truncated diff — a diff's tail is where the interesting part often is. */
const DIFF_TAIL_LINES = 8;
/**
 * Chars any single card may paint, whatever its line count says.
 *
 * A line budget alone is not a budget: one minified JSON response or a base64 blob is a *single* line
 * of 400 KB, passes any `lines.length` check, and turns the transcript into a wall. This is the
 * display budget only — the model's own view of a tool result has its own, larger clip in `agent.ts`,
 * because "how much should a human read" and "how much should the model see" are different questions.
 */
const PREVIEW_CHAR_BUDGET = 5000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Nothing is truncated silently: the marker says how much was withheld, in lines AND bytes, and where
 * the whole thing still is. The full output is always saved as an artifact (`artifacts.ts`), so this
 * is a display choice, not data loss — and the marker has to say so, or it reads as one.
 */
function omissionNote(hiddenLines: number, hiddenChars: number): string {
  const what = hiddenLines > 0
    ? `… ${hiddenLines} more line${hiddenLines === 1 ? '' : 's'} (${formatBytes(hiddenChars)})`
    : `… ${formatBytes(hiddenChars)} more`;
  return `{${theme.faint}-fg}│{/} {${theme.dim}-fg}${what} — full output kept, Ctrl+O to browse{/}`;
}

/**
 * Take lines until either budget runs out. Returns what to show plus exactly what was left behind, so
 * the caller can be honest about it.
 */
function budgeted(lines: string[], maxLines: number, maxChars = PREVIEW_CHAR_BUDGET): {
  shown: string[]; hiddenLines: number; hiddenChars: number;
} {
  const shown: string[] = [];
  let spent = 0;
  for (const line of lines) {
    if (shown.length >= maxLines || spent >= maxChars) break;
    shown.push(line);
    spent += line.length + 1;
  }
  const hiddenChars = lines.slice(shown.length).reduce((a, l) => a + l.length + 1, 0);
  return { shown, hiddenLines: lines.length - shown.length, hiddenChars };
}

/** When a tool declares no `icon` of its own. What every card used to show, unconditionally. */
const DEFAULT_TOOL_GLYPH = '▸';

/**
 * Styled tool-call header shown when a tool starts: `⌕ grep · pattern=foo path=src`.
 *
 * THE GLYPH COMES FROM THE TOOL (`Tool.icon`), passed in by the caller rather than looked up here: the
 * UI does not import the tool registry, and it should not start now — `tools.ts` reaches into the UI
 * for permission prompts, so the edge would be a cycle.
 *
 * IT MUST BE ONE CELL, and that is not a style preference. ayin wraps by character count
 * (`wrapPlain`, `wrapPre`), so a two-cell emoji here makes every line carrying it wrap a cell early and
 * smartCSR re-emits the shifted rows — measured: `\u{1F527} guarded · …` reports 51 characters and
 * paints 52 cells. `tool/check-glyphs.mjs` fails the build on one in `src/tools/defs/`.
 *
 * THE GATE CANNOT SEE EVERY TOOL, which is why the same rule is enforced again here. `AYIN_TOOL_DIRS`
 * loads tools from directories outside this repo — the whole point of it — and nothing builds those
 * with our prebuild. A third-party icon is checked at paint time and falls back to the default rather
 * than being drawn: a tool with a plain triangle is a cosmetic loss, a shifted transcript is not.
 */
export function formatToolCallForChat(tool: string, params: string, icon?: string): string {
  const p = params ? ` {${theme.muted}-fg}· ${escapeBlessedTags(params)}{/}` : '';
  return `{${theme.tool}-fg}${toolGlyph(icon)}{/} {bold}{${theme.accent}-fg}${tool}{/${theme.accent}-fg}{/bold}${p}`;
}

/**
 * ONE GLYPH THE TERMINAL CAN MEASURE — which now includes emoji.
 *
 * This used to reject anything with `Emoji_Presentation`, for the reason the whole width problem
 * exists: blessed measured such a glyph as one cell and the terminal painted two, so a card header
 * could spill past the edge and shift the rows after it. `width.ts` fixes the measurement itself, so
 * the ban is no longer what is protecting the layout — an emoji is now simply a two-cell character,
 * and blessed lays it out as one.
 *
 * WHAT IS STILL REFUSED, and why it is a different question. A ZWJ sequence (family), a flag (two
 * regional indicators) and a skin-tone modifier are SEVERAL code points that a terminal may or may not
 * combine into one cluster — the same string is one glyph in one emulator and three in another, so no
 * width is correct everywhere. One code point, optionally followed by a variation selector, is the
 * largest thing whose painted width is knowable, and that is the line.
 *
 * (Named rather than pasted: this file is scanned by `tool/check-glyphs.mjs`, which cannot tell a
 * glyph in a comment from one in a template literal — and it is right not to try.)
 */
function toolGlyph(icon?: string): string {
  if (!icon) return DEFAULT_TOOL_GLYPH;
  const cps = [...icon];
  // One code point, or one plus a variation selector (⚙️ = U+2699 U+FE0F) — nothing wider.
  const bare = cps.length === 1;
  const withSelector = cps.length === 2 && (cps[1] === '️' || cps[1] === '︎');
  if (!bare && !withSelector) return DEFAULT_TOOL_GLYPH; // a flag, a skin tone, a ZWJ sequence
  return icon;
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
    const { shown, hiddenLines, hiddenChars } = budgeted(lines, max);
    const rendered = shown.map(l => {
      const cut = l.length > 200 ? `${l.slice(0, 200)}…` : l;
      return `{${theme.faint}-fg}│{/} {${theme.diffCtx}-fg}${escapeBlessedTags(cut)}{/}`;
    });
    const more = hiddenLines > 0 || hiddenChars > 0 ? `\n${omissionNote(hiddenLines, hiddenChars)}` : '';
    return rendered.join('\n') + more + toolFooter(content, elapsedMs);
  }

  // A write_file diff had NO cap at all: rewriting a 3000-line file painted a 3000-line card and
  // buried everything before it, including the answer you were reading. Head + tail with an honest
  // middle marker — a diff's end matters as often as its beginning, so a plain head cut is the wrong
  // shape here. The `File:` header line is always kept.
  const diffLines = content.split('\n');
  const overBudget = diffLines.length > DIFF_PREVIEW_LINES
    || diffLines.reduce((a, l) => a + l.length + 1, 0) > PREVIEW_CHAR_BUDGET;
  let headLines = diffLines;
  let tailLines: string[] = [];
  let omitted = 0;
  let omittedChars = 0;
  if (overBudget) {
    const head = budgeted(diffLines, DIFF_PREVIEW_LINES - DIFF_TAIL_LINES);
    headLines = head.shown;
    const rest = diffLines.slice(headLines.length);
    tailLines = rest.slice(-DIFF_TAIL_LINES);
    const middle = rest.slice(0, Math.max(0, rest.length - tailLines.length));
    omitted = middle.length;
    omittedChars = middle.reduce((a, l) => a + l.length + 1, 0);
  }

  const rendered = [
    ...headLines.map(styleDiffLine).filter((l): l is string => l !== null),
    ...(omitted > 0 || omittedChars > 0 ? [omissionNote(omitted, omittedChars)] : []),
    ...tailLines.map(styleDiffLine).filter((l): l is string => l !== null),
  ];
  return rendered.join('\n') + toolFooter(content, elapsedMs);
}

/**
 * A gate card — the QA verdict and plan-mode's notices, in the same visual language as a tool result.
 *
 * These used to be plain `system` lines, which gave a three-pass review of the user's work exactly the
 * weight of `[Loop detected]` noise: a verdict on whether the change is actually done was the dimmest
 * thing on the screen. Same gutter and footer as a tool card, coloured by outcome, so it reads as a
 * result of work rather than as chatter.
 *
 * `kind` picks the colour and mark; `title` is the headline; `body` lines get the gutter.
 */
export function formatGateCardForChat(
  kind: 'pass' | 'fail' | 'stopped' | 'info',
  title: string,
  body: string[] = [],
  footer?: string,
): string {
  const look = {
    pass: { color: theme.ok, glyph: '▣', mark: '✓' },
    fail: { color: theme.warn, glyph: '▣', mark: '✗' },
    stopped: { color: theme.err, glyph: '▣', mark: '✗' },
    info: { color: theme.accent, glyph: '▣', mark: '·' },
  }[kind];

  const head = `{${look.color}-fg}${look.glyph}{/} {bold}{${look.color}-fg}${escapeBlessedTags(title)}{/${look.color}-fg}{/bold}`;
  // Body lines are QA's own prose (a reviewer's summary, an issue description) and can carry inline
  // markdown (bold, `code`) — escape raw {}/ FIRST, then style, so the reviewer's own braces/asterisks
  // never get mistaken for blessed tags or left as literal, unrendered markdown syntax.
  const lines = body.map((l) => `{${theme.faint}-fg}│{/} {${theme.diffCtx}-fg}${inlineFormat(escapeBlessedTags(l))}{/}`);
  const foot = footer
    ? `{${theme.faint}-fg}╰{/} {${look.color}-fg}${look.mark}{/} {${theme.dim}-fg}${escapeBlessedTags(footer)}{/}`
    : '';
  return [head, ...lines, foot].filter(Boolean).join('\n');
}

/** One diff line, styled. Returns null for the `---`/`+++` headers, which carry nothing readable. */
function styleDiffLine(line: string): string | null {
  const escaped = escapeBlessedTags(line);
  if (line.startsWith('File: ')) {
    return `{bold}{${theme.diffFileFg}-fg}{${theme.diffFileBg}-bg} ${escaped} {/${theme.diffFileBg}-bg}{/}`;
  }
  if (line.startsWith('--- ') || line.startsWith('+++ ')) return null;
  if (line.startsWith('@@')) {
    return `{${theme.diffHunkFg}-fg}{${theme.diffHunkBg}-bg} ${escaped} {/${theme.diffHunkBg}-bg}{/}`;
  }
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return `{${theme.diffAddFg}-fg}{${theme.diffAddBg}-bg} ${escaped} {/${theme.diffAddBg}-bg}{/}`;
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return `{${theme.diffDelFg}-fg}{${theme.diffDelBg}-bg} ${escaped} {/${theme.diffDelBg}-bg}{/}`;
  }
  if (line.startsWith(' ')) return `{${theme.diffCtx}-fg}${escaped}{/}`;
  return escaped;
}
