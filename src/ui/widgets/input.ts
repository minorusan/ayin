/**
 * InputBar — the bordered input at the bottom: buffer, cursor, soft-wrap, growth 3..10 rows.
 * Emits onSubmit(text) and onChange(text); prompt-history navigation stays here (up/down).
 * Key events arrive via handleKey() from the global key router (keys.ts) — this widget never
 * installs its own screen listeners.
 */

import blessed from 'blessed';
import { navigateUp, navigateDown, resetNavigation } from '../../history.js';
import { HEADLESS, noopBox } from '../headless.js';
import { screen, render } from '../screen.js';
import { theme } from '../theme.js';
import { relayout } from '../layout.js';

const MIN_HEIGHT = 3;  // border + 1 line + border
const MAX_HEIGHT = 10; // cap growth

export class InputBar {
  readonly wrapper: blessed.Widgets.BoxElement;
  readonly box: blessed.Widgets.BoxElement;

  private buffer = '';
  private cursor = 0;
  /** When the last keystroke arrived — how a pasted newline is told from a typed one. */
  private lastKeyAt = 0;
  private active = false;
  private onSubmit: (text: string) => void = () => {};
  private onChange: (text: string) => void = () => {};

  constructor() {
    this.wrapper = HEADLESS
      ? noopBox
      : blessed.box({
        parent: screen,
        bottom: 1, left: 0, right: 0, height: MIN_HEIGHT,
        border: { type: 'line' },
        style: { border: { fg: theme.border }, bg: theme.bg },
      });
    this.box = HEADLESS
      ? noopBox
      : blessed.box({
        parent: this.wrapper,
        top: 0, left: 1, right: 1, height: 1,
        style: { fg: theme.text, bg: theme.bg },
      });
    if (!HEADLESS) {
      blessed.text({
        parent: this.wrapper,
        top: 0, left: 0, width: 1, height: 1,
        content: '❯',
        style: { fg: theme.accent, bg: theme.bg },
      });
    }
  }

  handlers(handlers: { onSubmit?: (text: string) => void; onChange?: (text: string) => void }): void {
    if (handlers.onSubmit) this.onSubmit = handlers.onSubmit;
    if (handlers.onChange) this.onChange = handlers.onChange;
  }

  focus(): void {
    if (HEADLESS) return;
    this.active = true;
    screen.program.showCursor();
    this.redraw();
  }

  blur(): void {
    if (HEADLESS) return;
    this.active = false;
    screen.program.hideCursor();
    render();
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Move the cursor one buffer line up/down, keeping its column. Returns false when there is no line
   * to move to — that is the signal for the caller to fall through to prompt history.
   *
   * "Line" here means a real `\n` in the buffer, not a visual wrap: those are the boundaries the user
   * typed and the ones history navigation must not eat.
   */
  private moveCursorLine(dir: 1 | -1): boolean {
    if (!this.buffer.includes('\n')) return false;
    const before = this.buffer.slice(0, this.cursor);
    const lineStart = before.lastIndexOf('\n') + 1;
    const col = this.cursor - lineStart;

    if (dir === -1) {
      if (lineStart === 0) return false; // already on the first line → history
      const prevStart = this.buffer.lastIndexOf('\n', lineStart - 2) + 1;
      const prevLen = lineStart - 1 - prevStart;
      this.cursor = prevStart + Math.min(col, prevLen);
    } else {
      const nlAfter = this.buffer.indexOf('\n', this.cursor);
      if (nlAfter === -1) return false; // already on the last line → history
      const nextStart = nlAfter + 1;
      const nextEnd = this.buffer.indexOf('\n', nextStart);
      const nextLen = (nextEnd === -1 ? this.buffer.length : nextEnd) - nextStart;
      this.cursor = nextStart + Math.min(col, nextLen);
    }
    this.redraw();
    return true;
  }

  clear(): void {
    this.buffer = '';
    this.cursor = 0;
    this.redraw();
  }

  getHeight(): number {
    return Number(this.wrapper.height ?? MIN_HEIGHT);
  }

  setBottom(row: number): void {
    this.wrapper.bottom = row;
  }

  /** Editing keys, called by the key router while the input is active.
   *  Returns true when the key was consumed. */
  handleKey(ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg): boolean {
    switch (key.full) {
      // A newline that ARRIVED AS PART OF A PASTE is text, not a submit.
      //
      // Multi-line paste was unusable: the terminal delivers it as ordinary keystrokes, so the first
      // newline submitted the first line and the rest of the paste typed itself into whatever came
      // next. Pasted characters arrive back-to-back — a human cannot produce two keystrokes 12ms
      // apart — so a `return` that close behind another key is part of a burst and is inserted.
      //
      // Deliberate newlines have their own keys below (Alt+Enter, Ctrl+J), because a heuristic must
      // never be the ONLY way to do something.
      case 'return': case 'enter': {
        if (Date.now() - this.lastKeyAt < PASTE_BURST_MS) {
          this.insert('\n');
          this.lastKeyAt = Date.now();
          return true;
        }
        const text = this.buffer.trim();
        if (text) {
          this.buffer = '';
          this.cursor = 0;
          resetNavigation();
          this.redraw();
          this.onChange(''); // hides hints
          this.onSubmit(text);
        }
        return true;
      }
      case 'backspace':
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor--;
          this.redraw();
          this.onChange(this.buffer);
        }
        return true;
      case 'delete':
        if (this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
          this.redraw();
          this.onChange(this.buffer);
        }
        return true;
      // ↑/↓ walk prompt history — EXCEPT inside a multi-line buffer, where they move the cursor
      // between lines first. Without that exception, pressing ↑ to fix a typo on the first line of a
      // pasted three-line prompt silently replaces the whole thing with the previous prompt, and the
      // text you were writing is gone. History is only reached from the buffer's first (↑) or last
      // (↓) line, which is exactly how a shell behaves.
      case 'up': {
        if (this.moveCursorLine(-1)) return true;
        const entry = navigateUp(this.buffer);
        if (entry !== null) {
          this.buffer = entry;
          this.cursor = this.buffer.length;
          this.redraw();
          this.onChange(this.buffer);
        }
        return true;
      }
      case 'down': {
        if (this.moveCursorLine(1)) return true;
        const entry = navigateDown();
        if (entry !== null) {
          this.buffer = entry;
          this.cursor = this.buffer.length;
          this.redraw();
          this.onChange(this.buffer);
        }
        return true;
      }
      // A newline on purpose, for anyone who wants one without pasting.
      case 'M-return': case 'M-enter': case 'C-j':
        this.insert('\n');
        return true;
      case 'left':  if (this.cursor > 0) { this.cursor--; this.redraw(); } return true;
      case 'right': if (this.cursor < this.buffer.length) { this.cursor++; this.redraw(); } return true;
      case 'home': case 'C-a': this.cursor = 0; this.redraw(); return true;
      case 'end':  case 'C-e': this.cursor = this.buffer.length; this.redraw(); return true;
      case 'C-u':
        this.buffer = '';
        this.cursor = 0;
        this.redraw();
        this.onChange('');
        return true;
    }

    if (ch && !key.ctrl && !key.meta) {
      this.insert(ch);
      this.lastKeyAt = Date.now();
      return true;
    }
    return false;
  }

