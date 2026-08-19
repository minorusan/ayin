#!/usr/bin/env node
/**
 * check-explore-corpus — what `explore` appends from the corpus, and what it must never append.
 *
 * `npm run check:explore-corpus` (needs a build). Hermetic: a throwaway `AYIN_RAG_DIR`, hand-written
 * chunks and vectors, and `fetch` stubbed so the embedding "endpoint" is a function in this file. No
 * network, no GPU.
 *
 * THE FOUR THINGS IT PINS, each because the alternative is a wrong answer that reads like a right one:
 *   · `functionality` ONLY. `git`/`dependencies`/`connections`/`gotchas` answer questions the reader did
 *     not ask here, and a `ticket` chunk is a requirement rather than a description of the code.
 *   · a chunk the audit REJECTED never reaches a prompt. That is the entire point of the audit.
 *   · SEMANTIC only, and absent rather than degraded: no vectors from the configured model → no block.
 *     "Not embedded yet" is not "nothing known", and a keyword pass here would restate the localization.
 *   · a failed embedding call is REPORTED, never swallowed. A silent fallback once cost four rounds of
 *     debugging, because the wrong answer read as a bad corpus rather than as a pass that never ran.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const rag = mkdtempSync(join(tmpdir(), 'ayin-xc-rag-'));
const repo = mkdtempSync(join(tmpdir(), 'ayin-xc-repo-'));
process.env.AYIN_RAG_DIR = rag;
process.env.AYIN_EMBED_MODEL = 'fake-embed';
process.env.AYIN_EMBED_URL = 'http://127.0.0.1:1';   // never reached: fetch is stubbed
execFileSync('git', ['-C', repo, 'init', '-q']);
writeFileSync(join(repo, 'a.ts'), 'export function reward() {}\n');

// A one-dimensional "embedding space": the query lands at 1, and a chunk's vector is how close it is.
let embedFails = null;
globalThis.fetch = async () => {
  if (embedFails) throw embedFails;
  return { ok: true, status: 200, json: async () => ({ embedding: [1, 0] }) };
};

(await import(`file://${join(ROOT, 'dist', 'tool-wiring.js')}`)).ensureToolRuntime();
const { openStore, blobSha } = await import(`file://${join(ROOT, 'dist', 'indulge', 'store.js')}`);
const { exploreCorpusBlock, EXPLORE_CATEGORY } = await import(`file://${join(ROOT, 'dist', 'tools', 'explore', 'corpus.js')}`);

const store = openStore(repo);
mkdirSync(store.dir, { recursive: true });
// A corpus IS its manifest — `store.exists()` reads that file, and a directory of chunks without one is
// not a corpus. Caught by this gate on its first run: every block was absent for the right reason.
store.beginRun({ runId: 'gate', domains: ['rewards'], headSha: '' });
store.endRun('gate', 'finished');
store.releaseLock();
const sha = blobSha('export function reward() {}\n');
const chunk = (id, category, question, extra = {}) => ({
  chunkId: id, questionId: `q-${id}`, repoKey: store.key, domains: ['rewards'],
  question, answer: `Answer about ${question}`, files: ['a.ts'],
  citations: [{ path: 'a.ts', startLine: 1, endLine: 1, sha, ...(extra.cite ?? {}) }],
  entity: null, category, model: 'fake-model', createdAt: '2026-08-01T00:00:00.000Z', sourceSha: sha,
  ...extra.rest,
});
const chunks = [
  chunk('c-func-near', EXPLORE_CATEGORY, 'how the reward is picked'),
  chunk('c-func-far', EXPLORE_CATEGORY, 'how the reward is stored'),
  chunk('c-gotcha', 'gotchas', 'what breaks when the reward is null'),
  chunk('c-ticket', 'ticket', 'what the reward SHOULD be', {
    cite: { ticket: 'PROJ-9', at: '2026-07-01' },
  }),
  chunk('c-rejected', EXPLORE_CATEGORY, 'a claim the audit condemned', {
    rest: { qa: { verdict: 'reject', why: 'unsupported', by: 'model', at: '2026-08-02T00:00:00.000Z' } },
  }),
];
for (const c of chunks) store.saveChunk(c);

const vectors = (ids) => writeFileSync(join(store.dir, 'vectors.jsonl'),
  ids.map(([id, v]) => JSON.stringify({ chunkId: id, domains: ['rewards'], model: 'fake-embed', dim: 2, vector: v })).join('\n') + '\n');

// ── nothing embedded yet ────────────────────────────────────────────────────────

console.log('\nbefore any vectors exist');
ok(await exploreCorpusBlock(repo, 'how is the reward picked') === null,
  'no block at all — semantic only, and "not embedded" is not "nothing known"');

// ── the ordinary case ───────────────────────────────────────────────────────────

console.log('\nwith vectors');
vectors([
  ['c-func-near', [1, 0]],        // exactly the query
  ['c-func-far', [0.2, 1]],
  ['c-gotcha', [1, 0]],           // AS CLOSE as the winner: only the category keeps it out
  ['c-ticket', [1, 0]],
  ['c-rejected', [1, 0]],
]);
const { hasUsableVectors, liveVectors, loadVectors, embedModel } = await import(`file://${join(ROOT, 'dist', 'indulge', 'embed.js')}`);
const block = await exploreCorpusBlock(repo, 'how is the reward picked');
ok(block !== null, 'a block is produced');
ok(/how the reward is picked/.test(block), 'the nearest functionality answer is in it');
ok(!/what breaks when the reward is null/.test(block),
  'a `gotchas` chunk with an IDENTICAL vector is not — the category decides, not the distance');
ok(!/what the reward SHOULD be/.test(block), 'nor a `ticket` chunk from indulge --jira');
ok(!/the audit condemned/.test(block), 'nor a chunk the audit rejected — that is what the audit is for');
ok(/corpus · functionality/.test(block), 'the block says what it is', block.split('\n')[1]);
ok(/not by this tool/.test(block),
  'and that it is NOT explore\'s own output — format.ts guarantees file bytes, this is model prose');
ok(/cited: a\.ts:1-1/.test(block), 'every claim carries its citation', /cited: [^\n]*/.exec(block)?.[0]);
ok(/match 1\.00/.test(block), 'and the match score, so a weak hit reads as one');
// The far chunk scores 0.20. `corpus_search` would return it — the agent asked, and can judge. Nothing
// asked for THIS block, so a weak match here is a distractor injected into every explore result.
ok(!/how the reward is stored/.test(block), 'a weak match is dropped, not shown as knowledge',
  /2 of 2|1 of 2/.exec(block)?.[0] ?? '?');
