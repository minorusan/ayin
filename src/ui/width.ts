/**
 * width.ts — teaching blessed how wide a modern glyph actually is.
 *
 * THE BUG THIS EXISTS FOR, measured on the installed blessed: `unicode.strWidth('\u{1F527}')` returns
 * **1**, and every terminal draws that wrench two cells wide. blessed's double-wide table was written
 * before emoji existed — it covers CJK, Hangul, fullwidth forms and the Yi block, and stops. So blessed
 * lays out a row believing it is one cell narrower than the terminal will paint it, the last cell spills
 * past the right edge, the terminal wraps it onto a line blessed does not know exists, and `smartCSR`
 * then redraws every following row one position off. On screen that reads as the input bar swallowing
 * the thinking line, or text appearing twice.
 *
 * It has happened twice — U+1F512 in the `/lock` segment, U+23F3 in the queue segment — and the answer
 * both times was to ban the glyph (`tool/check-glyphs.mjs`, and `toolGlyph()` at paint time). Banning
 * the glyph treats the symptom: the measurement is what is wrong, and it is wrong for every consumer,
 * not just the two segments someone happened to notice.
 *
 * WHY PATCHING BLESSED IS THE RIGHT LAYER, and not a hack. `element.js` calls `unicode.strWidth(text)`
 * — a property lookup on the required module object, at call time, not a binding destructured at load.
 * Replacing `unicode.charWidth` therefore reaches blessed's own wrapping, alignment, scrolling and
 * cursor maths, which is exactly the set of things that must agree with the terminal. Fixing it only in
 * ayin's own string handling would leave blessed still measuring wrongly underneath.
 *
 * WHAT IS DELIBERATELY NOT CHANGED. Only the answer for code points blessed gets wrong is replaced; for
 * everything else the original function is called. A width table is the kind of thing that is very easy
 * to make worse, and CJK — the part blessed already handles — is the part with the most users.
 */

import blessed from 'blessed';

/**
 * Two cells: a pictograph that defaults to emoji presentation. `Emoji_Presentation` is the property
 * that means "renders as a colour emoji with no coaxing", which is precisely the set terminals draw
 * double-width. `\p{Emoji}` would be wrong — it includes `#`, `*` and the digits.
 */
const EMOJI_WIDE = /\p{Emoji_Presentation}/u;

/** A pictograph that is text by default and becomes emoji when followed by VS16. */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

const VS16 = 0xfe0f;
const VS15 = 0xfe0e;
const ZWJ = 0x200d;

/**
 * `@types/blessed` does not declare `unicode`, but the runtime module exports it and `element.js`
 * calls through it — which is the whole reason this patch reaches blessed's internals. Typed here
 * once, narrowly, rather than casting at each use.
 */
interface BlessedUnicode {
  charWidth: (str: string | number, i?: number) => number;
  codePointAt: (str: string, i: number) => number;
  strWidth: (str: string) => number;
}
const unicode = (blessed as unknown as { unicode: BlessedUnicode }).unicode;

/**
 * The width of one code point at `i`, as a terminal will paint it.
 *
 * `next` is the FOLLOWING code point, because a variation selector changes the width of the character
 * before it: `⚙` is one cell, `⚙️` is two, and the selector itself occupies none.
 */
export function codePointWidth(point: number, next?: number): number {
  if (point === VS16 || point === VS15 || point === ZWJ) return 0;
  const ch = String.fromCodePoint(point);
  // VS16 promotes a text-default pictograph to emoji presentation, and therefore to two cells.
  if (next === VS16 && PICTOGRAPHIC.test(ch)) return 2;
  // VS15 forces text presentation on an emoji-default pictograph — one cell.
  if (next === VS15) return 1;
  if (EMOJI_WIDE.test(ch)) return 2;
  return -1; // "no opinion" — let blessed answer
}

/** True display width of a string, counting what the terminal paints. Used by the gates and by wrapping. */
export function displayWidth(str: string): number {
  const cps = [...str].map((c) => c.codePointAt(0) as number);
  let w = 0;
  for (let i = 0; i < cps.length; i++) {
    const own = codePointWidth(cps[i], cps[i + 1]);
    w += own >= 0 ? own : unicode.charWidth(cps[i]);
  }
  return w;
}

let installed = false;

/**
 * Replace `unicode.charWidth` with one that knows about emoji. Idempotent, and safe to call before a
 * screen exists — it touches the unicode module, not the screen.
 *
 * MUST run before the first render. `screen.ts` calls it at module scope, above the `blessed.screen()`
 * that is the first thing to measure anything.
 */
export function installWidthPatch(): void {
  if (installed) return;
  installed = true;
  const original = unicode.charWidth.bind(unicode);
  unicode.charWidth = function patchedCharWidth(str: string | number, i?: number): number {
    const point = typeof str === 'number' ? str : unicode.codePointAt(str, i ?? 0);
    // The NEXT code point decides whether a variation selector is about to change this one's width.
    // Only available when we were handed the string; a bare code point has no follower to inspect.
    let next: number | undefined;
    if (typeof str !== 'number') {
      const at = i ?? 0;
      const step = point > 0xffff ? 2 : 1;
      if (at + step < str.length) next = unicode.codePointAt(str, at + step);
    }
    const own = codePointWidth(point, next);
    return own >= 0 ? own : original(str, i);
  };
}
