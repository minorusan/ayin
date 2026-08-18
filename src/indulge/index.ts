/**
 * indulge/index.ts — `ayin indulge`, the overnight corpus builder.
 *
 *     ayin indulge --repoPath <path> --domains "rendering,checkout"
 *     ayin indulge --status          what it is doing right now, for the morning check
 *     ayin indulge --report          write the audit markdown and stop
 *     ayin indulge --dry-run         discover only: the file list and a question estimate
 *
 * It runs unattended for hours, so the shape is dictated by that: no interactive prompt ever, one
 * lock per corpus, `progress.json` written at every step, and every stage resuming from disk. Kill
 * it at any point and the next run continues from the last record written.
 *
 * SIGINT/SIGTERM are cooperative: the flag is set, the stage in flight finishes its current record,
 * and the run closes its manifest honestly. A second signal exits immediately — an operator who
 * presses Ctrl+C twice means it.
 */

import { getConfigString } from '../prompts.js';
import { parseList } from './args.js';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { answerQuestions } from './answer.js';
import { discoverDomain } from './discover.js';
import { embedCorpus } from './embed.js';
import { generateQuestions } from './questions.js';
import { writeReport } from './report.js';
import { recordAnswer, recordPrompt, recordTool } from '../session-record.js';
import { initSession } from '../session-store.js';
import { assessChunk } from './staleness.js';
import { detectVendorRoots } from './vendor.js';
import { CATEGORIES, openStore, StoreLockedError, type Category, type Manifest, type Stage, sameProject } from './store.js';

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };

export interface IndulgeArgs {
  repoPath: string;
  domains: string[];
  status: boolean;
  report: boolean;
  dryRun: boolean;
  restart: boolean;
  /** `--search "<question>"` — query the corpus and print what it would hand the model. */
  search?: string;
  /** Run THIS build on a different provider than the interactive agent. */
  provider?: string;
  /** Flip `failed` questions back to `pending` so a fixed answer path can retry them. */
  retryFailed?: boolean;
  qa?: boolean;
  qaRules?: boolean;
  fix?: boolean;
  embedOnly: boolean;
  deep: boolean;
  importFrom?: string;
  maxDepth?: number;
  maxFiles?: number;
  keepVendor?: boolean;
  classifyVendor?: boolean;
  scope?: string;
  rescanVendor?: boolean;
  maxQuestions?: number;
  categories?: Category[];
}

/** `--flag value` and `--flag=value`, both. Unknown flags are reported, never guessed at. */
export function parseArgs(argv: string[]): { args: IndulgeArgs; errors: string[] } {
  const errors: string[] = [];
  const args: IndulgeArgs = {
    repoPath: process.cwd(), domains: [], status: false, report: false, dryRun: false, restart: false, embedOnly: false, deep: false,
  };
  const num = (v: string, name: string): number | undefined => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) { errors.push(`--${name} needs a non-negative number, got "${v}"`); return undefined; }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], undefined];
    const value = (): string => inlineValue ?? argv[++i] ?? '';
    switch (flag) {
      case '--repoPath': case '--repo': args.repoPath = value(); break;
      case '--domains': case '--domain':
        args.domains = parseList(value()); break;
      case '--scope': args.scope = value(); break;
      case '--status': args.status = true; break;
      case '--report': args.report = true; break;
      case '--search': case '--ask': args.search = value(); break;
      case '--provider': args.provider = value(); break;
      case '--retry-failed': args.retryFailed = true; break;
      case '--qa': args.qa = true; break;
      case '--qa-rules': args.qa = true; args.qaRules = true; break;
      case '--fix': case '--fixembed': args.fix = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--restart': args.restart = true; break;
      case '--import': args.importFrom = value(); break;
      case '--embed': args.embedOnly = true; break;
      case '--deep': args.deep = true; break;
      case '--depth': args.maxDepth = num(value(), 'depth'); break;
      case '--max-files': args.maxFiles = num(value(), 'max-files'); break;
      case '--keep-vendor': case '--include-vendor': args.keepVendor = true; break;
      case '--rescan-vendor': args.rescanVendor = true; break;
      case '--classify-vendor': args.classifyVendor = true; break;
      case '--max-questions': args.maxQuestions = num(value(), 'max-questions'); break;
      case '--categories': {
        // ANY angle, like domains. The five that ship carry tuned prompts; anything else gets a
        // generic frame naming it. What is still refused is a name that cannot be a prompt id or a
        // corpus field — that fails later, in a place with no useful error.
        const want = parseList(value());
        const bad = want.filter((c) => !/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(c));
        if (bad.length) {
          errors.push(`unusable categor${bad.length > 1 ? 'ies' : 'y'}: ${bad.join(', ')}`
            + ' — letters, digits, - and _ only, starting with a letter, up to 40 characters');
        }
        args.categories = want as Category[];
        break;
      }
      default: errors.push(`unknown flag: ${flag}`);
    }
  }
  return { args, errors };
}

