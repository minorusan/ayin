/**
 * indulge/store.ts — the on-disk corpus, and the only thing that survives the night.
 *
 * `ayin indulge` is an OVERNIGHT job: the operator decides in the evening which part of a repo
 * tomorrow's work lands in, starts it, and closes the laptop. A crash, a reboot or a kill -9 must cost
 * at most the one question that was in flight — never the eight hours before it. That single
 * requirement is what this module is: every stage writes its result to disk the moment it has one,
 * and every stage reads its own remaining work back off disk rather than from memory.
 *
 *   ~/.ayin-cli/rag/<repo-key>/
 *     manifest.json      repoPath + one row per run (domains, headSha, totals, status)
 *     files.jsonl        stage 1 — one line per discovered file
 *     questions.jsonl    stage 2 — one line per question, PLUS one line per status change
 *     chunks/<id>.json   stage 3 — one answered, citation-verified question
 *     progress.json      heartbeat — stage, done/total, current item (this is what `--status` reads)
 *     run.lock           the running process, so two indulges cannot share one corpus
 *
 * Outside the work tree on purpose: chunks quote method bodies, and a work repo belongs to an
 * employer — one `git add -A` in the wrong directory would publish the corpus.
 *
 * **Append-only, flushed per record.** `appendFileSync` opens, writes and closes, so a line is on
 * disk before the next one is computed; a power cut leaves a truthful partial file whose last line
 * may be torn, and every reader here skips a line it cannot parse. The two whole-file documents
 * (`manifest.json`, `progress.json`) go through `writeAtomic` — temp + rename — so a reader sees
 * the old bytes or the new ones, never half of either.
 *
 * **Status changes are appends, not rewrites.** A question's `pending → answered` is a second line
 * carrying the same `id`; readers merge lines in order and the last one wins. Rewriting a JSONL
 * file in place is precisely the operation that loses everything when the power goes at the wrong
 * millisecond, so this module never does it.
 */

