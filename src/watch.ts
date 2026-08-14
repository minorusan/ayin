/**
 * ayin watch — repo watcher daemon + post-commit code review.
 *
 *   ayin watch --repo <path>          install the hook and run the daemon (foreground)
 *   ayin watch --repo <path> --once   process any backlog for all watched repos, then exit
 *
 * Design (poll-only + persistent queue + resume-on-boot — survives a power cut):
 *   - The installed .git/hooks/post-commit appends one JSON line per commit to
 *     ~/.ayin-cli/watch/queue.jsonl. The hook never talks to the daemon and never blocks
 *     the commit — if the daemon is down, the queue simply accumulates.
 *   - The daemon polls the queue file (fs.watch is unreliable cross-platform; polling is
 *     the fleet pattern and macOS-friendly). Anything in the queue that is not in the
 *     processed ledger (~/.ayin-cli/watch/processed.jsonl) is backlog and gets reviewed —
 *     including work that was in flight when the machine died. Reviews are idempotent
 *     (the report file is rewritten), so a crash mid-review just re-runs it on boot.
 *   - For each commit: gather metadata + diff (capped), one LLM call reviewing against a
 *     catalog of typical code-smell signals (each finding reported with a confidence),
 *     write `reviews/<shortHash>/CodeReview.md` in the repo root (or under AYIN_REVIEW_DIR).
 *     A Unity repo's deterministic asset diff lands beside it in the same folder,
 *     `reviews/<shortHash>/AssetDiff.md` — one folder per review, nothing loose in the root.
 *   - Commits that only touch files under `reviews/` are skipped — otherwise committing a
 *     review would trigger a review of the review, forever.
 *   - Alongside the hooks (and re-asserted by the same 5-min self-heal), CLAUDE.md/GEMINI.md
 *     get one fenced pointer block listing pending reports, so the next agent session in that
 *     repo notices unread findings. Nothing else is written to a watched repo — no .gitignore
 *     edit, no hardcoded ignore list. What a repo ignores is its owner's call, not ayin's.
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync,
  readdirSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { llmChat, refreshActiveModel } from './llm/manager.js';
import { connect, llmBaseUrl } from './connection.js';
import { acquireLlm, type LlmHold } from './llm/authority.js';
import { initLlmProvider } from './llm/select.js';
import { prompts, packagePath, writeAtomic } from './prompts-service.js';
import { log } from './log.js';

/** The watcher's own prompts (SOURCE: `<pkg>/prompts/watch`), materialized into the local store at
 *  import time. Every reviewer instruction the daemon sends lives there as a `.txt`, not here. */
const watchPrompts = prompts.register('watch', packagePath('prompts', 'watch')).bundle;

const WATCH_DIR = join(homedir(), '.ayin-cli', 'watch');
const QUEUE_FILE = join(WATCH_DIR, 'queue.jsonl');
const PROCESSED_FILE = join(WATCH_DIR, 'processed.jsonl');
const PID_FILE = join(WATCH_DIR, 'daemon.pid');
const REPOS_FILE = join(WATCH_DIR, 'repos.json');

const POLL_MS = 2_000;
const HOOK_SELF_HEAL_MS = 5 * 60 * 1000; // re-add missing post-commit hooks to watched repos every 5 min
const MAX_DIFF_CHARS = 120_000;   // diff sent to the LLM is capped; big commits get a truncation note
const MAX_REVIEW_ATTEMPTS = 5;    // LLM/backend failures retry with backoff, then give up (ledgered)
const RETRY_BACKOFF_MS = 60_000;

const HOOK_MARKER = 'ayin-watch post-commit hook';

// Shared reviewer discipline (Unity): a reviewer must not claim an animator binding is "missing"
// from a prefab it merely grepped by name — a true fact about the wrong prefab is worse than a lie.
// The text is one prompt file (`watch/animatorExistenceRule`) injected into both reviewers.
const animatorRule = (): string => watchPrompts.get('animatorExistenceRule');

/** Typical code-smell signals the reviewer scores. Kept as data so the list is one place. */
export const SMELL_SIGNALS: Array<{ name: string; hint: string }> = [
  { name: 'long-function',        hint: 'a function/method doing too much or spanning far more lines than its siblings' },
  { name: 'deep-nesting',         hint: 'logic buried 4+ levels deep; early returns / guard clauses missing' },
  { name: 'duplicated-code',      hint: 'copy-paste blocks, or near-identical logic that should share one implementation' },
  { name: 'magic-values',         hint: 'unexplained numeric/string literals that deserve a named constant' },
  { name: 'god-object',           hint: 'a class/module accumulating unrelated responsibilities' },
  { name: 'dead-code',            hint: 'commented-out code, unreachable branches, unused symbols left behind' },
  { name: 'swallowed-errors',     hint: 'empty catch, ignored promise rejection, error paths that silently continue' },
  { name: 'race-condition',       hint: 'shared mutable state, check-then-act gaps, missing serialization around a shared resource' },
  { name: 'resource-leak',        hint: 'handles/sockets/timers/streams opened but not reliably closed (incl. error paths)' },
  { name: 'unbounded-memory',     hint: 'reading whole files/responses into memory where input can be huge (readFileSync on user data, unbounded buffers/arrays)' },
  { name: 'hardcoded-secret',     hint: 'credentials, tokens, keys, or private endpoints embedded in code' },
  { name: 'injection-risk',       hint: 'unescaped interpolation into shell commands, SQL, HTML, or eval' },
  { name: 'misleading-naming',    hint: 'names that lie about behavior, or inconsistent vocabulary for one concept' },
  { name: 'mixed-concerns',       hint: 'one change bundling unrelated features/refactors; a function reaching across layers' },
  { name: 'missing-error-handling', hint: 'happy-path-only code: no timeout, no failure branch for I/O, network, parsing' },
  { name: 'boundary-bugs',        hint: 'off-by-one, empty-input, null/undefined, first/last-element edge cases' },
  { name: 'breaking-change',      hint: 'public API/protocol/schema changed without migration or callers updated' },
  { name: 'missing-tests',        hint: 'new non-trivial logic with no accompanying test coverage' },
  { name: 'todo-left',            hint: 'TODO/FIXME/HACK markers introduced without a tracked follow-up' },
  { name: 'style-drift',          hint: 'code that ignores the conventions visible in the surrounding file' },
];

// ── small utils ──────────────────────────────────────────────────────

function out(line: string): void {
  process.stdout.write(line + '\n');
}

function sh(cmd: string, args: string[], cwd: string, capBytes = 4 * 1024 * 1024): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let capped = false;
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < capBytes) stdout += c.toString();
      else if (!capped) { capped = true; child.kill(); }
    });
    child.stderr.on('data', (c: Buffer) => { if (stderr.length < 16_384) stderr += c.toString(); });
    child.on('close', (code) => resolve({ ok: capped || code === 0, stdout, stderr }));
    child.on('error', (err) => resolve({ ok: false, stdout: '', stderr: String(err) }));
  });
}

function git(repo: string, args: string[], capBytes?: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return sh('git', ['-C', repo, ...args], repo, capBytes);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* torn/corrupt line (e.g. power cut mid-append) — skip */ }
  }
  return rows;
}

interface QueueEntry {
  ts: number; repo: string; commit: string;
  kind?: 'commit' | 'merge';
  prev?: string;             // merge: ORIG_HEAD
}

function entryKey(e: { repo?: string; commit?: string; kind?: string; ts?: number }): string {
  // Commit keys stay `repo@commit` (back-compat with the ledger). Merge gets its own namespace so
  // it can't dedup against a commit of the same hash.
  if (e.kind === 'merge') return `${e.repo}@merge@${e.commit}`;
  return `${e.repo}@${e.commit}`;
}

// llm authority (one door to the GPU): reviews take the llm resource as the `ayin` authority per
// backlog batch via acquireLlm() (llm/authority.ts) — gemma → qwen on gained, revert on release.
// A provider with no authority layer answers 'no-resource-layer' and the batch runs on whatever
// model is being served; the watcher is unchanged either way.
// BUSY (podcast render, code_agent) → reviews DEFER to a later poll; a background reviewer waits
// its turn, it never side-doors the GPU. No resource layer → best-effort on the served model.

// ── hook install ─────────────────────────────────────────────────────

/** The post-commit hook body for a repo. Extracted so install + self-heal write byte-identical
 *  hooks. repo path goes to printf as a %s ARG (not the format string) so a '%' can't corrupt it. */
