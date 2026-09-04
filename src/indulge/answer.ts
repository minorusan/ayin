/**
 * indulge/answer.ts — stage 3: answer one question, and PROVE it.
 *
 * This is the stage the corpus is judged on. A chunk that is merely plausible is worse than no chunk,
 * because at retrieval time it is indistinguishable from one that is true — it will be injected into
 * a prompt, believed, and acted on. So every chunk carries citations, and **every citation is
 * verified against the filesystem before the chunk is written**: the path resolves inside the repo,
 * the line range is in bounds, and the blob sha is computed from the bytes on disk at that moment.
 * A question whose proof does not resolve is recorded `failed` and stored nowhere.
 *
 * Two kinds of question, answered two different ways:
 *
 *   - **`git`** — authorship, age, churn. The FACTS come from `git log`/`rev-list`/`shortlog` output
 *     and never from a model: an approximated commit sha is a lie with a plausible shape. The model
 *     only selects and phrases, over that output plus the current source, and every sha it writes is
 *     re-checked with `rev-parse --verify`. (It answered them deterministically at first. Measured on
 *     a real run, the generated questions ask things like *"which commit explains why `noteShape`
 *     uses a bounding-box heuristic?"* — and a commit listing is a non-answer to that.)
 *   - **everything else** — the code itself, in ONE call. Stage 1 already walked the reference graph
 *     and wrote down every neighbour and why it is one, so `files.jsonl` answers "which files matter"
 *     before the question is asked. Running a 12-iteration explore loop to rediscover that cost 5-10
 *     model calls per question: measured at 131s each, against 17s for the direct path — 7.7x, with
 *     the same citations verified the same way. Sources go FIRST in the prompt and questions are
 *     answered grouped by file, so consecutive questions share a byte-identical prefix and the
 *     server's KV cache pays prefill once per file rather than once per question.
 *     `--deep` restores the explore path when thoroughness matters more than the night.
 *
 * `sourceSha` is the invalidation key. A re-run skips a question whose file has not changed, and
 * re-answers it when it has — that is what makes "ask indulge again" an expansion, not a restart.
 */

import { answerBatchSize, sourceBudgetChars } from './budget.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { activeModelId } from '../llm/manager.js';
import { exploreExecute } from '../tools/explore/index.js';
import { toolLlm, toolPrompts, type ToolPrompts } from '../tools/runtime.js';
import { ensureToolRuntime } from '../tool-wiring.js';
import { resolveInRepo } from './discover.js';
import { indulgersFor } from './hooks/registry.js';
import { blobSha, chunkId, type Chunk, type Citation, type IndulgeStore, type QuestionRecord } from './store.js';

// Drives the model and a tool directly, so it wires the runtime itself rather than trusting import
// order — `indulge` is headless and has no TUI boot to do it.
ensureToolRuntime();

const indulgePrompts = (): ToolPrompts => toolPrompts('indulge');

/** Answers longer than this are not answers, they are transcripts. */
const MAX_ANSWER_CHARS = 6000;
/** A citation spanning more than this is "the whole file", which proves nothing in particular. */
const MAX_CITATION_LINES = 400;
const GIT_LOG_COUNT = 10;
/** Source lines shown as evidence for a git question. */
const MAX_SOURCE_LINES = 400;

/**
 * The context budget for a direct answer, in characters.
 *
 * `AYIN_OLLAMA_CTX` defaults to 16384 tokens and that number was measured, not guessed: context past
 * it costs the VRAM holding model layers, and 10 spilled layers ran ~7x slower. ~50k characters is
 * roughly 12-13k tokens, leaving room for the question, the instructions and the answer.
 */
/**
 * DERIVED from the model that will read the prompt — see indulge/budget.ts.
 *
 * Was a flat 50,000, which is ~14k tokens before the instructions: against a 16k-context model every
 * answer prompt overflowed and was silently truncated, so the model answered about sources it never
 * saw and the citation gate then rejected it for claims it could not prove. Against OpenAI the same
 * number filled 11% of the window.
 */
const contextChars = (): number => sourceBudgetChars();
/** Neighbour files fed alongside the one the question is about. */
const MAX_NEIGHBOURS = 6;