import {
  appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { writeAtomic } from '../prompts-service.js';

/** Bumped when the on-disk shape changes incompatibly; a mismatched store is reported, not guessed at. */
export const STORE_VERSION = 1;

/** A lock whose heartbeat is older than this is treated as abandoned (crash, power cut, closed lid). */
const LOCK_STALE_MS = 10 * 60 * 1000;

export type Stage = 'idle' | 'discover' | 'questions' | 'answer' | 'report';
export type QuestionStatus = 'pending' | 'answered' | 'failed';
export type RunStatus = 'running' | 'finished' | 'interrupted';
export type Category = 'git' | 'dependencies' | 'connections' | 'functionality' | 'gotchas';

export const CATEGORIES: Category[] = ['git', 'dependencies', 'connections', 'functionality', 'gotchas'];

/** A named thing inside a file. `kind: 'file'` means the question is about the file as a whole. */
export interface Entity {
  kind: 'file' | 'class' | 'method' | 'property' | 'field' | 'function' | 'type';
  name: string;
  file: string;
}

/** Stage 1. `path` is repo-relative with POSIX separators — citations resolve against `repoPath`. */
export interface FileRecord {
  domain: string;
  path: string;
  /** 0 = an explore seed; 1..n = reached by n reference hops. */
  depth: number;
  /** Why this file is in the set, in one line — the audit trail for "did discovery invent this?". */
  why: string;
  /** git blob sha of the file when it was discovered. */
  sha: string;
  discoveredAt: string;
}

/** Stage 2. */
export interface QuestionRecord {
  id: string;
  /** repo-relative path this question is about. */
  file: string;
  entity: Entity | null;
  category: Category;
  text: string;
  status: QuestionStatus;
  /** Why a `failed` question failed — an unresolvable citation, a dead model, a read error. */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** Proof that an answer came from the code. Verified before its chunk is written. */
export interface Citation {
  path: string;
  startLine: number;
  endLine: number;
  /** git blob sha of the cited FILE at answer time — the line range is checked against these bytes. */
  sha: string;
}

/** Stage 3 — the unit Phase 2 will embed. */
export interface Chunk {
  chunkId: string;
  questionId: string;
  repoKey: string;
  /**
   * DEPRECATED and no longer written. It held an absolute path, which made every chunk carry the
   * building machine's home directory — not portable, and a personal detail in a file that may be
   * copied to another box. Nothing ever read it; the manifest holds the repo path.
   */
  repoPath?: string;
  /**
   * Every domain this chunk's file was discovered under.
   *
   * An ARRAY because a file legitimately belongs to several: discovery run for `liveops` and for
   * `trail-minigame` can surface the same file, and recording only the first made the chunk
   * invisible when searching the other. It is also the coarse index retrieval searches first —
   * pick the domains, then rank chunks inside them — so a chunk stranded in one domain is a chunk
   * that cannot be found from the other.
   */
  domains: string[];
  /** DEPRECATED single-domain form, still read from corpora written before `domains`. */
  domain?: string;
  question: string;
  answer: string;
  /**
   * The audit's verdict (`indulge --qa`), when one has been taken.
   *
   * Written onto the chunk rather than kept in a side file, and REVERSIBLE: nothing is deleted by an
   * audit. `--fix` decides what to do about a reject, and an audit that destroyed its evidence could
   * not be re-run with better criteria. Absent means "never judged", which is different from "ok".
   */
  qa?: { verdict: 'ok' | 'reject'; why?: string; by: 'rule' | 'model'; at: string };
  files: string[];
  citations: Citation[];
  entity: Entity | null;
  category: Category;
  model: string;
  createdAt: string;
  /** git blob sha of `entity.file` when answered — the invalidation key for a re-run. */
  sourceSha: string;
  /**
   * Where this was learned. BOTH, on purpose:
   *
   * `commit` is the machinery — it is what a diff can be taken against, and what says whether the
   * chunk is in your current history. `branch` is the MEANING: "this was written on dev" tells an
   * agent something a sha never will, and resolving a sha to a branch name is a tool call spent
   * learning nothing. Optional, so corpora built before this shipped keep working — they simply
   * report their provenance as unknown.
   */
  branch?: string;
  commit?: string;
  /**
   * Project-type facts, namespaced by the indulger that produced them (`ext.unity`, `ext.arduino`).
   *
   * Namespaced rather than flat because two packs will both want `references` and neither will know
   * the other took it. The CORE above is required and validated; this bag is open on purpose — a
   * Unity repo knows things about itself that no generic parser will ever derive, and baking those
   * into the core would make the core a liar about every other project type.
   */
  ext?: Record<string, Record<string, unknown>>;
}

export interface RunRecord {
  runId: string;
  started: string;
  finished?: string;
  domains: string[];
  headSha: string;
  status: RunStatus;
  /** Files discovered for this run's domains. `0` is a legitimate, reportable outcome. */
  matched: number;
  questions: number;
  chunks: number;
  failed: number;
  /**
   * The `--max-questions` this run was given, when it was given one.
   *
   * Recorded so `--status` can report an ETA against the limit that actually BINDS. Without it,
   * status could only project against the file list and reported ~49h for a run that had about half
   * an hour of budget left — the third number in this tool to mislead by measuring the wrong thing.
   */
  answerBudget?: number;
}

export interface Manifest {
  version: number;
  repoKey: string;
  /** How the key was derived — so a directory name is explicable rather than a mystery hash. */
  identity?: { kind: IdentityKind; value: string };
  /** Where it was last built, for the report header. Local information, never an identity. */
  repoPath: string;
  createdAt: string;
  runs: RunRecord[];
}

export interface Progress {
  runId: string;
  stage: Stage;
  done: number;
  total: number;
  /** What is being worked on right now, e.g. `src/Match.cs · gotchas`. */
  current: string;
  startedAt: string;
  updatedAt: string;
}

export interface Totals {
  files: number;
  questions: number;
  pending: number;
  answered: number;
  failed: number;
  chunks: number;
}

interface LockFile {
  pid: number;
  host: string;
  runId: string;
  startedAt: string;
  heartbeatAt: string;
}

/** Thrown when another live indulge owns this corpus. Carries the holder so the message can name it. */
export class StoreLockedError extends Error {
  constructor(readonly holder: LockFile) {
    super(`another ayin indulge is running on this repo (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt})`);
    this.name = 'StoreLockedError';
  }
}

/** Root of every repo's corpus. Overridable so gates and tests never touch the operator's real one. */
export function ragRoot(): string {
  return process.env.AYIN_RAG_DIR || join(homedir(), '.ayin-cli', 'rag');
}

/**
 * How a repo is identified, so a corpus built on one machine is usable on another.
 *
 * The corpus itself has always been portable — every path inside a chunk is repo-relative POSIX.
 * What was not portable was its NAME: keying on the absolute path meant `~/work/ayin` and
 * `/Users/you/ayin` were different corpora, so a night of GPU built on one box could not be dropped
 * onto another.
 *
 * Identity, in order of preference:
 *   1. the `origin` remote, normalised (`github.com/owner/repo`) — the same everywhere a repo is
 *      cloned, and readable by a human wondering what a directory holds;
 *   2. the ROOT COMMIT — identical in every clone, immune to renames and re-hosting, but it changes
 *      if history is ever rewritten (ayin's own was), which is why the remote comes first;
 *   3. the absolute path, for a directory that is not a git repo at all. Not portable, and honest
 *      about it.
 *
 * The slug is derived from the identity too, never from the directory name — a repo cloned into a
 * differently-named folder must still resolve to the same corpus.
 */
export type IdentityKind = 'remote' | 'root' | 'path';

export interface RepoIdentity {
  kind: IdentityKind;
  /** The raw identity value, recorded in the manifest so a key is explicable. */
  value: string;
  key: string;
}

function gitOut(repoPath: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000,
    }).trim();
  } catch { return ''; }
}

