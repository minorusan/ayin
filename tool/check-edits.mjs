#!/usr/bin/env node
/**
 * check-edits — the edit ledger, its undo, and the refusal that is the whole point of it.
 *
 * `npm run check:edits` (needs a build first). No LLM, no network, no git.
 *
 * WHY THE REFUSAL IS THE ASSERTION THAT MATTERS. An undo that restores blindly is worse than no undo:
 * between an edit and its reversal the Unity editor rewrites assets, the operator edits in their own
 * window, a checkout lands. Restoring over any of that destroys work silently, which is the failure
 * every other guard in this repo exists to prevent. So the ledger records the hash of what each edit
 * PRODUCED, and an undo compares it against the file as it is now — equal means exact, different
 * means say so and stop.
 *
 * And the ordering rule is the same argument one step along: undoing an older edit while a newer one
 * stands would write over the newer one.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const L = await import(join(ROOT, 'dist/edits/ledger.js'));

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const TMP = mkdtempSync(join(tmpdir(), 'ayin-edits-'));
const F = join(TMP, 'f.txt');
const read = () => (existsSync(F) ? readFileSync(F, 'utf8') : null);
/** Record an edit the way the agent loop does: bytes before, do the write, bytes after. */
const edit = (next, summary) => {
  const before = read();
  if (next === null) rmSync(F, { force: true }); else writeFileSync(F, next);
  return L.recordEdit({ path: F, tool: 'str_replace', before, after: read(), summary, cwd: TMP });
};

console.log('\n— an edit is recorded with the fingerprint of what it produced —');
writeFileSync(F, 'alpha\nbeta\n');
const r1 = edit('alpha\nBETA\n', 'beta -> BETA');
ok(r1 && r1.seq === 1, 'the first edit is #1', JSON.stringify(r1 && r1.seq));
ok(r1.beforeSha && r1.afterSha && r1.beforeSha !== r1.afterSha, 'and carries both hashes');
ok(L.stateOf(r1, L.history(undefined, TMP)) === 'current', 'while the file is what it left, it is current');
ok(L.recordEdit({ path: F, tool: 'str_replace', before: read(), after: read(), summary: 'no-op', cwd: TMP }) === null,
  'a tool that changed nothing records nothing — a ledger of no-ops hides the real entries');

console.log('\n— newest first, and one at a time —');
const r2 = edit('alpha\nBETA\nGAMMA\n', 'added GAMMA');
{
  const all = L.history(undefined, TMP);
  ok(L.stateOf(r1, all) === 'superseded', 'the earlier edit is superseded, not "changed outside"');
  ok(L.stateOf(r2, all) === 'current', 'and the later one is current');
}
{
  const out = L.undoLast({ cwd: TMP });
  ok(out.ok && read() === 'alpha\nBETA\n', 'undo restores exactly the bytes that edit replaced', JSON.stringify(read()));
  ok(/#2/.test(out.message), '  → and names which edit it reverted', out.message.split('\n')[0]);
}

console.log('\n— the refusal: something else wrote the file —');
writeFileSync(F, 'alpha\nBETA\nA HUMAN WAS HERE\n');
{
  const out = L.undoLast({ cwd: TMP });
  ok(!out.ok, 'an undo over a file changed outside the ledger is REFUSED');
  ok(/not the file edit #1 produced/.test(out.message), '  → naming the edit and what happened', out.message.split('\n')[0]);
  ok(/the edit left:/.test(out.message) && /the file is:/.test(out.message), '  → and showing BOTH hashes, so it is visible rather than asserted');
  ok(read() === 'alpha\nBETA\nA HUMAN WAS HERE\n', '  → and the other change is still there, untouched');
}
{
  const out = L.undoLast({ cwd: TMP, force: true });
  ok(out.ok && read() === 'alpha\nbeta\n', 'force proceeds, for when the operator has looked and decided');
  ok(/FORCED/.test(out.message), '  → and says that it forced');
}

console.log('\n— an edit that CREATED a file is undone by removing it —');
{
  rmSync(F, { force: true });
  const made = edit('brand new\n', 'created');
  ok(made && made.beforeSha === '', 'a creation records no before-hash');
  const out = L.undoLast({ cwd: TMP });
  ok(out.ok && !existsSync(F), 'and undoing it removes the file', String(existsSync(F)));
}

console.log('\n— nothing to undo is a real answer, not an error —');
{
  const out = L.undoLast({ cwd: TMP });
  ok(!out.ok && /nothing to undo/i.test(out.message), 'an exhausted ledger says so plainly', out.message);
}

console.log('\n— it survives the process that wrote it —');
{
  const all = L.history(undefined, TMP);
  ok(all.length === 3, 'every edit is on disk, undone ones included', String(all.length));
  ok(all.filter((r) => r.undone).length === 3, '  → with their undone flag, appended rather than rewritten');
  ok(existsSync(join(TMP, '.ayin', 'edits', 'ledger.jsonl')), '  → under .ayin/edits/, outside the work tree');
}

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\nedits check: ${fails} FAILED` : '\nedits check: all passed');
process.exit(fails ? 1 : 0);
