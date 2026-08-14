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
ok(S.repoKey(REPO) !== S.repoKey(join(TMP, 'other-checkout')),
  'two checkouts of one repo are separate corpora (they sit on different commits)');

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

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\nindulge check: ${fails} FAILURE(S)\n` : '\nindulge check: ok\n');
process.exit(fails ? 1 : 0);