/** `git@github.com:owner/repo.git` and `https://github.com/owner/repo` → `github.com/owner/repo`. */
export function normalizeRemote(url: string): string {
  return url.trim()
    .replace(/^[a-z+]+:\/\//i, '')     // scheme
    .replace(/^[^@/]+@/, '')            // user@
    .replace(/:(?=[^/])/, '/')          // scp-style host:path
    // Trailing slashes FIRST: `…/ayin.git/` must lose the slash before `.git` can be recognised,
    // or the same repo cloned from a URL with a trailing slash gets its own corpus.
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'repo';

export function repoIdentity(repoPath: string): RepoIdentity {
  const abs = resolve(repoPath);
  const remote = gitOut(abs, ['remote', 'get-url', 'origin']);
  if (remote) {
    const value = normalizeRemote(remote);
    return { kind: 'remote', value, key: `${slugify(value.split('/').pop() || 'repo')}-${hash8(value)}` };
  }
  // `--max-parents=0` can list several roots; the last is the oldest, and sorting keeps it stable.
  const roots = gitOut(abs, ['rev-list', '--max-parents=0', 'HEAD']).split('\n').filter(Boolean).sort();
  if (roots.length) {
    const value = roots[0];
    return { kind: 'root', value, key: `repo-${hash8(value)}` };
  }
  return { kind: 'path', value: abs, key: `${slugify(basename(abs))}-${hash8(abs)}` };
}

const hash8 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 8);

/** The corpus key for this repo — identity-derived, so it is the same on every machine. */
export function repoKey(repoPath: string): string {
  return repoIdentity(repoPath).key;
}

/** The pre-1.0.268 key: a hash of the absolute path. Kept ONLY so an existing corpus can be found
 *  and migrated rather than orphaned — a corpus costs a night of GPU. */
export function legacyRepoKey(repoPath: string): string {
  const abs = resolve(repoPath);
  return `${slugify(basename(abs))}-${hash8(abs)}`;
}

/**
 * The git blob sha of these bytes — identical to `git hash-object <file>`.
 *
 * Deliberately git's format rather than a plain sha1: a chunk's `sourceSha` can then be checked by
 * hand against the repo with a one-liner, which is the difference between a proof and a number.
 */
export function blobSha(content: Buffer | string): string {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * The form two questions are compared on: lowercased, punctuation dropped, whitespace collapsed.
 *
 * This collides re-runs that produce the same question with different casing, spacing or trailing
 * punctuation — which is what a re-generation actually does most of the time. It does NOT collide
 * paraphrases ("what breaks if I change this?" vs "what are the risks of editing this?"); nothing
 * lexical can, and pretending otherwise would silently double the night's work. Paraphrase dedup is
 * an embedding problem and belongs to Phase 2.
 */
export function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

const entityKey = (e: Entity | null): string => (e ? `${e.kind}:${e.name}` : '');

/** Stable across re-runs: the same question about the same entity is the same question. */
export function questionId(text: string, file: string, entity: Entity | null): string {
  return createHash('sha1').update(`${file}|${entityKey(entity)}|${normalizeQuestion(text)}`).digest('hex');
}

/** Stable across re-runs, and independent of the domain string that happened to surface the file. */
export function chunkId(key: string, file: string, entity: Entity | null, category: Category, qId: string): string {
  return createHash('sha1').update(`${key}|${file}|${entityKey(entity)}|${category}|${qId}`).digest('hex');
}

/** Parse a JSONL file, skipping any line that will not parse — a torn last line is the normal
 *  aftermath of a power cut mid-append, and it must not take the rest of the corpus with it. */
function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(v as Record<string, unknown>);
    } catch { /* torn or corrupt line — skip it, keep the rest */ }
  }
  return rows;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; } catch { return null; }
}