  private insert(raw: string): void {
    // Bracketed-paste markers, stripped defensively. blessed does not know the sequence, so
    // depending on the terminal it may surface as ordinary characters — and `[200~` typed into the
    // middle of a prompt is a worse bug than the one this fixes. A no-op when the terminal handles
    // them properly.
    const text = raw.replace(/\x1b?\[20[01]~/g, '');
    if (!text) return;
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.redraw();
    this.onChange(this.buffer);
  }

  redraw(): void {
    if (HEADLESS) return;
    const width = this.textWidth();
    // A large buffer is SUMMARISED rather than shown. Forty pasted lines pushed the chat off the
    // screen to display text the operator already has in their clipboard — and the input box grew
    // until there was nowhere left to read the answer it was about to ask for. The full text is
    // still what gets submitted; only the drawing is compacted.
    const wrapped = wrapLines(compactForDisplay(this.buffer, this.cursor), width);
    const { row: cursorRow, col: cursorCol } = cursorRenderPosition(this.buffer, this.cursor, width);
    const lineCount = Math.max(wrapped.length, cursorRow + 1);
    const wantedHeight = Math.min(MAX_HEIGHT, lineCount + 2); // +2 borders

    if (wantedHeight !== this.getHeight()) {
      this.wrapper.height = wantedHeight;
      this.box.height = wantedHeight - 2;
      relayout(); // hints + chat restack above the new height
    }

    const visibleLines = Math.max(1, wantedHeight - 2);
    const startLine = Math.max(0, cursorRow - visibleLines + 1);
    this.box.setContent(wrapped.slice(startLine, startLine + visibleLines).join('\n'));

    if (this.active) {
      const row = Number(this.wrapper.atop ?? 0) + 1 + (cursorRow - startLine);
      const col = Number(this.wrapper.aleft ?? 0) + 2 + cursorCol;
      screen.program.cup(row, col);
      screen.program.showCursor();
    }
    render();
  }

  private textWidth(): number {
    return Math.max(1, Number(screen.width ?? 80) - 4); // -2 border -1 prompt -1 padding
  }
}

/** Two keystrokes this close together did not come from a human. */
const PASTE_BURST_MS = 12;
/** Past this many lines, the input draws a summary instead of the text. */
const COMPACT_LINES = 8;
/** …or past this many characters, whichever comes first. */
const COMPACT_CHARS = 800;

/**
 * What the input BOX shows for a large buffer. The buffer itself is untouched.
 *
 * Keeps the head and the tail — the head is what was pasted, the tail is where the cursor usually
 * is and what the operator is about to type next. Hiding the middle costs nothing: it is text they
 * still have in their clipboard.
 */
export function compactForDisplay(text: string, cursor: number): string {
  const lines = text.split('\n');
  if (lines.length <= COMPACT_LINES && text.length <= COMPACT_CHARS) return text;

  // While the cursor is in the tail — the normal case, typing after a paste — show the tail whole so
  // editing stays WYSIWYG. A compaction that hides what you are typing is worse than no compaction.
  const head = lines.slice(0, 2);
  const tail = lines.slice(-3);
  const hidden = lines.length - head.length - tail.length;
  if (hidden <= 0) return text;
  const bytes = text.length;
  return [
    ...head,
    `… [+${hidden} line${hidden === 1 ? '' : 's'}, ${bytes} chars — pasted, sent in full]`,
    ...tail,
  ].join('\n');
}

function wrapLines(text: string, width: number): string[] {
  const wrapped: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) { wrapped.push(''); continue; }
    for (let i = 0; i < line.length; i += width) wrapped.push(line.slice(i, i + width));
  }
  return wrapped.length > 0 ? wrapped : [''];
}

function cursorRenderPosition(text: string, cursor: number, width: number): { row: number; col: number } {
  let row = 0;
  let col = 0;
  for (let i = 0; i < cursor; i++) {
    if (text[i] === '\n') { row++; col = 0; continue; }
    col++;
    if (col >= width) { row++; col = 0; }
  }
  return { row, col };
}