const USAGE = [
  'ayin indulge — build a per-repo corpus of answered questions (overnight job)',
  '',
  '  ayin indulge --domains "rendering,checkout" [--repoPath <path>]',
  '  ayin indulge --status        what it is doing now, and how far along',
  '  ayin indulge --report        write the audit markdown and stop',
  '  ayin indulge --dry-run       discover only — file list + question estimate, spends nothing',
  '',
  '  ayin indulge --embed         vectorise the corpus for semantic search (CPU, no GPU needed)',
  '  ayin indulge --search "<q>"  ask the corpus what it knows — exactly what the agent would be handed',
  '  ayin indulge --provider openai   build on OpenAI while the interactive agent stays local',
  '  ayin indulge --retry-failed  re-queue questions that failed, then answer them',
  '  ayin indulge --qa            audit the corpus: rules first (free), then the model in batches',
  '  ayin indulge --qa-rules      the free half only — no model, instant',
  '  ayin indulge --fix           re-answer what the audit rejected, then re-embed what changed',
  '',
  '  --import <dir>               install a corpus built elsewhere (nuk overnight -> laptop)',
  '  --deep                       full explore investigation per question (~8x slower, more thorough)',
  '  --restart                    discard the corpus and rebuild (default is RESUME)',
  '  --depth N                    reference-walk depth (default 3)',
  '  --max-files N                cap discovered files per domain',
  '  --max-questions N            cap answers this run',
  '  --categories \'["a","b"]\'     ANY angle. Tuned: git,dependencies,connections,functionality,gotchas',
  '                               anything else works too — "threadSafety" — the angle is named to the model',
].join('\n');

const hhmm = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** The morning check: one command that says whether it is alive and how far it got. */
/**
 * `--retry-failed` — put failed questions back in the queue and answer them.
 *
 * A question fails for two very different reasons, and only one of them is about the question. On a
 * real run 285 failed and **273 of them were "answer carried no citation"** — the answer path was
 * asking for citations in a shape the model would not emit. That is a bug in the asking, and every
 * one of those questions is still good.
 *
 * Recovering them by rebuilding the corpus would have meant re-answering fifteen hundred questions
 * to save two hundred and seventy-three, on a metered API. The questions are already on disk; only
 * their status says otherwise.
 *
 * Nothing is destroyed: a status change is an append, the existing chunks are untouched, and a
 * question that fails again simply fails again.
 */
async function runRetryFailed(repoPath: string, args: IndulgeArgs): Promise<number> {
  const store = openStore(repoPath);
  if (!store.exists()) { out(`No corpus for ${resolve(repoPath)} yet.`); return 2; }
  const failed = store.questions().filter((q) => q.status === 'failed');
  if (!failed.length) { out('Nothing failed — nothing to retry.'); return 0; }

  const why = new Map<string, number>();
  for (const q of failed) why.set(q.note ?? '(no reason recorded)', (why.get(q.note ?? '(no reason recorded)') ?? 0) + 1);
  out(`${failed.length} failed question(s):`);
  for (const [note, n] of [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    out(`  ${String(n).padStart(5)}  ${note}`);
  }

  for (const q of failed) store.setQuestionStatus(q.id, 'pending', 're-queued by --retry-failed');

  let stopping = false;
  process.on('SIGINT', () => { stopping = true; out('\nstopping after the current batch — the rest stay pending'); });
  await initSession();
  recordPrompt(`ayin indulge --retry-failed --repoPath ${repoPath}`);
  const started = Date.now();
  let lastLine = 0;
  const a = await answerQuestions({
    store, repoPath: resolve(repoPath), limit: args.maxQuestions, shouldStop: () => stopping,
    onStatus: (n) => out(`  ${n}`),
    onProgress: (done, total, current) => {
      store.setProgress({ runId: 'retry', stage: 'answer', done, total, current, startedAt: new Date(started).toISOString() });
      const nowMs = Date.now();
      if (nowMs - lastLine < 3000 && done < total) return;
      lastLine = nowMs;
      const el = (nowMs - started) / 1000;
      const rate = done > 0 ? done / el : 0;
      out(`  ${done}/${total} · ${Math.round(el)}s elapsed${rate > 0 && done < total ? ` · ~${Math.round((total - done) / rate)}s left` : ''}`);
    },
  });
  out();
  out(`${a.answered} answered · ${a.failed} still unproven · ${a.rejectedCitations} citation(s) rejected`);
  recordAnswer(`indulge --retry-failed · ${a.answered} answered · ${a.failed} still unproven`);

  const { embedCorpus } = await import('./embed.js');
  const e = await embedCorpus({ store, onStatus: (n) => out(`  ${n}`) });
  out(`  ${e.embedded} newly embedded · ${e.skipped} already had vectors`);
  return 0;
}

/**
 * `--qa` — audit what is already stored. See indulge/qa.ts for why it is two passes.
 */
async function runQaPass(repoPath: string, args: IndulgeArgs): Promise<number> {
  const store = openStore(repoPath);
  if (!store.exists()) { out(`No corpus for ${resolve(repoPath)} yet.`); return 2; }
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; out('\nstopping — verdicts already written are kept'); });
  const { runQa, formatQaReport } = await import('./qa.js');
  const started = Date.now();
  let lastLine = 0;
  const r = await runQa({
    store, rulesOnly: args.qaRules, limit: args.maxQuestions, shouldStop: () => stopping,
    onStatus: (n) => out(`  ${n}`),
    onProgress: (done, total) => {
      const nowMs = Date.now();
      if (nowMs - lastLine < 3000 && done < total) return;
      lastLine = nowMs;
      const el = (nowMs - started) / 1000;
      const rate = done > 0 ? done / el : 0;
      out(`  ${done}/${total} audited · ${Math.round(el)}s elapsed`
        + `${rate > 0 ? ` · ~${Math.round((total - done) / rate)}s left` : ''}`);
    },
  });
  out();
  out(formatQaReport(r));
  return 0;
}