const now = (): string => new Date().toISOString();

/** True if a process is running under this pid. `kill(pid, 0)` signals nothing; it only asks. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    // EPERM means it exists and belongs to someone else — alive for our purposes.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One repo's corpus. Construct with `openStore(repoPath)`; every path is fixed at construction so
 * no caller can write outside the store directory.
 */
export class IndulgeStore {
  readonly key: string;
  readonly repoPath: string;
  readonly identity: RepoIdentity;
  /** Not readonly: a legacy corpus that cannot be renamed is used where it lies. */
  dir: string;
  private readonly manifestFile: string;
  private readonly filesFile: string;
  private readonly questionsFile: string;
  private readonly askedFile: string;
  private readonly chunksDir: string;
  private readonly progressFile: string;
  private readonly lockFile: string;
  private held: LockFile | null = null;
  /**
   * The known question ids, seeded from disk on first use and kept current on every append.
   *
   * Not an optimisation for its own sake: without it `addQuestion` re-parses the whole JSONL to
   * answer "have I seen this id?", which is quadratic in the number of questions. Measured on this
   * box — 500 questions cost 175ms, 8000 cost 51s, and the curve keeps going; a repo whose files ×
   * entities × 5 categories reach five figures would spend the night on duplicate-checking rather
   * than on answers. Disk stays the source of truth on a cold start; this only spares a process
   * from re-reading what it just wrote, which is safe because the run lock means one writer.
   */
  private idCache: Set<string> | null = null;

  constructor(repoPath: string) {
    this.repoPath = resolve(repoPath);
    this.identity = repoIdentity(this.repoPath);
    this.key = this.identity.key;
    this.dir = join(ragRoot(), this.key);
    this.adoptLegacyCorpus();
    this.manifestFile = join(this.dir, 'manifest.json');
    this.filesFile = join(this.dir, 'files.jsonl');
    this.questionsFile = join(this.dir, 'questions.jsonl');
    this.askedFile = join(this.dir, 'asked.jsonl');
    this.chunksDir = join(this.dir, 'chunks');
    this.progressFile = join(this.dir, 'progress.json');
    this.lockFile = join(this.dir, 'run.lock');
  }

