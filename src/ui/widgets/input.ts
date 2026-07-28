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
      case 'return': case 'enter': {
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
      this.buffer = this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor);
      this.cursor++;
      this.redraw();
      this.onChange(this.buffer);
      return true;
    }
    return false;
  }

  redraw(): void {
    if (HEADLESS) return;
    const width = this.textWidth();
    const wrapped = wrapLines(this.buffer, width);
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
