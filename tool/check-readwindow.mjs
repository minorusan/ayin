#!/usr/bin/env node
/**
 * check-readwindow — READ windows: centring, sliding, boundary snapping, and the coverage report.
 *
 * `npm run check:readwindow` (needs a build first). No LLM, no network, nothing written outside the OS
 * temp directory.
 *
 * NOT to be confused with `check-window.mjs`, which guards the CONTEXT window's KV-cache headroom. Two
 * unrelated meanings of "window" live in this repo; this one is about which lines of a FILE come back.
 *
 * WHY A GATE. Window arithmetic is right in the middle and wrong at the edges — line 1, line `total`, a
 * window wider than the file, a span of exactly one line — and a hand test always picks the middle. Every
 * assertion here is an edge, plus the three behaviours the feature exists for:
 *
 *   - **`around` centres**, and clamps by SHIFTING rather than shrinking. Asking for 40 lines around
 *     line 3 must give 40 lines, not 23. A window that silently returns less than asked is the exact
 *     failure the caps in these tools were built to announce.
 *   - **A param-free re-read SLIDES.** The old behaviour returned the same top-of-file slice, so a second
 *     read of a big file was a wasted round. It must NOT slide when the file changed underneath, because
 *     the recorded spans then describe bytes that are gone.
 *   - **The footer reports the COMPLEMENT.** "N more lines" only ever described the tail, so after one
 *     slide it was wrong: read 1-800 then 801-1000 of a 2000-line file and it said "1000 more lines"
 *     with no hint that 1-800 was behind you.
 */

