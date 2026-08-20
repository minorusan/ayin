/**
 * commit-draft.ts — the commit message, drafted from three sources that already exist on this machine.
 *
 * STAGED ONLY. Every git read here is `--cached`: `git commit` takes the index, so a message that
 * describes unstaged edits describes a commit that will not happen. On a Unity tree the unstaged half
 * is usually generated assets the operator deliberately left out, and naming them is worse than
 * silence. Nothing staged is a decline, not an empty message.
 *
 * THE EXPENSIVE HALF IS LAST. Everything that decides WHETHER to spend a model call is deterministic:
 * the staged files come from git, the ticket keys come from a regex over the branch name, the local
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
/** git's own subject convention, and what the page paints red past. */
export const SUBJECT_LIMIT = 50;
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
  /** STAGED paths only — the message describes what a commit would take, not what is lying around. */
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
  // THE INDEX, NOT THE WORKING TREE. `git commit` takes what is staged, so a message describing
  // unstaged edits describes a commit that will not happen — and on a Unity tree the unstaged half is
  // usually generated assets the operator deliberately left out. `--cached` everywhere below.
  const files = git(repo, ['diff', '--cached', '--name-only', '-M'])
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const session = readSession(repo, branch);
  const subjects = git(repo, ['log', '--format=%s', `-${RECENT_SUBJECTS}`]).split('\n').filter(Boolean);
  const added = git(repo, ['diff', '--cached', '--no-color'])
    .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));

  const candidates = candidatesFrom([branch, ...session.turns, ...subjects, ...added]);

  if (candidates.length === 0) {
    return { branch, files, session, candidates, tickets: [], jiraNote: 'no ticket key in the branch name, the session or the staged diff' };
  }
  const lookup = await jiraTickets(candidates);
  if (!lookup.ok) return { branch, files, session, candidates, tickets: [], jiraNote: lookup.reason };
  if (lookup.tickets.length === 0) {
    return { branch, files, session, candidates, tickets: [], jiraNote: `Jira resolved none of ${candidates.join(', ')} — a ticket SHAPE is not a ticket` };
  }
  return { branch, files, session, candidates, tickets: lookup.tickets, jiraNote: '' };
}

// ── the draft ────────────────────────────────────────────────────────────────────

/** One ticket the diff carries, with the changed files that prove it. */
export interface Carried {
  key: string;
  /** Cited paths, already filtered to ones actually in the diff. */
  files: string[];
  note: string;
}

export interface CommitDraft {
  type: string;
  scope: string;
  /** Jira-confirmed AND citing at least one changed file. */
  carries: Carried[];
  /** One sentence covering all the changes. No keys — those are prepended here. */
  summary: string;
  /** Changes belonging to no ticket. */
  other: string;
}

/**
 * `type(scope): KEY-1,KEY-2 - summary` + body — assembled HERE, not by the model.
 *
 * The shape is the operator's convention, so it is built deterministically: a model asked to format
 * its own subject drifts, and it drifted into a real defect — a per-ticket paragraph headed by an
 * EMPTY key, rendering as a line that began with a bare colon. Keys cannot be empty on this path
 * because the array is filtered before it gets here, and the separator only appears when at least one
 * key survives.
 */
export function draftText(d: CommitDraft): string {
  const keys = d.carries.map((c) => c.key).filter(Boolean);
  const scope = d.scope ? `(${d.scope})` : '';
  const lead = keys.length ? `${keys.join(',')} - ` : '';
  const head = `${d.type || 'chore'}${scope}: ${lead}${d.summary}`;
  // THE CITATION IS PRINTED, and that is the point. Semantic relevance cannot be checked in code —
  // measured twice, the model cited a real changed file and still wrote prose about code that was not
  // in it, so filtering on "the citation resolves" passed a false attribution. Printing the files
  // beside the claim makes a wrong one self-refuting to the reader instead of hidden from them.
  const paras = d.carries
    .filter((c) => c.key)
    .map((c) => `${c.key} (${c.files.join(', ')}): ${c.note}`.trim());
  if (d.other) paras.push(`Also: ${d.other}`);
  return paras.length ? `${head}\n\n${paras.join('\n\n')}\n` : `${head}\n`;
}

