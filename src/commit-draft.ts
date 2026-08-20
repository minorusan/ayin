/**
 * commit-draft.ts — the commit message, drafted from three sources that already exist on this machine.
 *
 * THE EXPENSIVE HALF IS LAST. Everything that decides WHETHER to spend a model call is deterministic:
 * the changed files come from git, the ticket keys come from a regex over the branch name, the local
 * Claude Code transcript and the diff, and each key is then CONFIRMED against Jira. Only if Jira
 * resolves at least one does a model get asked to write anything. So an unconfigured Jira, a branch
 * with no ticket in its name, or a session that never mentioned one all cost nothing at all.
 *
 * WHY A TICKET SHAPE IS NOT A TICKET. `PROJECT-123` is structurally identical to a hardware part
 * number (`KY-040`), a spec name or a version string — `explain/git-history.ts` says so where the
 * regex lives, and this reuses that regex rather than growing a second one. The keys here are
 * CANDIDATES until `jiraTickets()` says otherwise; a candidate Jira does not resolve never reaches
 * the prompt, so the draft cannot attribute work to a ticket nobody verified.
 *
 * WHY THE LOCAL CLAUDE SESSION. The diff says what changed; it cannot say why, and it cannot say what
 * is still missing. The operator already said both, out loud, while doing the work — in a transcript
 * sitting at `~/.claude/projects/<slug>/*.jsonl`. Reading it is a file read, not an integration.
 * Scoped to the CURRENT BRANCH and to non-sidechain human turns: a subagent's prompts are ayin's own
 * scaffolding, and another branch's session is another feature's reasoning.
 *
 * ONE SLOT, AND IT IS GIT'S. The draft is written to `.git/COMMIT_EDITMSG`, which `git commit` and
 * every git client already prefill from — so the draft arrives where the operator was going to type
 * anyway, and `/diff` reads it back from the same place instead of holding a copy.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { llmChat } from './llm/manager.js';
import { jiraTickets, type JiraTicketDetail } from './jira.js';
import { prompts, packagePath } from './prompts-service.js';
import { log } from './log.js';

const draftPrompts = prompts.register('watch', packagePath('prompts', 'watch')).bundle;

/** Human turns pulled from the transcript. Enough to carry intent, not enough to bury the diff. */
const MAX_SESSION_TURNS = 25;
const MAX_SESSION_CHARS = 6_000;
/** One turn, clipped — a pasted stack trace is not intent. */
const MAX_TURN_CHARS = 600;
/** Transcripts read per draft, newest first. */
const MAX_TRANSCRIPTS = 6;
/** Diff handed to the model. The subject comes from the shape of the change, not every line of it. */
const MAX_DIFF_CHARS = 18_000;
/** Ticket candidates carried to a Jira lookup. */
const MAX_CANDIDATES = 12;
/**
 * Recent commit subjects scanned for keys, and it is a RECENCY window on purpose.
 *
 * Measured on a real feature branch: scoping to the branch's own commits (merge-base..HEAD) sounded
 * right and was worse — 100 own commits yielded 14 keys, most of them finished work. The last handful
 * of subjects yielded exactly the tickets the uncommitted change belonged to. What is in flight is
 * near HEAD, not near the fork point.
 */
const RECENT_SUBJECTS = 8;

/**
 * The same shape `explain/git-history.ts` extracts, and deliberately the same regex source of truth.
 * Not exported from there because that module reaches git history; this needs the pattern alone.
 */
const TICKET_CANDIDATE_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

