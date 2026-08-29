#!/usr/bin/env node
/**
 * Guard: no double-width glyphs in the TUI.
 *
 * blessed reports `strWidth` 1 for an emoji while terminals draw it 2 cells wide, so a single emoji
 * in the one-row status bar overflows it, wraps, and smartCSR then re-emits shifted rows — on screen
 * the input bar appears to swallow the thinking line and text looks duplicated. That has now
 * happened twice (U+1F512 for /lock, U+23F3 for the queue segment); this check is why it should not
 * happen a third time.
 *
 * Rule: in UI source every non-ASCII character must be BMP (not a surrogate pair) and must NOT have
 * Emoji_Presentation. Safe examples: U+26BF, U+29D7, U+2691, U+2B22, U+21C6, U+25CF.
 * Wired as `prebuild`, so a bad glyph fails the build instead of the layout.
 *
 * AND `Tool.icon`, WHICH IS PAINTED BY THE UI BUT DECLARED OUTSIDE IT. Every tool card leads with its
 * tool's glyph, and those live in `src/tools/defs/*.ts` — a directory this gate did not look at, so the
 * whole rule was one `icon: '\u{1F527}'` away from being bypassed by someone who never read it. Only
 * the icon VALUE is checked there: a tool's description is prose for the model, never painted, and has
 * no business being width-constrained.
 */
import { readFileSync, readdirSync } from 'node:fs';

const FILES = [
  'src/ui/widgets/status.ts', 'src/ui/widgets/chat.ts', 'src/ui/widgets/thinking.ts',
  'src/ui/widgets/input.ts', 'src/ui/widgets/hints.ts', 'src/dialog.ts',
];

/** `icon: '…'` (object literal) or `readonly icon = '…'` (class). */
const ICON = /\bicon\s*(?::|=)\s*(['"`])(.*?)\1/g;

let bad = 0;

let defs = [];
try { defs = readdirSync('src/tools/defs').filter((f) => f.endsWith('.ts')); } catch {}
for (const name of defs) {
  const file = `src/tools/defs/${name}`;
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(ICON)) {
      const icon = m[2];
      // ONE CELL, so also one code point: a flag, a skin tone or a ZWJ sequence is several.
      if ([...icon].length !== 1) {
        console.error(`${file}:${i + 1}  icon ${JSON.stringify(icon)} is ${[...icon].length} code points — an icon is ONE cell`);
        bad++;
        continue;
      }
      const wide = /\p{Emoji_Presentation}/u.test(icon) || icon.length > 1;
      if (wide) {
        console.error(`${file}:${i + 1}  double-width icon U+${icon.codePointAt(0).toString(16).toUpperCase()} — terminals draw it 2 cells, ayin wraps by character count`);
        bad++;
      }
    }
  });
}

for (const file of FILES) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  text.split('\n').forEach((line, i) => {
    for (const ch of line) {
      if (ch.codePointAt(0) < 128) continue;
      const wide = /\p{Emoji_Presentation}/u.test(ch) || ch.length > 1;
      if (!wide) continue;
      const cp = `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
      console.error(`${file}:${i + 1}  double-width glyph ${cp} — terminals draw it 2 cells, blessed counts 1`);
      bad++;
    }
  });
}
if (bad) {
  console.error(`\n${bad} wide glyph(s) found. Use a BMP symbol with Emoji_Presentation=false.`);
  process.exit(1);
}
console.log(`glyph check: ok (${FILES.length} UI file(s), ${defs.length} tool def(s))`);