  /**
   * A corpus built before identity keying sits under a path-derived name. Adopt it rather than
   * silently starting an empty one beside it — that would look like the night's work had vanished.
   * Renamed so the two never diverge; if the rename fails the legacy directory is used in place.
   */
  private adoptLegacyCorpus(): void {
    if (existsSync(this.dir)) return;
    const legacy = join(ragRoot(), legacyRepoKey(this.repoPath));
    if (legacy === this.dir || !existsSync(legacy)) return;
    try { renameSync(legacy, this.dir); } catch { this.dir = legacy; }
  }

  /** Create the directory tree. Safe to call repeatedly; never touches existing content. */
  private ensure(): void {
    mkdirSync(this.chunksDir, { recursive: true });
  }

  // ---------------------------------------------------------------- manifest

  manifest(): Manifest {
    const m = readJson<Manifest>(this.manifestFile);
    if (m && Array.isArray(m.runs)) return m;
    return { version: STORE_VERSION, repoKey: this.key, repoPath: this.repoPath, createdAt: now(), runs: [] };
  }

  private writeManifest(m: Manifest): void {
    this.ensure();
    writeAtomic(this.manifestFile, JSON.stringify(m, null, 2) + '\n');
  }

  // -------------------------------------------------------------------- lock

  /**
   * Take the corpus, or explain who has it.
   *
   * The stale case is the one that matters: after a power cut the lock file is still there and its
   * pid is dead, so a plain "lock exists → refuse" would need a human to delete a file before the
   * work could resume — exactly the human-in-the-loop the overnight requirement forbids. A lock
   * whose pid is gone (same host) or whose heartbeat has stopped (any host, e.g. a home directory
   * on a network mount) is adopted, not obeyed.
   */
  private acquireLock(runId: string): void {
    this.ensure();
    const existing = readJson<LockFile>(this.lockFile);
    if (existing && typeof existing.pid === 'number') {
      const sameHost = existing.host === hostname();
      const beat = Date.parse(existing.heartbeatAt || existing.startedAt || '');
      const heartbeatDead = !Number.isFinite(beat) || Date.now() - beat > LOCK_STALE_MS;
      const alive = sameHost ? pidAlive(existing.pid) && !heartbeatDead : !heartbeatDead;
      if (alive) throw new StoreLockedError(existing);
    }
    const lock: LockFile = { pid: process.pid, host: hostname(), runId, startedAt: now(), heartbeatAt: now() };
    writeAtomic(this.lockFile, JSON.stringify(lock, null, 2) + '\n');
    this.held = lock;
  }

  /** Refresh the lock's heartbeat. Called from `setProgress`, so liveness rides on real work. */
  private beat(): void {
    if (!this.held) return;
    this.held = { ...this.held, heartbeatAt: now() };
    try { writeAtomic(this.lockFile, JSON.stringify(this.held, null, 2) + '\n'); } catch { /* a lost beat is not fatal */ }
  }

  /** Release only OUR lock — never one adopted from us by a later run that decided we were dead. */
  releaseLock(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    const onDisk = readJson<LockFile>(this.lockFile);
    if (onDisk && onDisk.pid === held.pid && onDisk.host === held.host) {
      try { unlinkSync(this.lockFile); } catch { /* already gone */ }
    }
  }

  /** Who holds the corpus right now, for `--status` and for the refusal message. */
  lockHolder(): LockFile | null {
    return readJson<LockFile>(this.lockFile);
  }

  // -------------------------------------------------------------------- runs