if (!process.argv.includes('-p')) process.argv.push('-p');

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'ayin-rwhome-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const DIR = mkdtempSync(join(tmpdir(), 'ayin-readwindow-'));
let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};
const eq = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}`);

const W = await import('../dist/tools/readWindow.js');
const { tool: readFile } = await import('../dist/tools/defs/read_file.js');
const { _resetReadGuard, coverage } = await import('../dist/tools/readGuard.js');

console.log('centeredWindow — clamps by SHIFTING, never by shrinking');
eq(W.centeredWindow(500, 100, 1000), [451, 550], 'a window in the middle is centred');
eq(W.centeredWindow(3, 40, 1000), [1, 40], 'near the top it shifts to 1-40, keeping the full size');
eq(W.centeredWindow(998, 40, 1000), [961, 1000], 'near the end it shifts back, keeping the full size');
eq(W.centeredWindow(1, 1, 1000), [1, 1], 'a one-line window at line 1');
eq(W.centeredWindow(500, 5000, 1000), [1, 1000], 'a window wider than the file is the whole file');
eq(W.centeredWindow(1, 10, 1), [1, 1], 'a one-line file');
eq(W.centeredWindow(5, 10, 0), [1, 1], 'an empty file does not produce a negative span');

console.log('\nunreadRanges — the complement, which is what "still unseen" means');
eq(W.unreadRanges([], 100), [[1, 100]], 'nothing read: all of it');
eq(W.unreadRanges([[1, 100]], 100), [], 'all read: nothing');
eq(W.unreadRanges([[1, 40]], 100), [[41, 100]], 'a head leaves the tail');
eq(W.unreadRanges([[41, 60]], 100), [[1, 40], [61, 100]], 'a middle leaves two holes');
eq(W.unreadRanges([[1, 40], [41, 60]], 100), [[61, 100]], 'adjacent spans join, leaving one hole');
eq(W.unreadRanges([[1, 40], [30, 60]], 100), [[61, 100]], 'overlapping spans merge');
eq(W.unreadRanges([[1, 200]], 100), [], 'a span past the end does not invent negative ranges');
eq(W.unreadRanges([], 0), [], 'an empty file has nothing unread');

console.log('\nsnapEnd — a window must not end mid-construct');
{
  // A blank line at 12, a closing brace at 20, nothing else nearby.
  const lines = Array.from({ length: 60 }, (_, i) => `  body ${i + 1}`);
  lines[11] = '';   // line 12
  lines[19] = '}';  // line 20
  ok(W.snapEnd(lines, 1, 13, 60) === 12, 'ends at the blank line one back', String(W.snapEnd(lines, 1, 13, 60)));
  ok(W.snapEnd(lines, 1, 19, 60) === 20, 'extends 1 to the brace rather than shrinking 7 to the blank', String(W.snapEnd(lines, 1, 19, 60)));
  ok(W.snapEnd(lines, 1, 14, 60) === 12, 'but a blank 2 back beats a brace 6 forward', String(W.snapEnd(lines, 1, 14, 60)));
  ok(W.snapEnd(lines, 1, 60, 60) === 60, 'the last line needs no snapping');
  ok(W.snapEnd(lines, 1, 45, 60, 2) === 45, 'no break within slack leaves the end alone');
  ok(W.snapEnd(lines, 30, 31, 60, 20) > 30, 'never snaps back to or past `from`');
}

console.log('\nsnapStart — moves BACKWARDS only, to just after a blank line');
{
  const lines = Array.from({ length: 60 }, (_, i) => `  body ${i + 1}`);
  lines[29] = ''; // line 30
  ok(W.snapStart(lines, 34) === 31, 'starts just after the blank line', String(W.snapStart(lines, 34)));
  ok(W.snapStart(lines, 2) === 1, 'clamps to 1 near the top');
  ok(W.snapStart(lines, 55, 2) === 55, 'no blank within slack leaves it alone');
  ok(W.snapStart(lines, 20) <= 20, 'never moves forward to find one', String(W.snapStart(lines, 20)));
  ok(W.snapStart(lines, 500, 20) === 500, 'far from any break, the start is left alone');
}

console.log('\nread_file — a param-free re-read SLIDES to the unread part');
const BIG = join(DIR, 'big.ts');
{
  _resetReadGuard();
  // 1000 numbered lines with a blank every 50, so snapping has something to find.
  const lines = Array.from({ length: 1000 }, (_, i) => ((i + 1) % 50 === 0 ? '' : `const line${i + 1} = ${i + 1};`));
  writeFileSync(BIG, lines.join('\n') + '\n', 'utf-8');

  const a = await readFile.execute({ path: BIG });
  ok(/^\(lines 1-/.test(a), 'the first read starts at line 1', a.split('\n')[0]);
  ok(/unread: \d+-1001/.test(a), '...and the footer names the unread range', a.split('\n')[0]);
  ok(!/slid past/.test(a), '...and does not claim to have slid');

  const b = await readFile.execute({ path: BIG });
  const first = b.split('\n')[0];
  ok(/slid past what you already read/.test(b), 'the SECOND read slides forward', first);
  const m = first.match(/lines (\d+)-(\d+)/);
  ok(m && Number(m[1]) > 700, '...to a window past the first one', m ? m[1] : '?');
  ok(b.includes('const line897 = 897;'), '...and it contains the later content');

  // Keep sliding to the end, then confirm it says so rather than looping.
  let last = b;
  for (let i = 0; i < 5 && !/all 1001 lines/.test(last); i++) last = await readFile.execute({ path: BIG });
  ok(/all 1001 lines of this file have now been read/.test(last), 'sliding terminates at full coverage', last.split('\n')[0]);
  const cov = coverage(BIG);
  ok(cov && W.unreadRanges(cov.spans, cov.lines).length === 0, '...and the guard agrees the file is covered');
}

console.log('\nread_file — around= centres on a line, focused, and does not slide');
{
  _resetReadGuard();
  const r = await readFile.execute({ path: BIG, around: '900' });
  const m = r.split('\n')[0].match(/lines (\d+)-(\d+)/);
  ok(m && Number(m[1]) < 900 && Number(m[2]) > 900, 'the window straddles the target line', m ? `${m[1]}-${m[2]}` : '?');
  ok(r.includes('const line897 = 897;'), '...and contains it');
  ok(!/slid past/.test(r), '...and is not reported as a slide');
  // A focused window, not the full cap. Sized at READ_MAX_LINES this returned 202-1001 of a 1001-line
  // file: 800 lines of context to show one constant, and on a live run the model answered it with a
  // narrower read of its own.
  const span = m ? Number(m[2]) - Number(m[1]) + 1 : 0;
  ok(span > 40 && span < 200, 'around= defaults to a FOCUSED window, not the 800-line cap', `${span} lines`);
  const wide = await readFile.execute({ path: BIG, around: '900', limit: '400' });
  const mw = wide.split('\n')[0].match(/lines (\d+)-(\d+)/);
  ok(mw && Number(mw[2]) - Number(mw[1]) + 1 > 300, '...and limit= still widens it', mw ? `${mw[1]}-${mw[2]}` : '?');
}

console.log('\nread_file — a CHANGED file must not slide past lines that no longer exist');
{
  _resetReadGuard();
  const small = join(DIR, 'small.ts');
  writeFileSync(small, Array.from({ length: 900 }, (_, i) => `x${i + 1}`).join('\n') + '\n', 'utf-8');
  await readFile.execute({ path: small });
  writeFileSync(small, Array.from({ length: 30 }, (_, i) => `y${i + 1}`).join('\n') + '\n', 'utf-8');
  const t = new Date(Date.now() + 4000);
  utimesSync(small, t, t);
  const r = await readFile.execute({ path: small });
  ok(!/slid past/.test(r), 'the re-read does not slide', r.split('\n')[0]);
  ok(/^\(lines 1-/.test(r), '...it starts from the top again', r.split('\n')[0]);
  ok(r.includes('y1'), '...and shows the NEW content');
}

console.log('\nread_file — offset and tail still behave');
{
  _resetReadGuard();
  const t = await readFile.execute({ path: BIG, tail: '10' });
  ok(/lines 992-1001 of 1001/.test(t), 'tail returns the end', t.split('\n')[0]);
  const o = await readFile.execute({ path: BIG, offset: '500', limit: '20' });
  const m = o.split('\n')[0].match(/lines (\d+)-/);
  ok(m && m[1] === '500', 'offset starts exactly where asked', o.split('\n')[0]);
  const past = await readFile.execute({ path: BIG, offset: '99999' });
  ok(past.startsWith('Error:') && /past the end/.test(past), 'an offset past the end is an error', past.slice(0, 60));
}

rmSync(DIR, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
