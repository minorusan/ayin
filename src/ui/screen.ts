/**
 * Screen — the one blessed screen (noop in headless).
 *
 * COPY-PASTE CONTRACT, as amended. The old rule was absolute: **never** enable mouse tracking,
 * because it hijacks the terminal's native text selection and copying transcript text matters more
 * than scrolling with a wheel. The rule was right about the tradeoff and wrong that the tradeoff is
 * total — every terminal worth using (xterm, gnome-terminal, kitty, iTerm2, Windows Terminal, tmux)
 * lets **Shift+drag** bypass an application's mouse reporting and select natively. So the wheel is
 * now enabled, in exactly one place (`keys.ts#installMouseRouter`), under two conditions that keep
 * the spirit of the contract:
 *
 *   1. WHEEL EVENTS ONLY. Nothing here is clickable, focusable or draggable; no widget sets
 *      `mouse: true`. A click still does whatever your terminal would do with it.
 *   2. IT IS SWITCHABLE. `AYIN_MOUSE=0` restores the keyboard-only behaviour exactly, for a terminal
 *      where Shift+drag does not work.
 *
 * Keyboard scrolling stays (PgUp/PgDn, Shift+↑/↓) — the wheel is an addition, not a replacement, and
 * plain ↑/↓ remain prompt history.
 */

import blessed from 'blessed';
import { HEADLESS, noopScreen } from './headless.js';

export const screen: blessed.Widgets.Screen = HEADLESS
  ? noopScreen
  : blessed.screen({ smartCSR: true, title: 'ayin', fullUnicode: true });

export function render(): void {
  screen.render();
}
