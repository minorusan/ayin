/**
 * diff/comments.ts — what the operator wrote on a line, and what came back.
 *
 * APPEND-ONLY, because the alternative loses comments. A read-modify-write JSON document has two
 * failure modes that both matter here: a second ayin session in the same repo overwrites the first
 * one's comment between its read and its write, and a power cut during the write leaves a truncated
 * document where the whole thread used to be. Records are appended instead — a creation, then one
 * patch per status change — and the current state is the fold of the file. An interrupted append
 * costs the last line, which the fold skips as unparseable; it never costs the thread.
 *
 * ONE FILE PER REPO (`comments-<key>.jsonl`, key = a hash of the repo path). A comment carries the cwd
 * it was written in and the server refuses one whose cwd is not its own session's: the page is served
 * by the session that owns the repo, and a comment reaching a DIFFERENT repo's agent would have it
 * edit files the reviewer never looked at.
 *
 * ANCHORED BY TEXT, NOT ONLY BY NUMBER. The point of a comment is that the code changes in response to
 * it, and the fix moves every line below it. `lineNo` is where it was written; `lineText` is how the
 * re-rendered page finds it again. When neither matches, the thread is shown against the file with its
 * original coordinates rather than pinned to whatever line now holds that number — a comment attached
 * to the wrong line is worse than one attached to none.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../log.js';

export type CommentStatus = 'pending' | 'working' | 'done' | 'failed';

export interface DiffComment {
  id: string;
  /** The repo this was written against. Checked on every submit — never trusted from the browser. */
  cwd: string;
  /** What the diff compared against (`HEAD`, `main`, …), so a reload re-renders the same comparison. */
  rev: string;
  file: string;
  side: 'old' | 'new';
  lineNo: number;
  lineText: string;
  text: string;
  status: CommentStatus;
  /** The agent's reply, once the turn that consumed this comment finished. */
  response: string;
  error: string;
  createdAt: string;
  startedAt: string;
  doneAt: string;
}

const DIFF_DIR = join(homedir(), '.ayin-cli', 'diffs');

function storePath(cwd: string): string {
  const key = createHash('sha1').update(cwd).digest('hex').slice(0, 12);
  return join(DIFF_DIR, `comments-${key}.jsonl`);
}

type Record_ =
  | { t: 'new'; c: DiffComment }
  | { t: 'patch'; id: string; p: Partial<DiffComment> };

function append(cwd: string, rec: Record_): void {
  mkdirSync(DIFF_DIR, { recursive: true });
  appendFileSync(storePath(cwd), `${JSON.stringify(rec)}\n`, 'utf-8');
}

/** Fold the log into current state. A half-written last line is skipped, never fatal. */
export function readComments(cwd: string): DiffComment[] {
  const p = storePath(cwd);
  if (!existsSync(p)) return [];
  const byId = new Map<string, DiffComment>();
  let broken = 0;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let rec: Record_;
    try { rec = JSON.parse(line) as Record_; } catch { broken++; continue; }
    if (rec.t === 'new') byId.set(rec.c.id, rec.c);
    else {
      const cur = byId.get(rec.id);
      if (cur) byId.set(rec.id, { ...cur, ...rec.p });
    }
  }
  // A skipped line is a real loss of information, however small. Say so once per read rather than
  // letting a truncated store look like a store with fewer comments in it.
  if (broken) log('WARN', 'diff_comments_unparseable', { file: p, lines: String(broken) });
  return [...byId.values()];
}

export function getComment(cwd: string, id: string): DiffComment | null {
  return readComments(cwd).find((c) => c.id === id) ?? null;
}

export interface NewComment {
  cwd: string;
  rev: string;
  file: string;
  side: 'old' | 'new';
  lineNo: number;
  lineText: string;
  text: string;
}

export function createComment(n: NewComment): DiffComment {
  const now = new Date().toISOString();
  const c: DiffComment = {
    id: `c-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    cwd: n.cwd, rev: n.rev, file: n.file, side: n.side, lineNo: n.lineNo,
    lineText: n.lineText, text: n.text,
    status: 'pending', response: '', error: '',
    createdAt: now, startedAt: '', doneAt: '',
  };
  append(c.cwd, { t: 'new', c });
  log('INFO', 'diff_comment_created', { id: c.id, file: c.file, line: String(c.lineNo) });
  return c;
}

export function patchComment(cwd: string, id: string, p: Partial<DiffComment>): void {
  append(cwd, { t: 'patch', id, p });
}

export function markWorking(cwd: string, id: string): void {
  patchComment(cwd, id, { status: 'working', startedAt: new Date().toISOString() });
  log('INFO', 'diff_comment_working', { id });
}

export function markDone(cwd: string, id: string, response: string): void {
  patchComment(cwd, id, { status: 'done', response, doneAt: new Date().toISOString() });
  log('INFO', 'diff_comment_done', { id, replyChars: String(response.length) });
}

export function markFailed(cwd: string, id: string, error: string): void {
  patchComment(cwd, id, { status: 'failed', error, doneAt: new Date().toISOString() });
  log('WARN', 'diff_comment_failed', { id, error });
}

/**
 * Comments still owed an answer. Called at boot: a session killed mid-turn leaves `working` records
 * that nothing will ever finish, and a page polling one of them would spin forever. They are failed
 * loudly instead, naming the reason, so the operator can re-send rather than wait on a dead turn.
 */
export function reapAbandoned(cwd: string): number {
  let n = 0;
  for (const c of readComments(cwd)) {
    if (c.status === 'pending' || c.status === 'working') {
      markFailed(cwd, c.id, 'the session that took this comment exited before the turn finished — re-send it');
      n++;
    }
  }
  return n;
}

/**
 * The id inside a marker, or null for an ordinary prompt. This is how a comment that was folded into an
 * already-running turn is recognised on its way through the queue — the prompt text is the only thing
 * that crosses that boundary.
 */
export function commentIdFromPrompt(text: string): string | null {
  const m = /^<comment-response\s+diffPath='[^']*'\s+id="(c-[0-9a-f]+)">/.exec(text);
  return m ? m[1] : null;
}

/** The prompt the agent actually receives. The marker is the contract with `prompts/ayin/system.txt`. */
export function commentPrompt(c: DiffComment, pageUrl: string): string {
  return `<comment-response diffPath='${pageUrl}' id="${c.id}">\n`
    + `${c.file}:${c.lineNo} (${c.side === 'old' ? 'removed' : 'current'} side of the diff)\n`
    + `${c.side === 'old' ? '-' : '+'} ${c.lineText}\n\n`
    + `${c.text}`;
}