/**
 * `--fix` — act on the audit, then re-embed what changed.
 *
 * A reject is repaired according to WHAT was wrong, because the two failures need opposite
 * treatment. A bad QUESTION cannot be answered better — it is dropped and its question marked
 * failed, so nothing re-answers it at full price. A bad ANSWER to a good question is re-queued: the
 * question returns to `pending` and the normal answer path redoes it, with the same citation gate.
 *
 * Embedding runs last and only over what is missing a vector, so a fix costs one embed per repaired
 * chunk rather than a re-embed of the corpus.
 */
async function runFixPass(repoPath: string, args: IndulgeArgs): Promise<number> {
  const store = openStore(repoPath);
  if (!store.exists()) { out(`No corpus for ${resolve(repoPath)} yet.`); return 2; }
  const rejects = store.chunks().filter((c) => c.qa?.verdict === 'reject');
  if (!rejects.length) { out('Nothing rejected — run `ayin indulge --qa` first.'); return 0; }

  // One snapshot before the loop, not per item: `--fix` deletes chunks whose questions cannot be
  // repaired, and a corpus is a night on a shared card. Automatic and unconditional — a backup the
  // operator has to ask for is a backup that does not exist when it is needed.
  const backup = store.snapshot('fix');
  out(backup ? `backup: ${backup}` : 'WARNING: could not write a backup — nothing will be deleted this run');

  let stopping = false;
  process.on('SIGINT', () => { stopping = true; out('\nstopping after the current chunk — everything repaired so far is kept'); });
  await initSession();
  recordPrompt(`ayin indulge --fix --repoPath ${repoPath}`);

  // ONE CHUNK AT A TIME, AND NOTHING IS DESTROYED BEFORE ITS REPLACEMENT EXISTS.
  //
  // The first version read every reject, then deleted all their chunks and rewrote all their
  // question statuses BEFORE answering anything. Interrupted after one answer, that left 195 chunks
  // gone, their questions pending, and — because the verdicts lived on the deleted chunks — no
  // record that an audit had ever run. `--fix` then reported "nothing rejected". Maximum damage from
  // the earliest possible interruption, which is the exact inverse of what an interruptible job
  // should do.
  //
  // The deletion was never needed. `chunkId` is derived from (repo, file, entity, category,
  // questionId), so re-answering the SAME question writes the SAME id — the new chunk replaces the
  // old atomically, and the stale verdict goes with it. A bad answer therefore costs no deletion at
  // all: set the question pending, answer it, and either it improved or the old chunk is still
  // there. Only a bad QUESTION is deleted, because there is nothing to replace it with.
  const QUESTION_FAULTS = new Set(['question is a JSON blob', 'no question', 'question is an essay']);
  const budget = args.maxQuestions ?? Infinity;
  let dropped = 0, repaired = 0, unchanged = 0, done = 0;
  const started = Date.now();
  let lastLine = 0;

  for (const c of rejects) {
    if (stopping || repaired >= budget) break;
    done++;

    if (QUESTION_FAULTS.has(c.qa?.why ?? '')) {
      // Nothing can replace it, so this one really is a delete. Per item, so an interrupt costs one.
      // Refused outright when the backup failed: an unrecoverable delete of an expensive artifact is
      // not something to do on the assumption that the copy probably worked.
      if (!backup) { unchanged++; continue; }
      store.setQuestionStatus(c.questionId, 'failed', `dropped by audit: ${c.qa?.why}`);
      store.deleteChunk(c.chunkId);
      dropped++;
    } else {
      store.setQuestionStatus(c.questionId, 'pending', `re-queued by audit: ${c.qa?.why}`);
      const a = await answerQuestions({
        store, repoPath: resolve(repoPath), questionIds: [c.questionId], limit: 1,
        shouldStop: () => stopping,
      });
      if (a.answered > 0) repaired++;
      else unchanged++;   // the old chunk is untouched and still retrievable
    }

    const nowMs = Date.now();
    if (nowMs - lastLine > 3000 || done === rejects.length) {
      lastLine = nowMs;
      const el = (nowMs - started) / 1000;
      const rate = done / Math.max(el, 0.001);
      out(`  ${done}/${rejects.length} · ${repaired} repaired · ${dropped} dropped · ${unchanged} unchanged`
        + ` · ${Math.round(el)}s elapsed`
        + `${rate > 0 && done < rejects.length ? ` · ~${Math.round((rejects.length - done) / rate)}s left` : ''}`);
    }
  }

  out();
  out(`${done} of ${rejects.length} handled · ${repaired} re-answered · ${dropped} dropped (bad question)`
    + `${unchanged ? ` · ${unchanged} left as they were (the new answer proved nothing)` : ''}`
    + `${stopping ? ' · stopped early — re-run to continue' : ''}`);
  recordAnswer(`indulge --fix · ${repaired} repaired · ${dropped} dropped · ${unchanged} unchanged`);

  const { embedCorpus } = await import('./embed.js');
  const e = await embedCorpus({ store, onStatus: (n) => out(`  ${n}`) });
  out(`  ${e.embedded} newly embedded · ${e.skipped} already had vectors`);
  return 0;
}

