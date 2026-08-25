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
 * THREE RECORD KINDS, not two. A comment is answered by its OWN headless ayin (diff/runner.ts), and
 * that run talks while it works: every message it prints is appended here as a `note`. Notes are an
 * append, never a patch, because a patch merges a whole array and two writers would each overwrite the
 * other's notes — the run appends from its process while the session that spawned it appends from
 * another.
 *
 * ANCHORED BY TEXT, NOT ONLY BY NUMBER. The point of a comment is that the code changes in response to
 * it, and the fix moves every line below it. `lineNo` is where it was written; `lineText` is how the
 * re-rendered page finds it again. When neither matches, the thread is shown against the file with its
 * original coordinates rather than pinned to whatever line now holds that number — a comment attached
 * to the wrong line is worse than one attached to none.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../log.js';

export type CommentStatus = 'pending' | 'working' | 'done' | 'failed';

/** One thing the run said on its way to the answer. */
export interface CommentNote {
  at: string;
  text: string;
}

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
  /** Everything the run said before the reply, oldest first. Rendered small, under the question. */
  notes: CommentNote[];
  /** The headless run answering this. Checked with `kill(pid, 0)` — never trusted as a liveness claim. */
  pid: number;
  createdAt: string;
  startedAt: string;
  doneAt: string;
}

const DIFF_DIR = join(homedir(), '.ayin-cli', 'diffs');

function storePath(cwd: string): string {
  const key = createHash('sha1').update(cwd).digest('hex').slice(0, 12);
  return join(DIFF_DIR, `comments-${key}.jsonl`);
}

/**
 * A comment AS FOUND ON DISK. Notes and pid arrived after the first stores were written, so a record
 * from before them has neither field — the fold is the one place that can say so, and typing it here is
 * what stops every reader from having to.
 */
type StoredComment = Omit<DiffComment, 'notes' | 'pid'> & Partial<Pick<DiffComment, 'notes' | 'pid'>>;

type Record_ =
  | { t: 'new'; c: StoredComment }
  | { t: 'patch'; id: string; p: Partial<DiffComment> }
  | { t: 'note'; id: string; n: CommentNote };

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
    if (rec.t === 'new') byId.set(rec.c.id, { ...rec.c, notes: rec.c.notes ?? [], pid: rec.c.pid ?? 0 });
    else if (rec.t === 'note') {
      const cur = byId.get(rec.id);
      if (cur) byId.set(rec.id, { ...cur, notes: [...cur.notes, rec.n] });
    } else {
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
    notes: [], pid: 0,
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

/**
 * One thing the run said while it worked, straight into the thread.
 *
 * Appended by the RUN's own process (diff/runner.ts spawns it with `AYIN_DIFF_COMMENT_ID` set), which is
 * why it is a record kind rather than a patch: the session that spawned it is appending status patches
 * to the same file at the same time, and a patch carrying the whole array would drop whichever writer
 * read it first.
 */
export function addNote(cwd: string, id: string, text: string): void {
  const t = text.trim();
  if (!t) return;
  append(cwd, { t: 'note', id, n: { at: new Date().toISOString(), text: t } });
}

export function markFailed(cwd: string, id: string, error: string): void {
  patchComment(cwd, id, { status: 'failed', error, doneAt: new Date().toISOString() });
  log('WARN', 'diff_comment_failed', { id, error });
}

/**
 * Every thread, gone. What the red X on the page does.
 *
 * The FILE is removed, not rewritten empty: this store is append-only precisely so that no writer ever
 * has to hold the whole document, and truncating it in place would be the one read-modify-write in the
 * module. A run still talking to a deleted store simply recreates it with its own notes, which is the
 * honest outcome — a comment whose thread was cleared mid-answer has no thread to come back to.
 */
export function clearComments(cwd: string): number {
  const n = readComments(cwd).length;
  try { rmSync(storePath(cwd), { force: true }); }
  catch (e) { throw new Error(`could not clear the comment store — ${e instanceof Error ? e.message : String(e)}`); }
  log('INFO', 'diff_comments_cleared', { cwd, threads: String(n) });
  return n;
}

/**
 * Comments still owed an answer, whose run is GONE. Called at boot: a page polling a comment nothing
 * will ever finish spins forever, so those are failed loudly by name instead.
 *
 * The pid check is what keeps that from being a lie now that the answer is a separate process. A run
 * started by a session that has since exited is still working — killing its thread because its parent
 * died would fail an edit that is about to land. `kill(pid, 0)` is asked rather than the pid being
 * trusted: a pid recorded before a reboot names something else entirely, or nothing.
 */
export function reapAbandoned(cwd: string): number {
  let n = 0;
  for (const c of readComments(cwd)) {
    if (c.status !== 'pending' && c.status !== 'working') continue;
    if (c.pid && alive(c.pid)) continue;
    markFailed(cwd, c.id, 'the run answering this comment is gone — re-send it');
    n++;
  }
  return n;
}

/** Does this pid exist? Signal 0 tests, it does not deliver. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
