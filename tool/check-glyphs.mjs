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
 */
import { readFileSync } from 'node:fs';

const FILES = [
  'src/ui/widgets/status.ts', 'src/ui/widgets/chat.ts', 'src/ui/widgets/thinking.ts',
  'src/ui/widgets/input.ts', 'src/ui/widgets/hints.ts', 'src/dialog.ts',
];

let bad = 0;
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
console.log('glyph check: ok');
