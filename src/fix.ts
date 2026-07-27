/**
 * `/fix` — ayin fixing itself.
 *
 * You describe a change to ayin in the TUI; ayin writes a **fix request** into its own codebase and
 * runs **headless Claude Code** over it. Claude implements the change, bumps the version, commits
 * and publishes to the registry — or, if it can't or shouldn't, writes
 * `fixes/rejection-<id>.md` saying why. Either way the record lives in the repo, and the TUI shows
 * a red `FIX REJECTED` until you look at it.
 *
 *   <repo>/fixes/fix-<id>.md         the request (front-matter + your prompt)   ← committed
 *   <repo>/fixes/rejection-<id>.md   why it wasn't done                          ← committed
 *   <repo>/fixes/archive/            rejections you've acknowledged (`/fix clear`)
 *   ~/.ayin-cli/fixes/state.json     the queue                                   ← NOT in the repo
 *   ~/.ayin-cli/fixes/<id>.log       everything the agent printed
 *
 * SURVIVE THE POWER CUT. The queue is on disk, not in memory, and the agent is spawned **detached**
 * — killing ayin (or the terminal, or the machine) does not kill a fix in flight, and does not lose
 * one that was waiting. On every boot the supervisor reconciles: a run whose process is gone with no
 * exit marker is **requeued automatically**, not silently dropped. Nobody has to remember anything.
 *
 * ONE AT A TIME. Every fix mutates the same working tree, so two concurrent agents would produce a
 * merge conflict with themselves. A lockfile (with a stale-after-2h escape hatch, because a crashed
 * run must not block the queue forever) serializes them; extra requests queue and drain in order.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── where things live ─────────────────────────────────────────────────

/** The ayin SOURCE checkout the agent will work in. An ayin installed from the registry has no
 *  repo of its own, so this must be findable or `/fix` refuses — clearly, not mysteriously. */
export function repoPath(): string | null {
  const candidates = [
    process.env.AYIN_REPO,
    join(HERE, '..'),                      // running from dist/ inside the checkout
    join(homedir(), 'maradel', 'ayin'),    // the nuk's checkout
    join(homedir(), 'ayin'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(join(c, '.git')) && existsSync(join(c, 'package.json'))) return c;
  }
  return null;
}

const STATE_DIR = join(homedir(), '.ayin-cli', 'fixes');
const STATE_FILE = join(STATE_DIR, 'state.json');
const LOCK_FILE = join(STATE_DIR, 'run.lock');
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;
const CLAUDE_BIN = process.env.AYIN_CLAUDE_BIN ?? join(homedir(), '.local/bin/claude');

export function fixesDir(repo: string): string { return join(repo, 'fixes'); }
function requestPath(repo: string, id: string): string { return join(fixesDir(repo), `fix-${id}.md`); }
function rejectionPath(repo: string, id: string): string { return join(fixesDir(repo), `rejection-${id}.md`); }
function logPath(id: string): string { return join(STATE_DIR, `${id}.log`); }
function exitPath(id: string): string { return join(STATE_DIR, `${id}.exit`); }
function promptPath(id: string): string { return join(STATE_DIR, `${id}.prompt.txt`); }

