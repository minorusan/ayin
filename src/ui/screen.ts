/**
 * Screen — the one blessed screen (noop in headless).
 *
 * COPY-PASTE CONTRACT: no widget may ever enable blessed mouse tracking (`mouse: true`,
 * `screen.enableMouse()`, `clickable`/`draggable`). Mouse tracking hijacks the terminal's
 * native text selection, which is what makes chat text copy-pastable. Scrolling is keyboard
 * (PgUp/PgDn) by design.
 */

import blessed from 'blessed';
import { HEADLESS, noopScreen } from './headless.js';

export const screen: blessed.Widgets.Screen = HEADLESS
  ? noopScreen
  : blessed.screen({ smartCSR: true, title: 'ayin', fullUnicode: true });

export function render(): void {
  screen.render();
}
