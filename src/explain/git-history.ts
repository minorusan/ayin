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
  /**
   * Which of the paths handed in were touched most often, most-churned first — each with its OWN
   * earliest/latest commit date. This per-path range is what lets the writer tell a feature-specific
   * file from a widely-shared hub the feature merely calls into: a shared installer or central service
   * file will have a range stretching years further back than the rest of the evidence, and its full
   * history is NOT the feature's own history. Reproduced live, twice, against real features: the single
   * blended "earliest commit across everything" figure this replaced silently adopted a shared hub
   * file's ancient, unrelated commit as the feature's own origin date, reporting a feature as roughly
   * five years older than it actually was — its own dedicated files all began within one recent month,
   * confirmed by independent research before this fix.
   */
  churnByPath: Array<{ path: string; commits: number; earliestDate: string; latestDate: string }>;
  /** Who actually committed to these files, most commits first — the deterministic fact behind
   *  "developed mainly by X" in the narrative report; the writer is handed this instead of guessing
   *  authorship from skimming a commit list itself. */
  authorsByCommitCount: Array<{ author: string; commits: number }>;
}

export function computeBugSignal(history: GitHistoryResult): BugSignal {
  const bugfixCommits = history.commits.filter((c) => BUGFIX_RE.test(c.subject));
  const churnByPath = Object.entries(history.byPath)
    // `commits` is newest-first (git log's natural order): index 0 is the latest touch, the last
    // entry is the earliest ONE THIS PATH'S OWN CAPPED HISTORY REACHES — not necessarily the file's
    // true first commit if it exceeds `perPathCap`, but real evidence either way, never a guess.
    .map(([path, commits]) => ({
      path, commits: commits.length,
      earliestDate: commits.length ? commits[commits.length - 1].date : '',
      latestDate: commits.length ? commits[0].date : '',
    }))
    .sort((a, b) => b.commits - a.commits);

  // Authorship counts the FULL per-path history (deduped by hash), never `history.commits` — that list
  // is capped at `maxCommits` and sorted newest-first, so counting it answers "who committed here most
  // RECENTLY", not "who built this". The two diverge badly on any feature old enough to have accumulated
  // more than the cap since it was written: the original author's early work falls off the end of the
  // window and a later maintainer is reported as having "developed" it. Reproduced live against a real
  // feature — a true 18-vs-17 authorship lead flattened into a 17-vs-17 tie once capped, so consecutive
  // /explain runs on unchanged code named DIFFERENT primary authors, and the one who actually created
  // the feature (240+ commits under its original path) was not the one reported.
  const authorCounts = new Map<string, number>();
  const seenForAuthorship = new Set<string>();
  for (const commits of Object.values(history.byPath)) {
    for (const c of commits) {
      if (seenForAuthorship.has(c.hash)) continue;
      seenForAuthorship.add(c.hash);
      authorCounts.set(c.author, (authorCounts.get(c.author) ?? 0) + 1);
    }
  }
  const authorsByCommitCount = [...authorCounts.entries()]
    .map(([author, commits]) => ({ author, commits }))
    .sort((a, b) => b.commits - a.commits);

  return { bugfixCommits, churnByPath, authorsByCommitCount };
}

/** Render history + bug signal as plain text for the synthesis prompt — facts only, no opinions,
 *  same shape as `qa/probes.ts`'s `renderEvidence`. */
export function renderHistoryEvidence(history: GitHistoryResult, signal: BugSignal): string {
  const lines: string[] = [];
  lines.push(`COMMIT HISTORY (${history.commits.length} most recent commit(s) across these files, newest first —`);
  lines.push('a RECENT-ACTIVITY WINDOW, not the complete history: older commits fall off the end. Do NOT count');
  lines.push('authors or infer an origin date by reading this list — use the two measured sections below, which');
  lines.push('are computed across the full gathered history rather than this window):');
  for (const c of history.commits) lines.push(`  ${c.date}  ${c.hash.slice(0, 8)}  ${c.author.padEnd(20)}  ${c.subject}`);

  lines.push('');
  lines.push('AUTHORSHIP BY COMMIT COUNT (counted across the FULL gathered history of these files, not just the');
  lines.push('recent window above — attribute "developed mainly by" to whoever actually leads here, never a guess.');
  lines.push('If the top two are within a commit or two of each other, say it was a shared effort and name both');
  lines.push('rather than declaring a single primary author the numbers do not actually support):');
  for (const { author, commits } of signal.authorsByCommitCount) lines.push(`  ${commits} commit(s) — ${author}`);

  lines.push('');
  lines.push('CHURN BY FILE (most-touched first, each with its OWN earliest–latest commit date range — a measured');
  lines.push('fact, not a guess about fragility OR about when the feature began). READ THE RANGES BEFORE STATING AN');
  lines.push('ORIGIN DATE: a file whose range reaches much further back than the others is very likely a shared');
  lines.push('hub (an installer, a central game service) the feature was later wired into, not evidence the feature');
  lines.push('itself is that old — its full history belongs to everything else that ever touched it, not to this');
  lines.push('feature. Prefer the earliest date among files whose OWN range is closely scoped to when most of the');
  lines.push('listed churn actually happened; if every file\'s range agrees, that agreement is real evidence.');
  for (const { path, commits, earliestDate, latestDate } of signal.churnByPath) {
    lines.push(`  ${commits} commit(s) — ${path} (${earliestDate} to ${latestDate})`);
  }

  lines.push('');
  lines.push(signal.bugfixCommits.length
    ? `BUGFIX-LOOKING COMMITS (subject matched fix/bug/regression/crash/race/broken/revert/hotfix/workaround):`
    : 'BUGFIX-LOOKING COMMITS: none matched — do not invent a "this had bugs" narrative the evidence does not support.');
  for (const c of signal.bugfixCommits) lines.push(`  ${c.date}  ${c.hash.slice(0, 8)}  ${c.subject}`);

  return lines.join('\n');
}
