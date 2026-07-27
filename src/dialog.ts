/**
 * Dialog — the ONE popup overlay: a question, an optional subtitle, and a list of selectable
 * answers. Used by the tool-permission prompt (permissions.ts) and the model picker
 * (model-picker.ts) so both look and behave identically.
 *
 * ↑/↓ (or k/j) move, Enter picks, Esc cancels (-1), a hotkey picks directly. The input bar is
 * blurred while the popup is up, so keystrokes go to the dialog and never leak into the prompt.
 * Long lists scroll: only a window of rows is drawn, so a 40-model catalog can't outgrow the
 * terminal.
 *
 * API:
 *   const choice = await showDialog('Allow bash?', ['Allow once', 'Allow all bash', 'Deny']);
 *   // choice === 0 | 1 | 2 | -1
 */

import blessed from 'blessed';
import { screen, focusInput, blurInput } from './ui.js';
import { theme } from './ui/theme.js';

export interface DialogOption {
  label: string;
  key?: string;   // optional hotkey, e.g. 'a' for Allow
  note?: string;  // dim right-hand detail, e.g. "30B · Q4_K_M · active"
}

export interface DialogOpts {
  /** Dim line under the question — context that isn't a choice (active model, GPU, source url). */
  subtitle?: string;
  /** Pre-selected row. */
  selected?: number;
  /** Dim footer hint; defaults to the key legend. */
  footer?: string;
}

const MAX_ROWS = 12; // beyond this the list scrolls rather than growing off-screen

export function showDialog(
  question: string,
  options: DialogOption[],
  opts: DialogOpts = {},
): Promise<number> {
  return new Promise((resolve) => {
    let selected = Math.min(Math.max(opts.selected ?? 0, 0), Math.max(options.length - 1, 0));
    let top = Math.max(0, Math.min(selected - Math.floor(MAX_ROWS / 2), options.length - MAX_ROWS));
    if (top < 0) top = 0;
    let resolved = false;

    const rows = Math.min(options.length, MAX_ROWS);
    const footer = opts.footer ?? '↑↓ select · Enter confirm · Esc cancel';
    // question + optional subtitle + blank + rows + blank + footer + border(2)
    const height = rows + 5 + (opts.subtitle ? 1 : 0);
    const width = Math.min(
      Math.max(
        question.length + 6,
        footer.length + 6,
        (opts.subtitle?.length ?? 0) + 6,
        ...options.map(o => o.label.length + (o.note ? o.note.length + 4 : 0) + 8),
      ),
      Math.floor((screen.width as number) * 0.8),
    );

    const box = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width,
      height,
      border: { type: 'line' },
      tags: true,
      style: {
        fg: theme.text,
        bg: theme.panelBg,
        border: { fg: theme.accent },
      },
      padding: { left: 1, right: 1 },
    });

    function render(): void {
      // Keep the selection inside the visible window.
      if (selected < top) top = selected;
      if (selected >= top + rows) top = selected - rows + 1;

      const lines: string[] = [];
      lines.push(`{bold}${question}{/bold}`);
      if (opts.subtitle) lines.push(`{${theme.muted}-fg}${opts.subtitle}{/}`);
      lines.push('');
      for (let i = top; i < top + rows; i++) {
        const opt = options[i];
        if (!opt) break;
        const prefix = i === selected ? `{${theme.accent}-fg}▸{/}` : ' ';
        const highlight = i === selected ? '{bold}' : `{${theme.subtle}-fg}`;
        const hotkey = opt.key ? `{${theme.faint}-fg}[${opt.key}]{/} ` : '';
        const note = opt.note ? `  {${theme.faint}-fg}${opt.note}{/}` : '';
        lines.push(`${prefix} ${hotkey}${highlight}${opt.label}{/}${note}`);
      }
      lines.push('');
      const more = options.length > rows ? `  {${theme.faint}-fg}${selected + 1}/${options.length}{/}` : '';
      lines.push(`{${theme.faint}-fg}${footer}{/}${more}`);
      box.setContent(lines.join('\n'));
      screen.render();
    }

    function cleanup(result: number): void {
      if (resolved) return;
      resolved = true;
      screen.removeListener('keypress', onKey);
      box.destroy();
      focusInput();
      screen.render();
      resolve(result);
    }

    function onKey(ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg): void {
      if (key.full === 'up' || key.full === 'k') {
        selected = (selected - 1 + options.length) % options.length;
        render();
        return;
      }
      if (key.full === 'down' || key.full === 'j') {
        selected = (selected + 1) % options.length;
        render();
        return;
      }
      if (key.full === 'return' || key.full === 'enter') {
        cleanup(selected);
        return;
      }
      if (key.full === 'escape') {
        cleanup(-1);
        return;
      }
      // Hotkey matching
      if (ch) {
        const idx = options.findIndex(o => o.key === ch);
        if (idx >= 0) {
          cleanup(idx);
          return;
        }
      }
    }

    blurInput(); // the popup owns the keyboard while it is up
    screen.on('keypress', onKey);
    render();
  });
}
