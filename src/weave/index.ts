/**
 * WEAVE — the design follows the source, without anybody remembering to make it.
 *
 * `ayin watch --weave` puts a repo under a second kind of watch. The commit reviewer answers "what
 * landed"; this one answers "does the diagram still describe this code" — continuously, on the WORKING
 * TREE, before anything is committed.
 *
 * WHY A DIAGRAM ROTS, AND WHY A DAEMON IS THE FIX
 *
 * A design diagram is written once, during the conversation where it is useful, and is then wrong
 * within a week. Not through carelessness: updating it is a separate act with no immediate reward,
 * performed by the one person who already knows what changed and therefore needs the diagram least.
 * Everyone downstream — the next agent session, the reviewer, the operator in three months — pays for
 * that. So the update has to happen without being remembered, which makes it a daemon's job.
 *
 * THE SPLIT: A SET OPERATION DECIDES *WHETHER*, A MODEL DECIDES *WHAT*
 *
 * Every pass is cheap and deterministic: hash the source files, compare declarations against the
 * `.puml`, and stop. Most edits are bodies, and a body is not a surface — those passes cost one `git
 * ls-files` and nothing else. Only a real surface delta spends a model, and the model is handed the
 * delta rather than the diff, because "which types are missing" is arithmetic and only "which domain
 * does this belong in, and what is this member FOR" is judgment. See `delta.ts`.
 *
 * SURVIVING THE POWER CUT — WITH NO QUEUE
 *
 * The persistent state is a per-repo SNAPSHOT of the source surface, and it is advanced only after a
 * weave has been verified. So a machine that dies mid-run wakes up with the old snapshot, recomputes
 * the same delta and runs it again; the work is idempotent because the design either has the type or
 * does not. A queue would add a second source of truth that could disagree with the snapshot, and the
 * snapshot is the one that decides. Attempts and backoff live in the same file for the same reason: a
 * design the model cannot satisfy must not respawn a run every fifteen seconds forever, across
 * reboots included.
 *
 * WHAT IT WILL NOT DO
 *
 * It edits ONE file per repo, the design the operator named when they registered it. It never touches
 * source. It never commits. And it waits for the tree to go quiet before spending anything, because a
 * developer mid-refactor produces a delta per keystroke and none of them is the answer.
 */

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageFor } from '../entangle/index.js';
import { validate as validateDesign, renderDesign } from '../naama/index.js';
import { log } from '../log.js';
import { computeDelta, designOf, isEmpty, countOf, renderDelta, typesIn, type SourceType, type WeaveDelta } from './delta.js';

const WATCH_DIR = join(homedir(), '.ayin-cli', 'watch');
const STATE_FILE = join(WATCH_DIR, 'weave-state.json');
const LEDGER_FILE = join(WATCH_DIR, 'weave-log.jsonl');
const LOG_DIR = join(WATCH_DIR, 'weave');

/** How often the daemon looks at a weave repo. One `git ls-files` plus hashes — cheap by design. */
export const WEAVE_CHECK_MS = 15_000;
/**
 * The tree must be STILL this long before a model is spent.
 *
 * A developer mid-refactor emits a different delta on every save, and each intermediate one is wrong:
 * a type half-renamed, a file that exists but declares nothing yet. Waiting for quiet is what turns a
 * hundred keystrokes into one run — and the cost of getting it wrong is not a slow diagram, it is a
 * design amended to describe a state the code was passing through.
 */
export const WEAVE_QUIET_MS = 45_000;
/** A run that has not finished in this long is presumed wedged and killed. */
const RUN_TIMEOUT_MS = 20 * 60_000;
/** After this many failed attempts the repo is left alone until its delta CHANGES. */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 10 * 60_000;

/** Bounds on the source scan, so a monorepo or a vendored SDK cannot make a pass expensive. */
const MAX_SOURCE_FILES = 4_000;
const MAX_SOURCE_BYTES = 512 * 1024;
/** Diagram candidates read when discovering a design, and the ceiling on one. */
const MAX_DESIGN_CANDIDATES = 40;