  /**
   * Open a run and return its record.
   *
   * Any run still marked `running` in the manifest belongs to a process that died without
   * finishing, so it is closed as `interrupted` here — the manifest then tells the truth about the
   * night without anyone having to remember what happened. Its data stays: that is what the new
   * run resumes from.
   *
   * `restart` discards the corpus (files, questions, chunks, progress) but keeps the run history,
   * because "how many times has this been rebuilt, and when" is the audit trail.
   */
  beginRun(opts: { runId: string; domains: string[]; headSha: string; restart?: boolean; answerBudget?: number }): RunRecord {
    this.acquireLock(opts.runId);
    const m = this.manifest();
    for (const r of m.runs) if (r.status === 'running') r.status = 'interrupted';

    if (opts.restart) {
      // A restart throws away every answered question and every chunk — hours of a shared GPU. The
      // snapshot is not optional and not a flag: the operator typing --restart means "rebuild", not
      // "make last night unrecoverable".
      this.lastSnapshot = this.snapshot('restart');
      for (const p of [this.filesFile, this.questionsFile, this.askedFile, this.progressFile]) {
        try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
      }
      try { rmSync(this.chunksDir, { recursive: true, force: true }); } catch { /* best effort */ }
      this.idCache = null; // the file it was built from is gone
      this.ensure();
    }

    const run: RunRecord = {
      runId: opts.runId,
      started: now(),
      domains: opts.domains,
      headSha: opts.headSha,
      status: 'running',
      matched: 0,
      questions: 0,
      chunks: 0,
      failed: 0,
      answerBudget: opts.answerBudget,
    };
    m.version = STORE_VERSION;
    m.repoKey = this.key;
    m.repoPath = this.repoPath;
    m.identity = { kind: this.identity.kind, value: this.identity.value };
    m.runs.push(run);
    this.writeManifest(m);
    return run;
  }

  /**
   * Close a run, stamping its totals from what is actually ON DISK rather than from counters the
   * process was carrying. A count derived from memory is a count that lies after a crash.
   */
  endRun(runId: string, status: Exclude<RunStatus, 'running'> = 'finished'): RunRecord | null {
    const m = this.manifest();
    const run = m.runs.find((r) => r.runId === runId);
    if (run) {
      const t = this.totals();
      run.finished = now();
      run.status = status;
      run.matched = t.files;
      run.questions = t.questions;
      run.chunks = t.chunks;
      run.failed = t.failed;
      this.writeManifest(m);
    }
    this.releaseLock();
    return run ?? null;
  }

  // ------------------------------------------------------------ stage 1: files

  /** Append one discovered file. Written the moment discovery decides, not batched at stage end. */
  addFile(rec: Omit<FileRecord, 'discoveredAt'>): FileRecord {
    this.ensure();
    const full: FileRecord = { ...rec, discoveredAt: now() };
    appendFileSync(this.filesFile, JSON.stringify(full) + '\n');
    return full;
  }

  /** Every discovered file, deduped on `domain + path` (a later line wins — a re-discovery at a
   *  shallower depth or with a better reason replaces the earlier one). */
  files(): FileRecord[] {
    const byKey = new Map<string, FileRecord>();
    for (const row of readJsonl(this.filesFile)) {
      if (typeof row.path !== 'string' || typeof row.domain !== 'string') continue;
      byKey.set(`${row.domain}\u0000${row.path}`, row as unknown as FileRecord);
    }
    return [...byKey.values()];
  }

  // -------------------------------------------------------- stage 2: questions

  /**
   * Append a question unless its id is already known.
   *
   * Returns false when it was already there — which is how a resumed run skips work it did before
   * the crash, and how a re-run stays an expansion rather than a restart.
   */
  addQuestion(rec: Omit<QuestionRecord, 'status' | 'createdAt' | 'updatedAt'> & { status?: QuestionStatus }): boolean {
    const known = this.knownIds();
    if (known.has(rec.id)) return false;
    this.ensure();
    const full: QuestionRecord = { ...rec, status: rec.status ?? 'pending', createdAt: now(), updatedAt: now() };
    appendFileSync(this.questionsFile, JSON.stringify(full) + '\n');
    known.add(rec.id);
    return true;
  }

  /**
   * Record that a (file, entity, category) was ASKED — regardless of whether it yielded anything.
   *
   * Without this, "considered and produced nothing" is indistinguishable from "never asked", because
   * the resume set was derived from stored QUESTIONS. A target the model rightly had nothing to say
   * about was therefore re-asked on every future run, at the cost of the whole file in the prompt,
   * forever. Deriving resume from questions alone cannot express a legitimate empty answer.
   *
   * Kept as its own append-only log rather than folded into questions.jsonl: it is a different fact
   * with a different lifetime, and a reader of the corpus should not have to filter phantom rows out
   * of the question list to count questions.
   */
  markAsked(file: string, entity: Entity | null, category: Category): void {
    this.ensure();
    const key = `${file}|${entity ? `${entity.kind}:${entity.name}` : ''}|${category}`;
    if (this.askedCache?.has(key)) return;
    appendFileSync(this.askedFile, JSON.stringify({ file, entity, category, at: now() }) + '\n');
    this.askedCache?.add(key);
  }

