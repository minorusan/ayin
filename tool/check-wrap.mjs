#!/usr/bin/env node
/**
 * check-wrap — the transcript wraps to the terminal it is actually in.
 *
 * `npm run check:wrap` (needs a build first). No LLM, no network, no terminal.
 *
 * THE BUG THIS GATE EXISTS FOR. The chat box is a blessed box with `tags`, and blessed wraps it at the
 * box edge — knowing nothing about the gutter. So a wrapped continuation line starts at column 0 while
 * the line it continues started two to six columns in, behind `▌`, `◉` or `TOOL_INDENT`. On a wide
 * terminal a paragraph rarely reaches the edge and nobody notices. On a phone every paragraph does, and
 * the left margin alternates down the whole screen — reported as "on mobile all shit is all over the
 * places".
 *
 * Two halves are checked. The wrapping FUNCTIONS, against real strings — those are pure and testable.
 * And the fact that the widget CALLS them, as source assertions, because a widget cannot be painted
 * without a terminal and a wrap helper nobody calls is the bug with extra steps. (Source assertions are
 * brittle by nature — see check-gates.mjs — so these match shapes, not spellings.)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { wrapPlain } = await import(`file://${join(ROOT, 'dist', 'dialog.js')}`);

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

console.log('\n— wrapping, at the widths a phone actually has —');
for (const width of [20, 32, 40, 60, 80]) {
  const text = 'The scheduler batches by priority and then drains oldest-first, which is why a late '
    + 'high-priority item can still overtake an early one.';
  const out = wrapPlain(text, width);
  const worst = Math.max(...out.map((l) => l.length));
  ok(worst <= width, `at ${width} columns nothing overflows`, `widest line ${worst}`);
  ok(out.join(' ').replace(/\s+/g, ' ') === text.replace(/\s+/g, ' '), `at ${width} columns no word is lost`);
}

console.log('\n— the pathological inputs a coding agent produces —');
{
  const path = '/very/long/absolute/path/that/no/terminal/is/wide/enough/for/deeply/nested/file.ts';
  const out = wrapPlain(path, 24);
  ok(Math.max(...out.map((l) => l.length)) <= 24, 'a single unbreakable token is CHOPPED rather than overflowing');
  ok(out.join('') === path, 'and nothing is lost when it is');
}
ok(wrapPlain('a b c', 0).every((l) => l.length <= 8),
  'a width of 0 does not hang — a terminal narrower than the borders is reachable, and the loop would never advance');
ok(wrapPlain('', 40).length >= 0, 'an empty string does not throw');
ok(wrapPlain('one\n\nthree', 40).includes(''), 'a blank line survives — paragraph breaks are meaning, not whitespace');

console.log('\n— and the transcript widget uses them —');
const chat = readFileSync(join(ROOT, 'src', 'ui', 'widgets', 'chat.ts'), 'utf-8');
ok(/function usableCols\(\)/.test(chat), 'the width is computed in one place');
ok(/screen\.width/.test(chat.slice(chat.indexOf('function usableCols()'), chat.indexOf('function usableCols()') + 200)),
  'from the SCREEN, at draw time, so a resize reflows rather than baking an 80-column assumption');
ok(!/renderMarkdown\(msg\.content\)/.test(chat),
  'prose no longer goes through the UNWRAPPED renderer — that was the bug');
ok((chat.match(/usableCols\(\)/g) ?? []).length >= 5,
  'every line type is wrapped: the user turn, the answer, mid-turn prose, tool output, notices',
  `${(chat.match(/usableCols\(\)/g) ?? []).length} sites`);
ok(/wrapPre\(/.test(chat),
  'and preformatted output is HARD-wrapped, not reflowed — reflowing a diff or a table destroys it');

const ui = readFileSync(join(ROOT, 'src', 'ui', 'index.ts'), 'utf-8');
ok(/on\('resize'[\s\S]{0,120}chat\.redraw\(\)/.test(ui),
  'a resize redraws the chat, which is what makes the width above take effect');

console.log(fails ? `\nwrap check: ${fails} FAILED` : '\nwrap check: all passed');
process.exit(fails ? 1 : 0);
