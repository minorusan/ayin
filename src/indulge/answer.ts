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
 *   - **everything else** — a full explore-style investigation (multi-iteration, greps, reads,
 *     follows references), then one call that turns the evidence into an answer plus citations. The
 *     investigation and the writing are separate calls on purpose: a model asked to search and
 *     conclude in one breath tends to conclude first.
 *
 * `sourceSha` is the invalidation key. A re-run skips a question whose file has not changed, and
 * re-answers it when it has — that is what makes "ask indulge again" an expansion, not a restart.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { activeModelId } from '../llm/manager.js';
import { exploreExecute } from '../tools/explore.js';
import { toolLlm, toolPrompts, type ToolPrompts } from '../tools/runtime.js';
import { ensureToolRuntime } from '../tool-wiring.js';
import { resolveInRepo } from './discover.js';
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

export interface AnswerOptions {
  store: IndulgeStore;
  repoPath: string;
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
  for (const m of text.matchAll(/^\s*CITE:\s*(.+?):(\d+)\s*-\s*(\d+)\s*$/gim)) {
    const [, rawPath, rawStart, rawEnd] = m;
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

  const pending = store.pendingQuestions();
  const queue = opts.limit ? pending.slice(0, opts.limit) : pending;
  onStatus?.(`${pending.length} question(s) pending${opts.limit ? `, answering ${queue.length} this run` : ''}`);

  let done = 0;
  for (const q of queue) {
    done++;
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

    const built = await buildAnswer(opts, repoPath, q);
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

async function buildAnswer(
  opts: AnswerOptions, repoPath: string, q: QuestionRecord,
): Promise<{ answer: string; citations: Citation[]; rejected: number } | null> {
  // `git` questions are grounded in git output; everything else in an explore investigation.
  const gitFacts = q.category === 'git' ? answerFromGit(repoPath, q.file) : null;
  if (q.category === 'git' && !gitFacts) return null;

  // Git history alone cannot answer "why is it written this way" — measured: the model correctly
  // refused, noting it had not been given the code. The reason a thing looks the way it does is
  // usually in the file (a comment, the shape of the function), so a git question gets both.
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

  const prompt = indulgePrompts().get('answerFrame', {
    FILE: q.file,
    QUESTION: q.text,
    EVIDENCE: evidence,
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