// ── state ────────────────────────────────────────────────────────────

interface FileSurface { hash: string; types: string[] }
interface RepoSnapshot {
  /** Repo-relative path of the design this repo's weave owns. */
  design: string;
  /** Per source file: content hash, and the type names it declared when last woven. */
  files: Record<string, FileSurface>;
  /** When the snapshot was last advanced. */
  at: number;
  /** Consecutive failed weaves, and when the next one may be tried. Persisted: a reboot is not a reset. */
  attempts?: number;
  nextTryAt?: number;
  /** The delta signature the attempts above were counted against. A CHANGED delta is a fresh start. */
  failedOn?: string;
}
type WeaveState = Record<string, RepoSnapshot>;

function loadState(): WeaveState {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as WeaveState; } catch { return {}; }
}
function saveState(s: WeaveState): void {
  mkdirSync(WATCH_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/** One line per weave, for the operator and for `ayin watch` to be answerable about what it did. */
function ledger(entry: Record<string, unknown>): void {
  try {
    mkdirSync(WATCH_DIR, { recursive: true });
    appendFileSync(LEDGER_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch { /* the ledger is a record, never the mechanism — losing a line must not stop a weave */ }
}

/**
 * In-memory only: the surface fingerprint this repo last showed, and when it first showed it.
 *
 * The FINGERPRINT is the load-bearing half. A timer started at the first edit and never reset would
 * mean "45 seconds since you began", which fires in the middle of a refactor — the one thing the quiet
 * window exists to prevent. Every change to the surface restarts the clock, so the release condition
 * is really stillness.
 *
 * Deliberately not persisted: quiet is a property of right now, and a daemon that just booted has no
 * business believing a tree has been still since before it started.
 */
const lastSeen = new Map<string, { fp: string; at: number }>();

// ── git plumbing ─────────────────────────────────────────────────────

function git(repo: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((done) => {
    execFile('git', ['-C', repo, ...args], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      done({ ok: !err, stdout: stdout ?? '' });
    });
  });
}

/**
 * What ayin itself writes into a watched repo, and therefore must never read back as that repo's
 * source. `watch` installs a hound script under `.claude/hooks/` — a `.mjs`, which the TypeScript
 * surface language happily claims — so without this the weaver watches its own footprints and every
 * hook self-heal looks like the tree moved.
 */
const NOT_SOURCE = ['.claude/**', 'reviews/**', 'CLAUDE.md', 'GEMINI.md', 'AYIN-REPORT-*.md']
  .flatMap((g) => [`:(exclude,glob)${g}`, `:(exclude,glob)**/${g}`]);

/**
 * Every source file in the tree, tracked or not, honouring `.gitignore`.
 *
 * `git ls-files -co --exclude-standard` rather than a walk of our own: it is one process, it already
 * knows what the repo ignores, and it never enumerates `node_modules/`, `Library/` or `dist/`. What
 * counts as source is `languageFor()` — the same list `entangle` and the corpus walk use, so a
 * language becomes weave-able by being added once, in one place.
 */
async function sourceFiles(repo: string): Promise<string[]> {
  const r = await git(repo, ['ls-files', '-co', '--exclude-standard', '-z', '--', '.', ...NOT_SOURCE]);
  if (!r.ok) return [];
  const all = r.stdout.split('\0').filter(Boolean).filter((rel) => languageFor(join(repo, rel)) !== null);
  return all.slice(0, MAX_SOURCE_FILES);
}

async function mergeInProgress(repo: string): Promise<boolean> {
  const r = await git(repo, ['rev-parse', '--git-dir']);
  if (!r.ok) return false;
  const dir = r.stdout.trim();
  const abs = isAbsolute(dir) ? dir : join(repo, dir);
  return ['MERGE_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].some((m) => existsSync(join(abs, m)));
}

// ── the design this repo weaves into ─────────────────────────────────

/**
 * Find the repo's design when the operator did not name one.
 *
 * The SAME rule the Claude Code hound uses: a `.puml` that declares at least one type. That is what
 * makes "contains a design" a real test rather than an extension match — a sequence diagram or a
 * README snippet declares nothing and does not make a tree look designed. Two readers of "which file
 * is the design" would eventually disagree, and the disagreement would look like the weaver editing
 * the wrong file.
 */
export async function discoverDesign(repo: string): Promise<string | null> {
  const r = await git(repo, ['ls-files', '-co', '--exclude-standard', '-z', '--', '*.puml']);
  if (!r.ok) return null;
  const rels = r.stdout.split('\0').filter(Boolean).slice(0, MAX_DESIGN_CANDIDATES);
  for (const rel of rels) {
    const abs = join(repo, rel);
    try {
      if (statSync(abs).size > MAX_SOURCE_BYTES * 8) continue;
      if (designOf(readFileSync(abs, 'utf-8')).types.length > 0) return rel;
    } catch { /* unreadable or unparseable is simply not the design */ }
  }
  return null;
}

// ── surfacing ────────────────────────────────────────────────────────

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** The current surface of every source file: its hash, and the types it declares. */
async function scanSurface(repo: string): Promise<Record<string, FileSurface>> {
  const out: Record<string, FileSurface> = {};
  for (const rel of await sourceFiles(repo)) {
    const abs = join(repo, rel);
    let text: string;
    try {
      if (statSync(abs).size > MAX_SOURCE_BYTES) continue;
      text = readFileSync(abs, 'utf-8');
    } catch { continue; }
    out[rel] = { hash: sha(text), types: typesIn(rel, text, abs).map((t) => t.name) };
  }
  return out;
}

/** Which files appeared, changed, or went away since the snapshot. */
function classify(before: Record<string, FileSurface>, now: Record<string, FileSurface>): {
  added: string[]; modified: string[]; deleted: string[];
} {
  const added: string[] = [], modified: string[] = [], deleted: string[] = [];
  for (const [rel, s] of Object.entries(now)) {
    const was = before[rel];
    if (!was) added.push(rel);
    else if (was.hash !== s.hash) modified.push(rel);
  }
  for (const rel of Object.keys(before)) if (!now[rel]) deleted.push(rel);
  return { added, modified, deleted };
}

/** Re-read the changed files into typed surfaces — the input the delta is computed from. */
function surfacesOf(repo: string, rels: string[]): SourceType[] {
  const out: SourceType[] = [];
  for (const rel of rels) {
    const abs = join(repo, rel);
    try { out.push(...typesIn(rel, readFileSync(abs, 'utf-8'), abs)); } catch { /* raced with a delete */ }
  }
  return out;
}

/** A stable fingerprint of a delta, so "the same failure again" is distinguishable from a new one. */
function deltaKey(d: WeaveDelta): string {
  return sha(JSON.stringify([
    d.added.map((t) => `${t.name}:${t.members.join(',')}`).sort(),
    d.removed.map((r) => r.name).sort(),
    d.drifted.map((x) => `${x.name}:${x.gained.join(',')}/${x.lost.join(',')}`).sort(),
  ]));
}

// ── the headless run ─────────────────────────────────────────────────

/** ayin's own entry point. …/dist/weave/index.js → …/dist/index.js */
function ayinEntry(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'index.js');
}

const slug = (repo: string): string => repo.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-60);

export function weaveLogPath(repo: string, stamp: string): string {
  return join(LOG_DIR, `${slug(repo)}-${stamp}.log`);
}

/**
 * One headless ayin, one delta.
 *
 * A whole process rather than an LLM call, because reconciling a design is TOOL WORK: read the design,
 * apply authoring lines, check the result, render it. The commit reviewer gets away with a single call
 * because its output is prose nobody parses; this one has to leave a valid file behind.
 *
 * Resolves when the child exits. The caller verifies the file afterwards and never trusts the exit
 * code alone — an agent that says it is done is not evidence that the design parses.
 */
function runHeadless(repo: string, prompt: string, logPath: string): Promise<{ code: number | null; signal: string | null }> {
  mkdirSync(LOG_DIR, { recursive: true });
  const fd = openSync(logPath, 'a');
  return new Promise((done) => {
    let child;
    try {
      child = spawn(process.execPath, [ayinEntry(), '-p', prompt], {
        cwd: repo,
        stdio: ['ignore', fd, fd],
        env: {
          ...process.env,
          // The child is the weaver, and it must not start a weaver of its own — nor pick up a TUI.
          AYIN_WEAVE_CHILD: '1',
        },
      });
    } catch (err) {
      try { closeSync(fd); } catch { /* never opened */ }
      done({ code: null, signal: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, RUN_TIMEOUT_MS);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      try { closeSync(fd); } catch { /* already closed */ }
      done({ code: null, signal: err.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      try { closeSync(fd); } catch { /* already closed */ }
      done({ code, signal });
    });
  });
}

// ── one repo, one pass ───────────────────────────────────────────────

export interface WeaveOutcome {
  repo: string;
  status: 'quiet' | 'no-delta' | 'woven' | 'incomplete' | 'invalid' | 'no-design' | 'baselined' | 'backoff' | 'busy';
  note: string;
  delta?: WeaveDelta;
}

/** What a weave needs from the outside world. Injected so the gate can drive every branch offline. */
export interface WeaveDeps {
  /** Fill `prompts/watch/weaveRun.txt`. A prompt is a file, and this is the only thing that knows it. */
  prompt: (args: { design: string; delta: WeaveDelta; logPath: string }) => string;
  /**
   * Run the weaver. Defaults to a headless ayin.
   *
   * Injectable because a gate that spawns real agents is not a gate: it needs a model, it costs
   * minutes, and its result depends on whichever provider the machine happens to have configured. The
   * decision tree is the part worth asserting, and none of it needs an LLM.
   */
  run?: (repo: string, prompt: string, logPath: string) => Promise<{ code: number | null; signal: string | null }>;
}

/** Bring one repo's design back in line with its source, if it is out of line and the tree is quiet. */
export async function weaveRepo(
  repo: string,
  registeredDesign: string | undefined,
  deps: WeaveDeps,
  now = Date.now(),
): Promise<WeaveOutcome> {
  if (!existsSync(repo)) return { repo, status: 'no-design', note: 'the repo is gone' };
  if (await mergeInProgress(repo)) return { repo, status: 'busy', note: 'a merge or rebase is in progress' };

  const state = loadState();
  const snap = state[repo];

  const surface = await scanSurface(repo);
  const fingerprint = sha(JSON.stringify(Object.entries(surface).map(([k, v]) => `${k}:${v.hash}`).sort()));

  // FIRST SIGHT IS A BASELINE, NOT A JOB. Registering a repo whose diagram is years behind would
  // otherwise spawn one run holding every type in the tree — the exact prompt nothing can act on. The
  // gap is REPORTED and the snapshot is taken; from here on the weaver reacts to changes.
  if (!snap) {
    const design = registeredDesign ?? (await discoverDesign(repo));
    if (!design) {
      return { repo, status: 'no-design', note: 'no .puml in this tree declares a type — nothing to weave into' };
    }
    let gap = 0;
    try {
      const doc = designOf(readFileSync(join(repo, design), 'utf-8'));
      gap = countOf(computeDelta({ design: doc, current: surfacesOf(repo, Object.keys(surface)), goneFrom: [] }));
    } catch { /* an unreadable design is reported by the first real pass */ }
    state[repo] = { design, files: surface, at: now };
    saveState(state);
    ledger({ event: 'baselined', repo, design, files: Object.keys(surface).length, gap });
    return {
      repo,
      status: 'baselined',
      note: `baselined ${Object.keys(surface).length} source file(s) against ${design}` +
        (gap
          ? ` — ${gap} type(s) in this tree already differ from it. That backlog is NOT woven: it is the ` +
            'operator\'s call whether a years-old diagram should be caught up. Editing any of those files ' +
            'brings its own types across.'
          : ' — the design already matches'),
    };
  }

  const design = registeredDesign ?? snap.design;
  const designAbs = join(repo, design);
  if (!existsSync(designAbs)) {
    return { repo, status: 'no-design', note: `${design} is gone — re-register the repo with the design it should weave into` };
  }

  const changed = classify(snap.files, surface);
  const anyChange = changed.added.length + changed.modified.length + changed.deleted.length > 0;
  if (!anyChange) { lastSeen.delete(repo); return { repo, status: 'no-delta', note: 'source unchanged since the last weave' }; }

  // QUIET GATE. Any movement in the surface restarts the clock; only stillness releases a run.
  const seen = lastSeen.get(repo);
  if (!seen || seen.fp !== fingerprint) {
    lastSeen.set(repo, { fp: fingerprint, at: now });
    return { repo, status: 'quiet', note: 'change seen — waiting for the tree to settle' };
  }
  if (now - seen.at < WEAVE_QUIET_MS) return { repo, status: 'quiet', note: `settling (${Math.round((now - seen.at) / 1000)}s)` };

  let doc;
  try { doc = designOf(readFileSync(designAbs, 'utf-8')); }
  catch (err) { return { repo, status: 'invalid', note: `${design} could not be read: ${err instanceof Error ? err.message : String(err)}` }; }

  const delta = computeDelta({
    design: doc,
    current: surfacesOf(repo, [...changed.added, ...changed.modified]),
    goneFrom: changed.deleted.map((file) => ({ file, types: snap.files[file]?.types ?? [] })),
  });

  // A body edit is not a surface change. Advance the snapshot and spend nothing — this is the common
  // case by a wide margin, and it is the reason a 15-second cadence is affordable at all.
  if (isEmpty(delta)) {
    state[repo] = { ...snap, design, files: surface, at: now, attempts: 0, nextTryAt: 0, failedOn: '' };
    saveState(state);
    lastSeen.delete(repo);
    return { repo, status: 'no-delta', note: `${changed.added.length + changed.modified.length + changed.deleted.length} file(s) changed, no surface change` };
  }

  const key = deltaKey(delta);
  // Backoff, but only against the SAME delta: a design the model could not satisfy must not respawn a
  // run every quiet period forever, and a delta that has moved on deserves a fresh attempt.
  if (snap.failedOn === key && (snap.attempts ?? 0) >= MAX_ATTEMPTS) {
    return { repo, status: 'backoff', note: `gave up after ${snap.attempts} attempt(s) on this delta — it will be tried again when the source changes` };
  }
  if (snap.failedOn === key && snap.nextTryAt && now < snap.nextTryAt) {
    return { repo, status: 'backoff', note: `retrying in ${Math.round((snap.nextTryAt - now) / 1000)}s` };
  }

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const logPath = weaveLogPath(repo, stamp);
  ledger({ event: 'weaving', repo, design, ...renderCounts(delta), log: logPath });

  const exit = await (deps.run ?? runHeadless)(repo, deps.prompt({ design, delta, logPath }), logPath);

  // VERIFY THE FILE, NOT THE EXIT CODE. An agent reporting success is not evidence that the design
  // parses, that it still declares what it did, or that it now covers the delta.
  let after;
  try { after = designOf(readFileSync(designAbs, 'utf-8')); }
  catch (err) {
    return fail(state, repo, snap, design, key, now,
      `${design} does not parse after the run (${err instanceof Error ? err.message : String(err)}) — log: ${logPath}`, 'invalid');
  }

  const problems = validateDesign(after);
  const left = computeDelta({
    design: after,
    current: surfacesOf(repo, [...changed.added, ...changed.modified]),
    goneFrom: changed.deleted.map((file) => ({ file, types: snap.files[file]?.types ?? [] })),
  });

  if (!isEmpty(left)) {
    return fail(state, repo, snap, design, key, now,
      `${countOf(left)} of ${countOf(delta)} item(s) still differ after the run — log: ${logPath}`, 'incomplete');
  }

  // Woven. The snapshot advances only here, which is the whole resume story: a crash before this line
  // leaves the old snapshot, and the next pass recomputes the same delta and runs it again.
  state[repo] = { design, files: surface, at: now, attempts: 0, nextTryAt: 0, failedOn: '' };
  saveState(state);
  lastSeen.delete(repo);

  // BESIDE THE DESIGN, explicitly. naamah names its output after the input and writes it into the
  // process's cwd, and this process is a daemon — started from wherever the operator launched it, which
  // is nowhere near the repo. Left implicit, the page lands in a directory nobody will look in.
  const page = designAbs.replace(/\.puml$/i, '') + '.html';
  const drawn = await renderDesign(designAbs, page).catch((e) => `render failed: ${e instanceof Error ? e.message : String(e)}`);
  ledger({ event: 'woven', repo, design, ...renderCounts(delta), problems: problems.length, exit: exit.code, render: drawn.slice(0, 200) });

  return {
    repo,
    status: 'woven',
    note: `${countOf(delta)} change(s) written into ${design}` +
      (problems.length ? ` — ${problems.length} design problem(s) remain (naama op=check)` : '') +
      ` · ${drawn.split('\n')[0]}`,
    delta,
  };
}

function renderCounts(d: WeaveDelta): Record<string, number> {
  return { added: d.added.length, removed: d.removed.length, drifted: d.drifted.length, moved: d.moved.length };
}

function fail(
  state: WeaveState, repo: string, snap: RepoSnapshot, design: string, key: string, now: number,
  note: string, status: WeaveOutcome['status'],
): WeaveOutcome {
  const attempts = (snap.failedOn === key ? (snap.attempts ?? 0) : 0) + 1;
  state[repo] = { ...snap, design, attempts, nextTryAt: now + RETRY_BACKOFF_MS, failedOn: key };
  saveState(state);
  ledger({ event: 'failed', repo, design, attempts, note });
  log('WARN', 'weave_failed', { repo, design, attempts: String(attempts), note: note.slice(0, 200) });
  return { repo, status, note: `${note} (attempt ${attempts}/${MAX_ATTEMPTS})` };
}

// ── registration ─────────────────────────────────────────────────────

/** The repos that asked to be woven, and the design each one owns. Read from `repos.json`. */
export function weaveRepos(reposFile: string): Array<{ repo: string; design?: string }> {
  if (!existsSync(reposFile)) return [];
  try {
    const all = JSON.parse(readFileSync(reposFile, 'utf-8')) as Record<string, { weave?: { design?: string } }>;
    return Object.entries(all)
      .filter(([, v]) => v?.weave !== undefined)
      .map(([repo, v]) => ({ repo, design: v.weave?.design }));
  } catch { return []; }
}

/**
 * Record that a repo is woven, and into which file.
 *
 * The design path is stored REPO-RELATIVE: a checkout that moves, or the same repo cloned twice, keeps
 * a registration that still means something. An absolute path recorded once would silently weave into
 * a stale copy.
 */
export function registerWeave(reposFile: string, repo: string, design: string | null): string {
  const all = existsSync(reposFile)
    ? JSON.parse(readFileSync(reposFile, 'utf-8')) as Record<string, Record<string, unknown>>
    : {};
  const rel = design ? (isAbsolute(design) ? relative(repo, resolve(design)) : design) : undefined;
  all[repo] = { ...(all[repo] ?? { installedAt: new Date().toISOString() }), weave: { ...(rel ? { design: rel } : {}), at: new Date().toISOString() } };
  mkdirSync(dirname(reposFile), { recursive: true });
  writeFileSync(reposFile, JSON.stringify(all, null, 2));
  return rel ?? '(discovered on the first pass)';
}

/** Forget a repo's weave registration, leaving the rest of its watch entry alone. */
export function unregisterWeave(reposFile: string, repo: string): boolean {
  if (!existsSync(reposFile)) return false;
  try {
    const all = JSON.parse(readFileSync(reposFile, 'utf-8')) as Record<string, Record<string, unknown>>;
    if (!all[repo]?.weave) return false;
    delete all[repo].weave;
    writeFileSync(reposFile, JSON.stringify(all, null, 2));
    const state = loadState();
    delete state[repo];
    saveState(state);
    return true;
  } catch { return false; }
}

export { renderDelta, isEmpty, countOf };
export type { WeaveDelta };
