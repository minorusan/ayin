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
    // Shift+↑/↓ scroll the transcript a line at a time (plain ↑/↓ stay prompt-history). Scrolling up
    // disengages follow-the-bottom; scroll back to the bottom (or Shift+↓ past it) to resume.
    if (key.full === 'S-up') { opts.chat.scrollLine(-1); return; }
    if (key.full === 'S-down') { opts.chat.scrollLine(1); return; }

    opts.input.handleKey(ch, key);
  });

  installMouseRouter(opts.chat, opts.input);
}

/** Lines per wheel notch — the conventional three, so a flick moves a readable amount. */
const WHEEL_LINES = 3;

/**
 * Wheel scrolling — the ONLY mouse handling in ayin.
 *
 * See the amended copy-paste contract in `screen.ts`: tracking is enabled, but nothing is clickable
 * or draggable and only `wheelup`/`wheeldown` are consumed, so a click behaves exactly as your
 * terminal would behave without ayin. **Shift+drag still selects text natively** in every terminal
 * that implements the standard bypass, which is how copy-paste survives. `AYIN_MOUSE=0` restores the
 * old keyboard-only behaviour for a terminal where it does not.
 */
function installMouseRouter(chat: ChatLog, input: InputBar): void {
  if (process.env.AYIN_MOUSE === '0') return;
  try {
    // NARROW ON PURPOSE. `enableMouse()` turns on 1000 + 1002 (cell motion) + 1003 (ALL motion), so
    // every pixel of mouse movement becomes an event blessed has to parse and dispatch — for a feature
    // that only needs the wheel — and the motion grab is what fights text selection hardest. Asking
    // for `vt200Mouse` (1000: button press/release, which is where wheel buttons 64/65 arrive) plus
    // `sgrMouse` (1006: the modern encoding, correct past column 223) gets the wheel and nothing else.
    // Verified by the escape codes on the wire: `[?1000h[?1006h`, no 1002, no 1003.
    //
    // And we listen on the PROGRAM, not the screen. `screen.on('mouse', …)` is not a passive
    // subscription: blessed's Screen intercepts that registration and calls `_listenMouse()` →
    // `program.enableMouse()`, re-enabling everything we just declined. The program binds its own
    // mouse parser on its first `mouse` listener (`newListener` → `bindMouse`), so subscribing there
    // gives the same parsed events with only the modes we asked for.
    const program = (screen as unknown as {
      program?: {
        setMouse?: (opts: Record<string, boolean>, enable: boolean) => void;
        enableMouse?: () => void;
        on?: (ev: string, fn: (data: { action?: string }) => void) => void;
      };
    }).program;
    if (!program?.on) return; // no program (headless/noop screen) — nothing to bind

    if (typeof program.setMouse === 'function') program.setMouse({ vt200Mouse: true, sgrMouse: true }, true);
    else if (typeof program.enableMouse === 'function') program.enableMouse();

    program.on('mouse', (data: { action?: string }) => {
      if (!input.isActive()) return;
      if (data?.action === 'wheelup') chat.scrollLine(-1, WHEEL_LINES);
      else if (data?.action === 'wheeldown') chat.scrollLine(1, WHEEL_LINES);
    });
  } catch { /* no mouse reporting here — keyboard scrolling is unaffected */ }
}