/**
 * `--search "<question>"` — what the corpus would hand the agent, printed verbatim.
 *
 * The one thing a corpus cannot tell you from its totals is whether it ANSWERS anything. 847 chunks
 * across 31 files is a number; whether the two that matter for today's ticket are among them is a
 * different question, and the only honest way to settle it is to ask and read the reply.
 *
 * Prints the same block `corpus_search` returns — same ranking, same staleness labels, same
 * citations — so what is on screen is exactly what the model would see, not a summary of it.
 */
async function searchCorpus(repoPath: string, query: string): Promise<number> {
  if (!query.trim()) {
    out('ayin indulge --search "<question>" — ask the corpus what it knows.');
    return 2;
  }
  const store = openStore(repoPath);
  if (!store.exists()) { out(`No corpus for ${resolve(repoPath)} yet.`); return 2; }
  const { corpusSearch } = await import('./inject.js');
  out(await corpusSearch(resolve(repoPath), query, 5));
  return 0;
}

function printStatus(repoPath: string): number {
  const store = openStore(repoPath);
  if (!store.exists()) { out(`No corpus for ${resolve(repoPath)} yet.`); return 0; }
  const t = store.totals();
  const p = store.progress();
  const holder = store.lockHolder();
  const last = store.lastWriteAt();

  out(`corpus  ${store.dir}`);
  out(`files ${t.files} · questions ${t.questions} (${t.answered} answered, ${t.failed} failed, ${t.pending} pending) · chunks ${t.chunks}`);
  if (p) {
    // ETA against whichever limit BINDS FIRST, and say which — the same rule the in-run batch line
    // follows. Projecting against the FILE list alone reported ~49h for a run with about half an
    // hour of answer budget left, which is worse than printing nothing: it is a number that invites
    // a decision, and the decision it invites is wrong.
    const elapsed = Date.now() - Date.parse(p.startedAt);
    const answered = t.answered + t.failed;
    const run = store.manifest().runs.find((r) => r.status === 'running');
    const budgetLeft = run?.answerBudget !== undefined ? Math.max(0, run.answerBudget - answered) : Infinity;

    const perFile = p.done > 0 ? elapsed / p.done : 0;
    const perAnswer = answered > 0 ? elapsed / answered : 0;
    const byFiles = perFile && p.total > p.done ? perFile * (p.total - p.done) : Infinity;
    const byBudget = perAnswer && Number.isFinite(budgetLeft) ? perAnswer * budgetLeft : Infinity;
    const eta = Math.min(byFiles, byBudget);
    const bound = byBudget <= byFiles ? 'budget' : 'files';

    out(`stage   ${p.stage} ${p.done}/${p.total}`
      + `${Number.isFinite(eta) ? ` · eta ~${hhmm(eta)} (${bound})` : ''}`
      + `${Number.isFinite(budgetLeft) ? ` · ${budgetLeft} of budget left` : ''}`);
    out(`current ${p.current}`);
  }
  if (holder) {
    const beat = Date.parse(holder.heartbeatAt);
    const age = Date.now() - beat;
    out(age < 10 * 60_000
      ? `RUNNING  pid ${holder.pid} on ${holder.host} · last heartbeat ${hhmm(age)} ago`
      : `STALLED  pid ${holder.pid} on ${holder.host} · last heartbeat ${hhmm(age)} ago — the next run will adopt this lock`);
  } else {
    out(`idle${last ? ` · last write ${hhmm(Date.now() - last.getTime())} ago` : ''}`);
  }
  const runs = store.manifest().runs;
  const interrupted = runs.filter((r) => r.status === 'interrupted').length;
  if (interrupted) out(`${interrupted} earlier run(s) were interrupted; their work was kept and resumed.`);
  return 0;
}

/**
 * Install a corpus built on another machine.
 *
 * This is the point of identity keying: chunks hold only repo-relative paths, so a corpus copied
 * from the box that spent the night is directly usable here. Nothing is rewritten on import.
 *
 * It refuses a corpus belonging to a DIFFERENT repo — dropping one project's answers onto another
 * would poison retrieval with chunks that cite files this tree does not have, and every one would
 * look authoritative. It also reports how much of it is already stale against this checkout, because
 * "142 chunks" and "142 chunks, 9 of them describing code you have since changed" are different
 * things to be handed.
 */
/**
 * A corpus travels as an ARCHIVE, so import has to accept one.
 *
 * The build happens on the box with the GPU and the corpus is carried to the laptop as a `.tgz` —
 * that is the whole point of import. Taking only an unpacked directory made the documented workflow
 * fail at its last step: the operator was handed a tarball, passed it to the flag named for exactly
 * this, and was told it was "not a corpus".
 *
 * The archive's own root directory is the store directory (`<repoKey>/manifest.json`), so after
 * extraction the manifest is one level down. Accept either shape rather than dictating how the
 * tarball was rolled: look at the root, then at a lone subdirectory.
 */