export interface AnswerOptions {
  /** Only questions about these files. The interleaved runner answers a batch as soon as it exists. */
  only?: string[];
  /** Only these exact questions — how `--fix` repairs one chunk at a time, atomically. */
  questionIds?: string[];
  store: IndulgeStore;
  repoPath: string;
  /**
   * Run the full explore investigation per question instead of answering directly.
   *
   * Off by default because explore was re-deriving what stage 1 already wrote down: the question
   * names its file, and `files.jsonl` records every neighbour and WHY it is one. A 12-iteration
   * agentic loop to rediscover that costs ~5-10 model calls per question — measured at ~2 min each,
   * which turns a 200-question night into a fortnight. Feeding the code directly is one call.
   */
  deep?: boolean;
  /** Answer at most this many questions this run (a bounded night, not an unbounded one). */
  limit?: number;
  onStatus?: (note: string) => void;
  onProgress?: (done: number, total: number, current: string) => void;
  shouldStop?: () => boolean;
  /** Injectable seams — the gate proves verification and bookkeeping without a GPU. */
  ask?: (prompt: string) => Promise<string>;
  investigate?: (question: string, repoPath: string) => Promise<string>;
}

export interface AnswerReport {
  attempted: number;
  answered: number;
  /** Answered, but every citation was unresolvable — stored nowhere. */
  failed: number;
  skipped: number;
  stopped: boolean;
  /** Citations the model produced that did not survive verification. The corpus's honesty metric. */
  rejectedCitations: number;
}

/**
 * `CITE: path:start-end` lines → verified citations.
 *
 * Verification is the whole point, so it is deliberately unforgiving: the path must resolve to a
 * real file INSIDE the repo (`resolveInRepo` also refuses `../` escapes), the range must be sane and
 * within the file's actual line count, and the sha is computed from disk rather than taken from the
 * model. Anything else is dropped and counted.
 */
