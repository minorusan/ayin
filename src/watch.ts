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
  readdirSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { llmChat, refreshActiveModel } from './llm/manager.js';
import { connect, keliBaseUrl } from './connection.js';
import { acquireLlm, type LlmHold } from './resource-client.js';
import { log } from './log.js';

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

interface QueueEntry { ts: number; repo: string; commit: string; kind?: 'commit' | 'merge'; prev?: string }

function entryKey(e: { repo: string; commit: string; kind?: string }): string {
  // Commit keys stay `repo@commit` (back-compat with the existing ledger); a merge at the same
  // HEAD gets its own key so it can't be deduped against a commit review of that hash.
  return e.kind === 'merge' ? `${e.repo}@merge@${e.commit}` : `${e.repo}@${e.commit}`;
}

// llm authority (one door to the GPU): reviews take the llm resource as the `ayin` authority per
// backlog batch via acquireLlm() (resource-client.ts) — gemma → qwen on gained, revert on release.
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
  let reinstalled = 0, gone = 0;
  for (const repo of repos) {
    let wrote = false, missing = false;
    for (const { name, kind } of WATCH_HOOKS) {
      const paths = await hookPathFor(repo, name);
      if (!paths) { missing = true; break; }
      if (ensureOneHook(paths.hooksDir, paths.hookPath, repo, kind) === 'wrote') wrote = true;
    }
    if (missing) gone++;
    else if (wrote) reinstalled++;
  }
  if (reinstalled || gone) {
    out(`hook self-heal: ${reinstalled} repo(s) re-hooked, ${gone} missing — of ${repos.length} watched`);
    log('INFO', 'watch_hook_selfheal', { watched: String(repos.length), reinstalled: String(reinstalled), gone: String(gone) });
  }
}

// ── CLAUDE.md pointer ─────────────────────────────────────────────────
// After a report is written, upsert a fenced block in the repo-root CLAUDE.md listing the pending
// ayin reports, so Claude Code reads them next session. Managed region only — the rest is untouched;
// the file is created if absent. This block + ayin's report files are excluded from review + staging.

const CLAUDE_BEGIN = '<!-- ayin:reports:begin -->';
const CLAUDE_END = '<!-- ayin:reports:end -->';
const AYIN_REPORT_RE = /^(CodeReview-[0-9a-f]+|AssetDiff-[0-9a-f]+|AYIN-REPORT-[A-Za-z]+-.+)\.md$/;

