/**
 * git-history — deterministic evidence-gathering for `/explain`. No LLM, no network; everything here
 * is either `git log` or a regex over its output, same "facts the judge/writer cannot get by reading"
 * philosophy as `qa/probes.ts`. The synthesis prompt is handed this instead of being asked to recall or
 * guess a feature's history.
 */

import { execFileSync } from 'node:child_process';
import { log } from '../log.js';

export interface GitCommit {
  hash: string;
  date: string;
  author: string;
  subject: string;
}

export interface GitHistoryResult {
  /** Merged across every path, deduped by hash, newest first, capped at `maxCommits`. */
  commits: GitCommit[];
  /** Per-path commit lists (each independently capped) — the raw material for the churn signal below;
   *  a file's real "how often was this touched" count would be wrong if read off the merged/capped list. */
  byPath: Record<string, GitCommit[]>;
}

const FIELD_SEP = '\x1f'; // unlikely to appear in an author name or subject line, unlike '|' or ','

function runGitLog(path: string, root: string, cap: number): GitCommit[] {
  let out: string;
  try {
    out = execFileSync(
      'git',
      ['log', '--follow', `--max-count=${cap}`, '--date=short', `--pretty=format:%H${FIELD_SEP}%ad${FIELD_SEP}%an${FIELD_SEP}%s`, '--', path],
      { cwd: root, timeout: 8000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
  } catch (err) {
    log('WARN', 'explain_git_log_failed', { path, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  return out.split('\n').filter(Boolean).map((line) => {
    const [hash, date, author, ...rest] = line.split(FIELD_SEP);
    return { hash, date, author, subject: rest.join(FIELD_SEP) };
  });
}

/**
 * `git log --follow` per path (so a rename doesn't truncate history at the rename commit), merged and
 * deduped by hash across paths, newest first. A path git doesn't recognize (outside the repo, or the
 * repo has no history yet) just contributes nothing — never throws the whole gather.
 */
export function gatherGitHistory(paths: string[], root: string, opts: { perPathCap?: number; maxCommits?: number } = {}): GitHistoryResult {
  const perPathCap = opts.perPathCap ?? 60;
  const maxCommits = opts.maxCommits ?? 40;

  const byPath: Record<string, GitCommit[]> = {};
  const merged = new Map<string, GitCommit>();
  for (const path of paths) {
    const commits = runGitLog(path, root, perPathCap);
    byPath[path] = commits;
    for (const c of commits) if (!merged.has(c.hash)) merged.set(c.hash, c);
  }

  const commits = [...merged.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, maxCommits);
  return { commits, byPath };
}

// ── ticket-key candidates (self-validated by the caller against Jira, never trusted alone) ──

/**
 * A generic `PROJECT-123` shape is NOT a reliable ticket signal on its own — it is structurally
 * identical to plenty of ordinary text a commit message might contain (hardware part numbers like
 * `KY-040`, spec names, version-ish strings). This function only extracts CANDIDATES; the caller
 * (`explain/index.ts`) validates each one against Jira and keeps only what Jira actually resolves.
 */
const TICKET_CANDIDATE_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

export function extractTicketCandidates(commits: GitCommit[], limit = 40): string[] {
  const found = new Set<string>();
  for (const c of commits) {
    for (const m of c.subject.matchAll(TICKET_CANDIDATE_RE)) {
      found.add(m[1]);
      if (found.size >= limit) return [...found];
    }
  }
  return [...found];
}

// ── bug/fragility signal — evidence, not an opinion the writer has to invent ──

const BUGFIX_RE = /\b(fix|fixes|fixed|bug|bugfix|regression|crash|race|broken|revert|hotfix|workaround)\b/i;

export interface BugSignal {
  bugfixCommits: GitCommit[];
  /** Which of the paths handed in were touched most often, most-churned first. */
  churnByPath: Array<{ path: string; commits: number }>;
  /** Who actually committed to these files, most commits first — the deterministic fact behind
   *  "developed mainly by X" in the narrative report; the writer is handed this instead of guessing
   *  authorship from skimming a commit list itself. */
  authorsByCommitCount: Array<{ author: string; commits: number }>;
}

export function computeBugSignal(history: GitHistoryResult): BugSignal {
  const bugfixCommits = history.commits.filter((c) => BUGFIX_RE.test(c.subject));
  const churnByPath = Object.entries(history.byPath)
    .map(([path, commits]) => ({ path, commits: commits.length }))
    .sort((a, b) => b.commits - a.commits);

  const authorCounts = new Map<string, number>();
  for (const c of history.commits) authorCounts.set(c.author, (authorCounts.get(c.author) ?? 0) + 1);
  const authorsByCommitCount = [...authorCounts.entries()]
    .map(([author, commits]) => ({ author, commits }))
    .sort((a, b) => b.commits - a.commits);

  return { bugfixCommits, churnByPath, authorsByCommitCount };
}

/** Render history + bug signal as plain text for the synthesis prompt — facts only, no opinions,
 *  same shape as `qa/probes.ts`'s `renderEvidence`. */
export function renderHistoryEvidence(history: GitHistoryResult, signal: BugSignal): string {
  const lines: string[] = [];
  lines.push(`COMMIT HISTORY (${history.commits.length} commit(s), newest first):`);
  for (const c of history.commits) lines.push(`  ${c.date}  ${c.hash.slice(0, 8)}  ${c.author.padEnd(20)}  ${c.subject}`);

  lines.push('');
  lines.push('AUTHORSHIP BY COMMIT COUNT (a measured fact — attribute "developed mainly by" to whoever actually leads here, never a guess):');
  for (const { author, commits } of signal.authorsByCommitCount) lines.push(`  ${commits} commit(s) — ${author}`);
  lines.push(history.commits.length ? `  Earliest commit in this evidence: ${history.commits[history.commits.length - 1].date} (${history.commits[history.commits.length - 1].author})` : '');

  lines.push('');
  lines.push(`CHURN BY FILE (most-touched first — a measured fact, not a guess about fragility):`);
  for (const { path, commits } of signal.churnByPath) lines.push(`  ${commits} commit(s) — ${path}`);

  lines.push('');
  lines.push(signal.bugfixCommits.length
    ? `BUGFIX-LOOKING COMMITS (subject matched fix/bug/regression/crash/race/broken/revert/hotfix/workaround):`
    : 'BUGFIX-LOOKING COMMITS: none matched — do not invent a "this had bugs" narrative the evidence does not support.');
  for (const c of signal.bugfixCommits) lines.push(`  ${c.date}  ${c.hash.slice(0, 8)}  ${c.subject}`);

  return lines.join('\n');
}
