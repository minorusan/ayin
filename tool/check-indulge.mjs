#!/usr/bin/env node
/**
 * check-indulge — the corpus store's survival properties, against a real filesystem.
 *
 * `npm run check:indulge` (needs a build first). No LLM, no network: it builds a throwaway store in
 * the OS temp dir, drives it through a run, tears a line off the end of a JSONL the way a power cut
 * does, leaves a dead process's lock behind, and asserts the corpus comes back on its own.
 *
 * It exists because `indulge` is an OVERNIGHT job. The operator starts it and closes the laptop, so
 * the only thing standing between eight hours of GPU time and a reboot at 02:00 is that every
 * record is on disk the moment it exists and that a restart can tell what was in flight. None of
 * that is visible to a typecheck: a store that batches writes in memory, or one that needs a human
 * to delete a stale lock, compiles perfectly and loses the night.
 *
 * Kept honest by a second property: the ids must be STABLE. A re-run that recomputes a different id
 * for the same question re-answers work it already has, which turns "ask indulge again" from an
 * expansion into a restart that also doubles the corpus.
 */

// Declare ourselves headless BEFORE importing anything from dist: `answer.js` wires the tool
// runtime, and `ui/index.ts` builds real blessed widgets at module load unless HEADLESS is set —
// which grabs the terminal and leaves escape codes behind when the process exits.
if (!process.argv.includes('-p')) process.argv.push('-p');

import { appendFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(tmpdir(), 'ayin-indulge-'));
const REPO = join(TMP, 'repo');
process.env.AYIN_RAG_DIR = join(TMP, 'rag');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const S = await import(join(ROOT, 'dist/indulge/store.js'));

mkdirSync(join(REPO, 'src'), { recursive: true });
writeFileSync(join(REPO, 'src/A.cs'), 'class A {\n  void Ingest() {}\n}\n');
execFileSync('git', ['-C', REPO, 'init', '-q'], { stdio: 'ignore' });
const gitSha = execFileSync('git', ['-C', REPO, 'hash-object', 'src/A.cs'], { encoding: 'utf-8' }).trim();

// ── identity: a chunk's proof is checkable by hand, and ids never drift ──────────

ok(S.blobSha(readFileSync(join(REPO, 'src/A.cs'))) === gitSha,
  'blobSha is git\'s blob sha, so sourceSha can be checked with git hash-object');
ok(S.repoKey(REPO) === S.repoKey(REPO + '/'), 'repoKey ignores a trailing slash');
// REVERSED in 1.0.268, deliberately. This used to assert that two checkouts of one repo were
// separate corpora, reasoning that they sit on different commits. That predated the staleness
// layer: every chunk is now labelled per-file against the tree in front of it, so sharing one
// corpus across checkouts is safe — and keying on the absolute path made a corpus unmovable
// between machines, which is the whole point of building one overnight on a bigger box.
{
  const clone = join(TMP, 'clone-elsewhere');
  mkdirSync(clone, { recursive: true });
  execFileSync('bash', ['-c', `git init -q . && git remote add origin https://example.invalid/o/r.git`], { cwd: clone, stdio: 'ignore' });
  execFileSync('bash', ['-c', `git remote add origin https://example.invalid/o/r.git 2>/dev/null; true`], { cwd: REPO, stdio: 'ignore' });
  ok(S.repoKey(REPO) === S.repoKey(clone),
    'two checkouts of the SAME repo share one corpus — that is what makes it portable', `${S.repoKey(REPO)} vs ${S.repoKey(clone)}`);
  ok(S.repoIdentity(REPO).kind === 'remote', 'identity prefers the remote — stable across clones and machines');
  ok(S.normalizeRemote('git@github.com:o/r.git') === S.normalizeRemote('https://github.com/o/r/'),
    'ssh and https forms of one remote normalise to the same identity');
  execFileSync('bash', ['-c', 'git remote remove origin'], { cwd: REPO, stdio: 'ignore' });
  // A root commit only exists once something has been committed — until then there is nothing
  // stable to key on, which is itself the correct answer.
  ok(S.repoIdentity(REPO).kind === 'path', 'a git repo with NO commits has no stable identity yet — path, honestly');
  execFileSync('bash', ['-c', 'git add -A && git -c user.email=t@t -c user.name=t commit -qm first'], { cwd: REPO, stdio: 'ignore' });
  ok(S.repoIdentity(REPO).kind === 'root', 'once committed and with no remote, it keys on the ROOT COMMIT — identical in every clone');
  ok(S.repoIdentity(join(TMP, 'not-a-repo-at-all')).kind === 'path',
    'a plain directory falls back to its path, and says so rather than pretending to be portable');
}

const ent = { kind: 'method', name: 'Ingest', file: 'src/A.cs' };
const qA = S.questionId('What breaks if I change this?', 'src/A.cs', ent);
ok(qA === S.questionId('  what breaks if i change this  ', 'src/A.cs', ent),
  'questionId collides on case, spacing and punctuation — a re-run does not re-answer');
ok(qA !== S.questionId('What breaks if I change this?', 'src/A.cs', null),
  'the same words about the file and about a method are different questions');
const cA = S.chunkId('k', 'src/A.cs', ent, 'gotchas', qA);
ok(cA === S.chunkId('k', 'src/A.cs', ent, 'gotchas', qA), 'chunkId is stable across runs');
ok(cA !== S.chunkId('k', 'src/A.cs', ent, 'functionality', qA), 'chunkId separates categories');

// ── a run, written record by record ─────────────────────────────────────────────

const store = S.openStore(REPO);
store.beginRun({ runId: 'run-1', domains: ['rendering'], headSha: 'deadbeef' });
store.addFile({ domain: 'rendering', path: 'src/A.cs', depth: 0, why: 'explore seed', sha: gitSha });
store.addQuestion({ id: qA, file: 'src/A.cs', entity: ent, category: 'gotchas', text: 'What breaks if I change this?' });
const qB = S.questionId('What does Ingest return?', 'src/A.cs', ent);
store.addQuestion({ id: qB, file: 'src/A.cs', entity: ent, category: 'functionality', text: 'What does Ingest return?' });
ok(store.addQuestion({ id: qA, file: 'src/A.cs', entity: ent, category: 'gotchas', text: 'dupe' }) === false,
  'a known question id is refused, not appended twice');

store.saveChunk({
  chunkId: cA, questionId: qA, repoKey: store.key, repoPath: REPO, domain: 'rendering',
  question: 'What breaks if I change this?', answer: 'Ingest runs before Configure.',
  files: ['src/A.cs'], citations: [{ path: 'src/A.cs', startLine: 2, endLine: 2, sha: gitSha }],
  entity: ent, category: 'gotchas', model: 'test', createdAt: new Date().toISOString(), sourceSha: gitSha,
});
store.setQuestionStatus(qB, 'failed', 'citation did not resolve');

const merged = store.questions().find((q) => q.id === qB);
ok(merged.status === 'failed' && merged.note === 'citation did not resolve' && merged.text === 'What does Ingest return?',
  'a status change is an APPEND that merges over the original record, never a rewrite');
ok(JSON.stringify(store.totals()) === JSON.stringify({ files: 1, questions: 2, pending: 0, answered: 1, failed: 1, chunks: 1 }),
  'totals are counted from disk', JSON.stringify(store.totals()));

// ── the power cut: a torn trailing line must not take the corpus with it ─────────

