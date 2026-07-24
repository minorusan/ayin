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
 *     write CodeReview-<shortHash>.md into the repo root.
 *   - Commits that only touch CodeReview-*.md files are skipped — otherwise committing a
 *     review would trigger a review of the review, forever.
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { llmChat, refreshActiveModel } from './llm/manager.js';
import { connect } from './connection.js';
import { acquireLlm, type LlmHold } from './resource-client.js';
import { log } from './log.js';

const WATCH_DIR = join(homedir(), '.ayin-cli', 'watch');
const QUEUE_FILE = join(WATCH_DIR, 'queue.jsonl');
const PROCESSED_FILE = join(WATCH_DIR, 'processed.jsonl');
const PID_FILE = join(WATCH_DIR, 'daemon.pid');
const REPOS_FILE = join(WATCH_DIR, 'repos.json');

const POLL_MS = 2_000;
const MAX_DIFF_CHARS = 120_000;   // diff sent to the LLM is capped; big commits get a truncation note
const MAX_REVIEW_ATTEMPTS = 5;    // LLM/backend failures retry with backoff, then give up (ledgered)
const RETRY_BACKOFF_MS = 60_000;

const HOOK_MARKER = 'ayin-watch post-commit hook';

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

interface QueueEntry { ts: number; repo: string; commit: string }

function entryKey(e: { repo: string; commit: string }): string {
  return `${e.repo}@${e.commit}`;
}

// llm authority (one door to the GPU): reviews take the llm resource as the `ayin` authority per
// backlog batch via acquireLlm() (resource-client.ts) — gemma → qwen on gained, revert on release.
// BUSY (podcast render, code_agent) → reviews DEFER to a later poll; a background reviewer waits
// its turn, it never side-doors the GPU. No resource layer → best-effort on the served model.

// ── hook install ─────────────────────────────────────────────────────

async function installHook(repo: string): Promise<void> {
  const hooksDirRes = await git(repo, ['rev-parse', '--git-path', 'hooks']);
  if (!hooksDirRes.ok) throw new Error(`not a git repo: ${repo} (${hooksDirRes.stderr.trim()})`);
  const hooksDirRel = hooksDirRes.stdout.trim();
  const hooksDir = hooksDirRel.startsWith('/') ? hooksDirRel : join(repo, hooksDirRel);
  mkdirSync(hooksDir, { recursive: true });

  const hookPath = join(hooksDir, 'post-commit');
  const script = `#!/bin/sh
# ${HOOK_MARKER} — installed by \`ayin watch --repo ${repo}\`. Reinstalling overwrites this file.
# Appends this commit to the ayin-watch persistent queue. Never blocks the commit; if the
# daemon is down the queue just accumulates and is processed on its next boot.
QUEUE_DIR="$HOME/.ayin-cli/watch"
mkdir -p "$QUEUE_DIR" || exit 0
HASH=$(git rev-parse HEAD 2>/dev/null) || exit 0
printf '{"ts":%s,"repo":%s,"commit":"%s"}\\n' "$(date +%s)" '${JSON.stringify(repo)}' "$HASH" >> "$QUEUE_DIR/queue.jsonl"
exit 0
`;
  // NOTE: repo path is passed to printf as a %s ARG (not in the format string) so a '%' in the
  // path can't corrupt it. A single-quote in the path would still break the hook — install refuses
  // nothing there, but such paths are pathological; keep repos on sane paths.

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf-8');
    if (!existing.includes(HOOK_MARKER)) {
      throw new Error(
        `${hookPath} already exists and was not installed by ayin-watch — refusing to overwrite.\n` +
        `Add this line to it manually:\n` +
        `  printf '{"ts":%s,"repo":%s,"commit":"%s"}\\n' "$(date +%s)" '${JSON.stringify(repo)}' "$(git rev-parse HEAD)" >> "$HOME/.ayin-cli/watch/queue.jsonl"`,
      );
    }
  }
  writeFileSync(hookPath, script);
  chmodSync(hookPath, 0o755);

  // Register the repo (informational + lets us re-install hooks later).
  const repos = existsSync(REPOS_FILE) ? JSON.parse(readFileSync(REPOS_FILE, 'utf-8')) : {};
  repos[repo] = { hookPath, installedAt: new Date().toISOString() };
  writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));

  out(`hook installed: ${hookPath}`);
  log('INFO', 'watch_hook_installed', { repo, hookPath });
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
// (external, published on nukshare) turns it into a readable object-level report with full
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
      `fetch it from nukshare or set AYIN_UNITY_DIFF)_`;
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
  const files = numstat.split('\n').filter(Boolean).map(l => l.split('\t')[2] || '');
  return files.length > 0 && files.every(f => /(^|\/)(CodeReview|AssetDiff)-[0-9a-f]+\.md$/.test(f));
}