function git(repo: string, args: string[], maxBuffer = 8 * 1024 * 1024): string {
  try {
    return execFileSync('git', args, {
      cwd: repo, encoding: 'utf-8', maxBuffer, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return ''; }
}

// ── the local Claude Code transcript ─────────────────────────────────────────────

/** Claude Code's project directory name: the absolute repo path with every separator flattened. */
export function transcriptDir(repo: string): string {
  return join(homedir(), '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
}

export interface SessionRead {
  /** Human turns, oldest first. */
  turns: string[];
  /** Which transcript files were read, newest first. */
  files: string[];
}

/**
 * The operator's own words on THIS branch, newest transcripts first.
 *
 * Only `type: 'user'` records with a string content, `isSidechain` false and `isMeta` unset: a
 * sidechain is a subagent ayin spawned, and a meta record is harness bookkeeping. Neither is the
 * operator saying anything. Records also carry `gitBranch`, which is what scopes this to the feature
 * being committed rather than to everything ever done in the repo.
 */
export function readSession(repo: string, branch: string): SessionRead {
  const dir = transcriptDir(repo);
  if (!existsSync(dir)) return { turns: [], files: [] };
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => ({ n, at: (() => { try { return statSync(join(dir, n)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_TRANSCRIPTS)
      .map((x) => x.n);
  } catch { return { turns: [], files: [] }; }

  const turns: string[] = [];
  const files: string[] = [];
  for (const name of names) {
    let text = '';
    try { text = readFileSync(join(dir, name), 'utf-8'); } catch { continue; }
    const mine: string[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (d.type !== 'user' || d.isSidechain === true || d.isMeta === true) continue;
      if (branch && typeof d.gitBranch === 'string' && d.gitBranch && d.gitBranch !== branch) continue;
      const msg = d.message as { role?: string; content?: unknown } | undefined;
      if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') continue;
      const t = msg.content.trim();
      // A slash command or a harness-injected block is not the operator explaining their work.
      if (!t || t.startsWith('/') || t.startsWith('<')) continue;
      mine.push(t.length > MAX_TURN_CHARS ? `${t.slice(0, MAX_TURN_CHARS)}…` : t);
    }
    if (!mine.length) continue;
    files.push(name);
    turns.unshift(...mine);              // older file's turns go before the newer file's
    if (turns.length >= MAX_SESSION_TURNS) break;
  }
  return { turns: turns.slice(-MAX_SESSION_TURNS), files };
}

// ── deterministic gather ─────────────────────────────────────────────────────────

export interface DraftContext {
  branch: string;
  /** Changed paths, staged and unstaged, as git reports them. */
  files: string[];
  session: SessionRead;
  /** Ticket-shaped strings found, before validation. */
  candidates: string[];
  /** Only the ones Jira resolved. Empty means no model call is made. */
  tickets: JiraTicketDetail[];
  /** Why the Jira step produced nothing, when it produced nothing. Always reportable. */
  jiraNote: string;
}

function candidatesFrom(texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(TICKET_CANDIDATE_RE)) {
      found.add(m[1]);
      if (found.size >= MAX_CANDIDATES) return [...found];
    }
  }
  return [...found];
}

/**
 * Everything the draft needs, with no model involved.
 *
 * Candidates come from four places, cheapest first: the branch name (where a ticket key most often
 * lives), the operator's own turns this session, the last few commit subjects, and the diff's added
 * lines — a key mentioned in a comment or a test name counts.
 *
 * Measured on a real repo, three of those four found NOTHING and the commit subjects found everything:
 * the branch was `feature/solitairestreak/scoring`, the session turns never named a key, and the diff
 * carried none. A convention of putting keys in the subject is common enough that dropping this
 * source would have made the whole pipeline silent on the repo it was built for.
 */
export async function gatherDraftContext(repo: string): Promise<DraftContext> {
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const status = git(repo, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1']);
  const files = status.split('\n').filter((l) => l.length > 3).map((l) => l.slice(3));
  const session = readSession(repo, branch);
  const subjects = git(repo, ['log', '--format=%s', `-${RECENT_SUBJECTS}`]).split('\n').filter(Boolean);
  const added = git(repo, ['diff', 'HEAD', '--no-color'])
    .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));

  const candidates = candidatesFrom([branch, ...session.turns, ...subjects, ...added]);

  if (candidates.length === 0) {
    return { branch, files, session, candidates, tickets: [], jiraNote: 'no ticket key in the branch name, the session or the diff' };
  }
  const lookup = await jiraTickets(candidates);
  if (!lookup.ok) return { branch, files, session, candidates, tickets: [], jiraNote: lookup.reason };
  if (lookup.tickets.length === 0) {
    return { branch, files, session, candidates, tickets: [], jiraNote: `Jira resolved none of ${candidates.join(', ')} — a ticket SHAPE is not a ticket` };
  }
  return { branch, files, session, candidates, tickets: lookup.tickets, jiraNote: '' };
}

// ── the draft ────────────────────────────────────────────────────────────────────

export interface CommitDraft {
  type: string;
  scope: string;
  subject: string;
  body: string;
}

/** `type(scope): subject` + body — the text git will prefill. */
export function draftText(d: CommitDraft): string {
  const head = `${d.type || 'chore'}${d.scope ? `(${d.scope})` : ''}: ${d.subject}`;
  return d.body ? `${head}\n\n${d.body.trim()}\n` : `${head}\n`;
}

/** Where git keeps the message it will prefill. */
export function commitMsgPath(repo: string): string | null {
  const dir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
  return dir ? join(dir, 'COMMIT_EDITMSG') : null;
}

/** What `/diff` renders. Read from git, never from a copy this module keeps. */
export function readCommitDraft(repo: string): string | null {
  const p = commitMsgPath(repo);
  if (!p || !existsSync(p)) return null;
  try {
    // git leaves its own comment lines in here after a `git commit`; they are not a draft.
    const body = readFileSync(p, 'utf-8').split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
    return body || null;
  } catch { return null; }
}

export interface DraftResult {
  drafted: boolean;
  /** The message, when one was written. */
  text: string;
  ctx: DraftContext;
  /** Why nothing was drafted, when nothing was. Always worth showing. */
  why: string;
}

/**
 * Run the pipeline. A model is asked ONLY when Jira confirmed at least one ticket.
 *
 * The gate is deliberate and it is the whole cost story: without it every worktree pass on every
 * watched repo would spend a generation writing prose nobody asked for. With it, the spend is tied to
 * evidence that this change belongs to tracked work.
 */
export async function draftCommit(repo: string): Promise<DraftResult> {
  const ctx = await gatherDraftContext(repo);
  if (!ctx.files.length) return { drafted: false, text: '', ctx, why: 'working tree is clean' };
  if (!ctx.tickets.length) return { drafted: false, text: '', ctx, why: ctx.jiraNote };

  let diff = git(repo, ['diff', 'HEAD', '--no-color', '--no-ext-diff']);
  if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n[…diff truncated…]`;
  let session = ctx.session.turns.join('\n---\n');
  if (session.length > MAX_SESSION_CHARS) session = `[…earlier turns dropped…]\n${session.slice(-MAX_SESSION_CHARS)}`;

  const content = draftPrompts.get('commitDraft', {
    BRANCH: ctx.branch || '(detached)',
    TICKETS: ctx.tickets.map((t) => `- ${t.key} [${t.status}] ${t.title}`).join('\n'),
    SESSION: session || '(no local Claude session for this branch)',
    FILES: ctx.files.map((f) => `- ${f}`).join('\n'),
    DIFF: diff || '(no textual diff)',
  });

  let raw = '';
  try {
    // declareTools:false — this wants JSON back, not tool calls (see LlmChatOptions).
    raw = await llmChat([{ role: 'user', content }], { declareTools: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('WARN', 'commit_draft_failed', { error: msg });
    return { drafted: false, text: '', ctx, why: `model call failed: ${msg}` };
  }

  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return { drafted: false, text: '', ctx, why: 'the model returned no JSON object' };
  let parsed: Partial<CommitDraft>;
  try { parsed = JSON.parse(m[0]) as Partial<CommitDraft>; }
  catch { return { drafted: false, text: '', ctx, why: 'the model returned unparseable JSON' }; }
  if (!parsed.subject?.trim()) return { drafted: false, text: '', ctx, why: 'the model drafted no subject' };

  const text = draftText({
    type: (parsed.type || 'chore').trim(),
    scope: (parsed.scope || '').trim(),
    subject: parsed.subject.trim(),
    body: (parsed.body || '').trim(),
  });
  const p = commitMsgPath(repo);
  if (p) {
    try { writeFileSync(p, text); }
    catch (e) { log('WARN', 'commit_draft_write_failed', { error: e instanceof Error ? e.message : String(e) }); }
  }
  log('INFO', 'commit_drafted', { repo, tickets: ctx.tickets.map((t) => t.key).join(','), files: String(ctx.files.length) });
  return { drafted: true, text, ctx, why: '' };
}