ok(/1 of 2/.test(block), 'and the header says how many of the eligible chunks it is showing');

// ── the endpoint is down ────────────────────────────────────────────────────────

console.log('\nembedding endpoint down');
embedFails = new Error('connect ECONNREFUSED');
const failed = await exploreCorpusBlock(repo, 'a question never embedded before');
ok(typeof failed === 'string' && /did not run/.test(failed),
  'the failure is stated, not swallowed', String(failed).split('\n')[0]);
ok(/ECONNREFUSED/.test(failed), 'with the reason');
ok(/Nothing above is affected/.test(failed), 'and it says the localization itself still stands');
const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
embedFails = timeout;
const late = await exploreCorpusBlock(repo, 'another question never embedded');
ok(/slow or busy/.test(late), 'a timeout is named as a fact about the machine, not about the corpus',
  String(late).split('\n')[0]);
embedFails = null;

// ── no corpus at all ────────────────────────────────────────────────────────────

console.log('\nno corpus for this repo');
const bare = mkdtempSync(join(tmpdir(), 'ayin-xc-repo-'));
execFileSync('git', ['-C', bare, 'init', '-q']);
ok(await exploreCorpusBlock(bare, 'anything') === null, 'silent — explore is still a complete answer without one');
ok(await exploreCorpusBlock(repo, '   ') === null, 'an empty question asks nothing');
rmSync(bare, { recursive: true, force: true });

rmSync(rag, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });
console.log(fails ? `\nexplore corpus check: ${fails} FAILURE(S)\n` : '\nexplore corpus check: ok\n');
process.exit(fails ? 1 : 0);