const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`; // single-quote for bash

// ── state ─────────────────────────────────────────────────────────────

export type FixStatus = 'pending' | 'running' | 'done' | 'rejected' | 'failed';

export interface FixRequest {
  id: string;            // 20260727-084500 — also names the request and rejection files
  status: FixStatus;
  prompt: string;        // what the user asked for (first 200 chars, for listings)
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  pid?: number;          // the detached wrapper's pid, for liveness checks after a restart
  exitCode?: number;
}

interface State { requests: FixRequest[] }

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as State;
    if (Array.isArray(s.requests)) return s;
  } catch { /* first run, or a torn write — start clean rather than crash the TUI */ }
  return { requests: [] };
}

function saveState(s: State): void {
  mkdirSync(STATE_DIR, { recursive: true });
  // Write-then-rename: a power cut can leave the temp file behind, never a half-written queue.
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE_FILE);
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockHeld(): boolean {
  if (!existsSync(LOCK_FILE)) return false;
  try {
    if (Date.now() - statSync(LOCK_FILE).mtimeMs > STALE_LOCK_MS) return false; // crashed run — don't block forever
  } catch { /* ignore */ }
  return true;
}

// ── the public surface ────────────────────────────────────────────────

export interface FixSnapshot {
  queued: number;
  running: FixRequest | null;
  /** Unacknowledged `rejection-*.md` files in the repo — what turns the status bar red. */
  rejected: string[];
}

/** Count rejections on disk (the repo is the record, not our state file — a rejection committed
 *  from another machine and pulled in still counts). */
function rejectionIds(repo: string): string[] {
  try {
    return readdirSync(fixesDir(repo))
      .filter((f) => /^rejection-.*\.md$/.test(f))
      .map((f) => f.replace(/^rejection-/, '').replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

export function snapshot(): FixSnapshot {
  const repo = repoPath();
  const state = loadState();
  return {
    queued: state.requests.filter((r) => r.status === 'pending').length,
    running: state.requests.find((r) => r.status === 'running') ?? null,
    rejected: repo ? rejectionIds(repo) : [],
  };
}

export function listRequests(limit = 10): FixRequest[] {
  return loadState().requests.slice(-limit).reverse();
}

/** A unique, human-readable id. Seconds alone are NOT unique — two `/fix`es in the same second
 *  would share an id, and the second would overwrite the first's request file and inherit its
 *  rejection. Collisions get a `-2`, `-3`, … suffix. */
function newId(repo: string, taken: Set<string>): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let id = base;
  for (let n = 2; taken.has(id) || existsSync(requestPath(repo, id)); n++) id = `${base}-${n}`;
  return id;
}

/** Write the request into the codebase and enqueue it. Returns the id, or an error string. */
export function createRequest(prompt: string): { id: string } | { error: string } {
  const repo = repoPath();
  if (!repo) return { error: 'no ayin source checkout found — set AYIN_REPO to one (an ayin installed from the registry cannot fix itself)' };
  if (!existsSync(CLAUDE_BIN)) return { error: `claude binary not found at ${CLAUDE_BIN} (set AYIN_CLAUDE_BIN)` };

  const state = loadState();
  const id = newId(repo, new Set(state.requests.map((r) => r.id)));
  mkdirSync(fixesDir(repo), { recursive: true });
  const body = [
    '---',
    `id: ${id}`,
    'status: pending',
    `created: ${new Date().toISOString()}`,
    `requested_from: ${process.cwd()}`,
    '---',
    '',
    '# Fix request',
    '',
    prompt.trim(),
    '',
  ].join('\n');
  writeFileSync(requestPath(repo, id), body);

  state.requests.push({ id, status: 'pending', prompt: prompt.trim().slice(0, 200), createdAt: Date.now() });
  saveState(state);
  log('INFO', 'fix_requested', { id, repo });
  return { id };
}

/** Archive every rejection (clears the red badge). Returns how many were moved. */
export function acknowledgeRejections(): number {
  const repo = repoPath();
  if (!repo) return 0;
  const ids = rejectionIds(repo);
  if (!ids.length) return 0;
  const archive = join(fixesDir(repo), 'archive');
  mkdirSync(archive, { recursive: true });
  for (const id of ids) {
    try { renameSync(rejectionPath(repo, id), join(archive, `rejection-${id}.md`)); } catch { /* already gone */ }
  }
  log('INFO', 'fix_rejections_acked', { count: String(ids.length) });
  return ids.length;
}

/** The text of a rejection, for showing in chat. */
export function readRejection(id: string): string | null {
  const repo = repoPath();
  if (!repo) return null;
  try { return readFileSync(rejectionPath(repo, id), 'utf-8'); } catch { return null; }
}

// ── the supervisor ────────────────────────────────────────────────────

function spawnAgent(repo: string, req: FixRequest, state: State): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(promptPath(req.id), taskPrompt(repo, req.id));
  writeFileSync(LOCK_FILE, String(Date.now()));
  try { unlinkSync(exitPath(req.id)); } catch { /* no stale marker */ }

  // Detached bash wrapper: it outlives ayin (and the terminal), logs everything, and leaves an exit
  // marker + clears the lock however it ends — so the supervisor can tell "finished" from "died".
  const cmd =
    `exec >> ${sh(logPath(req.id))} 2>&1; ` +
    `echo "=== fix ${req.id} start $(date -Is) ==="; ` +
    `${sh(CLAUDE_BIN)} --dangerously-skip-permissions -p "$(cat ${sh(promptPath(req.id))})"; ` +
    `code=$?; ` +
    `echo "=== fix ${req.id} end $(date -Is) rc=$code ==="; ` +
    `echo $code > ${sh(exitPath(req.id))}; ` +
    `rm -f ${sh(LOCK_FILE)}`;

  const child = spawn('bash', ['-lc', cmd], { cwd: repo, detached: true, stdio: 'ignore', env: process.env });
  child.unref();

  req.status = 'running';
  req.startedAt = Date.now();
  req.pid = child.pid;
  saveState(state);
  log('INFO', 'fix_started', { id: req.id, pid: String(child.pid ?? 0) });
}

/**
 * One reconciliation pass. Finishes what ended, requeues what died, starts what's next.
 * Idempotent and cheap — safe to call on a timer and at boot.
 */
export function tick(onNote?: (note: string) => void): void {
  const repo = repoPath();
  if (!repo) return;
  const state = loadState();
  let dirty = false;

  for (const req of state.requests) {
    if (req.status !== 'running') continue;

    if (existsSync(exitPath(req.id))) {
      const code = Number((readFileSync(exitPath(req.id), 'utf-8') || '1').trim());
      const wasRejected = existsSync(rejectionPath(repo, req.id));
      req.status = wasRejected ? 'rejected' : code === 0 ? 'done' : 'failed';
      req.exitCode = code;
      req.finishedAt = Date.now();
      dirty = true;
      log('INFO', 'fix_finished', { id: req.id, status: req.status, code: String(code) });
      onNote?.(req.status === 'rejected'
        ? `Fix ${req.id} was REJECTED — /fix show ${req.id}`
        : req.status === 'done'
          ? `Fix ${req.id} completed — see fixes/fix-${req.id}.md for what changed (\`ayin update\` if it published).`
          : `Fix ${req.id} failed (exit ${code}) — see ~/.ayin-cli/fixes/${req.id}.log`);
      continue;
    }

    // No marker and the process is gone: the machine died mid-fix. Requeue it — the whole point of
    // discipline 1 is that this needs no human.
    if (!alive(req.pid)) {
      req.status = 'pending';
      req.pid = undefined;
      dirty = true;
      log('WARN', 'fix_requeued_after_death', { id: req.id });
      onNote?.(`Fix ${req.id} was interrupted (machine or process died) — requeued.`);
    }
  }

  const running = state.requests.some((r) => r.status === 'running');
  if (!running && !lockHeld()) {
    const next = state.requests.find((r) => r.status === 'pending');
    if (next) { spawnAgent(repo, next, state); dirty = false; /* spawnAgent saved */ }
  }

  if (dirty) saveState(state);
}

