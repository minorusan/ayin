#!/usr/bin/env node
/**
 * check-readguard — the read-before-edit / read-back-after invariant, against the built `dist` and a
 * real temp directory.
 *
 * `npm run check:readguard` (needs a build first). No LLM, no network, nothing written outside the OS
 * temp directory.
 *
 * WHY THIS GATE EXISTS AS CODE AND NOT AS A REVIEW. The bug it guards against is one nobody can see by
 * reading a diff: `str_replace` reports "old_str not found" for a file the model has not actually read,
 * which is indistinguishable from a quoting mistake, so the retry loosens the context until something
 * matches — and returns a clean, plausible diff for an edit in the wrong place. Every assertion below
 * is therefore about a REFUSAL happening, which is the only observable the failure has.
 *
 * The load-bearing cases, in order of how badly they bite:
 *
 *   - **A capped read does not license an edit anywhere in the file.** `read_file` returns at most
 *     READ_MAX_LINES; a 1000-line file read once has 200 unseen lines, and an edit landing there is
 *     exactly the edit-from-memory being prevented. A path-level guard passes this. This one does not.
 *   - **A stale read is refused.** The case where the model remembers honestly and the file changed
 *     underneath it — the only failure mode a more careful model could not avoid on its own.
 *   - **Creating needs no read**, and **a consecutive edit needs no re-read.** A guard that fires on
 *     correct behaviour gets removed wholesale, taking the real check with it, so the holes in the rule
 *     are asserted as deliberately as the rule.
 *   - **The read-back is reported.** Both tools build their diff from in-memory strings, so a write
 *     that did not land is invisible to them by construction.
 */

// Headless BEFORE importing anything from dist — `ui/index.ts` builds real blessed widgets at module
// load otherwise and leaves escape codes in the shell.
if (!process.argv.includes('-p')) process.argv.push('-p');

import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'ayin-rghome-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const DIR = mkdtempSync(join(tmpdir(), 'ayin-readguard-'));
let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { tool: readFile } = await import('../dist/tools/defs/read_file.js');
const { tool: strReplace } = await import('../dist/tools/defs/str_replace.js');
const { tool: writeFile } = await import('../dist/tools/defs/write_file.js');
const { _resetReadGuard } = await import('../dist/tools/readGuard.js');

const P = join(DIR, 'target.ts');
const short = ['alpha', 'beta', 'gamma', 'delta'].join('\n') + '\n';

console.log(`sandbox ${DIR}\n`);
console.log('str_replace — an edit needs a read that covers the edited line');
{
  _resetReadGuard();
  writeFileSync(P, short, 'utf-8');
  const r = await strReplace.execute({ path: P, old_str: 'beta', new_str: 'BETA' });
  ok(r.startsWith('Error:') && /have not read/.test(r), 'editing an UNREAD file is refused', r.split('\n')[0].slice(0, 72));
  ok(readFileSync(P, 'utf-8') === short, '...and the file is untouched');
}
{
  await readFile.execute({ path: P });
  const r = await strReplace.execute({ path: P, old_str: 'beta', new_str: 'BETA' });
  ok(!r.startsWith('Error:'), 'after a read, the same edit succeeds', r.split('\n')[0].slice(0, 60));
  ok(readFileSync(P, 'utf-8').includes('BETA'), '...the change is on disk');
  ok(/read back from disk/.test(r), '...and the result reports the read-back');
}
{
  const r = await strReplace.execute({ path: P, old_str: 'gamma', new_str: 'GAMMA' });
  ok(!r.startsWith('Error:'), 'a consecutive edit needs no ceremonial re-read', r.split('\n')[0].slice(0, 50));
}
{
  // Something else changes the file: the recorded read now describes bytes that are gone.
  writeFileSync(P, 'alpha\nBETA\nGAMMA\ndelta\nepsilon\n', 'utf-8');
  const t = new Date(Date.now() + 4000);
  utimesSync(P, t, t);
  const r = await strReplace.execute({ path: P, old_str: 'alpha', new_str: 'ALPHA' });
  ok(r.startsWith('Error:') && /changed on disk/.test(r), 'an edit against a STALE read is refused', r.split('\n')[0].slice(0, 72));
  await readFile.execute({ path: P });
  const r2 = await strReplace.execute({ path: P, old_str: 'alpha', new_str: 'ALPHA' });
  ok(!r2.startsWith('Error:'), 're-reading clears the staleness');
}

console.log('\nstr_replace — a CAPPED read does not license an edit in the unread part');
{
  _resetReadGuard();
  const big = join(DIR, 'big.ts');
  const lines = Array.from({ length: 1000 }, (_, i) => `const line${i + 1} = ${i + 1};`);
  writeFileSync(big, lines.join('\n') + '\n', 'utf-8');

  const head = await readFile.execute({ path: big });
  ok(/of 1001/.test(head) && /unread: \d+-1001/.test(head), 'the read is capped and names what is unread', head.split('\n')[0]);

  const r = await strReplace.execute({ path: big, old_str: 'const line950 = 950;', new_str: 'const line950 = 0;' });
  ok(r.startsWith('Error:') && /have not read that part/.test(r),
    'an edit at line 950 after reading 1-800 is REFUSED', r.split('\n')[0].slice(0, 90));
  ok(readFileSync(big, 'utf-8').includes('const line950 = 950;'), '...and line 950 is untouched');

  const r2 = await strReplace.execute({ path: big, old_str: 'const line400 = 400;', new_str: 'const line400 = 0;' });
  ok(!r2.startsWith('Error:'), 'an edit at line 400, which WAS returned, is allowed', r2.split('\n')[0].slice(0, 50));

  ok(/around=950/.test(r), '...and the refusal suggests around=<line>, not a computed offset');
  await readFile.execute({ path: big, around: '950' });
  const r3 = await strReplace.execute({ path: big, old_str: 'const line950 = 950;', new_str: 'const line950 = 0;' });
  ok(!r3.startsWith('Error:'), 'reading around=950 then allows the line-950 edit', r3.split('\n')[0].slice(0, 50));
}