const CHAIN_BEGIN = '# >>> ayin-watch (chained) >>>';
const CHAIN_END = '# <<< ayin-watch (chained) <<<';

// The two hooks the daemon installs per repo: post-commit → review each commit; post-merge →
// explain each pull/merge (AYIN-REPORT-MERGE). Both append one JSON line to the shared queue.
const WATCH_HOOKS: Array<{ name: string; kind: 'commit' | 'merge' }> = [
  { name: 'post-commit', kind: 'commit' },
  { name: 'post-merge', kind: 'merge' },
];

/** The shell that appends one queue line for this hook kind (assumes $QUEUE_DIR + $HASH set).
 *  A merge also captures $PREV (ORIG_HEAD) so the reviewer can diff exactly what was pulled. */
function queueAppend(repo: string, kind: 'commit' | 'merge'): string {
  const r = JSON.stringify(repo);
  if (kind === 'merge') {
    return `PREV=$(git rev-parse ORIG_HEAD 2>/dev/null || echo ""); printf '{"ts":%s,"repo":%s,"commit":"%s","prev":"%s","kind":"merge"}\\n' "$(date +%s)" '${r}' "$HASH" "$PREV" >> "$QUEUE_DIR/queue.jsonl"`;
  }
  return `printf '{"ts":%s,"repo":%s,"commit":"%s","kind":"commit"}\\n' "$(date +%s)" '${r}' "$HASH" >> "$QUEUE_DIR/queue.jsonl"`;
}

/** Standalone hook file (owns .git/hooks/<name>). Never blocks git; queue accumulates if down. */
function hookScript(repo: string, kind: 'commit' | 'merge'): string {
  return `#!/bin/sh
# ${HOOK_MARKER} — installed by \`ayin watch\`. Reinstalling overwrites this file.
# Appends this ${kind} to the ayin-watch persistent queue; if the daemon is down it accumulates.
QUEUE_DIR="$HOME/.ayin-cli/watch"
mkdir -p "$QUEUE_DIR" || exit 0
HASH=$(git rev-parse HEAD 2>/dev/null) || exit 0
${queueAppend(repo, kind)}
exit 0
`;
}

/** An appendable block that queues WITHOUT owning the file — ayin-watch coexists with a repo's
 *  existing hook (git-lfs, husky, …). No shebang; never `exit`s or fails the host hook (`… || true`);
 *  carries HOOK_MARKER so the marker check treats a chained hook as "ours"; fenced for idempotency. */
function chainedBlock(repo: string, kind: 'commit' | 'merge'): string {
  return `
${CHAIN_BEGIN}
# ${HOOK_MARKER} (chained) — queues this ${kind} for ayin; coexists with the hook above.
{ QUEUE_DIR="$HOME/.ayin-cli/watch"; mkdir -p "$QUEUE_DIR" && HASH=$(git rev-parse HEAD 2>/dev/null) && [ -n "$HASH" ] && { ${queueAppend(repo, kind)}; }; } || true
${CHAIN_END}
`;
}

/** Resolve a repo's hooks dir + a named hook path, or null if it's not a git repo (moved/deleted). */
async function hookPathFor(repo: string, hookName: string): Promise<{ hooksDir: string; hookPath: string } | null> {
  const res = await git(repo, ['rev-parse', '--git-path', 'hooks']);
  if (!res.ok) return null;
  const rel = res.stdout.trim();
  const hooksDir = rel.startsWith('/') ? rel : join(repo, rel);
  return { hooksDir, hookPath: join(hooksDir, hookName) };
}

/** Ensure one named hook is present: write our standalone if missing, chain onto a foreign hook,
 *  no-op if already ours. Returns whether it wrote anything. */
function ensureOneHook(hooksDir: string, hookPath: string, repo: string, kind: 'commit' | 'merge'): 'ok' | 'wrote' {
  if (existsSync(hookPath)) {
    if (readFileSync(hookPath, 'utf-8').includes(HOOK_MARKER)) return 'ok';
    appendFileSync(hookPath, chainedBlock(repo, kind)); // chain onto foreign (git-lfs/husky)
    return 'wrote';
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, hookScript(repo, kind));
  chmodSync(hookPath, 0o755);
  return 'wrote';
}

async function installHook(repo: string): Promise<void> {
  for (const { name, kind } of WATCH_HOOKS) {
    const paths = await hookPathFor(repo, name);
    if (!paths) throw new Error(`not a git repo: ${repo}`);
    const r = ensureOneHook(paths.hooksDir, paths.hookPath, repo, kind);
    out(r === 'wrote' ? `${name} hook set: ${paths.hookPath}` : `${name} hook already present`);
    log('INFO', 'watch_hook_installed', { repo, hook: name, result: r });
  }
  if (HOUND_ENABLED && ensureHoundHook(repo)) {
    out(`ayin-hound Stop hook set: ${join(repo, '.claude', 'hooks', HOUND_SCRIPT_NAME)}`);
    log('INFO', 'watch_hound_installed', { repo });
  }
  // Register the repo (the set the daemon watches + self-heals + reviews the working tree of).
  const repos = existsSync(REPOS_FILE) ? JSON.parse(readFileSync(REPOS_FILE, 'utf-8')) : {};
  repos[repo] = { installedAt: new Date().toISOString() };
  writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
}

/** The registered repos (keys of repos.json) — the set the daemon watches. */
function registeredRepos(): string[] {
  if (!existsSync(REPOS_FILE)) return [];
  try { return Object.keys(JSON.parse(readFileSync(REPOS_FILE, 'utf-8'))); } catch { return []; }
}

/** Self-heal (boot + every 5 min): re-add/re-chain BOTH hooks in every registered repo that lost
 *  them (re-clone, reset, or another tool overwriting .git/hooks). Cheap: rev-parse + stats. */
async function selfHealHooks(): Promise<void> {
  const repos = registeredRepos();
  if (repos.length === 0) return;
  let reinstalled = 0, gone = 0, hound = 0;
  for (const repo of repos) {
    let wrote = false, missing = false;
    for (const { name, kind } of WATCH_HOOKS) {
      const paths = await hookPathFor(repo, name);
      if (!paths) { missing = true; break; }
      if (ensureOneHook(paths.hooksDir, paths.hookPath, repo, kind) === 'wrote') wrote = true;
    }
    if (missing) { gone++; continue; }
    if (wrote) reinstalled++;
    if (HOUND_ENABLED && existsSync(repo) && ensureHoundHook(repo)) hound++;
  }
  if (reinstalled || gone || hound) {
    out(`hook self-heal: ${reinstalled} repo(s) re-hooked, ${gone} missing, ${hound} hound-refreshed — of ${repos.length} watched`);
    log('INFO', 'watch_hook_selfheal', { watched: String(repos.length), reinstalled: String(reinstalled), gone: String(gone), hound: String(hound) });
  }
}

// ── Claude Code hound hook (auto-installed alongside the git hooks) ──
// A Stop hook written into the watched repo's own .claude/settings.json: at the end of a Claude
// Code turn, if anything is staged, ayin looks at the index. The script (`assets/ayin-hound.mjs`,
// shipped with the package and copied in verbatim under a two-constant header) is deliberately
// two-stage:
//
//   FACTS   six mechanical checks computed by git alone — no model. A staged file no commit on this
//           branch ever touched · a .meta whose `guid:` line actually changed · a serialized field
//           removed/renamed · enum members inserted rather than appended · an interface that gained
//           a member · an asmdef reference dropped. Each is true by construction.
//   VERIFY  ayin itself, read-only (AYIN_READONLY=1 → grep/read only, never edit), capped at a small
//           round budget (AYIN_MAX_ROUNDS), asked ONLY to grep the repo and say which facts actually
//           break something. Engine is ayin, not `claude -p` — no LAN address to hardcode, no
//           separate config; it inherits whatever AYIN_MODEL_URL this install already talks to.
//
// The contract is ENFORCED in the script, not requested in the prompt: a finding whose citation does
// not resolve to a real path is dropped, and `greps_run: 0` forces UNVERIFIED. The previous hound
// reported greps it never ran and reasoned about files that do not exist; that is now structurally
// impossible. Blocking the stop costs a whole turn, so it is reserved for a verified, cited finding
// — deterministic flags, unverified checks and the commit nudge ride out as non-blocking
// `additionalContext`. AYIN_WATCH_HOUND=0 disables installing it (existing installs are left as-is).

