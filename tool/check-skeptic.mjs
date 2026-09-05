#!/usr/bin/env node
/**
 * check-skeptic — the deterministic half of the pre-mortem (`src/qa/skeptic.ts`).
 *
 * `npm run check:skeptic` (needs a build first). No LLM, no network, no TUI.
 *
 * WHAT IS WORTH ASSERTING HERE. The judged half is a model and cannot be pinned. The half that CAN
 * be wrong silently is the evidence: if the caller list comes back empty, the pass still produces a
 * confident-looking card — it simply reviews a file instead of a change, and nobody can tell from
 * the output that the most valuable input was missing. So this builds a REAL git repo in a temp
 * directory with a real caller, changes the module, and asserts the call site is found.
 *
 * A temp repo rather than this one: `blastRadius` reads `git diff`, so a test that ran against a
 * clean checkout would assert nothing, and one that ran against a dirty checkout would depend on
 * whatever the operator happened to be editing.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { blastRadius } = await import(join(ROOT, 'dist/qa/skeptic.js'));
const { describeFile } = await import(join(ROOT, 'dist/qa/probes.js'));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });

const repo = mkdtempSync(join(tmpdir(), 'ayin-skeptic-'));
try {
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'gate@example.invalid']);
  git(repo, ['config', 'user.name', 'gate']);

  // The module under change, and two files that use it: one importing it by NAME, one naming the
  // SYMBOL. Both are call sites a reviewer must see; neither is in the diff.
  writeFileSync(join(repo, 'port.js'), 'export function sendThing(a) { return a; }\n');
  writeFileSync(join(repo, 'caller-a.js'), "import { sendThing } from './port.js';\nsendThing(1);\n");
  writeFileSync(join(repo, 'caller-b.js'), "// uses the port module\nimport * as port from './port.js';\nport.sendThing(2);\n");
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);

  // The change: a second, required parameter. The classic thing a caller list catches and a
  // file-only review does not.
  writeFileSync(join(repo, 'port.js'), 'export function sendThing(a, b) { return a + b; }\n');

  const changed = [describeFile(join(repo, 'port.js'))];
  const r = blastRadius(repo, changed);

  ok(r.diff.includes('sendThing(a, b)'), 'the diff carries the change itself', r.diff.split('\n')[0] ?? '');
  ok(r.diff.includes('port.js'), 'and names the file it is in');
  ok(r.callerCount >= 2, 'both call sites are found', `${r.callerCount} hit(s)`);
  ok(r.callers.includes('caller-a.js'), 'the importer that names the SYMBOL is found');
  ok(r.callers.includes('caller-b.js'), 'the importer that names the MODULE is found');
  ok(!r.callers.includes('port.js:'),
    'the changed file itself is NOT in the caller list — it is already in the diff, and repeating it would push real call sites past the cap');

  // A file nothing else references must say so IN WORDS. An empty section reads to a model as "no
  // callers", which is a different claim from "the search found nothing" — and it would be the
  // wrong one in a repo that is not under git.
  writeFileSync(join(repo, 'lonely.js'), 'export function zzzUnreferenced() { return 1; }\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'lonely']);
  writeFileSync(join(repo, 'lonely.js'), 'export function zzzUnreferenced() { return 2; }\n');
  const alone = blastRadius(repo, [describeFile(join(repo, 'lonely.js'))]);
  ok(alone.callerCount === 0, 'a self-contained change finds no callers', `${alone.callerCount} hit(s)`);
  ok(/no other file in this repo names/.test(alone.callers),
    'and the absence is stated in words rather than left as an empty section');

  // NOT A GIT REPO AT ALL: the pass must degrade to "no diff, no callers" and never throw — the
  // agent runs in whatever directory the operator is in, and plenty of them are not repos.
  const bare = mkdtempSync(join(tmpdir(), 'ayin-skeptic-bare-'));
  try {
    writeFileSync(join(bare, 'x.js'), 'export const x = 1;\n');
    const none = blastRadius(bare, [describeFile(join(bare, 'x.js'))]);
    ok(none.callerCount === 0 && typeof none.diff === 'string',
      'a directory that is not a git repository yields no evidence instead of an exception');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log(`skeptic check: ${fails === 0 ? 'ok' : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);