function buildReviewPrompt(meta: CommitMeta, diff: string, truncated: boolean, unityMd?: string | null): string {
  const catalog = SMELL_SIGNALS.map(s => `- **${s.name}** — ${s.hint}`).join('\n');
  const unitySection = unityMd
    ? `\n## Deterministic Unity asset diff (tool-generated, object-level — trust this over raw YAML)\n${unityMd}\n`
    : '';
  return `Review the following git commit. You are a rigorous senior code reviewer: concrete, specific, no filler. Judge ONLY what the diff shows (plus obvious implications for callers).${unitySection}

## Commit
- Subject: ${meta.subject}
- Author: ${meta.author} <${meta.email}>
- Files changed: ${meta.filesChanged}
${meta.body ? `- Message body:\n${meta.body}\n` : ''}
## Code-smell signal catalog
Score the diff against these typical signals:
${catalog}

## Diff${truncated ? ' (TRUNCATED — very large commit; review what is shown and flag the size itself under mixed-concerns if warranted)' : ''}
\`\`\`diff
${diff}
\`\`\`

## Output format — respond in MARKDOWN, exactly these sections:

## Summary
2-4 sentences: what the commit does and your overall assessment.

## Findings
One subsection per code-smell signal you actually observe, ordered by confidence descending, format:

### [signal-name] — confidence 0.NN
- **Where:** file and line/hunk from the diff
- **Why it matters:** the concrete failure or cost
- **Suggestion:** the fix, in one or two sentences

Confidence is YOUR certainty the smell is real and worth acting on (0.30 = plausible hunch, 0.60 = likely real, 0.85+ = certain). Do NOT list signals below 0.30 and do NOT invent findings to fill space — an empty findings list is a valid, good outcome. If none: write exactly "No significant smells detected."

## Verdict
One line: **LGTM** / **LGTM with nits** / **Needs attention** — plus one sentence of justification.`;
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

  // Unity repos only: deterministic object-level asset diff → its OWN file next to the review
  // (AssetDiff-<shortHash>.md), and fed to the reviewer as ground truth.
  const unityMd = await unityAssetDiff(repo, commit);
  let assetDiffPath: string | null = null;
  if (unityMd) {
    assetDiffPath = join(repo, `AssetDiff-${meta.shortHash}.md`);
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
    { role: 'system', content: 'You are a rigorous senior code reviewer. You respond in clean markdown, no preamble, no tool calls.' },
    { role: 'user', content: buildReviewPrompt(meta, diff, truncated, unityMd) },
  ]);

  const reportPath = join(repo, `CodeReview-${meta.shortHash}.md`);
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

${unityMd ? `## Deterministic Unity asset diff\n\n→ **[AssetDiff-${meta.shortHash}.md](AssetDiff-${meta.shortHash}.md)** (object-level change map; the reviewer below saw it)\n\n` : ''}---

`;
  writeFileSync(reportPath, header + review.trim() + '\n');
  out(`  → ${reportPath}`);
  log('INFO', 'watch_review_written', { repo, commit: meta.shortHash, report: reportPath });
  return { status: 'reviewed', note: reportPath };
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

let lastBusyLogAt = 0;
let activeHold: { release: () => Promise<void> } | null = null; // released on SIGTERM so a kill mid-batch doesn't strand the grant until TTL

async function processBacklog(retryState: Map<string, { attempts: number; nextTryAt: number }>): Promise<void> {
  const processed = new Set(readJsonl(PROCESSED_FILE).map(r => String(r.key)));
  const queue = readJsonl(QUEUE_FILE) as unknown as QueueEntry[];

  const pending = queue.filter(e => {
    if (!e.repo || !e.commit || processed.has(entryKey(e))) return false;
    const retry = retryState.get(entryKey(e));
    return !retry || Date.now() >= retry.nextTryAt;
  });
  if (pending.length === 0) return;

  // One door: take the llm resource as `ayin` for this batch (backend swaps gemma → qwen).
  const hold: LlmHold = await acquireLlm('ayin watch: commit review batch');
  if (hold === 'busy') {
    if (Date.now() - lastBusyLogAt > 60_000) {
      lastBusyLogAt = Date.now();
      out(`llm resource busy — ${pending.length} review(s) deferred until it frees`);
      log('INFO', 'watch_llm_busy_deferred', { pending: String(pending.length) });
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
  for (const entry of pending) {
    const key = entryKey(entry);
    const retry = retryState.get(key);

    try {
      const result = await reviewCommit(entry.repo, entry.commit);
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

  const retryState = new Map<string, { attempts: number; nextTryAt: number }>();
  out(`ayin watch daemon up (pid ${process.pid}) — queue: ${QUEUE_FILE}`);
  log('INFO', 'watch_daemon_up', { pid: String(process.pid), once: String(once) });

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
      await processBacklog(retryState);
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