const HOUND_SCRIPT_NAME = 'ayin-hound.mjs';
const LEGACY_HOUND_SCRIPT = 'ayin-hound.sh'; // pre-1.0.224 bash hound — replaced, and its entry migrated
const HOUND_MARKERS = [HOUND_SCRIPT_NAME, LEGACY_HOUND_SCRIPT]; // substrings identifying our own settings.json entry
const HOUND_ENABLED = process.env.AYIN_WATCH_HOUND !== '0';

/** The hound script for a repo: the shipped asset, prefixed with the two constants the installer
 *  owns. The prompt text stays in the prompt store (§3) — it arrives here as a JSON string, never
 *  as a literal in the asset. */
function houndScript(promptText: string): string {
  const body = readFileSync(packagePath('assets', 'ayin-hound.mjs'), 'utf-8');
  return `#!/usr/bin/env node
// GENERATED by \`ayin watch\` — reinstalling overwrites this file. Edit the prompt, not this script:
// ~/.ayin-cli/prompts/watch/hound*.txt
const AYIN_HOUND_INSTRUCTIONS = ${JSON.stringify(promptText)};
${body}`;
}

interface ClaudeHookEntry { type: string; command: string; timeout?: number; statusMessage?: string }
interface ClaudeHookGroup { hooks?: ClaudeHookEntry[]; matcher?: string }
interface ClaudeSettings { hooks?: { [event: string]: ClaudeHookGroup[] }; [key: string]: unknown }

function ourHoundEntry(): ClaudeHookEntry {
  return {
    type: 'command',
    command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${HOUND_SCRIPT_NAME}"`,
    timeout: 300,
    statusMessage: 'ayin-hound: checking staged changes',
  };
}

/** Upsert ayin's Stop-hook entry into a repo's .claude/settings.json — a structural JSON merge,
 *  not a fenced-text block (JSON has no comment syntax to fence with). Leaves every OTHER top-level
 *  key, every OTHER Stop-hook group, and every other hook event untouched; only the one group whose
 *  command names our own script is added or replaced. An existing file that fails to parse is left
 *  alone rather than risking a hand-edited config. */
