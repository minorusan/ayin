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
      case 'up': {
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