/**
 * Commit what is staged, with the message currently in COMMIT_EDITMSG.
 *
 * `--no-verify` is NOT passed: the repo's own hooks are the operator's, and skipping them from a
 * button is not this feature's call to make. `--only` is not passed either — the index is exactly
 * what the operator assembled, and re-deciding it here would defeat the per-file buttons.
 *
 * Refuses on an empty index rather than producing an empty commit, and refuses on an empty message
 * rather than committing a blank subject that someone has to amend.
 */
export function commitStaged(repo: string, message?: string): { ok: boolean; why: string; sha: string } {
  const staged = git(repo, ['diff', '--cached', '--name-only']).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!staged.length) return { ok: false, why: 'nothing staged', sha: '' };
  // THE CALLER'S TEXT WINS. The page's fields are editable, and committing the file when the operator
  // has rewritten the form would silently discard what they typed. The stored draft is only the
  // fallback for a caller with nothing to say.
  const msg = (message ?? '').trim() || readCommitDraft(repo);
  if (!msg) return { ok: false, why: 'no message given and no draft stored — draft one first', sha: '' };
  try {
    execFileSync('git', ['commit', '-F', '-'], {
      cwd: repo, input: `${msg}\n`, encoding: 'utf-8', stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string };
    const detail = String(err.stderr ?? (e instanceof Error ? e.message : e)).trim().split('\n').slice(-3).join(' ');
    log('WARN', 'diff_commit_failed', { repo, error: detail });
    return { ok: false, why: detail || 'git commit failed', sha: '' };
  }
  const sha = git(repo, ['rev-parse', '--short', 'HEAD']).trim();
  log('INFO', 'diff_committed', { repo, sha, files: String(staged.length) });
  return { ok: true, why: `${staged.length} file(s) committed as ${sha}`, sha };
}

/** Where git keeps the message it will prefill. */
export function commitMsgPath(repo: string): string | null {
  const dir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
  return dir ? join(dir, 'COMMIT_EDITMSG') : null;
}

/**
 * Rephrase the subject alone, against the staged diff, to fit the limit.
 *
 * Deliberately NOT a redraft: the description is where the operator's own words accumulate, and
 * rewriting those under them while they edit is the worst kind of helpful. The type, scope and every
 * ticket key are kept verbatim — the keys were Jira-confirmed when the draft was made, and
 * re-deriving them here could quietly drop one.
 */