function unpacked(from: string): { dir: string; temp?: string } | null {
  const src = resolve(from);
  if (existsSync(join(src, 'manifest.json'))) return { dir: src };
  if (!existsSync(src) || statSync(src).isDirectory()) return null;

  const temp = mkdtempSync(join(tmpdir(), 'ayin-corpus-'));
  try {
    execFileSync('tar', ['xzf', src, '-C', temp], { stdio: 'pipe' });
  } catch {
    try { execFileSync('tar', ['xf', src, '-C', temp], { stdio: 'pipe' }); }
    catch { rmSync(temp, { recursive: true, force: true }); return null; }
  }
  if (existsSync(join(temp, 'manifest.json'))) return { dir: temp, temp };
  const entries = readdirSync(temp).filter((e) => statSync(join(temp, e)).isDirectory());
  for (const e of entries) {
    if (existsSync(join(temp, e, 'manifest.json'))) return { dir: join(temp, e), temp };
  }
  rmSync(temp, { recursive: true, force: true });
  return null;
}

function importCorpus(repoPath: string, from: string): number {
  const found = unpacked(from);
  if (!found) {
    out(`Not a corpus: ${resolve(from)} (no manifest.json)`);
    out('Expected a corpus directory, or a .tgz/.tar archive of one.');
    return 2;
  }
  const src = found.dir;
  const cleanup = (): void => { if (found.temp) rmSync(found.temp, { recursive: true, force: true }); };
  const store = openStore(repoPath);
  const incoming = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf-8')) as Manifest;
  const mine = store.identity;
  const theirs = incoming.identity;

  if (theirs && theirs.value !== mine.value) {
    // SAME PROJECT, DIFFERENT HOST is not a different repo. An SSH host alias — the usual way to hold
    // two GitHub accounts on one machine — rewrites the remote locally, so a corpus built on the box
    // with the alias was refused by the box without it. The owner/repo tail is what identifies the
    // project; the host is how this machine happens to reach it.
    if (!sameProject(mine, theirs)) {
      out(`That corpus belongs to a different repo.`);
      out(`  it was built for : ${theirs.kind} ${theirs.value}`);
      out(`  this repo is     : ${mine.kind} ${mine.value}`);
      out('Importing it would fill retrieval with answers about code this tree does not have.');
      cleanup();
      return 3;
    }
    out(`note: built against a different remote host for the same project — importing anyway.`);
    out(`  built for : ${theirs.value}`);
    out(`  this repo : ${mine.value}`);
  }
  if (!theirs) out('note: that corpus predates identity tracking — cannot verify it is for this repo.');

  if (resolve(store.dir) === src) { out('That corpus is already installed here.'); cleanup(); return 0; }

  // AN EXISTING CORPUS IS MOVED ASIDE, NEVER DELETED AND NEVER LEFT IN THE WAY.
  //
  // Import is how a corpus built on the machine with the card reaches the laptop, and that happens
  // again every time the corpus grows — so "move or delete it first" was an instruction to hand-run
  // `rm -rf` on hours of paid model time, repeatedly, at the exact moment the operator is trying to
  // get on with something else. Refusing to merge is still right; refusing to proceed is not.
  //
  // The old corpus keeps its content under a timestamped name, so a bad import costs one `mv` back.
  if (existsSync(store.dir)) {
    const aside = `${store.dir}.bak-${new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15)}-import`;
    renameSync(store.dir, aside);
    out(`the corpus already here was moved aside → ${aside}`);
    out('nothing was merged; restore it with mv if this import was a mistake.');
  }

  mkdirSync(dirname(store.dir), { recursive: true });
  cpSync(src, store.dir, { recursive: true });

  // RE-KEY to this machine's identity. The copied manifest still carries the building machine's key
  // and remote; leaving them would make every later run compare against a repo this tree is not, and
  // the next import would refuse the corpus it just installed.
  try {
    const mf = join(store.dir, 'manifest.json');
    const m = JSON.parse(readFileSync(mf, 'utf-8')) as Manifest;
    m.identity = mine;
    m.repoKey = mine.key;
    writeFileSync(mf, `${JSON.stringify(m, null, 2)}\n`, 'utf-8');
  } catch { /* a manifest that cannot be re-keyed still imports; the note above already said why */ }

  const after = openStore(repoPath);
  const chunks = after.chunks();
  let stale = 0;
  for (const c of chunks) if (assessChunk(repoPath, c).state !== 'fresh') stale++;
  out(`installed ${chunks.length} chunk(s) → ${after.dir}`);
  out(stale
    ? `${stale} of them describe code that has changed in this checkout — those are labelled STALE when used.`
    : 'every chunk still matches the code in this checkout.');
  cleanup();
  return 0;
}

/**
 * Which provider builds the corpus — separately from the one the agent talks to.
 *
 * A build is hours of a model reading source; a chat turn is seconds. Those are different jobs and
 * an operator legitimately wants them on different machines: the corpus on a hosted model for the
 * window and the reasoning, the interactive agent on the card in the room, at no cost per token.
 * Forcing one global choice means picking which of the two to make worse.
 *
 * Applied by setting the env var this process will read, rather than by threading a provider through
 * every call site: `indulge` IS its own process, `llm/select.ts` and `indulge/budget.ts` both consult
 * the env first, and a variable set before either is imported reaches both — including the context
 * budget, so choosing OpenAI here also widens the window without a second setting.
 */
function applyProviderOverride(explicit?: string): string | null {
  const want = (explicit || getConfigString('indulgeProvider') || '').trim().toLowerCase();
  if (!want) return null;
  process.env.AYIN_LLM_PROVIDER = want;
  return want;
}

