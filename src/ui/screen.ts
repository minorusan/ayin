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

export const screen: blessed.Widgets.Screen = HEADLESS
  ? noopScreen
  : blessed.screen({ smartCSR: true, title: 'ayin', fullUnicode: true });

export function render(): void {
  screen.render();
}