function listRepoReports(repo: string): string[] {
  try {
    return readdirSync(repo)
      .filter(f => AYIN_REPORT_RE.test(f))
      .map(f => ({ f, m: statSync(join(repo, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 12)
      .map(x => x.f);
  } catch { return []; }
}

function upsertClaudeReports(repo: string): void {
  const reports = listRepoReports(repo);
  const body = reports.length
    ? reports.map(f => `- \`${f}\``).join('\n')
    : '- (none pending)';
  const block = `${CLAUDE_BEGIN}\n## ⚠ Ayin review notes — read before continuing\nAuto-generated by \`ayin watch\` (local review). Newest first; open the file for the findings.\n${body}\n${CLAUDE_END}`;
  const claudePath = join(repo, 'CLAUDE.md');
  let content = '';
  try { content = existsSync(claudePath) ? readFileSync(claudePath, 'utf-8') : ''; } catch { return; }
  if (content.includes(CLAUDE_BEGIN)) {
    const before = content.slice(0, content.indexOf(CLAUDE_BEGIN));
    const endIdx = content.indexOf(CLAUDE_END);
    const after = endIdx >= 0 ? content.slice(endIdx + CLAUDE_END.length) : '';
    content = `${before}${block}${after}`;
  } else {
    content = content.trim() ? `${content.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`;
  }
  try { writeFileSync(claudePath, content); } catch { /* read-only tree — skip */ }
}

// ── danger push ───────────────────────────────────────────────────────
// When a review flags something dangerous, ping the user's phone via the Maradel backend's FCM
// door (POST /api/push — the headless counterpart to the send_push tool; no TUI). On by default;
// set AYIN_WATCH_PUSH=0 to silence. Best-effort — a push failure never breaks a review.
const PUSH_ENABLED = process.env.AYIN_WATCH_PUSH !== '0';
function repoName(repo: string): string { return repo.split('/').filter(Boolean).pop() || repo; }

async function sendDangerPush(title: string, body: string): Promise<void> {
  if (!PUSH_ENABLED) return;
  try {
    const res = await fetch(`${keliBaseUrl()}/api/push`, {
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
  // Skip commits that only touch ayin's own artifacts (else committing a review triggers a review
  // of the review, forever): CodeReview-*, AssetDiff-*, AYIN-REPORT-*.md.
  const files = numstat.split('\n').filter(Boolean).map(l => l.split('\t')[2] || '');
  return files.length > 0 && files.every(f => /(^|\/)(CodeReview-[0-9a-f]+|AssetDiff-[0-9a-f]+|AYIN-REPORT-[A-Za-z]+-.+)\.md$/.test(f));
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

  // Review output dir — a folder if AYIN_REVIEW_DIR is set (absolute, or relative to the repo);
  // else the repo root (back-compat). Reports + asset diffs are written here together, so the
  // relative AssetDiff link in the review header still resolves.
  const reviewDir = process.env.AYIN_REVIEW_DIR
    ? (process.env.AYIN_REVIEW_DIR.startsWith('/') ? process.env.AYIN_REVIEW_DIR : join(repo, process.env.AYIN_REVIEW_DIR))
    : repo;
  if (reviewDir !== repo) mkdirSync(reviewDir, { recursive: true });

  // Unity repos only: deterministic object-level asset diff → its OWN file next to the review
  // (AssetDiff-<shortHash>.md), and fed to the reviewer as ground truth.
  const unityMd = await unityAssetDiff(repo, commit);
  let assetDiffPath: string | null = null;
  if (unityMd) {
    assetDiffPath = join(reviewDir, `AssetDiff-${meta.shortHash}.md`);
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

  const reportPath = join(reviewDir, `CodeReview-${meta.shortHash}.md`);
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
  upsertClaudeReports(repo);
  // Dangerous → ping the phone. "Needs attention" is the reviewer's bad verdict.
  if (/needs attention/i.test(review)) {
    await sendDangerPush(`⚠ Ayin: review flags ${repoName(repo)}`, `"${meta.subject}" (${meta.shortHash}) — Needs attention. See CodeReview-${meta.shortHash}.md`);
  }
  return { status: 'reviewed', note: reportPath };
}

// ── merge review (post-merge / pull) ─────────────────────────────────
// Explains what a pull/merge just brought in — the range prev(ORIG_HEAD)..HEAD — into
// AYIN-REPORT-MERGE-<hash>.md in the repo root (so it shows in the client + gets picked up by
// the CLAUDE.md pointer). Answers "what changed under me and what should I watch out for".

function buildMergePrompt(range: string, oneline: string, stat: string, diff: string, truncated: boolean): string {
  return `You are briefing a developer on what a \`git pull\`/merge just brought into their repo (range ${range}).
Be concrete and skimmable. Cover: (1) a 2-4 sentence summary of what was pulled; (2) the notable
changes grouped by area (features, fixes, refactors, deps, config/schema/protocol); (3) BREAKING or
risky changes to watch — API/signature/schema changes, migrations, config that must change, anything
that could break the puller's in-flight work; (4) any follow-up the developer likely needs to do
(reinstall deps, run migrations, re-check a contract). If nothing risky, say so plainly.

## Commits pulled
${oneline || '(none)'}

## Files changed
\`\`\`
${stat || '(none)'}
\`\`\`

## Diff${truncated ? ' (TRUNCATED — large merge; reason over the stat + what is shown)' : ''}
\`\`\`diff
${diff}
\`\`\`

Respond in clean markdown with sections: ## Summary · ## What changed · ## Watch out · ## Follow-ups.
END with a final line that is EXACTLY one of: \`VERDICT: RISKY\` (breaking/risky changes the puller must act on) or \`VERDICT: OK\`.`;
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
    { role: 'system', content: 'You brief developers on what a pull/merge changed. Clean markdown, no preamble, no tool calls.' },
    { role: 'user', content: buildMergePrompt(range, onelineRes.stdout.trim(), statRes.stdout.trim(), diff, truncated) },
  ]);

  const reportPath = join(repo, `AYIN-REPORT-MERGE-${meta.shortHash}.md`);
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
  upsertClaudeReports(repo);
  if (/^VERDICT:\s*RISKY/im.test(review)) {
    await sendDangerPush(`⚠ Ayin: risky pull in ${repoName(repo)}`, `${range} brought in breaking/risky changes — see AYIN-REPORT-MERGE-${meta.shortHash}.md`);
  }
  return { status: 'reviewed', note: reportPath };
}

// ── 10-min working-tree pass: autostage + smell review (the eGPU workhorse) ──
// Every 10 min, per watched repo, IF the working tree changed since last check: qwen reviews the
// unstaged work, stages what's meaningful + unstages debug/junk (NO commit, NO push), drafts a
// conventional-commit message into .git/COMMIT_EDITMSG, and writes AYIN-REPORT-SMELLS-<ts>.md
// (dangerous ad-hoc solutions, heavy violations, logging suggestions). So you open Fork to ready
// chores. Fingerprint (ayin's own artifacts + CLAUDE.md excluded) means it's near-free when idle.

const WORKTREE_REVIEW_MS = 10 * 60 * 1000;
const WORKTREE_STATE_FILE = join(WATCH_DIR, 'worktree-state.json');
const MAX_WORKTREE_DIFF = 80_000;
const MAX_STAGE_BYTES = 2 * 1024 * 1024; // never stage a file bigger than this (blobs/binaries)

// Never stage (secrets + ayin's own artifacts + CLAUDE.md pointer).
const SECRET_RE = /(^|\/)(\.env(\.[^/]+)?|[^/]*\.(pem|key|p12|pfx|keystore)|id_rsa|id_ed25519|[^/]*(secret|credential)[^/]*)$/i;
function isStageable(path: string): boolean {
  const base = path.split('/').pop() || path;
  if (AYIN_REPORT_RE.test(base)) return false;
  if (base === 'CLAUDE.md') return false;
  if (SECRET_RE.test(path)) return false;
  return true;
}

interface WorktreeState { [repo: string]: { fingerprint: string; at: number } }
function loadWorktreeState(): WorktreeState {
  try { return existsSync(WORKTREE_STATE_FILE) ? JSON.parse(readFileSync(WORKTREE_STATE_FILE, 'utf-8')) : {}; } catch { return {}; }
}
function saveWorktreeState(s: WorktreeState): void {
  try { writeFileSync(WORKTREE_STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* best effort */ }
}

// ayin's own outputs — excluded from the unstaged-change fingerprint (pathspec) so writing a report
// or the CLAUDE.md pointer never re-triggers the pass, and from staging (isStageable).
const AYIN_EXCLUDE_PATHSPEC = ['CLAUDE.md', 'AYIN-REPORT-*.md', 'CodeReview-*.md', 'AssetDiff-*.md']
  .map(p => `:(exclude,glob)${p}`).concat([':(exclude,glob)**/AYIN-REPORT-*.md', ':(exclude,glob)**/CodeReview-*.md']);

/** Fingerprint of the UNSTAGED work only — `git diff` (working tree vs index, NOT --cached) plus
 *  new untracked files — with ayin's own artifacts + CLAUDE.md excluded. So the big (LLM) review
 *  fires only when the user's unstaged changes actually change: staging/unstaging alone doesn't
 *  trip it, and the dog writing its own report/CLAUDE.md never re-triggers itself. */
async function worktreeFingerprint(repo: string): Promise<string> {
  const diff = await git(repo, ['diff', '--', '.', ...AYIN_EXCLUDE_PATHSPEC], 400_000);
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

const WORKTREE_SYS = 'You are a senior engineer triaging a teammate\'s uncommitted work. You respond with ONE json code block and nothing else.';
function buildWorktreePrompt(files: string[], status: string, diff: string, truncated: boolean): string {
  return `A developer has uncommitted changes. Decide what to STAGE vs leave unstaged, draft a commit
message, and review for dangerous code. Meaningful product/logic/test/doc changes → stage:true.
Debug scaffolding, stray prints/logs, commented-out experiments, throwaway/scratch files, editor
cruft → stage:false. When unsure, stage:false (safer).

## Changed files
${files.map(f => `- ${f}`).join('\n')}

## git status --porcelain
\`\`\`
${status.trim()}
\`\`\`

## Diff vs HEAD${truncated ? ' (TRUNCATED)' : ''}
\`\`\`diff
${diff}
\`\`\`

Respond with exactly one \`\`\`json block:
{
  "files": [{"path": "<repo-relative path from the list>", "stage": true|false, "reason": "<short>"}],
  "commit": {"type": "feat|fix|refactor|chore|docs|test|perf", "scope": "<area or empty>", "subject": "<imperative <=72 chars>", "body": "<1-4 lines: what & why; bullet points ok>"},
  "smells": [{"severity": "high|med|low", "where": "<file:line>", "issue": "<dangerous ad-hoc / heavy violation>", "fix": "<concrete fix>"}],
  "logging": ["<specific suggestion to improve logging/observability in these changes>"]
}
Include EVERY changed file in "files". Only list real smells (empty array if none). Keep it terse.`;
}

function buildSmellReport(plan: WorktreePlan | null, raw: string, applied: { staged: number; unstaged: number }): string {
  const when = new Date().toISOString();
  if (!plan) {
    return `# Ayin working-tree review — ${when}\n\n_(could not parse a staging plan from the model; no staging applied — raw output below)_\n\n${raw.trim()}\n`;
  }
  const staged = plan.files.filter(f => f.stage).map(f => `- \`${f.path}\`${f.reason ? ` — ${f.reason}` : ''}`).join('\n') || '- (none)';
  const skipped = plan.files.filter(f => !f.stage).map(f => `- \`${f.path}\`${f.reason ? ` — ${f.reason}` : ''}`).join('\n') || '- (none)';
  const smells = (plan.smells || []).length
    ? plan.smells!.map(s => `### [${s.severity || '?'}] ${s.where || ''}\n- **Issue:** ${s.issue || ''}\n- **Fix:** ${s.fix || ''}`).join('\n\n')
    : 'None flagged.';
  const logging = (plan.logging || []).length ? plan.logging!.map(l => `- ${l}`).join('\n') : '- (no suggestions)';
  const msg = plan.commit?.subject ? commitText(plan.commit) : '(none drafted)';
  return `# Ayin working-tree review — ${when}

_Applied: staged ${applied.staged}, unstaged ${applied.unstaged}. **No commit, no push** — review in your git client and commit when ready._

## Staged (meaningful)
${staged}

## Left unstaged (debug / junk / unsure)
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

async function reviewWorktree(repo: string): Promise<void> {
  const statusRes = await git(repo, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1']);
  const files = statusRes.stdout.split('\n').filter(Boolean).map(l => l.slice(3)).filter(isStageable);
  if (files.length === 0) return;

  let diff = (await git(repo, ['diff', 'HEAD'], MAX_WORKTREE_DIFF + 4096)).stdout;
  const truncated = diff.length > MAX_WORKTREE_DIFF;
  if (truncated) diff = diff.slice(0, MAX_WORKTREE_DIFF) + '\n\n… DIFF TRUNCATED …';

  out(`reviewing working tree of ${repo} (${files.length} files)…`);
  const raw = await llmChat([
    { role: 'system', content: WORKTREE_SYS },
    { role: 'user', content: buildWorktreePrompt(files, statusRes.stdout, diff, truncated) },
  ]);
  const plan = parseWorktreePlan(raw);

  let staged = 0, unstaged = 0;
  if (plan) {
    for (const f of plan.files) {
      if (!f.path || !isStageable(f.path)) continue;
      const abs = join(repo, f.path);
      if (f.stage) {
        try { if (existsSync(abs) && statSync(abs).size <= MAX_STAGE_BYTES && (await git(repo, ['add', '--', f.path])).ok) staged++; } catch { /* skip */ }
      } else {
        await git(repo, ['reset', '-q', 'HEAD', '--', f.path]); // unstage if staged; no-op otherwise
        unstaged++;
      }
    }
    if (plan.commit?.subject) {
      const gd = await absGitDir(repo);
      if (gd) { try { writeFileSync(join(gd, 'COMMIT_EDITMSG'), commitText(plan.commit)); } catch { /* skip */ } }
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = join(repo, `AYIN-REPORT-SMELLS-${ts}.md`);
  writeFileSync(reportPath, buildSmellReport(plan, raw, { staged, unstaged }));
  out(`  → ${reportPath} (staged ${staged}, unstaged ${unstaged}) — NO commit`);
  log('INFO', 'worktree_reviewed', { repo, staged: String(staged), unstaged: String(unstaged), parsed: String(!!plan) });
  upsertClaudeReports(repo);
  const high = (plan?.smells || []).filter(s => (s.severity || '').toLowerCase() === 'high');
  if (high.length) {
    const first = high[0];
    await sendDangerPush(
      `⚠ Ayin: ${high.length} dangerous issue${high.length > 1 ? 's' : ''} in ${repoName(repo)}`,
      `${first.where ? first.where + ': ' : ''}${first.issue || 'high-severity finding'} — see ${reportPath.split('/').pop()}`,
    );
  }
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
      try { await reviewWorktree(repo); }
      catch (err) { log('WARN', 'worktree_review_failed', { repo, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) }); }
      // Recompute AFTER staging (staging flips porcelain XY codes) so we don't re-trigger on our own work.
      state[repo] = { fingerprint: await worktreeFingerprint(repo), at: Date.now() };
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