/** Start the supervisor: reconcile now (boot recovery) and every `everyMs` after. Unref'd. */
export function startFixSupervisor(onNote?: (note: string) => void, everyMs = 8_000): () => void {
  tick(onNote);
  const timer = setInterval(() => tick(onNote), everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── the agent's brief ─────────────────────────────────────────────────

function taskPrompt(repo: string, id: string): string {
  const req = requestPath(repo, id);
  const rej = rejectionPath(repo, id);
  return `You are Claude Code, running headless in the **ayin** repository at ${repo}, with full permissions.

THE FIX REQUEST IS: ${req}

Read it first. Its body is a user's description of a change they want made to ayin itself. You are
the only agent running here right now; the user is not watching. Finish or refuse — do not stop
half-way, and do not ask questions (nobody will answer).

DO THIS, IN ORDER:

0. RESPECT OTHER WORK. Run \`git status\` first. Do NOT touch, stage, commit or revert any
   uncommitted/untracked change you did not make in this run. Stage ONLY the specific files you
   change, by path — NEVER \`git add -A\` or \`git add .\`. \`fixes/*.md\` is yours to commit.

1. DECIDE, HONESTLY, WHETHER TO DO IT. Write a rejection instead of implementing when the request
   is ambiguous enough that you'd be guessing at what the user wants, would break or regress
   existing behaviour, is unsafe/destructive, needs a decision only the user can make, or is simply
   not something this codebase should do. A clean refusal is a good outcome; a wrong guess shipped
   to every machine is not.

   TO REJECT: write ${rej} — a short markdown file: what was asked, why it was not done, and what
   you would need (a decision, a clarification, a different approach) to proceed. Set
   \`status: rejected\` in the request's front-matter. Commit BOTH files. Then STOP: do not bump
   the version, do not publish.

2. TO IMPLEMENT: make the change properly, following ${repo}/docs/ARCHITECTURE.md and the house
   style of the files you touch (widgets read \`theme.ts\`, never hardcode colors; layout changes go
   through \`relayout()\`; no blessed mouse tracking — it breaks copy-paste; the LLM is reached only
   through the backend resource layer, never Ollama directly).
   - \`npx tsc --noEmit\` MUST pass. Then \`npm run build\`.
   - Update \`docs/ARCHITECTURE.md\` (and README.md if user-facing) in the SAME change. Code and
     docs disagreeing is a bug.
   - Keep it minimal and reversible. Do not refactor beyond the request.

3. PUBLISH IT (only after a clean typecheck + build):
   - Bump the PATCH version in package.json. Check \`npm view ayin versions\` first — the registry
     refuses a version that already exists, so pick the next unused one.
   - Commit your files + the version bump together, with a message explaining the change and
     referencing fix ${id}. End the message with:
       Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
   - \`npm publish\` (publishConfig points at the private registry; credentials are in ~/.npmrc).
   - \`git push\` if the branch has an upstream and the push is a fast-forward. If it is not, leave
     it unpushed and say so in the request file — never force-push.
   - Set \`status: done\` in the request's front-matter and append a short "## Result" section:
     what you changed, the new version, and anything the user should check.

4. NEVER LEAVE THE BUILD BROKEN. If you get part-way and cannot finish, revert your working-tree
   changes for the files you touched (\`git checkout -- <paths>\`), then go to step 1 and reject
   with an honest explanation. A published broken ayin auto-updates onto every machine.

The request file is the record. Leave it accurate.`;
}