export async function runIndulge(argv: string[]): Promise<number> {
  // Help first: asking for help must never be answered with "unknown flag: --help".
  if (argv.includes('--help') || argv.includes('-h')) { out(USAGE); return 0; }
  const { args, errors } = parseArgs(argv);
  if (errors.length) { out(errors.join('\n')); out(); out(USAGE); return 2; }

  const repoPath = resolve(args.repoPath);
  if (!existsSync(repoPath)) { out(`No such directory: ${repoPath}`); return 2; }

  // Before ANY provider is resolved or budget computed — both read the env first.
  const forced = applyProviderOverride(args.provider);

  if (args.status) return printStatus(repoPath);
  if (args.search !== undefined) return searchCorpus(repoPath, args.search);
  if (forced) out(`provider: ${forced} (this build only — the interactive agent is unchanged)`);
  if (args.retryFailed) return runRetryFailed(repoPath, args);
  if (args.qa) return runQaPass(repoPath, args);
  if (args.fix) return runFixPass(repoPath, args);
  if (args.importFrom) return importCorpus(repoPath, args.importFrom);

  if (args.embedOnly) {
    const store = openStore(repoPath);
    if (!store.exists()) { out(`No corpus for ${repoPath} yet — run indulge first.`); return 2; }
    let stopping = false;
    process.on('SIGINT', () => { stopping = true; out('\nstopping after the current chunk…'); });
    const embedSession = await initSession();
    recordPrompt(`ayin indulge --embed --repoPath ${repoPath}`);
    // Progress on the TERMINAL, not only in the status file. This sat silent for minutes: the
    // progress callback wrote where `--status` reads and nowhere the operator was looking, so a
    // working process was indistinguishable from a hung one. Throttled to a line every few seconds —
    // per-chunk would scroll 847 lines past faster than anyone can read them.
    const embedStart = Date.now();
    let lastLine = 0;
    const r = await embedCorpus({
      store, onStatus: (n) => out(`  ${n}`), shouldStop: () => stopping,
      onProgress: (done, total, current) => {
        store.setProgress({
          runId: 'embed', stage: 'answer', done, total, current,
          startedAt: new Date(embedStart).toISOString(),
        });
        const nowMs = Date.now();
        if (nowMs - lastLine < 3000 && done < total) return;
        lastLine = nowMs;
        const elapsed = nowMs - embedStart;
        const rate = done > 0 ? done / (elapsed / 1000) : 0;
        const left = rate > 0 ? (total - done) / rate : 0;
        out(`  ${done}/${total} embedded · ${Math.round(elapsed / 1000)}s elapsed`
          + `${rate > 0 ? ` · ${rate.toFixed(1)}/s` : ''}`
          + `${left > 0 && done < total ? ` · ~${Math.round(left)}s left` : ''}`);
      },
    });
    out(`${r.embedded} embedded · ${r.skipped} already done · ${r.failed} failed` + (r.foreign ? ` · ${r.foreign} from another model` : ''));
    recordAnswer(`indulge --embed · ${r.embedded} embedded · ${r.skipped} already done · ${r.failed} failed · model ${r.model}`);
    out(`model: ${r.model} — vectors are only comparable to others from this same model.`);
    out(`session ${embedSession}`);
    return r.failed && !r.embedded ? 1 : 0;
  }

  const store = openStore(repoPath);

  if (args.report) {
    if (!store.exists()) { out(`No corpus for ${repoPath} yet — run indulge first.`); return 2; }
    const r = writeReport({ store, repoPath });
    out(`${r.path}`);
    out(`${r.chunks} chunk(s) across ${r.files} file(s)${r.stale ? ` · ${r.stale} STALE` : ''}${r.failedQuestions ? ` · ${r.failedQuestions} unproven` : ''}`);
    return 0;
  }

  if (args.domains.length === 0) { out('--domains is required (comma-separated).'); out(); out(USAGE); return 2; }

  // Cooperative stop. The stages check this between records, so a signal costs at most the one
  // question in flight; a second signal is an operator who means it.
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) { out('\nsecond signal — exiting now.'); process.exit(130); }
    stopping = true;
    out('\nstopping after the current step… (again to force)');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const shouldStop = (): boolean => stopping;

  // A session record, so an overnight run on another machine leaves a readable trail. Without one
  // `session-record.ts` no-ops on a null session id and indulge is invisible: eight hours of work
  // whose only account is a manifest the operator would have to know to look for.
  const sessionId = await initSession();
  recordPrompt(`ayin indulge --domains "${args.domains.join(',')}" --repoPath ${repoPath}`);

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const headSha = '';
  try {
    store.beginRun({ runId, domains: args.domains, headSha, restart: args.restart, answerBudget: args.maxQuestions });
    if (args.restart) {
      out(store.lastSnapshot
        ? `--restart: the previous corpus was copied to ${store.lastSnapshot}`
        : '--restart: WARNING — the previous corpus could not be backed up, and has been discarded');
    }
  } catch (err) {
    if (err instanceof StoreLockedError) {
      out(String(err.message));
      out(`If that process is gone, its lock is adopted automatically once its heartbeat stops.`);
      return 3;
    }
    throw err;
  }

  const startedAt = new Date().toISOString();
  const progress = (stage: Stage, done: number, total: number, current: string): void =>
    store.setProgress({ runId, stage, done, total, current, startedAt });
  const status = (note: string): void => out(`  ${note}`);

  try {
    out(`indulge ${repoPath}`);
    out(`corpus  ${store.dir}`);
    out(`domains ${args.domains.join(', ')}`);
    out();

    // ── stage 1 ────────────────────────────────────────────────────────────────
    progress('discover', 0, args.domains.length, '');
    let matched = 0;
  // ── which directories are NOT this team's code ────────────────────────────────
  //
  // Decided ONCE, before any domain is discovered, because every later stage pays for it: the walk,
  // the reference index, and — most expensively — the questions generated and answered about files
  // the team merely consumes. A real run produced a "bingo gameplay" corpus rooted in
  // `Plugins/Zenject/Source/Main/IInstantiator.cs`, questions billed and all.
  //
  // Cheap pass first (names we already know), one model call for the remainder, cached in the corpus.
  let vendorRoots: string[] = [];
  if (!args.keepVendor) {
    const v = await detectVendorRoots({
      repoPath,
      corpusDir: store.dir,
      refresh: args.rescanVendor === true,
      classify: args.classifyVendor === true,
      onStatus: (s) => out(`  ${s}`),
    });
    vendorRoots = v.roots;
  } else {
    out('  --keep-vendor: third-party code will be indexed too');
  }

    for (const [i, spec] of args.domains.entries()) {
      // `name@path` scopes ONE domain to a subtree — different domains need different places, so a
      // single global scope would not do. The name stored on every file and chunk is the bare name;
      // the path is a discovery constraint, not part of the operator's vocabulary.
      const at = spec.lastIndexOf('@');
      const domain = at > 0 ? spec.slice(0, at).trim() : spec;
      const scope = at > 0 ? spec.slice(at + 1).trim() : (args.scope ?? '');
      if (scope) out(`  scoped to ${scope}`);
      if (shouldStop()) break;
      out(`[discover] ${domain}`);
      const r = await discoverDomain({
        store, repoPath, domain, maxDepth: args.maxDepth, maxFiles: args.maxFiles, onStatus: status,
        vendorRoots, scope,
      });
      matched += r.added;
      progress('discover', i + 1, args.domains.length, domain);
      recordTool('indulge:discover', domain, JSON.stringify({
        seeds: r.seeds, added: r.added, hallucinated: r.hallucinated.length, truncated: r.truncated, indexed: r.indexed,
      }));
      if (r.seeds === 0) out(`  "${domain}" matched nothing in this repo — no files written.`);
      else out(`  ${r.added} file(s)${r.truncated ? ' (capped — the walk stopped early)' : ''}` +
        `${r.hallucinated.length ? ` · ${r.hallucinated.length} named path(s) did not exist and were dropped` : ''}`);
    }

    if (matched === 0) {
      out();
      out('Nothing matched. No questions, no chunks — a corpus is not invented to have one.');
      store.endRun(runId, 'finished');
      return 0;
    }

    if (args.dryRun) {
      const files = store.files().length;
      out();
      out(`dry run: ${files} file(s) discovered. A full run would ask roughly ${files * 5 * 2}–${files * 5 * 5} question(s).`);
      out('Nothing was spent and no questions were written.');
      store.endRun(runId, 'finished');
      return 0;
    }

    // ── stages 2 + 3, INTERLEAVED ──────────────────────────────────────────────
    //
    // These used to be two barriers: generate every question for every file, THEN answer. Measured
    // on a real run — 1139 files, 5802 generation calls — that meant TEN HOURS holding the GPU with
    // ZERO chunks written, because not one answer had been reached. Stopping produced nothing usable
    // and `--max-questions` bounded only the tail, so the cap did not shorten the run at all.
    //
    // Resumability was never the problem: every question was on disk. INCREMENTAL VALUE was. A run
    // that cannot be stopped for a usable half is a run that has to be babysat to the end.
    //
    // So: files in DEPTH ORDER (seeds first — that ordering is why a capped run describes the thing
    // asked about rather than its neighbours), a batch at a time, generate then answer then move on.
    // Chunks land from the first batch, an interrupted run leaves a corpus that already retrieves,
    // and the answer budget stops the whole loop instead of only its last stage.
    const BATCH = 12;
    const runStart = Date.now();

    /** `4h 12m` / `38m` / `45s` — the shortest form that is still unambiguous. */
    const dur = (ms: number): string => {
      const sec = Math.max(0, Math.round(ms / 1000));
      if (sec < 90) return `${sec}s`;
      const min = Math.round(sec / 60);
      return min < 90 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
    };
    const depthByPath = new Map<string, number>();
    for (const f of store.files()) {
      const prev = depthByPath.get(f.path);
      if (prev === undefined || f.depth < prev) depthByPath.set(f.path, f.depth);
    }
    const ordered = [...depthByPath.keys()].sort((a, b) =>
      (depthByPath.get(a) ?? 99) - (depthByPath.get(b) ?? 99) || a.localeCompare(b));

    out();
    out(`[questions + answers]  ${ordered.length} file(s), ${BATCH} at a time, seeds first`);
    const q = { generated: 0, duplicates: 0, skipped: 0, calls: 0, targets: 0, files: 0, stopped: false };
    const a = { attempted: 0, answered: 0, failed: 0, skipped: 0, rejectedCitations: 0, stopped: false };
    let budget = args.maxQuestions ?? Infinity;

    for (let i = 0; i < ordered.length && budget > 0 && !shouldStop(); i += BATCH) {
      const batch = ordered.slice(i, i + BATCH);
      const qr = await generateQuestions({
        store, repoPath, categories: args.categories, only: batch, onStatus: status, shouldStop,
        // File position, NOT the inner step: `--status` renders done/total as files and derives its
        // ETA from them, so mixing units there reported nonsense like 405/351.
        onProgress: (_done, _total, current) => progress('questions', i, ordered.length, current),
      });
      q.generated += qr.generated; q.duplicates += qr.duplicates; q.skipped += qr.skipped;
      q.calls += qr.calls; q.targets += qr.targets; q.files += qr.files;
      if (qr.stopped) { q.stopped = true; break; }

      const ar = await answerQuestions({
        store, repoPath, only: batch, limit: Number.isFinite(budget) ? budget : undefined,
        deep: args.deep, onStatus: status, shouldStop,
        onProgress: (done, total, current) => progress('answer', i, ordered.length, `${current} · ${done}/${total} in batch`),
      });
      a.attempted += ar.attempted; a.answered += ar.answered; a.failed += ar.failed;
      a.skipped += ar.skipped; a.rejectedCitations += ar.rejectedCitations;
      budget -= ar.answered + ar.failed;
      if (ar.stopped) { a.stopped = true; break; }

      // One line per batch, so a long run is legible while it runs rather than only at the end.
      // ETA against whichever limit BINDS FIRST — the answer budget or the file list. Reporting only
      // one of them is how a run that was about to stop at file 35 of 351 looked like it had hours
      // to go, and a progress line nobody can act on is the same as no progress line.
      const filesDone = Math.min(i + BATCH, ordered.length);
      const elapsed = Date.now() - runStart;
      const perAnswer = a.answered > 0 ? elapsed / a.answered : 0;
      const perFile = filesDone > 0 ? elapsed / filesDone : 0;
      const byBudget = Number.isFinite(budget) && perAnswer > 0 ? budget * perAnswer : Infinity;
      const byFiles = perFile > 0 ? (ordered.length - filesDone) * perFile : Infinity;
      const eta = Math.min(byBudget, byFiles);
      const bound = byBudget <= byFiles ? 'budget' : 'files';

      out(`  [${filesDone}/${ordered.length}] depth ${depthByPath.get(batch[0]) ?? '?'}`
        + ` · +${qr.generated} question(s) · +${ar.answered} answered`
        + `${ar.failed ? ` · ${ar.failed} unproven` : ''}`
        + `${Number.isFinite(budget) ? ` · ${Math.max(0, budget)} budget left` : ''}`
        + ` · ${dur(elapsed)} elapsed`
        + `${Number.isFinite(eta) ? ` · ~${dur(eta)} left (${bound})` : ''}`
        + `${a.answered > 0 ? ` · ${(a.answered / (elapsed / 60000)).toFixed(1)}/min` : ''}`);
    }

    recordTool('indulge:questions', args.categories?.join(',') ?? 'all', JSON.stringify(q));
    recordTool('indulge:answer', `limit=${args.maxQuestions ?? 'none'}`, JSON.stringify(a));
    out();
    out(`  ${q.generated} new question(s)`
      + `${q.duplicates ? `, ${q.duplicates} already known` : ''}${q.skipped ? `, ${q.skipped} skipped (already generated)` : ''}`);
    out(`  ${a.answered} answered · ${a.failed} unproven (not stored) · ${a.rejectedCitations} citation(s) rejected`);

    // ── the deliverable ────────────────────────────────────────────────────────
    // Close the run BEFORE writing the report: `endRun` stamps the run's totals from disk, and the
    // report renders the manifest. Writing it first published a run row reading `running · 0 chunks`
    // in a document whose whole job is to be an accurate account of the night.
    progress('report', 0, 1, 'writing');
    store.endRun(runId, stopping ? 'interrupted' : 'finished');
    const r = writeReport({ store, repoPath });
    const totals = store.totals();
    out();
    out(`report  ${r.path}`);
    out(`corpus  ${totals.chunks} chunk(s) · ${totals.answered} answered · ${totals.failed} unproven · ${totals.pending} still pending`);
    if (stopping) out('Stopped early — re-run to continue where this left off.');
    // The one line worth finding later: what this night actually produced.
    recordAnswer(`indulge ${stopping ? 'INTERRUPTED' : 'finished'} · domains ${args.domains.join(',')}`
      + ` · ${totals.chunks} chunk(s) · ${totals.answered} answered · ${totals.failed} unproven`
      + ` · ${totals.pending} pending · report ${r.path}`);
    out(`session ${sessionId} — the run is logged in ~/.ayin-cli/sessions/${sessionId}.jsonl`);
    return 0;
  } catch (err) {
    // The run stays `running` in the manifest only until the next run adopts it, which is what makes
    // a crash indistinguishable from a kill: both resume.
    store.endRun(runId, 'interrupted');
    const msg = err instanceof Error ? err.message : String(err);
    recordAnswer(`indulge FAILED: ${msg}`);
    out(`indulge failed: ${msg}`);
    return 1;
  }
}