  /** Every (file, entity, category) already put to the model, as `file|kind:name|category`. */
  askedKeys(): ReadonlySet<string> {
    if (!this.askedCache) {
      this.askedCache = new Set(
        readJsonl(this.askedFile).map((r) => {
          const e = r.entity as { kind?: string; name?: string } | null;
          return `${String(r.file ?? '')}|${e ? `${e.kind}:${e.name}` : ''}|${String(r.category ?? '')}`;
        }),
      );
    }
    return this.askedCache;
  }

  private askedCache: Set<string> | null = null;

  /** Where the most recent automatic snapshot landed, so the caller can SAY so. */
  lastSnapshot: string | null = null;

  /** The live id cache, built from disk on first use. Private — callers get a read-only view. */
  private knownIds(): Set<string> {
    if (!this.idCache) this.idCache = new Set(this.questions().map((q) => q.id));
    return this.idCache;
  }

  /**
   * Record a question's outcome as a NEW line carrying the same id. `questions()` merges lines in
   * order, so the last one wins — an append instead of an in-place rewrite of the whole file.
   */
  setQuestionStatus(id: string, status: QuestionStatus, note?: string): void {
    this.ensure();
    appendFileSync(this.questionsFile, JSON.stringify({ id, status, note, updatedAt: now() }) + '\n');
  }

