/**
 * Screen — the one blessed screen (noop in headless).
 *
 * COPY-PASTE CONTRACT: the terminal's own text selection wins. Mouse tracking is OFF by default.
 *
 * This has been decided twice. The original rule was absolute — never enable tracking, because it
 * hijacks native selection and copying transcript text matters more than a scroll wheel. It was then
 * amended on the theory that Shift+drag is a universal bypass, so the wheel could be had for free. It
 * is not universal enough: an operator on macOS could not select anything in ayin at all, and getting a
 * stack trace out of the tool matters more than scrolling with a wheel. The original rule stands.
 *
 *   · Default: no tracking. Select and copy exactly as in any other program.
 *   · `AYIN_MOUSE=1`, or `/set mouse on`, enables WHEEL EVENTS ONLY (`keys.ts#installMouseRouter`).
 *     Nothing is clickable, focusable or draggable; no widget sets `mouse: true`.
 *   · Keyboard scrolling always works: PgUp/PgDn, Shift+↑/↓. Plain ↑/↓ stay prompt history.
 */

import blessed from 'blessed';
import { HEADLESS, noopScreen } from './headless.js';
import { installWidthPatch } from './width.js';

/**
 * BEFORE THE SCREEN EXISTS, because the screen is the first thing to measure anything.
 *
 * blessed's own width table predates emoji and answers 1 for a glyph the terminal paints in 2 cells —
 * see `width.ts` for what that costs. Installed here rather than in `index.ts` so that any entry point
 * reaching a screen has already been through it; it is idempotent and touches only the unicode module,
 * so running it in headless too is free and keeps the two paths measuring identically.
 */
installWidthPatch();

export const screen: blessed.Widgets.Screen = HEADLESS
  ? noopScreen
  : blessed.screen({ smartCSR: true, title: 'ayin', fullUnicode: true });

/**
 * BRACKETED PASTE. Tells the terminal that this program handles a paste itself.
 *
 * Two things follow. The terminal stops warning ("are you sure you want to paste 3 lines?") — that
 * warning exists precisely because a program that has NOT said this will treat the newlines as
 * Enter, which is exactly what ayin used to do. And the paste arrives wrapped in markers, so it is
 * distinguishable from typing.
 *
 * Enabled unconditionally rather than behind a setting: a program that cannot take a multi-line
 * paste is not a program anyone wants to configure, and the markers are stripped defensively at the
 * input either way, so the worst case of a terminal that ignores this is no change at all.
 */
if (!HEADLESS) {
  try {
    process.stdout.write('\x1b[?2004h');
    const off = (): void => { try { process.stdout.write('\x1b[?2004l'); } catch { /* terminal gone */ } };
    // On every way out, including the ones nobody plans for: leaving the mode set would have the
    // NEXT program in that terminal receive paste markers it does not understand.
    process.on('exit', off);
    process.on('SIGINT', off);
    process.on('SIGTERM', off);
  } catch { /* a terminal that refuses the sequence is not worth an exception */ }
}

export function render(): void {
  screen.render();
}
