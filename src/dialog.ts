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
import { renderMarkdownWrapped } from './markdown.js';

export interface DialogOption {
  label: string;
  key?: string;   // optional hotkey, e.g. 'a' for Allow
  note?: string;  // dim right-hand detail, e.g. "30B · Q4_K_M · active"
  danger?: boolean; // renders red — for Deny / destructive choices
  /** A dim SECOND line under the label, for rows that carry metadata worth reading (a session's
   *  turns / tools / context size). Doubles the row height, so the visible window halves. */
  sub?: string;
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

/** Single-line plain truncate with an ellipsis — for metadata that must not wrap. */
function truncPlain(s: string, width: number): string {
  const w = Math.max(8, width);
  return s.length > w ? `${s.slice(0, w - 1)}…` : s;
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

    // A `sub` line doubles an option's height, so the visible window halves.
    const perRow = options.some((o) => o.sub) ? 2 : 1;
    const rows = Math.min(options.length, Math.max(1, Math.floor(MAX_ROWS / perRow)));
    const footer = opts.footer ?? '↑↓ select · Enter confirm · Esc cancel';

    // ── width: wide enough for the content, never wider than the screen ──
    // blessed can report 0/undefined for a screen it hasn't measured; fall back to a sane 80x24 so
    // the geometry below can never go negative.
    const screenW = Number(screen.width) > 20 ? Number(screen.width) : 80;
    const screenH = Number(screen.height) > 6 ? Number(screen.height) : 24;
    const longestOption = Math.max(
      0,
      ...options.map((o) => o.label.length + (o.note ? o.note.length + 4 : 0)),
      ...options.map((o) => (o.sub ? o.sub.length + 6 : 0)),
    );
    const want = Math.max(question.length, footer.length, opts.subtitle?.length ?? 0, longestOption) + 8;
    const width = Math.max(Math.min(MIN_WIDTH, screenW - 4), Math.min(want, MAX_WIDTH, screenW - 4));
    const inner = width - 4; // borders + one space of padding each side

    // ── wrap the prose parts to that width ──
    const qLines = wrapPlain(question, inner);
    const subLines = opts.subtitle ? wrapPlain(opts.subtitle, inner) : [];
    const targetLines = opts.target ? wrapPlain(opts.target, inner) : [];
    // The body is the agent's own prose ("why it wants this") and routinely carries full markdown —
    // headings, bold, bullets. renderMarkdownWrapped wraps FIRST (plain text, tag-safe) then styles
    // each already-wrapped line, so `**not this literally**` renders instead of showing raw asterisks.
    let bodyLines = opts.body ? renderMarkdownWrapped(opts.body, inner, wrapPlain) : [];

    // Height must fit the terminal. The reason (body) is the least critical text, so it is what
    // gets cut — the question, the target and the choices always stay whole and reachable.
    const fixed = qLines.length + subLines.length + targetLines.length + rows * perRow + 4; // + blanks/footer/border
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
        // The metadata line: indented under the label, dim, and brighter on the selected row so the
        // selection reads as one two-line block rather than two unrelated rows.
        if (opt.sub) lines.push(`     {${sel ? theme.muted : theme.faint}-fg}${truncPlain(opt.sub, inner - 6)}{/}`);
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

    // Set just before subscribing; consulted by onKey so a queued Enter cannot confirm instantly.
    let guardConfirm: () => boolean = () => false;

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
        if (guardConfirm()) return; // the keystroke that opened this dialog — not an answer to it
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

    /**
     * THE KEYSTROKE THAT OPENED THE DIALOG MUST NOT ALSO ANSWER IT.
     *
     * A dialog opened from a slash command is created inside the input widget's submit handler, and the
     * Enter that submitted the line is delivered to the SCREEN immediately afterwards. Subscribe
     * synchronously and that Enter lands on `onKey`, which confirms the pre-selected row and destroys the
     * box before a single frame is painted: the operator sees no popup at all and gets whatever row 0
     * happened to be. Reported as "`/model` does nothing and then lies about the provider".
     *
     * Older callers escaped it by accident — they awaited network calls (a catalogue fetch) before
     * opening, which drained the pending key event first. Anything synchronous hit it every time, which
     * is why this belongs here rather than in each caller.
     *
     * Two layers, because either alone is thin: subscribe on the next macrotask so the pending keypress is
     * delivered first, and ignore a confirm for a moment after opening in case one is queued behind it.
     * Navigation and Escape stay live immediately — only ACCEPTING is deferred.
     */
    const openedAt = Date.now();
    const CONFIRM_GRACE_MS = 150;
    guardConfirm = () => Date.now() - openedAt < CONFIRM_GRACE_MS;

    blurInput(); // the popup owns the keyboard while it is up
    render();    // paint FIRST, so the box is on screen before any key can dismiss it
    setTimeout(() => {
      if (resolved) return;
      screen.on('keypress', onKey);
    }, 0);
  });
}