  /** Every question, with each id's lines merged in order. */
  questions(): QuestionRecord[] {
    const byId = new Map<string, QuestionRecord>();
    for (const row of readJsonl(this.questionsFile)) {
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) continue;
      const prev = byId.get(id);
      // A delta whose base line was torn away has no question text — there is nothing to answer,
      // so it is dropped rather than resurrected as a half-record.
      if (!prev && typeof row.text !== 'string') continue;
      byId.set(id, { ...(prev ?? {}), ...row } as QuestionRecord);
    }
    return [...byId.values()];
  }

  /** Read-only so a caller cannot desync the cache from disk by adding an id nobody wrote. */
  questionIds(): ReadonlySet<string> {
    return this.knownIds();
  }

  /** The remaining work, read from disk — this is what resume iterates. */
  pendingQuestions(): QuestionRecord[] {
    return this.questions().filter((q) => q.status === 'pending');
  }

  // ---------------------------------------------------------- stage 3: chunks

  /**
   * Write one chunk and mark its question answered.
   *
   * Atomic, so a chunk file is either absent or complete — a half-written chunk read back by a
   * resumed run would be a citation-less answer that looks answered. Callers verify citations
   * BEFORE calling this; a chunk that reaches disk is one whose proof resolved.
   */
  /** Record an audit verdict on a chunk, in place. Absent verdict means never judged. */
  setChunkQa(chunkId: string, qa: { verdict: 'ok' | 'reject'; why?: string; by: 'rule' | 'model' }): void {
    const chunk = this.readChunk(chunkId);
    if (!chunk) return;
    this.saveChunk({ ...chunk, qa: { ...qa, at: now() } });
  }

  /**
   * Copy the whole corpus aside before anything destroys part of it.
   *
   * A corpus is not a file, it is a NIGHT ON A SHARED CARD. `--restart` unlinks every record and
   * removes the chunk directory; `--fix` deletes chunks whose questions cannot be repaired. Both are
   * correct operations and both are unrecoverable, and the operator learns which one they meant
   * afterwards.
   *
   * Automatic, in the same code path as the destruction — a backup a human has to remember is a
   * backup that does not exist at 3am. Best-effort: a snapshot that fails must not block the work,
   * but it is reported so nobody believes they have one when they do not.
   */
  snapshot(reason: string): string | null {
    if (!existsSync(this.dir)) return null;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const dest = `${this.dir}.bak-${stamp}-${reason.replace(/[^a-z0-9]+/gi, '')}`;
    try {
      cpSync(this.dir, dest, { recursive: true });
      this.pruneSnapshots();
      return dest;
    } catch {
      return null;
    }
  }

  /** Keep the newest few. The point is surviving a mistake, not archiving every one. */
  private pruneSnapshots(KEEP = 3): void {
    try {
      const parent = dirname(this.dir);
      const mine = `${this.key}.bak-`;
      const backups = readdirSync(parent).filter((n) => n.startsWith(mine)).sort().reverse();
      for (const old of backups.slice(KEEP)) {
        try { rmSync(join(parent, old), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    } catch { /* no parent, nothing to prune */ }
  }

  /** Remove a chunk entirely — used by `--fix` after its question has been re-queued. */
  deleteChunk(chunkId: string): void {
    try { rmSync(join(this.chunksDir, `${chunkId}.json`), { force: true }); } catch { /* already gone */ }
  }

  saveChunk(chunk: Chunk): void {
    this.ensure();
    writeAtomic(join(this.chunksDir, `${chunk.chunkId}.json`), JSON.stringify(chunk, null, 2) + '\n');
    this.setQuestionStatus(chunk.questionId, 'answered');
  }

  hasChunk(id: string): boolean {
    return existsSync(join(this.chunksDir, `${id}.json`));
  }

  readChunk(id: string): Chunk | null {
    return readJson<Chunk>(join(this.chunksDir, `${id}.json`));
  }

  /** Every chunk on disk, sorted by id so a report is byte-stable across runs. */
  chunks(): Chunk[] {
    if (!existsSync(this.chunksDir)) return [];
    const out: Chunk[] = [];
    for (const name of readdirSync(this.chunksDir).filter((n) => n.endsWith('.json')).sort()) {
      const c = readJson<Chunk>(join(this.chunksDir, name));
      if (c && typeof c.chunkId === 'string') out.push(c);
    }
    return out;
  }

  // ---------------------------------------------------------------- progress

  /** The heartbeat `ayin indulge --status` reads, and the lock's liveness signal. */
  setProgress(p: Omit<Progress, 'updatedAt'>): void {
    this.ensure();
    writeAtomic(this.progressFile, JSON.stringify({ ...p, updatedAt: now() }, null, 2) + '\n');
    this.beat();
  }

  progress(): Progress | null {
    return readJson<Progress>(this.progressFile);
  }

  /** Counted from disk, never from memory — the numbers a resumed run and `--status` both trust. */
  totals(): Totals {
    const qs = this.questions();
    return {
      // UNIQUE PATHS, not rows. `files()` carries one row per (path, domain), so a file surfaced by
      // two domains counted twice — `--status` said 454 files while the run's own loop said 351, for
      // the same corpus, in the same tool. Two numbers for one thing is how a reader stops trusting
      // either.
      files: new Set(this.files().map((f) => f.path)).size,
      questions: qs.length,
      pending: qs.filter((q) => q.status === 'pending').length,
      answered: qs.filter((q) => q.status === 'answered').length,
      failed: qs.filter((q) => q.status === 'failed').length,
      chunks: this.chunks().length,
    };
  }

  /** True once anything has been written for this repo — `indulge` resumes instead of starting over. */
  exists(): boolean {
    return existsSync(this.manifestFile);
  }

  /** mtime of the newest artifact, for "is it still alive?" without parsing progress. */
  lastWriteAt(): Date | null {
    let newest = 0;
    for (const p of [this.progressFile, this.questionsFile, this.filesFile, this.manifestFile]) {
      try { if (existsSync(p)) newest = Math.max(newest, statSync(p).mtimeMs); } catch { /* ignore */ }
    }
    return newest ? new Date(newest) : null;
  }
}

export function openStore(repoPath: string): IndulgeStore {
  return new IndulgeStore(repoPath);
}