function upsertHoundSettings(repo: string): boolean {
  const dir = join(repo, '.claude');
  const path = join(dir, 'settings.json');
  let settings: ClaudeSettings = {};
  if (existsSync(path)) {
    try { settings = JSON.parse(readFileSync(path, 'utf-8')); }
    catch { log('WARN', 'hound_settings_unparseable', { repo }); return false; }
  }
  settings.hooks = settings.hooks || {};
  const stopGroups: ClaudeHookGroup[] = settings.hooks.Stop || [];
  // Both markers, so the pre-1.0.224 `bash …/ayin-hound.sh` entry is REPLACED rather than left
  // beside the new one — a repo that upgrades would otherwise run two hounds per stop.
  const others = stopGroups.filter(g => !g.hooks?.some(h => HOUND_MARKERS.some(m => h.command?.includes(m))));
  settings.hooks.Stop = [...others, { hooks: [ourHoundEntry()] }];
  mkdirSync(dir, { recursive: true });
  return writeIfChanged(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Write/refresh the hound script + settings.json entry for one repo. Idempotent: only writes when
 *  bytes actually change (Unity-ness is re-checked live, so a repo that grows an Assets/ folder
 *  later gets the Unity-scoped prompt on the next self-heal, no reinstall needed). */
export function ensureHoundHook(repo: string): boolean {
  const unity = isUnityRepo(repo);
  const promptText = watchPrompts.get(unity ? 'houndUnityChecks' : 'houndGeneralChecks', {
    CONTRACT: watchPrompts.get('houndContract'),
  });
  const scriptPath = join(repo, '.claude', 'hooks', HOUND_SCRIPT_NAME);
  const desired = houndScript(promptText);
  let wrote = false;
  if (!existsSync(scriptPath) || readFileSync(scriptPath, 'utf-8') !== desired) {
    mkdirSync(join(repo, '.claude', 'hooks'), { recursive: true });
    writeAtomic(scriptPath, desired);
    chmodSync(scriptPath, 0o755);
    wrote = true;
  }
  // The bash hound it replaces: remove the file too, not just its settings.json entry, so a stale
  // copy can't be re-wired by hand later.
  const legacy = join(repo, '.claude', 'hooks', LEGACY_HOUND_SCRIPT);
  if (existsSync(legacy)) { try { unlinkSync(legacy); wrote = true; } catch { /* read-only tree */ } }
  const settingsWrote = upsertHoundSettings(repo);
  return wrote || settingsWrote;
}

// ── agent-file pointer (CLAUDE.md + GEMINI.md) ────────────────────────
// After a report is written, upsert a fenced block in the repo-root agent instruction files listing
// the pending ayin reports, so the next Claude Code / Gemini CLI session reads them. Managed region
// only — the rest of each file is untouched; a file is created if absent. These blocks + ayin's
// report files are excluded from review + staging (see EXCLUDE_PATHSPEC / isStageable).

/** The repo-root instruction files ayin maintains — one per coding agent that reads a repo file. */
const AGENT_FILES = ['CLAUDE.md', 'GEMINI.md'];

const CLAUDE_BEGIN = '<!-- ayin:reports:begin -->';
const CLAUDE_END = '<!-- ayin:reports:end -->';

/** Basename pattern for the ONE report kind still written loose at the repo root: the periodic
 *  worktree smell pass (`AYIN-REPORT-SMELLS-<timestamp>.md`) — it is not tied to any one commit, so
 *  it does not fit the per-commit `reviews/<hash>/` folder the way CodeReview/AssetDiff/MergeReport
 *  do. Everything else ayin writes lives under `reviews/`. */
const AYIN_REPORT_RE = /^AYIN-REPORT-[A-Za-z]+-.+\.md$/;
/** A path (relative or absolute) is one of ayin's own outputs — used to exclude the whole `reviews/`
 *  folder from review, staging and the untracked-file fingerprint, regardless of what's inside it. */
function isAyinReviewPath(path: string): boolean {
  return /(^|\/)reviews\//.test(path);
}

/** The reports worth pointing an agent at: the per-commit ones nested under `reviews/`, plus any
 *  smell report still sitting at the repo root, newest first. */
function listRepoReports(repo: string): string[] {
  const found: Array<{ f: string; m: number }> = [];
  try {
    for (const f of readdirSync(repo)) {
      if (AYIN_REPORT_RE.test(f)) found.push({ f, m: statSync(join(repo, f)).mtimeMs });
    }
  } catch { /* repo unreadable — the root scan just contributes nothing */ }
  try {
    const reviewsDir = join(repo, 'reviews');
    for (const hash of readdirSync(reviewsDir)) {
      const hashDir = join(reviewsDir, hash);
      if (!statSync(hashDir).isDirectory()) continue;
      for (const name of readdirSync(hashDir)) {
        if (!/\.md$/.test(name)) continue;
        found.push({ f: `reviews/${hash}/${name}`, m: statSync(join(hashDir, name)).mtimeMs });
      }
    }
  } catch { /* no reviews/ yet — nothing to add */ }
  return found.sort((a, b) => b.m - a.m).slice(0, 12).map(x => x.f);
}

/** Replace a fenced managed region in `content` (or append it), returning the new content.
 *  Everything outside the fence is preserved byte-for-byte. */
function upsertBlock(content: string, begin: string, end: string, block: string): string {
  if (content.includes(begin)) {
    const before = content.slice(0, content.indexOf(begin));
    const endIdx = content.indexOf(end);
    const after = endIdx >= 0 ? content.slice(endIdx + end.length) : '';
    return `${before}${block}${after}`;
  }
  return content.trim() ? `${content.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`;
}

/** Write only if the bytes actually change (atomically — temp file + rename, so a power cut
 *  mid-write can never leave a truncated CLAUDE.md/settings.json for the next reader). The
 *  self-heal runs every 5 min over every watched repo — an unconditional write would churn mtimes
 *  (and, for a tracked file, the worktree) forever. */
function writeIfChanged(path: string, content: string): boolean {
  try {
    if (existsSync(path) && readFileSync(path, 'utf-8') === content) return false;
    writeAtomic(path, content);
    return true;
  } catch { return false; } // read-only tree — skip
}

function upsertAgentReports(repo: string): void {
  const reports = listRepoReports(repo);
  const body = reports.length
    ? reports.map(f => `- \`${f}\``).join('\n')
    : '- (none pending)';
  const block = `${CLAUDE_BEGIN}\n## ⚠ Ayin review notes — read before continuing\nAuto-generated by \`ayin watch\` (local review). Newest first; open the file for the findings.\n${body}\n${CLAUDE_END}`;
  for (const name of AGENT_FILES) {
    const path = join(repo, name);
    let content = '';
    try { content = existsSync(path) ? readFileSync(path, 'utf-8') : ''; } catch { continue; }
    writeIfChanged(path, upsertBlock(content, CLAUDE_BEGIN, CLAUDE_END, block));
  }
}

// ── repo hygiene: REMOVED ──────────────────────────────────────────────
// ayin used to write a managed .gitignore block, and quote the same list into CLAUDE.md/GEMINI.md,
// on every watched repo — a hardcoded "local dev cruft" list that included one deployment's own
// internal tooling folder names. That is not ayin's call to make: which paths a repo ignores is the
// repo owner's decision, not a side effect of pointing ayin at it, and hardcoding one operator's
// project layout into a public tool leaks exactly what it should never have known. Removed outright,
// not made opt-in — an opt-in default is still a default someone has to notice and turn off.
// AYIN_WATCH_HYGIENE, ensureHygiene(), upsertCruftIgnore(), upsertCruftInstruction() and LOCAL_CRUFT
// are gone; nothing replaces them. Anything a repo owner wants ignored belongs in that repo's own
// .gitignore, written by them.

// ── danger push ───────────────────────────────────────────────────────
// When a review flags something dangerous, ping the user's phone via the backend's push
// door (POST /api/push — the headless counterpart to the send_push tool; no TUI). On by default;
// set AYIN_WATCH_PUSH=0 to silence. Best-effort — a push failure never breaks a review.
const PUSH_ENABLED = process.env.AYIN_WATCH_PUSH !== '0';
function repoName(repo: string): string { return repo.split('/').filter(Boolean).pop() || repo; }

async function sendDangerPush(title: string, body: string): Promise<void> {
  if (!PUSH_ENABLED) return;
  try {
    const res = await fetch(`${llmBaseUrl()}/api/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = res.ok ? (await res.json()) as { delivered?: number } : null;
    out(`  📲 push: ${title} (delivered ${data?.delivered ?? 0})`);
    log('INFO', 'watch_push', { title: title.slice(0, 80), delivered: String(data?.delivered ?? 0), ok: String(res.ok) });
  } catch (err) {
    log('WARN', 'watch_push_failed', { error: (err instanceof Error ? err.message : String(err)).slice(0, 150) });
  }
}

// ── review ───────────────────────────────────────────────────────────

interface CommitMeta {
  hash: string; shortHash: string; author: string; email: string;
  date: string; subject: string; body: string; branch: string;
  numstat: string; filesChanged: number;
}

async function gatherMeta(repo: string, commit: string): Promise<CommitMeta | null> {
  const fmt = await git(repo, ['show', '-s', '--format=%H%n%h%n%an%n%ae%n%aI%n%s%n%b', commit]);
  if (!fmt.ok) return null;
  const [hash, shortHash, author, email, date, subject, ...bodyLines] = fmt.stdout.split('\n');
  const numstatRes = await git(repo, ['show', '--numstat', '--format=', commit]);
  const numstat = numstatRes.stdout.trim();
  const branchRes = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    hash, shortHash, author, email, date, subject,
    body: bodyLines.join('\n').trim(),
    branch: branchRes.stdout.trim() || '(unknown)',
    numstat,
    filesChanged: numstat ? numstat.split('\n').length : 0,
  };
}

// ── deterministic Unity asset diff (Unity repos ONLY) ────────────────
// Unity scene/prefab/asset YAML is noise to an LLM; the deterministic unity_asset_diff tool
// (external, supplied by the operator) turns it into a readable object-level report with full
// hierarchy paths. For repos with Assets/ + ProjectSettings/ we run it commit^ → commit and
// embed its --md output in the review verbatim, ahead of the LLM's take. The tool itself
// no-ops on non-Unity repos (exit 0), but we gate anyway to avoid spawning python elsewhere.

const UNITY_DIFF_MAX_CHARS = 30_000;

function unityDiffToolPath(): string {
  return process.env.AYIN_UNITY_DIFF || join(homedir(), 'tools', 'unity_asset_diff.py');
}

function isUnityRepo(repo: string): boolean {
  return existsSync(join(repo, 'Assets')) && existsSync(join(repo, 'ProjectSettings'));
}

async function unityAssetDiff(repo: string, commit: string): Promise<string | null> {
  if (!isUnityRepo(repo)) return null; // non-Unity repo → section absent entirely
  const tool = unityDiffToolPath();
  if (!existsSync(tool)) {
    return `_(unity repo detected, but the deterministic diff tool is missing at \`${tool}\` — ` +
      `install it there or point AYIN_UNITY_DIFF at it)_`;
  }
  const parent = await git(repo, ['rev-parse', `${commit}^`]);
  if (!parent.ok) return '_(first commit — no parent to diff against)_';
  const res = await sh('python3', [tool, `${commit}^`, '--target', commit, '--repo', repo, '--md'], repo, UNITY_DIFF_MAX_CHARS + 4096);
  if (!res.ok) {
    log('WARN', 'watch_unity_diff_failed', { repo, commit: commit.substring(0, 12), stderr: res.stderr.substring(0, 200) });
    return `_(deterministic diff failed: ${res.stderr.trim().substring(0, 200) || 'unknown error'})_`;
  }
  let out = res.stdout.trim();
  if (!out) return '_(no Unity asset changes in this commit)_';
  if (out.length > UNITY_DIFF_MAX_CHARS) out = out.substring(0, UNITY_DIFF_MAX_CHARS) + '\n\n… (unity diff truncated) …';
  return out;
}

function onlyReviewFiles(numstat: string): boolean {
  // Skip commits that only touch ayin's own artifacts (else committing a review triggers a review
  // of the review, forever): anything under reviews/, or a root-level AYIN-REPORT-*.md.
  const files = numstat.split('\n').filter(Boolean).map(l => l.split('\t')[2] || '');
  return files.length > 0 && files.every(f => isAyinReviewPath(f) || AYIN_REPORT_RE.test(f.split('/').pop() || f));
}

function buildReviewPrompt(meta: CommitMeta, diff: string, truncated: boolean, unityMd?: string | null): string {
  const catalog = SMELL_SIGNALS.map(s => `- **${s.name}** — ${s.hint}`).join('\n');
  // The two optional sections are their own prompt ids (the store has no conditionals); the
  // newlines that join them to the body stay here, since only the code knows they are separators.
  return watchPrompts.get('commitReview', {
    UNITY_SECTION: unityMd ? `\n${watchPrompts.get('commitReviewUnity', { UNITY_MD: unityMd })}\n` : '',
    BODY_SECTION: meta.body ? `${watchPrompts.get('commitReviewBody', { BODY: meta.body })}\n` : '',
    TRUNCATION_NOTE: truncated ? ` ${watchPrompts.get('commitReviewTruncated')}` : '',
    CATALOG: catalog,
    ANIMATOR_RULE: animatorRule(),
    SUBJECT: meta.subject,
    AUTHOR: meta.author,
    EMAIL: meta.email,
    FILES_CHANGED: String(meta.filesChanged),
    DIFF: diff,
  });
}

async function reviewCommit(repo: string, commit: string): Promise<{ status: 'reviewed' | 'skipped' | 'gone'; note: string }> {
  const meta = await gatherMeta(repo, commit);
  if (!meta) return { status: 'gone', note: 'commit not found (rebased/gc?)' };

  // Review-of-review guard: a commit that only adds/edits CodeReview-*.md is not reviewed.
  if (onlyReviewFiles(meta.numstat)) {
    return { status: 'skipped', note: 'only CodeReview-*.md files touched' };
  }

  const diffRes = await git(repo, ['show', '--format=', '--patch', commit], MAX_DIFF_CHARS + 4096);
  let diff = diffRes.stdout;
  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) {
    const cut = diff.lastIndexOf('\ndiff --git', MAX_DIFF_CHARS);
    diff = diff.substring(0, cut > MAX_DIFF_CHARS / 2 ? cut : MAX_DIFF_CHARS)
      + '\n\n… DIFF TRUNCATED (commit too large) …';
  }
  if (!diff.trim()) diff = '(empty diff — merge or metadata-only commit)';

  // Review output dir — ONE FOLDER PER REVIEW: `reviews/<shortHash>/` under the repo root, or under
  // AYIN_REVIEW_DIR if set (absolute, or relative to the repo). Everything about this commit's review
  // — the report, the Unity asset diff — lives together in that one folder, so a repo-relative link
  // between them never needs the hash repeated in the filename, and the repo root stays clean.
  const reviewsBase = process.env.AYIN_REVIEW_DIR
    ? (process.env.AYIN_REVIEW_DIR.startsWith('/') ? process.env.AYIN_REVIEW_DIR : join(repo, process.env.AYIN_REVIEW_DIR))
    : join(repo, 'reviews');
  const reviewDir = join(reviewsBase, meta.shortHash);
  mkdirSync(reviewDir, { recursive: true });

  // Unity repos only: deterministic object-level asset diff → its OWN file beside the review, in the
  // same per-commit folder, and fed to the reviewer as ground truth.
  const unityMd = await unityAssetDiff(repo, commit);
  let assetDiffPath: string | null = null;
  if (unityMd) {
    assetDiffPath = join(reviewDir, `AssetDiff.md`);
    writeFileSync(assetDiffPath, `# Unity Asset Diff — ${meta.subject}

| | |
|---|---|
| **Commit** | \`${meta.hash}\` |
| **Author** | ${meta.author} \`<${meta.email}>\` |
| **Date** | ${meta.date} |
| **Generated** | ${new Date().toISOString()} — ayin watch (deterministic, unity_asset_diff) |

---

${unityMd}
`);
    out(`  → ${assetDiffPath}`);
  }

  out(`reviewing ${meta.shortHash} "${meta.subject}" (${meta.filesChanged} files)…`);
  const review = await llmChat([
    { role: 'system', content: watchPrompts.get('commitReviewSystem') },
    { role: 'user', content: buildReviewPrompt(meta, diff, truncated, unityMd) },
  ]);

  const reportPath = join(reviewDir, `CodeReview.md`);
  const header = `# Code Review — ${meta.subject}

| | |
|---|---|
| **Commit** | \`${meta.hash}\` |
| **Author** | ${meta.author} \`<${meta.email}>\` |
| **Date** | ${meta.date} |
| **Branch** | ${meta.branch} |
| **Files changed** | ${meta.filesChanged} |
| **Reviewed** | ${new Date().toISOString()} — ayin watch |

## Changed files

\`\`\`
${meta.numstat || '(none)'}
\`\`\`

${unityMd ? `## Deterministic Unity asset diff\n\n→ **[AssetDiff.md](AssetDiff.md)** (object-level change map; the reviewer below saw it)\n\n` : ''}---

`;
  writeFileSync(reportPath, header + review.trim() + '\n');
  out(`  → ${reportPath}`);
  log('INFO', 'watch_review_written', { repo, commit: meta.shortHash, report: reportPath });
  upsertAgentReports(repo);
  // Dangerous → ping the phone. "Needs attention" is the reviewer's bad verdict.
  if (/needs attention/i.test(review)) {
    await sendDangerPush(`⚠ Ayin: review flags ${repoName(repo)}`, `"${meta.subject}" (${meta.shortHash}) — Needs attention. See reviews/${meta.shortHash}/CodeReview.md`);
  }
  return { status: 'reviewed', note: reportPath };
}

// ── merge review (post-merge / pull) ─────────────────────────────────
// Explains what a pull/merge just brought in — the range prev(ORIG_HEAD)..HEAD — into
// reviews/<hash>/MergeReport.md, same one-folder-per-commit convention as the post-commit review
// (so it shows in the client + gets picked up by the agent-file pointer). Answers "what changed
// under me and what should I watch out for".

function buildMergePrompt(range: string, oneline: string, stat: string, diff: string, truncated: boolean): string {
  return watchPrompts.get('mergeReport', {
    TRUNCATION_NOTE: truncated ? ` ${watchPrompts.get('mergeReportTruncated')}` : '',
    ANIMATOR_RULE: animatorRule(),
    RANGE: range,
    ONELINE: oneline || '(none)',
    STAT: stat || '(none)',
    DIFF: diff,
  });
}

async function reviewMerge(repo: string, commit: string, prev?: string): Promise<{ status: 'reviewed' | 'skipped' | 'gone'; note: string }> {
  const meta = await gatherMeta(repo, commit);
  if (!meta) return { status: 'gone', note: 'merge HEAD not found (rebased/gc?)' };
  // Range that was pulled: ORIG_HEAD..HEAD when we captured it, else the merge's first-parent range.
  const range = prev && prev.length >= 7 ? `${prev}..${commit}` : `${commit}^1..${commit}`;
  const onelineRes = await git(repo, ['log', '--oneline', '--no-decorate', range], 20_000);
  if (!onelineRes.ok || !onelineRes.stdout.trim()) {
    return { status: 'skipped', note: 'nothing new pulled (fast-forward no-op or range empty)' };
  }
  const statRes = await git(repo, ['diff', '--stat', range], 20_000);
  const diffRes = await git(repo, ['diff', range], MAX_DIFF_CHARS + 4096);
  let diff = diffRes.stdout;
  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) {
    const cut = diff.lastIndexOf('\ndiff --git', MAX_DIFF_CHARS);
    diff = diff.substring(0, cut > MAX_DIFF_CHARS / 2 ? cut : MAX_DIFF_CHARS) + '\n\n… DIFF TRUNCATED …';
  }
  if (!diff.trim()) diff = '(no textual diff — merge of already-present objects)';

  out(`explaining merge ${meta.shortHash} (${range})…`);
  const review = await llmChat([
    { role: 'system', content: watchPrompts.get('mergeReportSystem') },
    { role: 'user', content: buildMergePrompt(range, onelineRes.stdout.trim(), statRes.stdout.trim(), diff, truncated) },
  ]);

  const reviewsBase = process.env.AYIN_REVIEW_DIR
    ? (process.env.AYIN_REVIEW_DIR.startsWith('/') ? process.env.AYIN_REVIEW_DIR : join(repo, process.env.AYIN_REVIEW_DIR))
    : join(repo, 'reviews');
  const reviewDir = join(reviewsBase, meta.shortHash);
  mkdirSync(reviewDir, { recursive: true });
  const reportPath = join(reviewDir, `MergeReport.md`);
  const header = `# Merge report — what \`${range}\` pulled in

| | |
|---|---|
| **Into** | \`${meta.hash}\` (${meta.branch}) |
| **Range** | \`${range}\` |
| **Generated** | ${new Date().toISOString()} — ayin watch |

---

`;
  writeFileSync(reportPath, header + review.trim() + '\n');
  out(`  → ${reportPath}`);
  log('INFO', 'watch_merge_written', { repo, commit: meta.shortHash, report: reportPath });
  upsertAgentReports(repo);
  if (/^VERDICT:\s*RISKY/im.test(review)) {
    await sendDangerPush(`⚠ Ayin: risky pull in ${repoName(repo)}`, `${range} brought in breaking/risky changes — see reviews/${meta.shortHash}/MergeReport.md`);
  }
  return { status: 'reviewed', note: reportPath };
}

// ── 10-min working-tree pass: autostage + smell review (the eGPU workhorse) ──
// Every 10 min, per watched repo, IF the working tree changed since last check: qwen reviews the
// unstaged work, stages what's meaningful + unstages debug/junk (NO commit, NO push), drafts a
// conventional-commit message into .git/COMMIT_EDITMSG, and writes AYIN-REPORT-SMELLS-<ts>.md
// (dangerous ad-hoc solutions, heavy violations, logging suggestions). So you open Fork to ready
// chores. Fingerprint (ayin's own artifacts + agent files excluded) means it's near-free when idle.

const WORKTREE_REVIEW_MS = 10 * 60 * 1000;
const WORKTREE_STATE_FILE = join(WATCH_DIR, 'worktree-state.json');
const MAX_WORKTREE_DIFF = 80_000;
const MAX_STAGE_BYTES = 2 * 1024 * 1024; // never stage a file bigger than this (blobs/binaries)

// Never stage (secrets + ayin's own artifacts + the agent-file pointers).
const SECRET_RE = /(^|\/)(\.env(\.[^/]+)?|[^/]*\.(pem|key|p12|pfx|keystore)|id_rsa|id_ed25519|[^/]*(secret|credential)[^/]*)$/i;
// Infra the developer manages by hand — never auto-staged, and excluded from the review trigger:
// git hooks, Unity ProjectSettings/ + UserSettings/, and editor/IDE settings (.vscode/.idea/.vs,
// .csproj/.sln/.user/.vsconfig). Deterministic so it holds regardless of the model's judgement.
const NEVER_STAGE_RE = /(^|\/)(ProjectSettings|UserSettings|Packages|AddressableAssetsData|\.vscode|\.idea|\.vs|hooks)(\/|$)|\.(csproj|sln|user|vsconfig|txt|meta)$/i;
// ── what ayin is allowed to stage in a Unity repo (ALLOWLIST, deterministic) ──
// EXACTLY four things. Nothing else, ever, whatever the model proposes:
//   1. .cs        — and only when the change adds no debug code
//   2. .controller
//   3. .anim
//   4. .asset     — ONLY a custom ScriptableObject instance under Assets/ whose m_Script guid
//                   resolves to a .cs in this project. Not ProjectSettings, not Addressables
//                   config, not baked data, not package-owned assets.
//
// NOT staged, deliberately: `.meta` sidecars, Addressables (`AddressableAssetsData/`), prefabs,
// scenes, materials, textures, `.overrideController`, and everything else. Unity rewrites half of
// these just for opening the editor, and auto-staging them is the whole complaint this allowlist
// exists to answer. Stage them by hand, deliberately.
//
// `.meta` was previously staged as a "sidecar" of anything above. It no longer is — a `.meta`
// riding along on someone else's judgement is exactly how unrelated churn reached the index.
const UNITY_ANIM_RE = /\.(anim|controller)$/i;
// Scratch prints. LogError/LogWarning/LogException are deliberate production error reporting and
// are NOT debug code; Debug.Log and friends are what gets left behind.
const DEBUG_CODE_RE = /\b(?:UnityEngine\.)?Debug\.Log(?:Format)?\s*\(|(?:^|[^.\w])print\s*\(|\bConsole\.(?:Write|WriteLine)\s*\(|\bSystem\.Diagnostics\.Debug\.(?:Write|WriteLine)\s*\(/;
// A Unity MonoScript reference inside a .asset: `m_Script: {fileID: 11500000, guid: <32 hex>, …}`.
// fileID 11500000 IS MonoScript — an .asset carrying one is a ScriptableObject instance.
const MONO_SCRIPT_RE = /m_Script:\s*\{fileID:\s*11500000,\s*guid:\s*([0-9a-f]{32})/;

function isStageable(path: string): boolean {
  const base = path.split('/').pop() || path;
  if (isAyinReviewPath(path)) return false;
  if (AYIN_REPORT_RE.test(base)) return false;
  // ayin's own managed file — the agent-file pointer block. The dev decides when that gets
  // committed; auto-staging it would commit ayin's bookkeeping for them.
  if (AGENT_FILES.includes(base)) return false;
  if (SECRET_RE.test(path)) return false;
  if (NEVER_STAGE_RE.test(path)) return false;
  return true;
}

/** `staged` is the LEDGER of paths ayin itself staged, per repo. It is the whole reason ayin can
 *  clean up after itself without ever touching the developer's own `git add`: a path is only
 *  unstaged if ayin put it there and it no longer qualifies. Persisted, so a power cut between
 *  staging and the next pass doesn't turn ayin's work into the developer's. */
interface WorktreeState { [repo: string]: { fingerprint: string; at: number; staged?: string[] } }
function loadWorktreeState(): WorktreeState {
  try { return existsSync(WORKTREE_STATE_FILE) ? JSON.parse(readFileSync(WORKTREE_STATE_FILE, 'utf-8')) : {}; } catch { return {}; }
}
function saveWorktreeState(s: WorktreeState): void {
  try { writeFileSync(WORKTREE_STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* best effort */ }
}

// Paths excluded from the unstaged-change fingerprint AND the review diff: ayin's own outputs (so
// writing a report or the agent-file pointer never re-triggers the pass) + the never-stage infra
// (ProjectSettings/UserSettings/IDE/hooks — the dev owns those). Matches isStageable / NEVER_STAGE_RE
// in intent. `reviews/**` covers CodeReview/AssetDiff/MergeReport in one glob, one level deep or not.
const EXCLUDE_PATHSPEC = [
  'CLAUDE.md', 'GEMINI.md', 'AYIN-REPORT-*.md', 'reviews/**',
  'ProjectSettings/**', 'UserSettings/**', 'Packages/**', '.vscode/**', '.idea/**', '.vs/**',
  'Assets/AddressableAssetsData/**',
  '*.csproj', '*.sln', '*.user', '*.vsconfig', '*.txt',
].flatMap(g => [`:(exclude,glob)${g}`, `:(exclude,glob)**/${g}`]);

/** Fingerprint of the UNSTAGED work only — `git diff` (working tree vs index, NOT --cached) plus
 *  new untracked files — with ayin's own artifacts + agent files excluded. So the big (LLM) review
 *  fires only when the user's unstaged changes actually change: staging/unstaging alone doesn't
 *  trip it, and the dog writing its own report or the agent-file pointer never re-triggers itself. */
async function worktreeFingerprint(repo: string): Promise<string> {
  const diff = await git(repo, ['diff', '--', '.', ...EXCLUDE_PATHSPEC], 400_000);
  const others = await git(repo, ['ls-files', '--others', '--exclude-standard']);
  const untracked = others.stdout.split('\n').filter(Boolean).filter(isStageable).sort().join('\n');
  return createHash('sha1').update(`${diff.stdout}\n--untracked--\n${untracked}`).digest('hex');
}

async function absGitDir(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
}
async function mergeOrRebaseInProgress(repo: string): Promise<boolean> {
  const gd = await absGitDir(repo);
  if (!gd) return false;
  return ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some(f => existsSync(join(gd, f)));
}

interface WorktreePlan {
  files: Array<{ path: string; stage: boolean; reason?: string }>;
  commit?: { type?: string; scope?: string; subject?: string; body?: string };
  smells?: Array<{ severity?: string; where?: string; issue?: string; fix?: string }>;
  logging?: string[];
}
function parseWorktreePlan(raw: string): WorktreePlan | null {
  const m = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]);
    if (!Array.isArray(o.files)) o.files = [];
    return o as WorktreePlan;
  } catch { return null; }
}
function commitText(c: NonNullable<WorktreePlan['commit']>): string {
  const head = `${c.type || 'chore'}${c.scope ? `(${c.scope})` : ''}: ${c.subject || 'work in progress'}`;
  return c.body ? `${head}\n\n${c.body}\n` : `${head}\n`;
}

// ── the Unity staging allowlist, evaluated per file ──────────────────

/** The lines this file ADDS relative to HEAD — the whole file when it is untracked. What a change
 *  removes can't introduce debug code, so only additions are inspected. */
async function addedLines(repo: string, path: string, tracked: boolean): Promise<string[]> {
  if (!tracked) {
    // Bounded: an untracked file can be anything, including a multi-MB generated .cs. A file over
    // the stage cap is never staged anyway, so reading past it buys nothing.
    try {
      if (statSync(join(repo, path)).size > MAX_STAGE_BYTES) return [];
      return readFileSync(join(repo, path), 'utf-8').split('\n');
    } catch { return []; }
  }
  const res = await git(repo, ['diff', 'HEAD', '--', path], 2 * 1024 * 1024);
  return res.stdout.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
}

/** Does this change introduce live debug output? Line comments are stripped first: a commented-out
 *  `// print(x)` is dead code for the reviewer to flag, not a reason to withhold the whole file from
 *  the index forever — and "why won't ayin stage this file" with no visible cause is its own bug. */
function addsDebugCode(lines: string[]): boolean {
  return lines.some(l => DEBUG_CODE_RE.test(l.replace(/\/\/.*$/, '')));
}

/** Does the guid belong to a .cs in THIS project (rather than a package or Unity itself)? One
 *  `git grep` per distinct guid, cached for the pass. */
async function guidIsProjectScript(repo: string, guid: string, cache: Map<string, boolean>): Promise<boolean> {
  const cached = cache.get(guid);
  if (cached !== undefined) return cached;
  const res = await git(repo, ['grep', '-l', '--untracked', '-F', '-e', `guid: ${guid}`, '--', 'Assets/*.cs.meta'], 200_000);
  const hit = res.stdout.trim().length > 0;
  cache.set(guid, hit);
  return hit;
}

/** Why ayin may stage this path in a Unity repo, or null for "leave it alone". The allowlist is the
 *  whole policy — there is no model judgement in this decision, by design. */
export async function unityStageReason(
  repo: string, path: string, tracked: boolean, guidCache: Map<string, boolean>,
): Promise<string | null> {
  if (UNITY_ANIM_RE.test(path)) return 'animator controller / clip';
  if (/\.cs$/i.test(path)) {
    return addsDebugCode(await addedLines(repo, path, tracked)) ? null : 'C# source, no debug code added';
  }
  if (/\.asset$/i.test(path)) {
    if (!/^Assets\//.test(path)) return null; // ProjectSettings/, Packages/, anything outside the project
    let text = '';
    try { text = readFileSync(join(repo, path), 'utf-8').slice(0, 64 * 1024); } catch { return null; }
    const guid = text.match(MONO_SCRIPT_RE)?.[1];
    if (!guid) return null; // not a ScriptableObject instance (baked data, a built-in asset type, …)
    return (await guidIsProjectScript(repo, guid, guidCache)) ? 'custom ScriptableObject asset' : null;
  }
  return null;
}

function buildWorktreePrompt(files: string[], status: string, diff: string, truncated: boolean): string {
  return watchPrompts.get('worktreeReview', {
    TRUNCATION_NOTE: truncated ? ` ${watchPrompts.get('worktreeReviewTruncated')}` : '',
    FILES: files.map(f => `- ${f}`).join('\n'),
    STATUS: status.trim(),
    DIFF: diff,
  });
}

interface Applied { staged: Array<{ path: string; why: string }>; unstaged: string[] }

function buildSmellReport(plan: WorktreePlan | null, raw: string, applied: Applied): string {
  const when = new Date().toISOString();
  const stagedSet = new Set(applied.staged.map(s => s.path));
  const stagedLines = applied.staged.map(s => `- \`${s.path}\` — ${s.why}`).join('\n') || '- (none)';
  const unstagedLines = applied.unstaged.map(p => `- \`${p}\` — ayin had staged it; it no longer qualifies`).join('\n');
  if (!plan) {
    return `# Ayin working-tree review — ${when}\n\n_(could not parse a staging plan from the model — staging is deterministic and ran anyway; raw output below)_\n\n## Staged\n${stagedLines}\n\n${raw.trim()}\n`;
  }
  const staged = stagedLines;
  const skipped = [
    unstagedLines,
    plan.files.filter(f => !stagedSet.has(f.path)).map(f => `- \`${f.path}\`${f.reason ? ` — ${f.reason}` : ''}`).join('\n'),
  ].filter(Boolean).join('\n') || '- (none)';
  const smells = (plan.smells || []).length
    ? plan.smells!.map(s => `### [${s.severity || '?'}] ${s.where || ''}\n- **Issue:** ${s.issue || ''}\n- **Fix:** ${s.fix || ''}`).join('\n\n')
    : 'None flagged.';
  const logging = (plan.logging || []).length ? plan.logging!.map(l => `- ${l}`).join('\n') : '- (no suggestions)';
  const msg = plan.commit?.subject ? commitText(plan.commit) : '(none drafted)';
  return `# Ayin working-tree review — ${when}

_Applied: staged ${applied.staged.length}, unstaged ${applied.unstaged.length}. **No commit, no push** — review in your git client and commit when ready._

## Staged by ayin
${staged}

## Left alone (yours to stage, or debug / junk / unsure)
${skipped}

## Proposed commit message
\`\`\`
${msg.trim()}
\`\`\`
_(also written to \`.git/COMMIT_EDITMSG\` — your client / \`git commit\` will prefill it.)_

## ⚠ Dangerous ad-hoc solutions & heavy violations
${smells}

## Logging / observability suggestions
${logging}
`;
}

/** Stage exactly one path — nothing rides along. No `.meta` sidecar, no sibling, no inference.
 *  Every staged path had to earn it on its own through the allowlist. */
async function stageOne(repo: string, path: string): Promise<boolean> {
  const abs = join(repo, path);
  try {
    if (!existsSync(abs) || statSync(abs).size > MAX_STAGE_BYTES) return false;
    return (await git(repo, ['add', '--', path])).ok;
  } catch { return false; }
}

async function reviewWorktree(repo: string, ledger: string[]): Promise<string[]> {
  // -uall (untracked-files=all): without it, git collapses an entirely-new, never-before-seen
  // directory to one line (`?? Assets/NewFeature/`) instead of listing the files inside it — so a
  // brand-new Unity feature folder (script + anim added together, a common workflow) would never
  // individually match the allowlist. Cheap: this repo's untracked set is small by review time.
  const statusRes = await git(repo, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall']);
  const rows = statusRes.stdout.split('\n').filter(Boolean).map(l => ({ xy: l.slice(0, 2), path: l.slice(3) }));
  const untracked = new Set(rows.filter(r => r.xy === '??').map(r => r.path));
  const files = rows.map(r => r.path).filter(isStageable);
  if (files.length === 0) return [];

  let diff = (await git(repo, ['diff', 'HEAD', '--', '.', ...EXCLUDE_PATHSPEC], MAX_WORKTREE_DIFF + 4096)).stdout;
  const truncated = diff.length > MAX_WORKTREE_DIFF;
  if (truncated) diff = diff.slice(0, MAX_WORKTREE_DIFF) + '\n\n… DIFF TRUNCATED …';

  out(`reviewing working tree of ${repo} (${files.length} files)…`);
  const raw = await llmChat([
    { role: 'system', content: watchPrompts.get('worktreeReviewSystem') },
    { role: 'user', content: buildWorktreePrompt(files, statusRes.stdout, diff, truncated) },
  ]);
  const plan = parseWorktreePlan(raw);

  // ── staging ────────────────────────────────────────────────────────
  // Unity repo → the ALLOWLIST decides, not the model: animator controllers/clips, custom
  // ScriptableObject assets, and .cs that adds no debug code (plus .meta sidecars). The model's
  // stage:true is ignored entirely here — a plan that wants a prefab staged does not get one.
  // Non-Unity repo → the model still proposes, but the same .cs debug veto applies.
  const applied: Applied = { staged: [], unstaged: [] };
  const unity = isUnityRepo(repo);
  const guidCache = new Map<string, boolean>();
  const qualifies = new Map<string, string>(); // path → why, for everything ayin is allowed to stage

  if (unity) {
    for (const f of files) {
      const why = await unityStageReason(repo, f, !untracked.has(f), guidCache);
      if (why) qualifies.set(f, why);
    }
  } else if (plan) {
    for (const f of plan.files) {
      if (!f.path || !f.stage || !isStageable(f.path) || !files.includes(f.path)) continue;
      if (/\.cs$/i.test(f.path) && addsDebugCode(await addedLines(repo, f.path, !untracked.has(f.path)))) continue;
      qualifies.set(f.path, f.reason || 'model: meaningful work');
    }
  }
  for (const [path, why] of qualifies) {
    if (await stageOne(repo, path)) applied.staged.push({ path, why });
  }

  // Clean up after OURSELVES only. A path is unstaged solely when ayin staged it on an earlier pass
  // and it no longer qualifies (a .cs that just grew a Debug.Log, an asset that stopped being a
  // custom ScriptableObject). The developer's own `git add` is never touched — unstaging deliberate
  // work is a worse failure than leaving junk in the index.
  for (const path of ledger) {
    if (qualifies.has(path)) continue;
    if (!(await git(repo, ['diff', '--cached', '--name-only', '--', path])).stdout.trim()) continue;
    await git(repo, ['reset', '-q', 'HEAD', '--', path]);
    applied.unstaged.push(path);
  }

  if (plan?.commit?.subject) {
    const gd = await absGitDir(repo);
    if (gd) { try { writeFileSync(join(gd, 'COMMIT_EDITMSG'), commitText(plan.commit)); } catch { /* skip */ } }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = join(repo, `AYIN-REPORT-SMELLS-${ts}.md`);
  writeFileSync(reportPath, buildSmellReport(plan, raw, applied));
  out(`  → ${reportPath} (staged ${applied.staged.length}, unstaged ${applied.unstaged.length}) — NO commit`);
  log('INFO', 'worktree_reviewed', { repo, staged: String(applied.staged.length), unstaged: String(applied.unstaged.length), parsed: String(!!plan) });
  upsertAgentReports(repo);
  const high = (plan?.smells || []).filter(s => (s.severity || '').toLowerCase() === 'high');
  if (high.length) {
    const first = high[0];
    await sendDangerPush(
      `⚠ Ayin: ${high.length} dangerous issue${high.length > 1 ? 's' : ''} in ${repoName(repo)}`,
      `${first.where ? first.where + ': ' : ''}${first.issue || 'high-severity finding'} — see ${reportPath.split('/').pop()}`,
    );
  }
  return applied.staged.map(s => s.path);
}

/** The 10-min pass over all watched repos whose working tree changed since last check. Takes the
 *  qwen authority once for the batch (one door); defers if the GPU is busy. */
async function runWorktreePass(): Promise<void> {
  const repos = registeredRepos();
  if (repos.length === 0) return;
  const state = loadWorktreeState();
  const changed: string[] = [];
  for (const repo of repos) {
    if (!existsSync(repo)) continue;
    if (await mergeOrRebaseInProgress(repo)) continue; // don't touch the index mid-merge/rebase
    const fp = await worktreeFingerprint(repo);
    if (fp && fp !== state[repo]?.fingerprint) changed.push(repo);
  }
  if (changed.length === 0) return;

  const hold: LlmHold = await acquireLlm('ayin watch: working-tree review');
  if (hold === 'busy') { out(`llm busy — working-tree review of ${changed.length} repo(s) deferred`); return; }
  if (typeof hold === 'object') { activeHold = hold; out('llm acquired (ayin) — working-tree review'); }
  await refreshActiveModel().catch(() => {});
  try {
    for (const repo of changed) {
      // The ledger persists across passes AND across a power cut: what ayin staged stays ayin's to
      // clean up, and a crash between staging and the next pass never re-attributes it to the dev.
      let ledger = state[repo]?.staged ?? [];
      try { ledger = await reviewWorktree(repo, ledger); }
      catch (err) { log('WARN', 'worktree_review_failed', { repo, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) }); }
      // Recompute AFTER staging (staging flips porcelain XY codes) so we don't re-trigger on our own work.
      state[repo] = { fingerprint: await worktreeFingerprint(repo), at: Date.now(), staged: ledger };
      saveWorktreeState(state);
    }
  } finally {
    if (typeof hold === 'object') { await hold.release(); activeHold = null; }
  }
}

// ── daemon ───────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquirePidfile(): boolean {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (pid && pid !== process.pid && pidAlive(pid)) return false;
  }
  writeFileSync(PID_FILE, String(process.pid));
  return true;
}

/** The watch daemon's pid, if one is currently alive — used by `ayin update` to restart a
 *  long-running daemon after a global install, so it doesn't keep serving stale code until someone
 *  notices and restarts it by hand. */
export function watchDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  return pid && pidAlive(pid) ? pid : null;
}

let lastBusyLogAt = 0;
let activeHold: { release: () => Promise<void> } | null = null; // released on SIGTERM so a kill mid-batch doesn't strand the grant until TTL

async function processBacklog(retryState: Map<string, { attempts: number; nextTryAt: number }>): Promise<void> {
  const processed = new Set(readJsonl(PROCESSED_FILE).map(r => String(r.key)));
  const queue = readJsonl(QUEUE_FILE) as unknown as QueueEntry[];

  const ready = (e: QueueEntry) => {
    if (processed.has(entryKey(e))) return false;
    const retry = retryState.get(entryKey(e));
    return !retry || Date.now() >= retry.nextTryAt;
  };
  // Only commit/merge markers are actionable. Stale `kind:'mine'` markers from the removed
  // episode-farming path carry no repo/commit, so they fall out here and are simply ignored.
  const reviewEntries = queue.filter(e => e.repo && e.commit && ready(e));
  if (reviewEntries.length === 0) return;

  // One door: take the llm resource as `ayin` for the REVIEW batch (backend swaps gemma → qwen).
  const hold: LlmHold = await acquireLlm('ayin watch: commit review batch');
  if (hold === 'busy') {
    if (Date.now() - lastBusyLogAt > 60_000) {
      lastBusyLogAt = Date.now();
      out(`llm resource busy — ${reviewEntries.length} review(s) deferred until it frees`);
      log('INFO', 'watch_llm_busy_deferred', { pending: String(reviewEntries.length) });
    }
    return;
  }
  if (hold !== 'no-resource-layer') {
    activeHold = hold;
    out('llm acquired (ayin) — backend swapping to the coder model');
  }
  // The swap changes the served model → re-resolve the dialect before reviewing.
  await refreshActiveModel().catch(() => {});

  try {
  for (const entry of reviewEntries) {
    const key = entryKey(entry);
    const retry = retryState.get(key);

    try {
      const result = entry.kind === 'merge'
        ? await reviewMerge(entry.repo, entry.commit, entry.prev)
        : await reviewCommit(entry.repo, entry.commit);
      appendFileSync(PROCESSED_FILE, JSON.stringify({ key, ts: Date.now(), ...result }) + '\n');
      processed.add(key);
      retryState.delete(key);
      if (result.status !== 'reviewed') out(`  → ${result.status}: ${result.note}`);
    } catch (err) {
      const attempts = (retry?.attempts ?? 0) + 1;
      const msg = err instanceof Error ? err.message : String(err);
      log('WARN', 'watch_review_failed', { key, attempts: String(attempts), error: msg.substring(0, 300) });
      if (attempts >= MAX_REVIEW_ATTEMPTS) {
        appendFileSync(PROCESSED_FILE, JSON.stringify({ key, ts: Date.now(), status: 'failed', note: msg.substring(0, 300) }) + '\n');
        retryState.delete(key);
        out(`  → FAILED after ${attempts} attempts: ${msg.substring(0, 120)}`);
      } else {
        retryState.set(key, { attempts, nextTryAt: Date.now() + RETRY_BACKOFF_MS * attempts });
        out(`  → attempt ${attempts} failed (${msg.substring(0, 120)}) — will retry`);
      }
    }
  }
  } finally {
    // Batch drained (or failed) → give the GPU back; backend reverts to gemma.
    if (typeof hold === 'object') { await hold.release(); activeHold = null; }
  }
}

export async function runWatch(args: string[]): Promise<void> {
  const repoIdx = args.indexOf('--repo');
  const repoArg = repoIdx !== -1 ? args[repoIdx + 1] : null;
  const once = args.includes('--once');

  mkdirSync(WATCH_DIR, { recursive: true });

  if (repoArg) {
    const res = await sh('git', ['-C', repoArg, 'rev-parse', '--show-toplevel'], process.cwd());
    if (!res.ok) {
      process.stderr.write(`ayin watch: ${repoArg} is not a git repository\n`);
      process.exit(1);
    }
    await installHook(res.stdout.trim());
  }
  // No --repo → run the daemon over the global queue (the boot/launchd resume path:
  // hooks are already installed in the watched repos, the queue is shared).

  if (!acquirePidfile()) {
    const pid = readFileSync(PID_FILE, 'utf-8').trim();
    out(`ayin watch daemon already running (pid ${pid}) — hook installed, this instance exits.`);
    return;
  }

  await connect(); // marks the LLM transport ready (HTTP; per-call failures are retried above)
  await initLlmProvider(); // decide direct vs resource once, before the first backlog pass

  const retryState = new Map<string, { attempts: number; nextTryAt: number }>();
  out(`ayin watch daemon up (pid ${process.pid}) — queue: ${QUEUE_FILE}`);
  log('INFO', 'watch_daemon_up', { pid: String(process.pid), once: String(once) });

  // Self-heal hooks on boot — a repo re-cloned/reset while we were down lost its post-commit hook.
  await selfHealHooks();
  let lastHookHealAt = Date.now();
  let lastWorktreeAt = 0; // 0 → first working-tree pass runs shortly after boot, then every 10 min

  // Backlog first — anything committed while we were down (or in flight at the power cut).
  await processBacklog(retryState);
  if (once) { cleanupPidfile(); out('backlog processed — exiting (--once).'); return; }

  const shutdownSignal = async () => {
    cleanupPidfile();
    if (activeHold) await activeHold.release().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdownSignal(); });
  process.on('SIGTERM', () => { void shutdownSignal(); });

  // Poll loop. Serialized: one pass at a time, one review at a time (one door to the LLM).
  for (;;) {
    await new Promise(r => setTimeout(r, POLL_MS));
    try {
      if (Date.now() - lastHookHealAt >= HOOK_SELF_HEAL_MS) {
        lastHookHealAt = Date.now();
        await selfHealHooks(); // re-add the post-commit hook to any watched repo that lost it
      }
      await processBacklog(retryState);
      if (Date.now() - lastWorktreeAt >= WORKTREE_REVIEW_MS) {
        lastWorktreeAt = Date.now();
        await runWorktreePass(); // autostage + smell review of any watched repo whose tree changed
      }
    } catch (err) {
      log('ERROR', 'watch_loop_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function cleanupPidfile(): void {
  try {
    if (existsSync(PID_FILE) && readFileSync(PID_FILE, 'utf-8').trim() === String(process.pid)) unlinkSync(PID_FILE);
  } catch { /* best effort */ }
}
