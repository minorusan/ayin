/**
 * Dialog — generic question + answers overlay.
 *
 * Shows a question with selectable answers. User picks with arrow keys + Enter.
 * Returns the selected answer index, or -1 if cancelled (Esc).
 *
 * API:
 *   const choice = await showDialog('Allow bash?', ['Allow once', 'Allow all bash', 'Deny']);
 *   // choice === 0 | 1 | 2 | -1
 */

import blessed from 'blessed';
import { screen } from './ui.js';

export interface DialogOption {
  label: string;
  key?: string;  // optional hotkey, e.g. 'a' for Allow
}

export function showDialog(
  question: string,
  options: DialogOption[],
): Promise<number> {
  return new Promise((resolve) => {
    let selected = 0;
    let resolved = false;

    const height = options.length + 4; // question + options + padding + border
    const width = Math.min(
      Math.max(question.length + 6, ...options.map(o => o.label.length + 8)),
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
        fg: 'white',
        bg: '#1a1a1a',
        border: { fg: '#7B8CDE' },
      },
      padding: { left: 1, right: 1 },
    });

    function render(): void {
      const lines: string[] = [];
      lines.push(`{bold}${question}{/bold}`);
      lines.push('');
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const prefix = i === selected ? '{#7B8CDE-fg}▸{/}' : ' ';
        const highlight = i === selected ? '{bold}' : '{#888-fg}';
        const hotkey = opt.key ? `{#555-fg}[${opt.key}]{/} ` : '';
        lines.push(`${prefix} ${hotkey}${highlight}${opt.label}{/}`);
      }
      box.setContent(lines.join('\n'));
      screen.render();
    }

    function cleanup(result: number): void {
      if (resolved) return;
      resolved = true;
      screen.removeListener('keypress', onKey);
      box.destroy();
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

    screen.on('keypress', onKey);
    render();
  });
}
