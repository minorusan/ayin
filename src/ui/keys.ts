/**
 * Key router — the ONE screen keypress listener. Order preserved from the original:
 *   1. C-o / C-s / escape → the app's global handler (works while the agent is busy);
 *      if the input is inactive that's all they do.
 *   2. C-c → shutdown.
 *   3. Input inactive → nothing else.
 *   4. PgUp/PgDn → chat scroll.
 *   5. Everything else → the input widget.
 */

import type blessed from 'blessed';
import { HEADLESS } from './headless.js';
import { screen } from './screen.js';
import type { ChatLog } from './widgets/chat.js';
import type { InputBar } from './widgets/input.js';

export type GlobalKeyHandler = (key: string) => void;

export function installKeyRouter(opts: {
  chat: ChatLog;
  input: InputBar;
  getGlobalHandler: () => GlobalKeyHandler | null;
  shutdown: () => void;
}): void {
  if (HEADLESS) return;

  screen.on('keypress', (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => {
    if (key.full === 'C-o' || key.full === 'C-s' || key.full === 'escape') {
      const handler = opts.getGlobalHandler();
      if (handler) handler(key.full);
      if (!opts.input.isActive()) return;
    }
    if (key.full === 'C-c') { opts.shutdown(); return; }

    if (!opts.input.isActive()) return;

    if (key.full === 'pageup') { opts.chat.scrollHalfPage(-1); return; }
    if (key.full === 'pagedown') { opts.chat.scrollHalfPage(1); return; }

    opts.input.handleKey(ch, key);
  });
}