appendFileSync(join(process.env.AYIN_RAG_DIR, store.key, 'questions.jsonl'), '{"id":"torn","file":"src/B.cs","cat');
const torn = S.openStore(REPO);
ok(torn.questions().length === 2, 'a torn last line is skipped and the earlier records survive');
ok(torn.readChunk(cA).answer.startsWith('Ingest'), 'chunks are readable after the tear');

// ── the crash: a dead holder's lock is adopted with NO human in the loop ─────────

const lockPath = join(process.env.AYIN_RAG_DIR, store.key, 'run.lock');
const deadLock = { pid: 0x7ffffff, host: hostname(), runId: 'run-1', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
writeFileSync(lockPath, JSON.stringify(deadLock));
const resumed = S.openStore(REPO);
let adopted = true, why = '';
try { resumed.beginRun({ runId: 'run-2', domains: ['rendering'], headSha: 'deadbeef' }); } catch (e) { adopted = false; why = e.message; }
ok(adopted, 'a lock held by a dead pid is adopted — a stale lock never needs a human to delete it', why);
ok(resumed.manifest().runs.find((r) => r.runId === 'run-1').status === 'interrupted',
  'the run that died is recorded as interrupted, so the manifest tells the truth about the night');
const rt = resumed.totals();
ok(rt.questions === 2 && rt.chunks === 1 && rt.answered === 1,
  'resume reads prior work back and does not redo it', JSON.stringify(rt));

// ── but a LIVE holder is refused, so two indulges cannot share one corpus ────────

let refused = false, msg = '';
try { S.openStore(REPO).beginRun({ runId: 'run-3', domains: ['x'], headSha: 'y' }); } catch (e) { refused = e.name === 'StoreLockedError'; msg = e.message; }
ok(refused && /pid \d+ on /.test(msg), 'a live holder is refused, and the refusal names it', msg);

// A foreign host cannot be pid-checked, so liveness falls back to the heartbeat.
writeFileSync(lockPath, JSON.stringify({ pid: 1, host: 'another-box', runId: 'r', startedAt: '2020-01-01T00:00:00.000Z', heartbeatAt: '2020-01-01T00:00:00.000Z' }));
let staleForeign = true;
try { S.openStore(REPO).beginRun({ runId: 'run-4', domains: ['x'], headSha: 'y' }); } catch { staleForeign = false; }
ok(staleForeign, 'a foreign lock whose heartbeat stopped is adopted (laptop that never came back)');
writeFileSync(lockPath, JSON.stringify({ pid: 1, host: 'another-box', runId: 'r', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
let liveForeign = false;
try { S.openStore(REPO).beginRun({ runId: 'run-5', domains: ['x'], headSha: 'y' }); } catch (e) { liveForeign = e.name === 'StoreLockedError'; }
ok(liveForeign, 'a foreign lock that is still beating is obeyed');
rmSync(lockPath, { force: true });

// ── endRun stamps what is on disk, not what a counter in memory believed ─────────

const closer = S.openStore(REPO);
closer.beginRun({ runId: 'run-6', domains: ['rendering'], headSha: 'cafe' });
const rec = closer.endRun('run-6');
ok(rec.chunks === 1 && rec.questions === 2 && rec.failed === 1, 'endRun stamps totals from disk', JSON.stringify(rec));
ok(!existsSync(lockPath), 'endRun releases the lock');

// ── a domain that matches nothing writes a manifest and NOTHING else ────────────

const EMPTY = join(TMP, 'empty-repo');
mkdirSync(EMPTY, { recursive: true });
const es = S.openStore(EMPTY);
es.beginRun({ runId: 'r1', domains: ['does-not-exist-xyz'], headSha: 'h' });
const er = es.endRun('r1');
ok(er.matched === 0 && er.questions === 0 && er.chunks === 0, 'a no-match domain records matched: 0');
ok(!existsSync(join(process.env.AYIN_RAG_DIR, es.key, 'files.jsonl')),
  'a no-match domain writes no file list — inventing one would poison the corpus silently');

// ── restart discards the corpus but keeps the audit trail ───────────────────────

const rs = S.openStore(REPO);
rs.beginRun({ runId: 'run-7', domains: ['rendering'], headSha: 'cafe', restart: true });
ok(rs.questions().length === 0 && rs.chunks().length === 0, 'restart clears questions and chunks');
ok(rs.manifest().runs.some((r) => r.runId === 'run-1'), 'restart keeps the run history');
ok(rs.addQuestion({ id: qA, file: 'src/A.cs', entity: ent, category: 'gotchas', text: 'What breaks if I change this?' }),
  'after restart the same id is accepted again (the id cache followed the file it was built from)');
rs.endRun('run-7');

// ── scale: duplicate-checking must not be quadratic in the number of questions ──
// Measured before the id cache: 500 questions cost 175ms and 8000 cost 51s. A repo whose
// files x entities x 5 categories reach five figures would spend the night on bookkeeping.

const BIG = join(TMP, 'big-repo');
mkdirSync(BIG, { recursive: true });
const big = S.openStore(BIG);
big.beginRun({ runId: 'scale', domains: ['x'], headSha: 'h' });
const t0 = Date.now();
for (let i = 0; i < 8000; i++) {
  const text = `question ${i} about the ingest path`;
  big.addQuestion({ id: S.questionId(text, 'src/A.cs', null), file: 'src/A.cs', entity: null, category: 'gotchas', text });
}
const elapsed = Date.now() - t0;
ok(elapsed < 5000, `8000 questions append in linear time (${elapsed}ms, was ~51s when this was quadratic)`);
big.endRun('scale');

// ── stage 1: discovery never invents a file, and the graph it walks is checkable ─

const D = await import(join(ROOT, 'dist/indulge/discover.js'));

// A path the model named is untrusted input until the filesystem agrees.
ok(D.resolveInRepo(REPO, 'src/A.cs') === 'src/A.cs', 'a real file resolves to a repo-relative path');
ok(D.resolveInRepo(REPO, '`src/A.cs`,') === 'src/A.cs', 'markdown punctuation around a path is stripped');
ok(D.resolveInRepo(REPO, 'src/Invented.cs') === null, 'a path that does not exist is refused — this is the hallucination guard');
ok(D.resolveInRepo(REPO, '../../etc/passwd') === null, 'a path escaping the repo is refused');
ok(D.resolveInRepo(REPO, '/etc/passwd') === null, 'an absolute path outside the repo is refused');
ok(D.resolveInRepo(REPO, 'src') === null, 'a directory is not a file');

const extracted = D.extractPaths('I looked around and read things.\n\nFILES:\nsrc/A.cs\nsrc/B.cs\n');
ok(extracted.includes('src/A.cs') && extracted.includes('src/B.cs'), 'paths are read out of the FILES: block', JSON.stringify(extracted));

// A fixture whose import graph is known by construction, including the two cases that were bugs:
// a `.js` specifier that resolves to a `.ts` file, and a `bin/` directory holding real source.
const G = join(TMP, 'graph-repo');
const w = (rel, body) => { mkdirSync(join(G, dirname(rel)), { recursive: true }); writeFileSync(join(G, rel), body); };
w('src/seed.ts', "import { helper } from './helper.js';\nexport class SeedThing { run() { return helper(); } }\n");
w('src/helper.ts', "export function helper() { return 1; }\n");
w('src/caller.ts', "import { SeedThing } from './seed.js';\nexport const c = new SeedThing();\n");
w('src/far.ts', "import { c } from './caller.js';\nexport const f = c;\n");
w('bin/cli.mjs', "import { SeedThing } from '../src/seed.js';\nconsole.log(SeedThing);\n");
w('src/unrelated.ts', "export const nothing = 1;\n");

const gs = S.openStore(G);
gs.beginRun({ runId: 'g1', domains: ['seed'], headSha: 'h' });
const gr = await D.discoverDomain({ store: gs, repoPath: G, domain: 'seed', maxDepth: 1, seedsOverride: ['src/seed.ts'] });
const at = (d) => gs.files().filter((f) => f.depth === d).map((f) => f.path).sort();
ok(JSON.stringify(at(1)) === JSON.stringify(['bin/cli.mjs', 'src/caller.ts', 'src/helper.ts']),
  'depth 1 is exactly what the seed imports and what imports the seed', JSON.stringify(at(1)));
ok(!gs.files().some((f) => f.path === 'src/unrelated.ts'), 'an unrelated file is not swept in');
ok(!gs.files().some((f) => f.path === 'src/far.ts'), 'maxDepth is respected — depth 2 is not walked');
ok(gs.files().every((f) => f.sha && f.why), 'every discovered file carries a blob sha and a reason');
gs.endRun('g1');

// `.js` → `.ts` is load-bearing: under NodeNext every TS file imports its sibling as `.js`.
ok(D.importEdges(G, 'src/seed.ts', readFileSync(join(G, 'src/seed.ts'), 'utf-8'))[0] === 'src/helper.ts',
  "a './helper.js' specifier resolves to helper.ts");
ok(D.importEdges(G, 'src/seed.ts', "import fs from 'node:fs';\nimport x from 'react';\n").length === 0,
  'bare specifiers are not files in this repo and produce no edge');

// A domain that matches nothing writes nothing — the failure this module exists to prevent.
const gs2 = S.openStore(join(TMP, 'nomatch-repo'));
mkdirSync(join(TMP, 'nomatch-repo'), { recursive: true });
gs2.beginRun({ runId: 'g2', domains: ['ghost'], headSha: 'h' });
const gr2 = await D.discoverDomain({ store: gs2, repoPath: join(TMP, 'nomatch-repo'), domain: 'ghost', seedsOverride: [] });
ok(gr2.seeds === 0 && gr2.added === 0 && gs2.files().length === 0,
  'a domain with no seeds writes no files at all', JSON.stringify(gr2));
gs2.endRun('g2');

// The file cap must be REPORTED, never silent — a truncated walk that reads as complete is a lie.
const gs3 = S.openStore(G);
gs3.beginRun({ runId: 'g3', domains: ['seed'], headSha: 'h', restart: true });
const gr3 = await D.discoverDomain({ store: gs3, repoPath: G, domain: 'seed', maxDepth: 3, maxFiles: 2, seedsOverride: ['src/seed.ts'] });
ok(gr3.truncated === true && gr3.added === 2, 'hitting the file cap sets truncated', JSON.stringify(gr3));
gs3.endRun('g3');

// ── C#: a shared name is not a dependency ───────────────────────────────────────
// Measured on a real 3454-file Unity repo: "0 import edge(s) resolved" (C# has no relative
// imports), so every hop fell through to mention edges and depth 2 pulled 337 files for a
// 40-type feature. A mention now has to be REACHABLE — the target's namespace must be one the
// source `using`s, or its own.
{
  const CS = join(TMP, 'cs-repo');
  const w = (rel2, body) => { mkdirSync(join(CS, dirname(rel2)), { recursive: true }); writeFileSync(join(CS, rel2), body); };
  w('Rewards/RewardService.cs', 'namespace Game.Rewards {\nusing Game.Shared;\npublic class RewardService { RewardConfig c; Logger l; }\n}\n');
  w('Rewards/RewardConfig.cs', 'namespace Game.Rewards {\npublic class RewardConfig { public int A; }\n}\n');
  w('Shared/Logger.cs', 'namespace Game.Shared {\npublic class Logger { }\n}\n');
  for (let i = 0; i < 12; i++) {
    w(`Other/Screen${i}.cs`, `namespace Game.Unrelated {\npublic class Screen${i} { void X() { RewardConfig c; } }\n}\n`);
  }
  w('Rewards/RewardService.cs.meta', 'guid: abc\n');

  const cstore = S.openStore(CS);
  cstore.beginRun({ runId: 'cs', domains: ['reward'], headSha: 'h' });
  const cr = await D.discoverDomain({ store: cstore, repoPath: CS, domain: 'reward', seedsOverride: ['Rewards/RewardService.cs'] });
  const paths = cstore.files().map((f) => f.path);
  ok(paths.includes('Rewards/RewardConfig.cs'), 'a type in the SAME namespace is reached without any using');
  ok(paths.includes('Shared/Logger.cs'), 'a type in a namespace the file `using`s is reached');
  ok(!paths.some((p2) => p2.startsWith('Other/')),
    'files that merely NAME the type from an unreachable namespace are excluded — a shared word is not a dependency',
    JSON.stringify(paths));
  ok(cr.added === 3, 'three files, not fifteen', String(cr.added));
  ok(!paths.some((p2) => p2.endsWith('.meta')), 'Unity .meta sidecars never enter the corpus');
  // A real run seeded on Core.csproj AND on ayin's own AYIN-REPORT-*.md, and both produced
  // questions. Seeds must be SOURCE; citations stay unrestricted, since a citation may point at
  // anything that exists.
  writeFileSync(join(CS, 'Core.csproj'), '<Project />\n');
  const sfRepo = join(TMP, 'seed-filter-repo');
  mkdirSync(sfRepo, { recursive: true });
  writeFileSync(join(sfRepo, 'Core.csproj'), '<Project />\n');
  writeFileSync(join(sfRepo, 'NOTES.md'), '# notes\n');
  writeFileSync(join(sfRepo, 'a.ts'), 'export const a = 1;\n');
  const sfStore = S.openStore(sfRepo);
  sfStore.beginRun({ runId: 'sf', domains: ['x'], headSha: 'h' });
  const sf = await D.discoverDomain({
    store: sfStore, repoPath: sfRepo, domain: 'x', maxDepth: 0,
    seedsOverride: ['Core.csproj', 'NOTES.md', 'a.ts'],
  });
  ok(sf.seeds === 1 && sfStore.files().every((f) => f.path === 'a.ts'),
    'a .csproj/.md that EXISTS is still not a seed — a corpus answers questions about code',
    JSON.stringify(sfStore.files().map((f) => f.path)));
  ok(sf.skippedNonSource.length === 2, 'and the skip is reported, not silent', JSON.stringify(sf.skippedNonSource));
  sfStore.endRun('sf');
  ok(D.resolveInRepo(CS, 'Core.csproj') !== null, 'a .csproj still RESOLVES — a citation may point anywhere that exists');
  ok(D.resolveInRepo(CS, 'Rewards/RewardService.cs.meta') === null,
    'a .meta a model names is refused even though it exists — a GUID answers no question');
  cstore.endRun('cs');
}

// ── Unity shape: no namespaces at all, and one ambient type ─────────────────────
// The namespace gate does nothing in a codebase that has no namespaces — which is most Unity C#.
// Measured on a real 3454-file project: depth 1 added 4 files and depth 2 added 393, because a
// widely-used type drags in every file that names it. Popularity is proof a name does NOT
// discriminate, so an over-mentioned name stops being an edge, and each file gets a fan-out budget.
{
  const U = join(TMP, 'unity-repo');
  const wu = (n, body) => { mkdirSync(join(U, 'Assets'), { recursive: true }); writeFileSync(join(U, 'Assets', n), body); };
  wu('RewardService.cs', 'public class RewardService { RewardConfig cfg; ILogger log; }\n');
  wu('RewardConfig.cs', 'public class RewardConfig { public int Amount; }\n');
  wu('ILogger.cs', 'public class ILogger { }\n');
  for (let i = 0; i < 60; i++) wu(`Screen${i}.cs`, `public class Screen${i} { ILogger log; }\n`);
  for (let i = 0; i < 3; i++) wu(`RewardUser${i}.cs`, `public class RewardUser${i} { RewardConfig c; }\n`);

  const ustore = S.openStore(U);
  ustore.beginRun({ runId: 'u', domains: ['reward'], headSha: 'h' });
  const ur = await D.discoverDomain({ store: ustore, repoPath: U, domain: 'reward', maxDepth: 2, seedsOverride: ['Assets/RewardService.cs'] });
  const up = ustore.files().map((f) => f.path);
  ok(up.includes('Assets/RewardConfig.cs'), 'a genuinely used type is still reached with no namespaces present');
  ok(!up.some((x) => x.includes('Screen')),
    'the 60 files naming an AMBIENT type are excluded — popularity proves the name does not discriminate',
    JSON.stringify(up.length));
  ok(!up.includes('Assets/ILogger.cs'), 'the ambient type itself is not pulled in either');
  ok(ur.added < 10, 'a namespace-free repo does not explode', String(ur.added));
  ustore.endRun('u');
}

// ── the direct answer path: the code, one call, no rediscovery ──────────────────
{
  const AN = await import(join(ROOT, 'dist/indulge/answer.js'));
  const DA = join(TMP, 'direct-repo');
  mkdirSync(join(DA, 'src'), { recursive: true });
  writeFileSync(join(DA, 'src/svc.ts'), 'export class Svc { run() {} }\n');
  writeFileSync(join(DA, 'src/user.ts'), 'import { Svc } from "./svc.js";\nnew Svc().run();\n');
  const ds = S.openStore(DA);
  ds.beginRun({ runId: 'd', domains: ['x'], headSha: 'h' });
  ds.addFile({ domain: 'x', path: 'src/svc.ts', depth: 0, why: 'explore seed', sha: 'a' });
  ds.addFile({ domain: 'x', path: 'src/user.ts', depth: 1, why: 'imports src/svc.ts', sha: 'b' });

  const ctx = AN.contextFilesFor(ds, 'src/svc.ts');
  ok(ctx[0] === 'src/svc.ts', 'the file the question is about comes first');
  ok(ctx.includes('src/user.ts'), 'a file whose reason names it is a neighbour — the graph already knew');
  ok(AN.contextFilesFor(ds, 'src/user.ts').includes('src/svc.ts'),
    'the INBOUND edge counts too: the file this one was reached from');

  const src = AN.buildSources(DA, ctx);
  ok(/^1 export class Svc/m.test(src), 'sources carry 1-based line numbers — what a CITE must refer to');
  ok(src.indexOf('src/svc.ts') < src.indexOf('src/user.ts'),
    'the question\'s own file leads, so questions about it share a cached prefix');
  const tiny = AN.buildSources(DA, ctx, 60);
  ok(/CLIPPED|not shown/.test(tiny), 'exceeding the context budget is ANNOUNCED, never silent');

  // one call, no explore
  let calls = 0;
  const dq = S.questionId('what does run do?', 'src/svc.ts', null);
  ds.addQuestion({ id: dq, file: 'src/svc.ts', entity: null, category: 'functionality', text: 'what does run do?' });
  const dr = await AN.answerQuestions({
    store: ds, repoPath: DA,
    ask: async (prompt) => { calls++; return `It does nothing.\nCITE: src/svc.ts:1-1`; },
  });
  ok(calls === 1 && dr.answered === 1, 'one model call per question, not an investigation', `${calls} call(s)`);
  ds.endRun('d');
}

// ── stage 2: generation bookkeeping — resume, caps and dedup, without a GPU ──────
// These are the parts that decide whether a night's work is lost or repeated, and none of them
// should need a model to prove. The `ask` seam exists for exactly this.

const Q = await import(join(ROOT, 'dist/indulge/questions.js'));

const parsed = Q.parseQuestions('Here are the questions:\n- What runs first?\n2. Why is it ordered that way?\nNONE\ntiny\n* What breaks if it is reordered?\n', 10);
ok(parsed.length === 3, 'preamble, NONE and too-short lines are dropped', JSON.stringify(parsed));
ok(parsed[0] === 'What runs first?' && parsed[1] === 'Why is it ordered that way?' && parsed[2] === 'What breaks if it is reordered?',
  'bullets, numbering and quoting are stripped', JSON.stringify(parsed));
ok(Q.parseQuestions('- a question that is long enough\n- another question long enough\n', 1).length === 1, 'the per-target cap is enforced');
ok(Q.parseQuestions('NONE\n', 4).length === 0, 'NONE means zero questions, not a filled quota');

const ENT = join(TMP, 'ent-repo');
mkdirSync(join(ENT, 'src'), { recursive: true });
const tsSource = 'export class Widget {\n  public run(): void {}\n  private hidden(): void {}\n  public get size(): number { return 1; }\n}\n';
writeFileSync(join(ENT, 'src/widget.ts'), tsSource);
const targets = Q.targetsFor('src/widget.ts', tsSource, 12);
ok(targets[0] === null, 'the first target is the file as a whole');
const names = targets.filter(Boolean).map((e) => `${e.kind} ${e.name}`);
ok(names.includes('class Widget'), 'the declared type is a target', JSON.stringify(names));
ok(names.some((n) => n.includes('Widget.run')), 'a public method is a target', JSON.stringify(names));
ok(!names.some((n) => n.includes('hidden')), 'a private member is not a target — nobody asks about a private helper');
ok(Q.targetsFor('src/widget.ts', tsSource, 1).length <= 2, 'maxEntities caps the target list');

const qs = S.openStore(ENT);
qs.beginRun({ runId: 'q1', domains: ['w'], headSha: 'h' });
qs.addFile({ domain: 'w', path: 'src/widget.ts', depth: 0, why: 'seed', sha: S.blobSha(tsSource) });

let calls = 0;
const ask = async () => { calls++; return '- What does run() guarantee about ordering?\n- What happens if size is read first?\n'; };
const q1 = await Q.generateQuestions({ store: qs, repoPath: ENT, categories: ['gotchas'], ask });
ok(q1.calls > 0 && q1.generated > 0, 'generation writes questions', JSON.stringify(q1));

const before = calls;
const q2 = await Q.generateQuestions({ store: qs, repoPath: ENT, categories: ['gotchas'], ask });
ok(calls === before && q2.calls === 0 && q2.generated === 0 && q2.skipped > 0,
  'a resumed run re-asks the model NOTHING — the (file, entity, category) triple is the resume key', JSON.stringify(q2));
ok(qs.totals().questions === q1.generated, 'resume adds no duplicate questions', String(qs.totals().questions));

// The same text about a different entity is a different question; about the SAME entity it is one.
const e1 = { kind: 'method', name: 'Widget.run', file: 'src/widget.ts' };
ok(S.questionId('same words', 'src/widget.ts', e1) !== S.questionId('same words', 'src/widget.ts', null),
  'identical wording about a method and about the file are separate questions');
qs.endRun('q1'); // release before another store opens the same corpus below

// A model that is down must not lose what is already written, and must leave the triple retryable.
const qf = S.openStore(join(TMP, 'fail-repo'));
mkdirSync(join(TMP, 'fail-repo', 'src'), { recursive: true });
writeFileSync(join(TMP, 'fail-repo/src/widget.ts'), tsSource);
qf.beginRun({ runId: 'qf', domains: ['w'], headSha: 'h' });
qf.addFile({ domain: 'w', path: 'src/widget.ts', depth: 0, why: 'seed', sha: S.blobSha(tsSource) });
const qfr = await Q.generateQuestions({ store: qf, repoPath: join(TMP, 'fail-repo'), categories: ['gotchas'], maxEntities: 0, ask: async () => { throw new Error('model down'); } });
ok(qfr.generated === 0 && qf.totals().questions === 0, 'a failed generation writes nothing');
let retried = 0;
await Q.generateQuestions({ store: qf, repoPath: join(TMP, 'fail-repo'), categories: ['gotchas'], maxEntities: 0, ask: async () => { retried++; return '- A question long enough to keep\n'; } });
ok(retried === 1 && qf.totals().questions === 1, 'the failed triple is retried on the next run, not marked done');
qf.endRun('qf');

// A cooperative stop lands BETWEEN records — an overnight job must be killable without corruption.
const qstop = S.openStore(ENT);
qstop.beginRun({ runId: 'q2', domains: ['w'], headSha: 'h', restart: true });
qstop.addFile({ domain: 'w', path: 'src/widget.ts', depth: 0, why: 'seed', sha: S.blobSha(tsSource) });
const stopped = await Q.generateQuestions({ store: qstop, repoPath: ENT, ask, shouldStop: () => true });
ok(stopped.stopped === true && stopped.calls === 0, 'shouldStop halts before spending a call', JSON.stringify(stopped));
qstop.endRun('q2');

// ── stage 3: NO PROOF, NO CHUNK ─────────────────────────────────────────────────
// The corpus's whole value is that a retrieved chunk is true. A plausible-but-wrong chunk is worse
// than a missing one, because at retrieval time nothing distinguishes it from a correct one — it
// gets injected into a prompt, believed, and acted on. So verification is adversarial here.

const AN = await import(join(ROOT, 'dist/indulge/answer.js'));

const V = join(TMP, 'verify-repo');
mkdirSync(join(V, 'src'), { recursive: true });
const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
writeFileSync(join(V, 'src/a.ts'), tenLines);

const keep = AN.verifyCitations(V, 'CITE: src/a.ts:2-4');
ok(keep.citations.length === 1 && keep.rejected === 0, 'a resolvable citation is kept');
ok(keep.citations[0].sha === S.blobSha(tenLines), 'the sha is computed from disk, not taken from the model');
ok(keep.citations[0].startLine === 2 && keep.citations[0].endLine === 4, 'the line range is preserved');

const reject = (text, label) => {
  const r = AN.verifyCitations(V, text);
  ok(r.citations.length === 0 && r.rejected === 1, label, JSON.stringify(r.citations));
};
reject('CITE: src/a.ts:0-3', 'line 0 is refused — citations are 1-indexed');
reject('CITE: src/a.ts:4-2', 'an inverted range is refused');
reject('CITE: src/a.ts:1-11', 'a range past the end of the file is refused');
reject('CITE: src/nope.ts:1-2', 'a citation to a file that does not exist is refused');
reject('CITE: ../../../etc/passwd:1-2', 'a citation escaping the repo is refused');
reject('CITE: /etc/passwd:1-2', 'an absolute path outside the repo is refused');

const none = AN.verifyCitations(V, 'The answer is obviously 42, no proof needed.');
ok(none.citations.length === 0 && none.rejected === 0, 'an answer with no citation yields none');
ok(AN.verifyCitations(V, 'CITE: src/a.ts:2-4\nCITE: src/a.ts:2-4').citations.length === 1,
  'a repeated citation is counted once');
ok(AN.stripCitations('Answer.\n\nCITE: src/a.ts:1-2\n') === 'Answer.', 'CITE lines are stripped from the prose');

// The end-to-end guarantee: a model that cites nothing resolvable must produce NO chunk.
const av = S.openStore(V);
av.beginRun({ runId: 'a1', domains: ['d'], headSha: 'h' });
av.addFile({ domain: 'd', path: 'src/a.ts', depth: 0, why: 'seed', sha: S.blobSha(tenLines) });
const mkQ = (text, category = 'functionality') => {
  const id = S.questionId(text, 'src/a.ts', null);
  av.addQuestion({ id, file: 'src/a.ts', entity: null, category, text });
  return id;
};
const badId = mkQ('What does this do when the input is empty?');
const bad = await AN.answerQuestions({
  store: av, repoPath: V,
  investigate: async () => 'I looked at the file and formed a strong opinion about it.',
  ask: async () => 'It handles the empty case by returning early.\nCITE: src/imaginary.ts:1-5',
});
ok(bad.answered === 0 && bad.failed === 1 && bad.rejectedCitations === 1,
  'an answer whose only citation is unresolvable is FAILED, never stored', JSON.stringify(bad));
ok(av.chunks().length === 0, 'no chunk reached disk');
ok(av.questions().find((q) => q.id === badId).status === 'failed', 'the question is marked failed');
ok(/citation/i.test(av.questions().find((q) => q.id === badId).note || ''), 'the failure note says why');

const goodId = mkQ('Which line carries the boundary condition?');
const good = await AN.answerQuestions({
  store: av, repoPath: V,
  investigate: async () => 'Read src/a.ts, lines 1-10.',
  ask: async () => 'Line 3 carries it.\nCITE: src/a.ts:3-3\nCITE: src/gone.ts:1-2',
});
ok(good.answered === 1 && good.rejectedCitations === 1,
  'a partly-verifiable answer keeps the proof that resolves and drops the rest', JSON.stringify(good));
const chunk = av.chunks()[0];
ok(chunk.citations.length === 1 && chunk.citations[0].path === 'src/a.ts', 'only the verified citation is stored');
ok(chunk.files.length === 1 && chunk.sourceSha === S.blobSha(tenLines), 'sourceSha is the invalidation key');
ok(chunk.chunkId === S.chunkId(av.key, 'src/a.ts', null, 'functionality', goodId), 'the chunk id is the derived one');
ok(av.questions().find((q) => q.id === goodId).status === 'answered', 'the question is marked answered');

// Resume: an already-chunked question costs nothing and is not re-asked.
let asked = 0;
const again = await AN.answerQuestions({
  store: av, repoPath: V,
  investigate: async () => { asked++; return 'x'; }, ask: async () => { asked++; return 'y'; },
});
ok(asked === 0 && again.attempted === 0, 'a resumed run re-answers nothing', JSON.stringify(again));

// A stop lands between questions, and a vanished file fails rather than throwing.
const stopId = mkQ('Anything at all?');
const halted = await AN.answerQuestions({ store: av, repoPath: V, shouldStop: () => true, ask: async () => 'x' });
ok(halted.stopped === true && halted.attempted === 0, 'shouldStop halts before spending a call');
rmSync(join(V, 'src/a.ts'));
const gone = await AN.answerQuestions({ store: av, repoPath: V, ask: async () => 'x' });
ok(gone.failed >= 1 && av.questions().find((q) => q.id === stopId).status === 'failed',
  'a file that vanished between stages fails the question instead of throwing');
av.endRun('a1');

// git-category facts come from git, and an invented sha is caught.
ok(AN.gitShasResolve(ROOT, 'see commit deadbeefdeadbeef for details') === false, 'an invented commit sha is refused');
ok(AN.answerFromGit(join(TMP, 'not-a-repo'), 'x.ts') === null, 'a non-repo yields no git answer');

// ── the command surface, and the audit deliverable ──────────────────────────────

const IX = await import(join(ROOT, 'dist/indulge/index.js'));
const RP = await import(join(ROOT, 'dist/indulge/report.js'));

const p1 = IX.parseArgs(['--domains', 'a, b ,,c', '--depth', '2', '--max-questions', '5']);
ok(JSON.stringify(p1.args.domains) === '["a","b","c"]', 'domains split and trim, empties dropped', JSON.stringify(p1.args.domains));
ok(p1.args.maxDepth === 2 && p1.args.maxQuestions === 5 && p1.errors.length === 0, 'numeric flags parse');
ok(IX.parseArgs(['--domains=x', '--depth=3']).args.maxDepth === 3, '--flag=value form works too');
ok(IX.parseArgs(['--frobnicate']).errors.length === 1, 'an unknown flag is an error, never guessed at');
ok(IX.parseArgs(['--depth', 'lots']).errors.length === 1, 'a non-numeric count is refused');
ok(IX.parseArgs([]).args.domains.length === 0, 'no domains parses to none (the caller refuses it)');

// The report re-verifies rather than trusting the flag set when the chunk was stored: "the proof
// resolved once" and "the proof resolves now" are different claims, and a stale chunk presented as
// current defeats the document's purpose.
const R = join(TMP, 'report-repo');
mkdirSync(join(R, 'src'), { recursive: true });
const src = 'a\nb\nc\nd\n';
writeFileSync(join(R, 'src/f.ts'), src);
const repStore = S.openStore(R);
repStore.beginRun({ runId: 'r1', domains: ['d'], headSha: 'h' });
repStore.addFile({ domain: 'd', path: 'src/f.ts', depth: 0, why: 'seed', sha: S.blobSha(src) });
const rq = S.questionId('what is b?', 'src/f.ts', null);
repStore.addQuestion({ id: rq, file: 'src/f.ts', entity: null, category: 'functionality', text: 'what is b?' });
const rc = {
  chunkId: S.chunkId(repStore.key, 'src/f.ts', null, 'functionality', rq), questionId: rq, repoKey: repStore.key,
  repoPath: R, domain: 'd', question: 'what is b?', answer: 'It is the second line.',
  files: ['src/f.ts'], citations: [{ path: 'src/f.ts', startLine: 2, endLine: 2, sha: S.blobSha(src) }],
  entity: null, category: 'functionality', model: 'test', createdAt: new Date().toISOString(), sourceSha: S.blobSha(src),
};
repStore.saveChunk(rc);
ok(RP.chunkStillResolves(R, rc) === true, 'a chunk whose bytes are unchanged still resolves');
const rep1 = RP.writeReport({ store: repStore, repoPath: R });
ok(existsSync(rep1.path) && rep1.chunks === 1 && rep1.stale === 0, 'the report is written and counts its chunks', JSON.stringify(rep1));
ok(readFileSync(rep1.path, 'utf-8').includes('src/f.ts:2-2'), 'a citation is rendered as path:start-end so a reader can jump to it');

writeFileSync(join(R, 'src/f.ts'), 'a\nCHANGED\nc\nd\n');
ok(RP.chunkStillResolves(R, rc) === false, 'editing the cited file makes the chunk stale');
const rep2 = RP.writeReport({ store: repStore, repoPath: R });
ok(rep2.stale === 1 && readFileSync(rep2.path, 'utf-8').includes('STALE'),
  'the report marks stale chunks instead of presenting them as current', JSON.stringify(rep2));
repStore.endRun('r1');

// ── staleness: the corpus assists an agent that EDITS CODE ──────────────────────
// A chunk that went stale during the session is the dangerous case — it is a confident claim with a
// citation attached, and the citation makes it MORE believable. Chunks are never silently dropped
// (a chunk written on dev is usually still broadly true) and never silently trusted either.

const ST = await import(join(ROOT, 'dist/indulge/staleness.js'));
const AN2 = await import(join(ROOT, 'dist/indulge/answer.js'));

const G2 = join(TMP, 'stale-repo');
mkdirSync(join(G2, 'src'), { recursive: true });
const gsh = (cmd) => execFileSync('bash', ['-c', cmd], { cwd: G2, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
writeFileSync(join(G2, 'src/a.ts'), 'one\ntwo\nthree\nfour\n');
gsh('git init -q . && git config user.email t@t && git config user.name t && git add -A && git commit -qm first && git branch -M dev');

const prov = AN2.repoProvenance(G2);
ok(prov.branch === 'dev' && /^[0-9a-f]{40}$/.test(prov.commit), 'provenance records the branch NAME and the exact commit', JSON.stringify(prov));

const mkChunk = () => ({
  chunkId: 'c', questionId: 'q', repoKey: 'k', repoPath: G2, domain: 'd', question: 'what?', answer: 'a',
  files: ['src/a.ts'],
  citations: [{ path: 'src/a.ts', startLine: 2, endLine: 3, sha: S.blobSha(readFileSync(join(G2, 'src/a.ts'))) }],
  entity: null, category: 'functionality', model: 'm', createdAt: '2026-08-14T10:00:00Z', sourceSha: 'x',
  branch: prov.branch, commit: prov.commit,
});
const base = mkChunk();

const fresh = ST.assessChunk(G2, base);
ok(fresh.state === 'fresh' && !/STALE/.test(fresh.label), 'unchanged cited files are fresh', fresh.label);
ok(fresh.label.includes('on dev'), 'the label leads with the BRANCH — a sha means nothing to an agent', fresh.label);
ok(!fresh.label.includes(prov.commit), 'the sha stays out of the agent-facing line', fresh.label);

writeFileSync(join(G2, 'src/a.ts'), 'one\nTWO CHANGED\nthree\nfour\nfive\n');
const dirty = ST.assessChunk(G2, base);
ok(dirty.state === 'stale' && dirty.uncommitted === true, 'an uncommitted edit — the agent\'s own, usually — is stale', dirty.label);
ok(/uncommitted changes/.test(dirty.label), 'and is named as uncommitted rather than as a branch difference', dirty.label);
ok(/\+2/.test(dirty.label), 'the label carries the size of the change so the model can calibrate', dirty.label);

gsh('git add -A && git commit -qm second && git checkout -q -b feat/x');
writeFileSync(join(G2, 'src/a.ts'), 'one\nTWO\nthree\nfour\nfive\nsix\nseven\n');
gsh('git add -A && git commit -qm third');
const onFeature = ST.assessChunk(G2, base);
ok(onFeature.state === 'stale' && onFeature.label.includes('on dev'),
  'a chunk written on dev, read from a feature branch, says so', onFeature.label);
ok(onFeature.changed.includes('src/a.ts'), 'the label names WHICH file moved, though the whole chunk is stale');

// Chunk-level, not per-citation: one moved file marks the whole chunk, because chunks are built
// around interconnected things and the claim is about how they fit together.
const twoFiles = { ...base, citations: [
  { path: 'src/a.ts', startLine: 1, endLine: 2, sha: 'deadbeef' },
  { path: 'src/a.ts', startLine: 3, endLine: 4, sha: S.blobSha(readFileSync(join(G2, 'src/a.ts'))) },
] };
ok(ST.assessChunk(G2, twoFiles).state === 'stale', 'one stale citation makes the whole chunk stale');

gsh('git checkout -q dev && git checkout -q -b other && git commit -q --allow-empty -m other');
const otherSha = gsh('git rev-parse HEAD');
gsh('git checkout -q dev');
const divergent = ST.assessChunk(G2, { ...mkChunk(), branch: 'other', commit: otherSha });
ok(divergent.state === 'divergent' && /not in your current history/.test(divergent.label),
  'a chunk from a branch you are not standing on is DIVERGENT, not merely stale', divergent.label);

rmSync(join(G2, 'src/a.ts'));
ok(ST.assessChunk(G2, base).state === 'missing', 'a cited file that no longer exists is its own state');

const noProv = ST.assessChunk(G2, { ...base, branch: undefined, commit: undefined });
ok(/branch unknown/.test(noProv.label), 'a chunk predating provenance says so instead of claiming a branch', noProv.label);

// ── retrieval: the corpus finally pays back ─────────────────────────────────────
// `read_file` PUSHES what is known about the file just read (an exact path lookup — no embedding, no
// threshold, so it cannot surface a plausible-but-unrelated chunk). `corpus_search` is the PULL half.
// Both label staleness, because a retrieved chunk is exactly as dangerous as an injected one.

const INJ = await import(join(ROOT, 'dist/indulge/inject.js'));
const MODES = await import(join(ROOT, 'dist/modes.js'));

const IR = join(TMP, 'inject-repo');
mkdirSync(join(IR, 'src'), { recursive: true });
const rsrc = 'alpha\nbeta\ngamma\n';
writeFileSync(join(IR, 'src/x.ts'), rsrc);
const istore = S.openStore(IR);
istore.beginRun({ runId: 'i1', domains: ['d'], headSha: 'h' });
const iq = S.questionId('what is beta?', 'src/x.ts', null);
istore.addQuestion({ id: iq, file: 'src/x.ts', entity: null, category: 'functionality', text: 'what is beta?' });
istore.saveChunk({
  chunkId: S.chunkId(istore.key, 'src/x.ts', null, 'functionality', iq), questionId: iq, repoKey: istore.key,
  repoPath: IR, domain: 'd', question: 'what is beta?', answer: 'Beta is the second line and nothing depends on it.',
  files: ['src/x.ts'], citations: [{ path: 'src/x.ts', startLine: 2, endLine: 2, sha: S.blobSha(rsrc) }],
  entity: null, category: 'functionality', model: 'm', createdAt: '2026-08-14T10:00:00Z', sourceSha: S.blobSha(rsrc),
  branch: 'dev', commit: 'abc123', domains: ['d'],
});
istore.endRun('i1');

const block = INJ.corpusBlockFor(IR, 'src/x.ts');
ok(block && /what is beta/.test(block), 'reading a file surfaces what the corpus answered about it');
ok(block.includes('on dev'), 'the injected chunk carries its provenance label', (block.match(/\[corpus[^\]]*\]/) || [''])[0]);
ok(/src\/x.ts:2-2/.test(block), 'the citation is shown so the agent can go and check');

// Ranking: the chunk about the lines ON SCREEN wins, not the most recent one. Measured wrong
// before this — reading lines 115-118 of a file surfaced a chunk about lines 277-287 first.
{
  const far = S.questionId('what is far away?', 'src/x.ts', null);
  istore.addQuestion({ id: far, file: 'src/x.ts', entity: null, category: 'gotchas', text: 'what is far away?' });
  istore.saveChunk({
    chunkId: S.chunkId(istore.key, 'src/x.ts', null, 'gotchas', far), questionId: far, repoKey: istore.key,
    domains: ['d'], question: 'what is far away?', answer: 'About the end of the file.',
    files: ['src/x.ts'], citations: [{ path: 'src/x.ts', startLine: 3, endLine: 3, sha: S.blobSha(rsrc) }],
    entity: null, category: 'gotchas', model: 'm', createdAt: '2027-01-01T00:00:00Z',  // NEWER
    sourceSha: S.blobSha(rsrc), branch: 'dev', commit: 'abc123',
  });
  const near = INJ.corpusBlockFor(IR, 'src/x.ts', { startLine: 2, endLine: 2 });
  ok(/what is beta/.test(near) && !/far away/.test(near),
    'the chunk citing the lines being read wins over a NEWER chunk about elsewhere in the file');
  const wide = INJ.corpusBlockFor(IR, 'src/x.ts', { startLine: 1, endLine: 300 });
  ok((wide.match(/^Q\. /gm) || []).length === 2, 'a whole-file read may carry two chunks; a narrow peek only one');
  ok((near.match(/^Q\. /gm) || []).length === 1, 'a four-line peek does not come back with a briefing attached');
}

ok(INJ.domainsOf({ domains: ['a', 'b'] }).length === 2, 'a chunk can belong to several domains');
ok(INJ.domainsOf({ domain: 'legacy' })[0] === 'legacy',
  'a chunk written before domains[] still reports its single domain');
ok(/not the code/.test(block), 'the block says plainly that these are notes, not the source');
ok(INJ.corpusBlockFor(IR, 'src/never-mentioned.ts') === null, 'a file with no chunks injects nothing');

writeFileSync(join(IR, 'src/x.ts'), 'alpha\nBETA CHANGED\ngamma\n');
ok(/STALE/.test(INJ.corpusBlockFor(IR, 'src/x.ts')), 'editing the file flips the injected label to STALE');
writeFileSync(join(IR, 'src/x.ts'), rsrc);

MODES.setCorpusInjection(false);
ok(INJ.corpusBlockFor(IR, 'src/x.ts') === null, '/corpus off injects nothing — the switch is what makes "does it help?" measurable');
MODES.setCorpusInjection(true);
ok(INJ.corpusBlockFor(IR, 'src/x.ts') !== null, '/corpus on restores it');

ok(/what is beta/.test(await INJ.corpusSearch(IR, 'beta', 3)), 'corpus_search finds a chunk by keyword');
ok(/Nothing in the corpus matches/.test(await INJ.corpusSearch(IR, 'quantum blockchain', 3)),
  'a query that matches nothing says so instead of returning the nearest thing');
ok(/ayin indulge/.test(await INJ.corpusSearch(join(TMP, 'no-corpus-repo'), 'anything')),
  'searching a repo with no corpus names the command that would build one');

// ── the cheap pass: find chunks by NAME before anything semantic ────────────────

const LX = await import(join(ROOT, 'dist/indulge/lexicon.js'));

ok(LX.normalizeName('noteShape') === LX.normalizeName('NoteShape')
  && LX.normalizeName('note_shape') === LX.normalizeName('noteShape'),
  'case, camelCase and underscores collapse to one index key — otherwise they never become candidates');
ok(LX.normalizeName('HTTPServer') === 'http server', 'an acronym boundary splits too');
ok([...LX.trigrams('noteshape')].includes('not') && [...LX.trigrams('noteshape')].includes('ape'),
  'ALL trigrams are indexed, not just the leading three');
ok(LX.levenshtein('noteshape', 'ntoeshape') === 2, 'edit distance measures a transposed typo');
ok(LX.levenshtein('noteshape', 'somethingelse', 3) > 3, 'a far-off name bails out instead of computing a full matrix');

ok(LX.symbolsIn('why does `noteShape` use `tailApex`?').includes('noteShape'),
  'backticked identifiers are pulled out of question text');
ok(LX.symbolsIn('the `groups(inner)` generator').includes('groups'), 'a call is indexed by its name, without the args');
ok(!LX.symbolsIn('the quick brown fox jumped').length, 'plain prose contributes no symbols — an index of everything is no index');

{
  const lchunks = [{
    chunkId: 'L1', question: 'In `noteShape`, why is the `tailApex` found by shrinking the box?',
    answer: 'It removes each vertex.', files: ['src/extract.mjs'],
    citations: [{ path: 'src/extract.mjs', startLine: 1, endLine: 9, sha: 'x' }],
    entity: null, category: 'gotchas', domains: ['render'],
  }];
  const lex = LX.buildLexicon(lchunks);
  const top = (q) => LX.lookupNames(lex, q)[0];
  ok(top('noteShape')?.score === 1, 'an exact symbol match scores 1');
  ok(top('noteshape')?.handle.raw === 'noteShape', 'case-only difference still resolves');
  ok(top('ntoeShape')?.handle.raw === 'noteShape',
    'a typo in the FIRST THREE characters still finds it — the reason for all-trigrams over leading-3');
  ok(top('tail apex')?.handle.raw === 'tailApex', 'a two-word query finds the camelCase symbol');
  ok(top('extract.mjs')?.handle.kind === 'file', 'file names are handles too');
  ok(LX.lookupNames(lex, 'RewardService').length === 0, 'a name that is not in the corpus matches nothing');
  ok(LX.lookupNames(lex, 'the and for with').length === 0, 'stopwords match nothing');
}

// ── vectors: the expensive pass, and the rules that keep it honest ──────────────

const EM = await import(join(ROOT, 'dist/indulge/embed.js'));

ok(EM.cosine([1, 0, 0], [1, 0, 0]) === 1, 'identical vectors score 1');
ok(Math.abs(EM.cosine([1, 0, 0], [0, 1, 0])) < 1e-9, 'orthogonal vectors score 0');
ok(EM.cosine([2, 0], [8, 0]) === 1, 'magnitude is divided out — only DIRECTION matters');

{
  // a domain's vector is the MEAN of its chunks', not the embedding of its arbitrary name
  const vs = [
    { chunkId: 'x', domains: ['a'], model: 'm', dim: 2, vector: [1, 0] },
    { chunkId: 'y', domains: ['a'], model: 'm', dim: 2, vector: [0, 1] },
    { chunkId: 'z', domains: ['b'], model: 'm', dim: 2, vector: [-1, 0] },
  ];
  const cents = EM.domainCentroids(vs);
  ok(Math.abs(cents.get('a')[0] - 0.5) < 1e-9 && Math.abs(cents.get('a')[1] - 0.5) < 1e-9,
    'a domain centroid is the mean of its chunks');

  // coarse-then-fine: a chunk in a losing domain is not a candidate, however it scores
  const hits = EM.vectorSearch(vs, [1, 0], { topDomains: 1, limit: 5 });
  ok(hits.every((h) => h.chunkId !== 'z'),
    'a chunk in an unranked domain cannot win — scoping beats scoring');
  ok(hits[0].chunkId === 'x', 'within the chosen domain, the closest chunk wins');
  ok(EM.vectorSearch(vs, [1, 0], { topDomains: 1, limit: 5, within: new Set(['y']) })
    .every((h) => h.chunkId === 'y'), 'a name-restricted candidate set is respected');
}

{
  // vectors from another model must never be treated as usable
  const vstore = S.openStore(join(TMP, 'vec-repo'));
  mkdirSync(join(TMP, 'vec-repo'), { recursive: true });
  vstore.beginRun({ runId: 'v', domains: ['d'], headSha: 'h' });
  const vq = S.questionId('q?', 'f.ts', null);
  vstore.addQuestion({ id: vq, file: 'f.ts', entity: null, category: 'functionality', text: 'q?' });
  vstore.saveChunk({
    chunkId: S.chunkId(vstore.key, 'f.ts', null, 'functionality', vq), questionId: vq, repoKey: vstore.key,
    domains: ['d'], question: 'q?', answer: 'a', files: ['f.ts'],
    citations: [{ path: 'f.ts', startLine: 1, endLine: 1, sha: 'x' }], entity: null,
    category: 'functionality', model: 'm', createdAt: '2026-08-14T00:00:00Z', sourceSha: 'x',
  });
  let calls = 0;
  const r1 = await EM.embedCorpus({ store: vstore, embed: async () => { calls++; return [1, 2, 3]; } });
  ok(r1.embedded === 1 && calls === 1, 'each chunk is embedded once');
  const r2 = await EM.embedCorpus({ store: vstore, embed: async () => { calls++; return [1, 2, 3]; } });
  ok(r2.embedded === 0 && r2.skipped === 1 && calls === 1,
    're-running embeds nothing — resumable, like every other stage');
  ok(EM.loadVectors(vstore)[0].model === EM.embedModel(),
    'every vector records the model that produced it — a vector is only comparable to its own kind');
  const stopped = await EM.embedCorpus({ store: vstore, shouldStop: () => true, embed: async () => [1] });
  ok(stopped.stopped === true, 'a kill lands between chunks');
  vstore.endRun('v');
}

// ── prompt-level lookup: /embed, /embedthis, and the automatic first prompt ──────
// A prompt is a far worse retrieval key than a file path — a large share of turns are `continue`
// and `yes`, and embedding those returns noise with a confident score. Hence opt-in, with the
// first prompt of a session as the one reliable exception.

ok(await INJ.corpusForPrompt(IR, 'continue') === null, '"continue" carries no query — no lookup');
ok(await INJ.corpusForPrompt(IR, 'yes') === null, '"yes" likewise');
ok(await INJ.corpusForPrompt(IR, 'ok do it') === null, 'a two-word acknowledgement is not a question');
ok(await INJ.corpusForPrompt(join(TMP, 'no-corpus-repo'), 'what does the widget do') === null,
  'no corpus means no block, not an apology injected into the prompt');
ok((await INJ.corpusForPrompt(IR, 'what is beta in this file')) !== null,
  'a real question does retrieve');

INJ.setPendingCorpus('BLOCK');
ok(INJ.pendingCorpus() === 'BLOCK', 'the block survives being read — a turn spans many rounds');
ok(INJ.pendingCorpus() === 'BLOCK', 'and reading it twice does not consume it');
INJ.clearPendingCorpus();
ok(INJ.pendingCorpus() === null, 'clearing at turn end keeps one turn\'s lookup out of the next');

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\nindulge check: ${fails} FAILURE(S)\n` : '\nindulge check: ok\n');
process.exit(fails ? 1 : 0);