export async function rephraseSubject(repo: string, subject: string): Promise<{ subject: string; note: string }> {
  const staged = git(repo, ['diff', '--cached', '--name-only', '-M'])
    .split('\n').map((l) => l.trim()).filter(Boolean);
  if (!staged.length) return { subject: '', note: 'nothing staged' };
  let diff = git(repo, ['diff', '--cached', '--no-color', '--no-ext-diff', '-M']);
  if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n[…diff truncated…]`;

  const content = draftPrompts.get('commitRephrase', {
    LIMIT: String(SUBJECT_LIMIT),
    SUBJECT: subject.trim() || '(none yet)',
    FILES: staged.map((f) => `- ${f}`).join('\n'),
    DIFF: diff || '(no textual diff)',
  });
  let raw = '';
  try { raw = await llmChat([{ role: 'user', content }], { declareTools: false }); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('WARN', 'commit_rephrase_failed', { error: msg });
    return { subject: '', note: `model call failed: ${msg}` };
  }
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return { subject: '', note: 'the model returned no JSON object' };
  let out: { subject?: string };
  try { out = JSON.parse(m[0]) as { subject?: string }; }
  catch { return { subject: '', note: 'the model returned unparseable JSON' }; }
  const next = (out.subject || '').trim().replace(/\.$/, '');
  if (!next) return { subject: '', note: 'the model returned no subject' };
  return {
    subject: next,
    note: next.length > SUBJECT_LIMIT
      ? `still ${next.length} characters — ${SUBJECT_LIMIT} is hard to reach with this many ticket keys`
      : `${next.length}/${SUBJECT_LIMIT}`,
  };
}

/**
 * Where ayin records WHICH HEAD its draft was written against.
 *
 * `.git/COMMIT_EDITMSG` is not ayin's file — git writes the message of every commit into it, including
 * ones made with `-m`. So "the file is non-empty" says nothing about whether a draft exists, and
 * treating it as one is a real bug that shipped for exactly one test: a fixture whose previous commit
 * message was still sitting there got committed a second time, message and all.
 *
 * A HEAD stamp is the right invariant, not a hash of the text. Hashing would call an operator's own
 * edit "not a draft" and throw their words away; HEAD moving means the message describes a commit that
 * has ALREADY been made, which is the only case that must be suppressed.
 */
function draftStampPath(repo: string): string | null {
  const dir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
  return dir ? join(dir, 'ayin-commit-draft.head') : null;
}

function headSha(repo: string): string {
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

/**
 * What `/diff` renders, and what Commit will use — read from git, never from a copy kept here.
 *
 * Null unless ayin wrote a draft against the CURRENT HEAD. Anything else in COMMIT_EDITMSG is git's
 * leftover from a commit already made, and showing it as a draft invites committing it twice.
 */
export function readCommitDraft(repo: string): string | null {
  const p = commitMsgPath(repo);
  const stamp = draftStampPath(repo);
  if (!p || !existsSync(p) || !stamp || !existsSync(stamp)) return null;
  try {
    if (readFileSync(stamp, 'utf-8').trim() !== headSha(repo)) return null;  // HEAD moved: already committed
    // git leaves its own comment lines in here; they are not part of a message.
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
  if (!ctx.files.length) return { drafted: false, text: '', ctx, why: 'nothing staged — a commit would take nothing' };
  if (!ctx.tickets.length) return { drafted: false, text: '', ctx, why: ctx.jiraNote };

  let diff = git(repo, ['diff', '--cached', '--no-color', '--no-ext-diff', '-M']);
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
  let parsed: { type?: string; scope?: string; summary?: string; other?: string; carries?: unknown[] };
  try { parsed = JSON.parse(m[0]) as typeof parsed; }
  catch { return { drafted: false, text: '', ctx, why: 'the model returned unparseable JSON' }; }
  if (!parsed.summary?.trim()) return { drafted: false, text: '', ctx, why: 'the model drafted no summary' };

  // TWO filters, and the second is the one that matters.
  //
  // Jira-confirmed is not enough: measured twice, the model read the scoring narrative out of the
  // SESSION — which describes work from earlier commits — and claimed tickets whose files this diff
  // never touched. Wording the instruction harder did not fix it. So a ticket must CITE a changed
  // file, and a citation that is not in the changed set drops the ticket with it. The same
  // anti-fabrication shape the hound uses: a claim that cannot point at something real is discarded
  // before anyone reads it, rather than requested politely.
  const confirmed = new Set(ctx.tickets.map((t) => t.key.toUpperCase()));
  const changed = new Set(ctx.files);
  const carries = (Array.isArray(parsed.carries) ? parsed.carries : [])
    .map((c) => {
      const o = (c ?? {}) as { key?: unknown; files?: unknown; note?: unknown };
      return {
        key: String(o.key ?? '').trim().toUpperCase(),
        files: Array.isArray(o.files) ? (o.files as unknown[]).map(String) : [],
        note: String(o.note ?? '').trim(),
      };
    })
    .filter((c) => confirmed.has(c.key))
    // Only the citations that are really in the diff survive, and a ticket with none left goes too.
    .map((c) => ({ ...c, files: c.files.map((f) => String(f).trim()).filter((f) => changed.has(f)) }))
    .filter((c) => c.files.length > 0);
  const dropped = (Array.isArray(parsed.carries) ? parsed.carries.length : 0) - carries.length;

  const text = draftText({
    type: (parsed.type || 'chore').trim(),
    scope: (parsed.scope || '').trim(),
    carries,
    summary: parsed.summary.trim().replace(/\.$/, ''),
    other: (parsed.other || '').trim(),
  });
  const p = commitMsgPath(repo);
  const stamp = draftStampPath(repo);
  if (p) {
    try {
      writeFileSync(p, text);
      // Stamped with the HEAD it describes, so the next commit makes it stale automatically.
      if (stamp) writeFileSync(stamp, `${headSha(repo)}\n`);
    } catch (e) { log('WARN', 'commit_draft_write_failed', { error: e instanceof Error ? e.message : String(e) }); }
  }
  log('INFO', 'commit_drafted', {
    repo, carried: carries.join(',') || '(none)', droppedUncited: String(dropped),
    confirmed: ctx.tickets.map((t) => t.key).join(','), files: String(ctx.files.length),
  });
  return { drafted: true, text, ctx, why: '' };
}
