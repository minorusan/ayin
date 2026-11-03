/**
 * Key router — the ONE screen keypress listener. Order preserved from the original:
 *   1. C-b / C-f / C-o / C-s / escape → the app's global handler (works while the agent is busy);
 *      if the input is inactive that's all they do.
 *      C-b is in that set for the same reason Escape is: it exists ONLY for the moment the agent has
 *      the terminal and you want it back. A background key that needed an idle prompt would be
 *      unreachable exactly when it is the thing you are reaching for. C-f joins them because a card
 *      is most worth folding while it is being painted at you.
 *   2. C-c → shutdown.
 *   3. Input inactive → nothing else.
 *   4. PgUp/PgDn → chat scroll.
 *   5. Everything else → the input widget.
 */

import type blessed from 'blessed';
import { HEADLESS } from './headless.js';
import { screen } from './screen.js';
import { getConfigString } from '../prompts.js';
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

  const wheel = installWheelAsArrows();

  screen.on('keypress', (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => {
    // The wheel, arriving as arrow keys — scrolls the transcript, never the prompt history.
    if ((key.full === 'up' || key.full === 'down') && wheel.take(key.full)) {
      // An open overlay (input blurred) scrolls itself on ↑/↓ in app.ts; the transcript stays put.
      if (opts.input.isActive()) opts.chat.scrollLine(key.full === 'up' ? -1 : 1);
      return;
    }
    if (key.full === 'C-b' || key.full === 'C-f' || key.full === 'C-o' || key.full === 'C-s' || key.full === 'escape') {
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

    // TYPING IS THE WAY BACK DOWN. Reading history and then starting to type is unambiguous: the
    // attention is on the prompt, so the prompt is what must be on screen. Nothing else re-engages
    // follow on its own — that is the whole point of the lock — so without this the only exit from a
    // scrolled-up view is scrolling all the way back down (Shift+↓ / PgDn; `end` is the input
    // cursor, not the transcript), and a user who scrolled up to read and then answered would be
    // typing into a prompt they could not see.
    //
    // A PRINTABLE character only. Control and meta combos are commands, arrows are history, and
    // Enter is about to redraw at the bottom anyway; snapping on those would drag the view around
    // while the user is still navigating.
    if (isPrintable(ch, key) && opts.chat.isScrolledUp()) opts.chat.scrollToBottom();

    opts.input.handleKey(ch, key);
  });

  installMouseRouter(opts.chat, opts.input);
}

/**
 * One character the user actually typed, as opposed to a key they pressed.
 *
 * `ch` is present for control keys too (Enter carries \r, Backspace \x7f), so a length check alone
 * would snap the view on navigation. Anything below 0x20, DEL, and any ctrl/meta combo are out.
 */
function isPrintable(ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg): boolean {
  if (!ch || ch.length !== 1 || key.ctrl || key.meta) return false;
  const code = ch.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

/**
 * THE WHEEL WITH MOUSE TRACKING OFF — which is the default, see `installMouseRouter`.
 *
 * Most terminals in "alternate scroll" mode (xterm 1007, on by default in GNOME Terminal, iTerm2,
 * Terminal.app, Windows Terminal) turn each wheel notch into ↑/↓ key presses while a full-screen app is
 * up. ayin bound plain ↑/↓ to prompt history, so scrolling back through the transcript cycled the
 * prompt instead — reported: "I cannot scroll up by any means. Up arrow circles prompt."
 *
 * A notch is SEVERAL arrows in ONE input chunk (three, typically); a held or tapped key is one arrow per
 * chunk, because the terminal writes each key press as it happens. So a chunk made only of two or more
 * identical arrow sequences is the wheel, and its arrows are consumed as scrolling. One arrow in a chunk
 * is always a key. The listener is PREPENDED so it classifies the chunk before blessed turns it into
 * key presses. One line per arrow, so a notch moves the conventional three.
 */
/** One input chunk → a wheel burst of n arrows, or null when it is a key (or anything else). */
export function wheelBurst(chunk: string): { dir: 'up' | 'down'; n: number } | null {
  if (!/^(\x1b[[O][AB])+$/.test(chunk)) return null;
  const seq = chunk.slice(0, 3);
  const n = chunk.length / 3;
  if (n < 2 || chunk !== seq.repeat(n)) return null;
  return { dir: seq.endsWith('A') ? 'up' : 'down', n };
}

function installWheelAsArrows(): { take: (dir: 'up' | 'down') => boolean } {
  let pending: { dir: 'up' | 'down'; n: number } | null = null;
  const input = (screen.program as unknown as { input?: NodeJS.ReadableStream }).input;
  input?.prependListener('data', (chunk: Buffer | string) => {
    pending = wheelBurst(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  return {
    take(dir) {
      if (!pending || pending.dir !== dir) return false;
      if (--pending.n <= 0) pending = null;
      return true;
    },
  };
}

/** Lines per wheel notch — the conventional three, so a flick moves a readable amount. */
const WHEEL_LINES = 3;

/**
 * Wheel scrolling — the ONLY mouse handling in ayin.
 *
 * OPT-IN. See the copy-paste contract in `screen.ts`: the terminal's native selection wins by default,
 * so tracking is off unless `AYIN_MOUSE=1` / `/set mouse on`. When it IS on, nothing is clickable or
 * draggable and only `wheelup`/`wheeldown` are consumed, so a click behaves exactly as your terminal
 * would without ayin, and Shift+drag selects natively in terminals that implement the bypass.
 */
function installMouseRouter(chat: ChatLog, input: InputBar): void {
  /**
   * OFF BY DEFAULT, and that is a reversal.
   *
   * Wheel scrolling was made the default on the theory that Shift+drag is a universal bypass, so nothing
   * was really lost. It is not universal enough: an operator on macOS reported, plainly, that they could
   * not select anything in ayin's terminal — and selecting transcript text is not a nicety, it is how you
   * get a stack trace out of the tool and into a bug report or a chat.
   *
   * So the older rule stands after all: the terminal's own selection wins, because losing it costs more
   * than a wheel gains. `AYIN_MOUSE=1` (or `/set mouse on`) opts in for anyone who prefers the trade —
   * and PgUp/PgDn and Shift+↑/↓ scroll without any of this.
   */
  const wanted = (process.env.AYIN_MOUSE ?? getConfigString('mouse') ?? '').trim().toLowerCase();
  const on = wanted === '1' || wanted === 'on' || wanted === 'true';
  if (!on) return;
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
