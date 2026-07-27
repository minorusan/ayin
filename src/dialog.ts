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
  danger?: boolean; // renders red — for Deny / destructive choices
}

export interface DialogOpts {
  /** Dim line under the question — context that isn't a choice (active model, GPU, source url). */
  subtitle?: string;
  /**
   * The THING being decided about — a path, a shell command, a URL. Shown in full, wrapped over as
   * many lines as it needs, in the accent colour. Never truncate a path into "/Users/…/clea…": the
   * whole point of the prompt is knowing WHAT you are approving.
   */
  target?: string;
  /** Why the agent wants it — wrapped, dim, and the first thing dropped if the screen is short. */
  body?: string;
  /** Pre-selected row. */
  selected?: number;
  /** Dim footer hint; defaults to the key legend. */
  footer?: string;
}

const MAX_ROWS = 12; // beyond this the list scrolls rather than growing off-screen
const MIN_WIDTH = 56;
const MAX_WIDTH = 100;

/**
 * Wrap PLAIN text to `width`, honouring existing newlines and hard-breaking tokens that can't fit
 * (long paths, URLs, base64). Wrapping happens before any colour tags are added — wrapping tagged
 * text would split `{#abc-fg}` mid-tag and corrupt the whole stream.
 */
export function wrapPlain(text: string, width: number): string[] {
  // A width of 0 or less would make the hard-break loop below slice nothing and never advance —
  // an infinite loop that pushes until the array blows up. Reachable for real: a screen whose
  // width blessed reports as 0/undefined, or a terminal narrower than the borders.
  const w0 = Math.max(8, Math.floor(width) || 8);
  if (w0 !== width) width = w0;
  const out: string[] = [];
  for (const para of text.replace(/\t/g, '  ').split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      let w = word;
      // A single token longer than the width gets chopped — a 120-char path must not blow the box.
      while (w.length > width) {
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ` ${w}`;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out;
}

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

    // ── width: wide enough for the content, never wider than the screen ──
    // blessed can report 0/undefined for a screen it hasn't measured; fall back to a sane 80x24 so
    // the geometry below can never go negative.
    const screenW = Number(screen.width) > 20 ? Number(screen.width) : 80;
    const screenH = Number(screen.height) > 6 ? Number(screen.height) : 24;
    const longestOption = Math.max(0, ...options.map((o) => o.label.length + (o.note ? o.note.length + 4 : 0)));
    const want = Math.max(question.length, footer.length, opts.subtitle?.length ?? 0, longestOption) + 8;
    const width = Math.max(Math.min(MIN_WIDTH, screenW - 4), Math.min(want, MAX_WIDTH, screenW - 4));
    const inner = width - 4; // borders + one space of padding each side

    // ── wrap the prose parts to that width ──
    const qLines = wrapPlain(question, inner);
    const subLines = opts.subtitle ? wrapPlain(opts.subtitle, inner) : [];
    const targetLines = opts.target ? wrapPlain(opts.target, inner) : [];
    let bodyLines = opts.body ? wrapPlain(opts.body, inner) : [];

    // Height must fit the terminal. The reason (body) is the least critical text, so it is what
    // gets cut — the question, the target and the choices always stay whole and reachable.
    const fixed = qLines.length + subLines.length + targetLines.length + rows + 4; // + blanks/footer/border
    const roomForBody = Math.max(0, (screenH - 4) - fixed);
    let bodyTruncated = false;
    if (bodyLines.length > roomForBody) {
      bodyLines = bodyLines.slice(0, Math.max(0, roomForBody - 1));
      bodyTruncated = true;
    }
    const height = Math.min(
      fixed + bodyLines.length + (bodyTruncated ? 1 : 0) + (targetLines.length ? 1 : 0),
      screenH - 2,
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

      // The question: what kind of decision this is (bold, plain white).
      for (const l of qLines) lines.push(`{bold}${l}{/bold}`);
      // Subtitle: quiet context.
      for (const l of subLines) lines.push(`{${theme.muted}-fg}${l}{/}`);
      // The target: what is actually being acted on — accent, in full, wrapped.
      if (targetLines.length) {
        lines.push('');
        for (const l of targetLines) lines.push(`{${theme.accent}-fg}${l}{/}`);
      }
      // The reason: dim, wrapped, cut before anything important is.
      if (bodyLines.length) {
        lines.push('');
        for (const l of bodyLines) lines.push(`{${theme.muted}-fg}${l}{/}`);
        if (bodyTruncated) lines.push(`{${theme.faint}-fg}…{/}`);
      }

      lines.push('');
      for (let i = top; i < top + rows; i++) {
        const opt = options[i];
        if (!opt) break;
        const sel = i === selected;
        const prefix = sel ? `{${theme.accent}-fg}▸{/}` : ' ';
        // A hotkey chip that reads as a key, and stays legible on the selected row.
        const hotkey = opt.key ? `{${sel ? theme.accentBright : theme.faint}-fg}[${opt.key}]{/} ` : '    ';
        const labelColor = opt.danger ? theme.err : sel ? theme.text : theme.subtle;
        const label = sel ? `{bold}{${labelColor}-fg}${opt.label}{/}{/bold}` : `{${labelColor}-fg}${opt.label}{/}`;
        const note = opt.note ? `  {${theme.faint}-fg}${opt.note}{/}` : '';
        lines.push(`${prefix} ${hotkey}${label}${note}`);
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