export function verifyCitations(repoPath: string, text: string): { citations: Citation[]; rejected: number } {
  const citations: Citation[] = [];
  let rejected = 0;
  const seen = new Set<string>();
  // RECOGNISE MORE SHAPES; VERIFY EXACTLY AS STRICTLY.
  //
  // The old pattern demanded `CITE:` at line start and the range at line END, so every ordinary way a
  // model decorates a list discarded the WHOLE answer: `**CITE:** x.cs:1-5`, `- CITE: x.cs:1-5`, a
  // single line `x.cs:42`, or any trailing word. Measured on a real build: 906 of 1,420 answered
  // questions failed with "answer carried no citation" — 64% of the GPU time spent, thrown away, on
  // answers that were probably fine. The source already recorded this happening once before.
  //
  // Loosening the PARSE is safe because it changes nothing about what is accepted as true: every
  // citation below still has to resolve to a real file and a real line range, or it is rejected. Only
  // the ways of WRITING one have widened.
  // The leading anchor accepts a JSON boundary as well as a line start: the blended shape puts the
  // citation inside an object — {"a":"…","CITE: src/a.ts:2-4"} — where it is preceded by `","`, not a
  // newline. Requiring the literal CITE keyword is what keeps this from matching prose.
  const CITE = /(?:^|[\n,"'{])\s*(?:[-*>]\s*)?\**\s*CITE\**\s*:\s*\**\s*([^\s:*"'][^:*\n"']*?)\s*:\s*L?(\d+)\s*(?:-\s*L?(\d+))?/gi;
  for (const m of text.matchAll(CITE)) {
    // A single line is a one-line range, not a malformed one.
    const [, rawPath, rawStart, rawEndMaybe] = m;
    const rawEnd = rawEndMaybe ?? rawStart;
    const key = `${rawPath}:${rawStart}-${rawEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const rel = resolveInRepo(repoPath, rawPath);
    if (!rel) { rejected++; continue; }
    let body: Buffer;
    try { body = readFileSync(join(repoPath, rel)); } catch { rejected++; continue; }
    const lineCount = body.toString('utf-8').split('\n').length;
    const startLine = parseInt(rawStart, 10);
    const endLine = parseInt(rawEnd, 10);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) { rejected++; continue; }
    if (startLine < 1 || endLine < startLine || endLine > lineCount) { rejected++; continue; }
    if (endLine - startLine + 1 > MAX_CITATION_LINES) { rejected++; continue; }
    citations.push({ path: rel, startLine, endLine, sha: blobSha(body) });
  }
  return { citations, rejected };
}

/** The answer text with its CITE lines removed — they are structure, not prose. */
export function stripCitations(text: string): string {
  return text.replace(/^\s*CITE:\s*.+$/gim, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Where the repo is right now: the branch name and the exact commit.
 *
 * Both are recorded on every chunk. A detached HEAD has no branch name, so it reports the tag if
 * there is one and `(detached)` otherwise — never an empty string that reads as "no provenance".
 */
export function repoProvenance(repoPath: string): { branch: string; commit: string } {
  const commit = git(repoPath, ['rev-parse', 'HEAD']);
  let branch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') {
    branch = git(repoPath, ['describe', '--tags', '--exact-match']) || '(detached)';
  }
  return { branch, commit };
}

/**
 * The files to put in front of the model for a question about `file`.
 *
 * `file` first, then its graph neighbours — the ones discovery already recorded as importing it,
 * imported by it, or referencing it. Stage 1 walked that graph deterministically; asking a model to
 * find them again is paying twice for one answer.
 */
export function contextFilesFor(store: IndulgeStore, file: string): string[] {
  const records = store.files();
  const neighbours: string[] = [];

  // OUTBOUND: files whose reason names this one — "imported by src/A.ts", "references src/A.ts (X)".
  for (const r of records) {
    if (r.path !== file && r.why.includes(file)) neighbours.push(r.path);
  }
  // INBOUND: the file this one was reached FROM. Its own `why` names it, and that edge is just as
  // real — without this, asking about a type omits the file that uses it, which is usually the
  // whole point of the question.
  const known = new Set(records.map((r) => r.path));
  for (const r of records.filter((x) => x.path === file)) {
    for (const m of r.why.matchAll(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}/g)) {
      if (known.has(m[0]) && m[0] !== file) neighbours.push(m[0]);
    }
  }
  // Shallower files first: a direct neighbour explains more than one three hops out.
  const depthOf = (p: string): number => records.find((r) => r.path === p)?.depth ?? 99;
  neighbours.sort((a, b) => depthOf(a) - depthOf(b));
  return [file, ...[...new Set(neighbours)].slice(0, MAX_NEIGHBOURS)];
}

/**
 * The sources block, numbered, within budget.
 *
 * Ordered file-first and placed at the TOP of the prompt on purpose: every question about the same
 * file then shares a byte-identical prefix, so the server's KV cache carries it and prefill is paid
 * once per file rather than once per question. Four questions about one file is four times the
 * saving.
 *
 * Anything dropped is announced. A silently clipped file reads as the whole file, and the model
 * cites line numbers that do not exist in what it was shown.
 */
export function buildSources(repoPath: string, files: string[], budget = contextChars()): string {
  const blocks: string[] = [];
  let used = 0;
  const skipped: string[] = [];
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(repoPath, f), 'utf-8'); } catch { continue; }
    const lines = text.split('\n');
    const numbered = lines.map((l, i) => `${i + 1} ${l}`).join('\n');
    const block = `=== ${f} (${lines.length} lines) ===\n${numbered}`;
    if (used + block.length > budget) {
      if (blocks.length === 0) {
        // The first file alone exceeds the budget: show as much as fits, and say so.
        const head = numbered.slice(0, budget - 200);
        blocks.push(`=== ${f} (${lines.length} lines, CLIPPED to fit the context) ===\n${head}`);
        used = budget;
      } else skipped.push(f);
      continue;
    }
    blocks.push(block);
    used += block.length;
  }
  if (skipped.length) {
    blocks.push(`=== not shown (context full): ${skipped.join(', ')} ===`);
  }
  return blocks.join('\n\n');
}

/**
 * Deterministic project-type facts for `file`, from every indulger that has any.
 *
 * Appended AFTER the sources and before the questions, which keeps it inside the per-file prefix
 * every question about that file shares — so the server's KV cache still pays for it once rather
 * than once per question.
 *
 * A broken or throwing hook costs its own block and nothing else: this is the overnight path, and a
 * night must not be lost to somebody's regex.
 */
export function hookEvidence(repoPath: string, file: string): string {
  let source: string;
  try { source = readFileSync(join(repoPath, file), 'utf-8'); } catch { return ''; }
  const blocks: string[] = [];
  for (const hook of indulgersFor(repoPath)) {
    if (!hook.evidenceFor) continue;
    try {
      const text = hook.evidenceFor({ repoPath, file, source });
      if (text && text.trim()) blocks.push(text.trim());
    } catch { continue; }
  }
  if (!blocks.length) return '';
  // Named as facts about the repo rather than as more source, because that is what they are: the
  // model must be able to tell a binding it was handed from a line it read.
  return `=== FACTS ABOUT ${file} (derived from the repository, not from the source above) ===\n${blocks.join('\n\n')}`;
}

/** The file with 1-based line numbers, clipped — the numbers are what a CITE line must refer to. */
function readSource(repoPath: string, file: string): string {
  let text: string;
  try { text = readFileSync(join(repoPath, file), 'utf-8'); } catch { return '(unreadable)'; }
  const lines = text.split('\n');
  const shown = lines.slice(0, MAX_SOURCE_LINES).map((l, i) => `${i + 1} ${l}`).join('\n');
  return lines.length > MAX_SOURCE_LINES
    ? `${shown}\n… (clipped at ${MAX_SOURCE_LINES} of ${lines.length} lines)`
    : shown;
}

const git = (repoPath: string, args: string[]): string => {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch { return ''; }
};

/**
 * The git EVIDENCE for a file: history, first appearance, churn, authors.
 *
 * Every fact here comes from git, never from a model — an approximated commit sha is a lie with a
 * plausible shape. But the evidence is not itself the answer: questions are model-generated, and
 * measured on a real run they ask things like *"which commit explains why `noteShape` uses a
 * bounding-box heuristic?"*. Returning a commit listing to that question is a non-answer, so the
 * listing becomes the evidence for one writing call, exactly as `explore` output does for the other
 * categories. The model selects and phrases; git supplies the facts; `gitShasResolve` then checks
 * every sha in what it wrote.
 *
 * The file itself is the guaranteed citation — the history is *about* those bytes.
 */
export function answerFromGit(repoPath: string, file: string): { answer: string; citations: Citation[] } | null {
  if (!existsSync(join(repoPath, '.git')) && !git(repoPath, ['rev-parse', '--git-dir'])) return null;
  const log = git(repoPath, ['log', `-${GIT_LOG_COUNT}`, '--date=short', '--format=%h %ad %an — %s', '--', file]);
  if (!log) return null;

  const commits = log.split('\n').filter(Boolean);
  const first = git(repoPath, ['log', '--reverse', '--date=short', '--format=%h %ad %an', '--', file]).split('\n')[0] || '';
  const total = git(repoPath, ['rev-list', '--count', 'HEAD', '--', file]) || String(commits.length);
  const authors = git(repoPath, ['shortlog', '-sn', '--no-merges', 'HEAD', '--', file])
    .split('\n').filter(Boolean).slice(0, 5).map((l) => l.trim()).join('; ');

  let body: Buffer;
  try { body = readFileSync(join(repoPath, file)); } catch { return null; }
  const lineCount = body.toString('utf-8').split('\n').length;

  const answer = [
    `${file} has ${total} commit(s) touching it.`,
    first ? `First appeared: ${first}.` : '',
    `Most recent changes (newest first):`,
    ...commits.map((c) => `  ${c}`),
    authors ? `Authors by commit count: ${authors}.` : '',
  ].filter(Boolean).join('\n');

  return { answer, citations: [{ path: file, startLine: 1, endLine: lineCount, sha: blobSha(body) }] };
}

/**
 * Every commit sha named in a git answer must resolve to a real commit.
 *
 * `rev-parse --verify <sha>^{commit}` prints the full sha and fails silently otherwise, so an empty
 * result IS the rejection. This text is built from git output rather than generated, so a failure
 * here means the repo moved under us — not that a model invented a sha — but it is checked all the
 * same, because that is the difference between a proof and a well-formatted claim.
 */
export function gitShasResolve(repoPath: string, answer: string): boolean {
  for (const m of answer.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    if (!git(repoPath, ['rev-parse', '--verify', `${m[0]}^{commit}`])) return false;
  }
  return true;
}

/**
 * Answer every pending question, writing each chunk the moment its proof resolves.
 *
 * Sequential on purpose for this first version: the GPU serialises generation anyway, so concurrency
 * would only hide file and git I/O, and it would buy that at the cost of interleaved progress and a
 * harder resume story. Recorded in TechDebt as the knob to add if the night proves I/O-bound.
 */
export async function answerQuestions(opts: AnswerOptions): Promise<AnswerReport> {
  const { store, onStatus, onProgress, shouldStop } = opts;
  const repoPath = resolve(opts.repoPath);
  const report: AnswerReport = {
    attempted: 0, answered: 0, failed: 0, skipped: 0, stopped: false, rejectedCitations: 0,
  };

  // Read once per run, not per chunk: the tree does not move under a single run, and it is two
  // subprocesses per call.
  const provenance = repoProvenance(repoPath);

  // DEPTH first, then file. On a capped run the order IS the corpus: measured on a real repo, an
  // alphabetical sort spent all 15 answers on a depth-1 neighbour while the seed — the file the
  // domain actually named — got none. Seeds are the feature; neighbours are context.
  // Within a depth, still grouped by file, so consecutive questions share the cached sources prefix.
  const depthOf = new Map<string, number>();
  for (const f of store.files()) {
    const prev = depthOf.get(f.path);
    if (prev === undefined || f.depth < prev) depthOf.set(f.path, f.depth);
  }
  const only = opts.only ? new Set(opts.only) : null;
  const ids = opts.questionIds ? new Set(opts.questionIds) : null;
  const pending = store.pendingQuestions()
    .filter((q) => (!only || only.has(q.file)) && (!ids || ids.has(q.id)))
    .sort((a, b) => {
    const d = (depthOf.get(a.file) ?? 99) - (depthOf.get(b.file) ?? 99);
    return d !== 0 ? d : a.file.localeCompare(b.file);
  });
  const queue = opts.limit ? pending.slice(0, opts.limit) : pending;
  onStatus?.(`${pending.length} question(s) pending${opts.limit ? `, answering ${queue.length} this run` : ''}`);

  // ── batch the DIRECT path, by file ─────────────────────────────────────────────
  //
  // Questions are already sorted by depth then file, so a run of consecutive same-file questions is
  // exactly the set that shares sources. `deep`/`investigate` runs an explore loop per question and
  // is deliberately excluded: those do not share a prompt.
  const batchable = !opts.deep && !opts.investigate;
  const batchSize = batchable ? answerBatchSize() : 1;
  const precomputed = new Map<string, { answer: string; citations: Citation[]; rejected: number }>();
  const batchedIds = new Set<string>();

  const fillBatchFor = async (index: number): Promise<void> => {
    if (!batchable || batchSize < 2) return;
    const q0 = queue[index];
    if (!q0 || batchedIds.has(q0.id) || q0.category === 'git') return;   // git answers come from git
    const group: QuestionRecord[] = [];
    for (let k = index; k < queue.length && group.length < batchSize; k++) {
      const q = queue[k];
      if (q.file !== q0.file || q.category === 'git') break;
      if (store.hasChunk(chunkId(store.key, q.file, q.entity, q.category, q.id))) continue;
      group.push(q);
    }
    if (group.length < 2) return;   // one question is not a batch; the single path is simpler
    for (const q of group) batchedIds.add(q.id);
    onStatus?.(`${q0.file}: asking ${group.length} question(s) in one call`);
    const answers = await buildAnswerBatch(opts, repoPath, q0.file, group);
    for (const [id, v] of answers) precomputed.set(id, v);
  };

  let done = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const q = queue[qi];
    done++;
    await fillBatchFor(qi);
    if (shouldStop?.()) { report.stopped = true; onStatus?.('stop requested — the rest stay pending'); return report; }

    const id = chunkId(store.key, q.file, q.entity, q.category, q.id);
    if (store.hasChunk(id)) { report.skipped++; store.setQuestionStatus(q.id, 'answered'); continue; }

    // The file must still be there — discovery may have run against a tree that has since changed.
    let sourceSha: string;
    try { sourceSha = blobSha(readFileSync(join(repoPath, q.file))); } catch {
      store.setQuestionStatus(q.id, 'failed', 'file no longer readable');
      report.failed++; continue;
    }

    onProgress?.(done, queue.length, `${q.file} · ${q.category}`);
    report.attempted++;

    // A batched answer if this question was in one; otherwise the single-question path. A question
    // the batch omitted falls through to `undefined` and is treated as unanswered — never as empty.
    const built = precomputed.has(q.id) ? precomputed.get(q.id)! : await buildAnswer(opts, repoPath, q);
    if (!built) { store.setQuestionStatus(q.id, 'failed', 'no answer produced'); report.failed++; continue; }
    report.rejectedCitations += built.rejected;

    // THE GUARANTEE: no proof, no chunk.
    if (built.citations.length === 0) {
      store.setQuestionStatus(q.id, 'failed', built.rejected > 0
        ? `all ${built.rejected} citation(s) failed verification`
        : 'answer carried no citation');
      report.failed++;
      onStatus?.(`FAILED (unproven): ${q.file} · ${q.category}`);
      continue;
    }

    const chunk: Chunk = {
      chunkId: id,
      questionId: q.id,
      repoKey: store.key,
      domains: domainsOfFile(store, q.file),
      question: q.text,
      answer: built.answer.slice(0, MAX_ANSWER_CHARS),
      files: [...new Set(built.citations.map((c) => c.path))],
      citations: built.citations,
      entity: q.entity,
      category: q.category,
      // Read AFTER the call, not before the loop: the manager caches the served model id when it
      // first talks to the provider, so capturing it up front recorded `unknown` in every chunk of a
      // freshly started process. A corpus field that says which model wrote a chunk has to be true.
      model: activeModelId() || 'unknown',
      branch: provenance.branch || undefined,
      commit: provenance.commit || undefined,
      createdAt: new Date().toISOString(),
      sourceSha,
    };
    // Project-type facts, computed here because THIS is the overnight job. An indulger that throws
    // must cost its own facts, never the chunk that was already proved.
    for (const ind of indulgersFor(repoPath)) {
      try {
        const facts = ind.onChunkCreated(chunk, { repoPath, file: q.file, source: '' });
        if (facts) (chunk.ext ??= {})[ind.id] = facts;
      } catch (err) {
        onStatus?.(`indulger ${ind.id} failed on ${q.file}: ${String(err).slice(0, 100)}`);
      }
    }

    store.saveChunk(chunk);
    report.answered++;
    onStatus?.(`${q.file} · ${q.category} → ${built.citations.length} verified citation(s)`);
  }

  return report;
}

/** EVERY domain that surfaced this file — a file discovered under two domains belongs to both. */
function domainsOfFile(store: IndulgeStore, file: string): string[] {
  return [...new Set(store.files().filter((f) => f.path === file).map((f) => f.domain).filter(Boolean))];
}

/**
 * Answer SEVERAL questions about one file in a single call.
 *
 * The sources are identical for every question about the same file, so sending them once and asking
 * ten questions costs one prompt instead of ten. This is where an overnight run's time actually
 * went: 847 answers, each re-sending the same file, at 17–45s apiece. The model does the same work
 * either way — it was being spoon-fed one bite at a time.
 *
 * Batch size comes from the window (indulge/budget.ts) because the binding limit is the REPLY: every
 * answer shares one output budget, and a batch large enough to truncate its last answers is worse
 * than no batching. At 16k that is 4 questions; on a 128k window, 24.
 *
 * A question the model omits, or answers unciteably, simply gets no entry — the caller marks it
 * failed and it stays pending for another run. One bad answer never costs the batch.
 */
/**
 * Verify a `cite: [{path, from, to}]` array, by exactly the rules `verifyCitations` applies to CITE
 * lines: the path resolves inside the repo, the range is sane, and it is not the whole file.
 *
 * Same gate, different notation. A structured citation is easier for a model to emit correctly; it is
 * not easier to get away with.
 */
function citationsFromJson(repoPath: string, raw: string): { citations: Citation[]; rejected: number } {
  let rows: Array<{ path?: string; from?: number; to?: number }>;
  try { rows = JSON.parse(raw) as typeof rows; } catch { return { citations: [], rejected: 0 }; }
  if (!Array.isArray(rows)) return { citations: [], rejected: 0 };
  // Rendered back into the canonical text form so ONE verifier decides what counts as proof — two
  // implementations of "is this citation real" is how one of them quietly becomes laxer.
  const asLines = rows
    .filter((r) => r && typeof r.path === 'string')
    .map((r) => `CITE: ${r.path}:${Number(r.from) || 0}-${Number(r.to) || 0}`)
    .join('\n');
  return verifyCitations(repoPath, asLines);
}

async function buildAnswerBatch(
  opts: AnswerOptions, repoPath: string, file: string, questions: QuestionRecord[],
): Promise<Map<string, { answer: string; citations: Citation[]; rejected: number }>> {
  const out = new Map<string, { answer: string; citations: Citation[]; rejected: number }>();
  const sources = buildSources(repoPath, contextFilesFor(opts.store, file));
  if (!sources) return out;
  const facts = hookEvidence(repoPath, file);

  const prompt = indulgePrompts().get('answerBatch', {
    SOURCES: facts ? `${sources}\n\n${facts}` : sources,
    FILE: file,
    QUESTIONS: questions.map((q) => `- id: ${q.id}\n  ${q.text}`).join('\n'),
  });
  let reply: string;
  try {
    reply = opts.ask ? await opts.ask(prompt) : await toolLlm().ask([{ role: 'user', content: prompt }]);
  } catch { return out; }

  // Pairs scanned positionally, for the reasons the question parser learned the hard way: duplicate
  // keys are valid JSON and silently keep only the last, and a truncated reply must yield what it
  // completed rather than nothing.
  //
  // CITATIONS ARE A STRUCTURED FIELD, not `CITE:` lines inside the answer string. The first version
  // asked for those lines embedded in a JSON string, which meant escaped newlines inside a value —
  // an awkward shape for a model emitting JSON, and it simply dropped them: unproven answers went
  // from 3% of a run to 19%, three hundred answers thrown away for want of a format. `path/from/to`
  // is the shape the model is already writing everything else in.
  // How far past a matched entry to look for a stray citation. One entry's worth: enough to reach the
// keys the model put after `a`, short enough that it cannot borrow the NEXT answer's citation.
const ENTRY_LOOKAHEAD = 400;
  const known = new Set(questions.map((q) => q.id));
  const pair = /"id"\s*:\s*"([^"]+)"\s*,\s*"a"\s*:\s*("(?:[^"\\]|\\.)*")\s*(?:,\s*"cite"\s*:\s*(\[[\s\S]*?\]))?/g;
  let m: RegExpExecArray | null;
  while ((m = pair.exec(reply))) {
    const id = m[1].trim();
    if (!known.has(id) || out.has(id)) continue;
    let text: string;
    try { text = JSON.parse(m[2]) as string; } catch { continue; }
    if (/NOTHING KNOWN/i.test(text)) continue;   // a real answer, and it stores nothing

    // Structured first; the CITE-line form still parses, because a model that writes them anyway is
    // giving a correct answer in the older shape and dropping it would be pedantry.
    //
    // AND LOOK IN THE WHOLE ENTRY, not just the answer string. Observed on a real build: the model
    // blends the two conventions and writes the CITE line as a bare JSON KEY beside `a` —
    //     {"id":"q1","a":"…","CITE: path/File.cs:10-14"}
    // — so there is no `cite` array to capture, and scanning only the answer TEXT finds nothing. The
    // citation is present and correct; it is simply one field over. That mismatch failed 70% of the
    // answers in a run, each one discarded as "answer carried no citation" while carrying one.
    const entry = reply.slice(m.index, m.index + m[0].length + ENTRY_LOOKAHEAD);
    const structured = m[3] ? citationsFromJson(repoPath, m[3]) : null;
    const v = structured && structured.citations.length
      ? structured
      : (() => {
        const inText = verifyCitations(repoPath, text);
        return inText.citations.length ? inText : verifyCitations(repoPath, entry);
      })();
    out.set(id, { answer: stripCitations(text), citations: v.citations, rejected: v.rejected });
  }
  return out;
}

async function buildAnswer(
  opts: AnswerOptions, repoPath: string, q: QuestionRecord,
): Promise<{ answer: string; citations: Citation[]; rejected: number } | null> {
  // `git` questions are grounded in git output; everything else in an explore investigation.
  const gitFacts = q.category === 'git' ? answerFromGit(repoPath, q.file) : null;
  if (q.category === 'git' && !gitFacts) return null;

  // Git history alone cannot answer "why is it written this way" — measured: the model correctly
  // refused, noting it had not been given the code. The reason a thing looks the way it does is
  // usually in the file (a comment, the shape of the function), so a git question gets both.
  // ── the DIRECT path: the code itself, one call ──
  // Stage 1 already knows which files matter; explore would rediscover them at ~5-10 model calls
  // per question. Sources go first so questions about one file share a cached prefix.
  if (!gitFacts && !opts.deep && !opts.investigate) {
    const sources = buildSources(repoPath, contextFilesFor(opts.store, q.file));
    if (!sources) return null;
    const facts = hookEvidence(repoPath, q.file);
    const direct = indulgePrompts().get('answerDirect', {
      SOURCES: facts ? `${sources}\n\n${facts}` : sources, FILE: q.file, QUESTION: q.text,
    });
    let reply: string;
    try {
      reply = opts.ask ? await opts.ask(direct) : await toolLlm().ask([{ role: 'user', content: direct }]);
    } catch { return null; }
    const v = verifyCitations(repoPath, reply);
    return { answer: stripCitations(reply), citations: v.citations, rejected: v.rejected };
  }

  const evidence = gitFacts
    ? `${gitFacts.answer}\n\nCURRENT SOURCE of ${q.file}:\n${readSource(repoPath, q.file)}`
    : opts.investigate
      ? await opts.investigate(q.text, repoPath)
      : await exploreExecute({
        question: `${q.text}\n\n(This is about ${q.file}. Read it, and show the line numbers of what you rely on.)`,
        cwd: repoPath,
        thorough: 'true',
      });
  if (!evidence || evidence.trim().length < 20) return null;

  // THE SAME FACTS THE DIRECT PATH GETS. `--deep` and `--investigate` are what an operator reaches
  // for when thoroughness matters most, so they were the wrong paths to leave without the assembly
  // and container facts: an explore loop reads code, and neither a `.asmdef` nor "who binds this" is
  // in the code it reads. A git answer gets them too — "why does it look like this" is often
  // answered by which assembly it had to live in.
  const facts = hookEvidence(repoPath, q.file);

  const prompt = indulgePrompts().get('answerFrame', {
    FILE: q.file,
    QUESTION: q.text,
    EVIDENCE: facts ? `${evidence}\n\n${facts}` : evidence,
  });
  let reply: string;
  try {
    reply = opts.ask ? await opts.ask(prompt) : await toolLlm().ask([{ role: 'user', content: prompt }]);
  } catch { return null; }

  // A model writing over git output must not invent a sha while doing it.
  if (gitFacts && !gitShasResolve(repoPath, reply)) return null;

  const { citations, rejected } = verifyCitations(repoPath, reply);
  // A git answer always keeps the file-level citation: the history is about those exact bytes, and
  // the model's own CITE lines (if any) are additional proof, not a replacement for it.
  const all = gitFacts ? [...gitFacts.citations, ...citations] : citations;
  return { answer: stripCitations(reply), citations: all, rejected };
}