console.log('\nwrite_file — create is free, overwrite is not');
{
  _resetReadGuard();
  const fresh = join(DIR, 'brand-new.md');
  const r = await writeFile.execute({ path: fresh, content: '# new\n\nbody\n' });
  ok(r.startsWith('Created'), 'CREATING a file needs no prior read', r.split('\n')[0].slice(0, 60));
  ok(/read back from disk/.test(r), '...and the create reports its read-back', r.split('\n')[0].slice(0, 70));

  _resetReadGuard();
  const r2 = await writeFile.execute({ path: fresh, content: '# clobbered\n' });
  ok(r2.startsWith('Error:') && /have not read/.test(r2), 'OVERWRITING an unread file is refused', r2.split('\n')[0].slice(0, 72));
  ok(readFileSync(fresh, 'utf-8').includes('body'), '...and the original survives');

  await readFile.execute({ path: fresh });
  const r3 = await writeFile.execute({ path: fresh, content: '# now allowed\n' });
  ok(!r3.startsWith('Error:'), 'after a full read, the overwrite succeeds', r3.split('\n')[0].slice(0, 50));
}
{
  // The case write_file's own "N lines GONE" banner warns about, refused instead of merely reported.
  _resetReadGuard();
  const big = join(DIR, 'big2.ts');
  writeFileSync(big, Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n', 'utf-8');
  await readFile.execute({ path: big });
  const r = await writeFile.execute({ path: big, content: 'line 1\nline 2\n' });
  ok(r.startsWith('Error:') && /only read lines/.test(r),
    'rewriting a file read only in part is REFUSED', r.split('\n')[0].slice(0, 96));
  ok(statSync(big).size > 5000, '...and the 1000-line file is intact');
}

console.log('\nread-back — a write that does not land must not report success');
{
  const { readBackAfter } = await import('../dist/tools/readGuard.js');
  const gone = join(DIR, 'never-written.txt');
  const a = readBackAfter(gone, 'expected content');
  ok(!a.ok && /nothing exists/.test(a.note), 'a missing file fails the read-back', a.note.slice(0, 60));
  const real = join(DIR, 'mismatch.txt');
  writeFileSync(real, 'what is actually there', 'utf-8');
  const b = readBackAfter(real, 'what was meant to be there');
  ok(!b.ok && /MISMATCH/.test(b.note), 'content that differs fails the read-back', b.note.slice(0, 70));
  const c = readBackAfter(real, 'what is actually there');
  ok(c.ok && /byte-identical/.test(c.note), 'matching content passes', c.note);
}

console.log('\nthe repeat guard must not block the recovery the read guard prescribes');
{
  // THE INTERACTION THAT BROKE A LIVE RUN. readGuard refuses an edit to unread lines and says "read
  // them, then make the same call again". That retry is byte-identical, and a read is TREE_SAFE so it
  // bumps no mutation epoch — so the repeat guard skipped it, then blocked it, and the edit never
  // landed while the turn reported "Done".
  const { guardBeginTurn, guardCheck, guardNoteRead } = await import('../dist/tool-guard.js');
  const f = join(DIR, 'interaction.ts');
  writeFileSync(f, 'const a = 1;\n', 'utf-8');
  guardBeginTurn();
  const params = { path: f, old_str: 'const a = 1;', new_str: 'const a = 2;' };

  const first = guardCheck('str_replace', params);
  ok(first.allow, 'the first edit attempt is allowed (readGuard is what refuses it)');

  const repeatNoRead = guardCheck('str_replace', params);
  ok(!repeatNoRead.allow, 'an identical retry with NOTHING in between is still refused — the loop case stays closed',
    repeatNoRead.label);

  guardNoteRead([f]);
  const afterRead = guardCheck('str_replace', params);
  ok(afterRead.allow, 'but after READING the file, the identical retry RUNS', afterRead.label);
  ok(/READ the file since/.test(afterRead.note ?? ''), '...and the note says why', (afterRead.note ?? '').slice(0, 64));

  const againNoRead = guardCheck('str_replace', params);
  ok(!againNoRead.allow, 'and a further identical call with no new read is refused again', againNoRead.label);
}

console.log('\nunexecutedCallText — a call in an invented format is not a finished answer');
{
  const { unexecutedCallText } = await import('../dist/llm/manager.js');
  const names = ['str_replace', 'write_file', 'read_file', 'bash'];
  // The shape observed live, after a refused edit: every dialect parses it to zero calls, zero calls
  // reads as a final answer, and the turn ends claiming "Done." with the file unchanged.
  const cases = [
    ['[str_replace(path=/a, old_str=x, new_str=y)]', 'str_replace'],
    ['str_replace(path=/a, old_str=x)', 'str_replace'],
    ['  [write_file(path=/x, content=hi)]', 'write_file'],
    ['I will use str_replace to fix it.', null],
    ['The str_replace tool prefers a unique match.', null],
    ['Use `str_replace(path=...)` inline.', null],
    ['Example:\n```\nstr_replace(path=/a, old_str=b)\n```\ndone', null],
    ['Done. No changes were needed.', null],
    ['', null],
  ];
  for (const [txt, expected] of cases) {
    const got = unexecutedCallText(txt, names);
    ok(got === expected, `${expected ? 'DETECTS' : 'ignores'} ${JSON.stringify(txt).slice(0, 46)}`, `-> ${got}`);
  }
}

rmSync(DIR, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
