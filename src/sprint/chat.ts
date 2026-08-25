/**
 * sprint/chat.ts — one markdown file per ticket, and that file IS the thread.
 *
 * EVERY TURN IS WRITTEN BY CODE. The operator's on the way in, and the run's — each message it prints,
 * then its closing one — from the run's own process: this module is the only writer of a thread file, so
 * a turn is always one heading, one real timestamp, and an append at the end. Handing the agent the PATH
 * and asking it to append was the first design and it failed exactly where a model fails — it invented
 * the timestamp, anchored a `str_replace` on the operator's turn and inserted its answer ABOVE the
 * message that asked for it, twice. The agent never learns the path now; earlier turns reach it as TEXT
 * (`threadBefore`), and its closing message is the reply.
 *
 * THREE WHOS, not two. `note` is something the run said on the way to the answer — shown small and quiet
 * — and `ayin` is the answer. A run cannot know which of its messages is the last one, so the mirror
 * holds each back until the next arrives (see app.ts `runHeadless`): whatever is still held when the run
 * ends IS the reply. That is what keeps the same sentence from landing twice under two different headings.
 *
 * Still deliberately NOT the diff comment store: no status machine and no reply payload, because a
 * ticket does not move under the discussion the way a diff does. The page polls a `size-mtime` stamp and
 * re-renders when the file grew.
 *
 * OUTSIDE THE REPO, always. `~/.ayin-cli/sprint/chat/` — a discussion about a ticket is not a change to
 * the project, and writing it into the working tree would put it in the next diff, the next commit and
 * eventually someone's review.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `PROJ-123`. Anything else is not a ticket and must not become a path. */
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;

export function isTicketKey(key: string): boolean {
  return KEY_RE.test(key);
}

function chatDir(): string {
  return join(homedir(), '.ayin-cli', 'sprint', 'chat');
}

/**
 * The thread file for a ticket.
 *
 * The key is validated by the caller and re-validated here before it becomes a filename: this value
 * arrives from a browser, and a path built from an unchecked string is the one bug in this file that
 * would matter.
 */
export function chatPath(key: string): string {
  const k = key.toUpperCase();
  if (!isTicketKey(k)) throw new Error(`not a ticket key: ${key}`);
  return join(chatDir(), `${k}.md`);
}

export interface ChatRead {
  /** Raw markdown, oldest first. Empty when no one has said anything yet. */
  text: string;
  /** Size and mtime, so the page can tell "changed" from "same" without diffing prose. */
  version: string;
}

export function readChat(key: string): ChatRead {
  const p = chatPath(key);
  if (!existsSync(p)) return { text: '', version: '0-0' };
  try {
    const st = statSync(p);
    return { text: readFileSync(p, 'utf-8'), version: `${st.size}-${Math.floor(st.mtimeMs)}` };
  } catch { return { text: '', version: '0-0' }; }
}

export interface ChatTurn { who: string; when: string; body: string }

/** Who wrote a turn. `note` is progress, `ayin` is the answer. */
export type ChatWho = 'you' | 'ayin' | 'note';

/**
 * Split the thread into turns on the heading both writers produce.
 *
 * Anything before the first heading is kept as a turn attributed to nobody rather than dropped: if the
 * agent ever appends without the heading, its answer must still be visible — losing prose because it
 * was formatted wrong is the one failure this file cannot afford.
 */
export function parseTurns(text: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const re = /^##\s+(you|ayin|note)\s+·\s+(\S+)\s*$/gm;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  let pending: { who: string; when: string } | null = null;
  while ((m = re.exec(text))) {
    const body = text.slice(lastEnd, m.index).trim();
    if (pending) turns.push({ ...pending, body });
    else if (body) turns.push({ who: '', when: '', body });
    pending = { who: m[1], when: m[2] };
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd).trim();
  if (pending) turns.push({ ...pending, body: tail });
  else if (tail) turns.push({ who: '', when: '', body: tail });
  return turns;
}

/**
 * Everything said before this turn, as text, tail-clipped.
 *
 * This is what replaces giving the agent the path. Read BEFORE the operator's turn is appended, so the
 * message being answered arrives once — as the question — rather than twice. The clip keeps the tail:
 * a long thread's last exchanges are what the new message is about, and the oldest turn is the one that
 * can be dropped without changing the answer.
 */
export function threadBefore(key: string, limit = 4000): string {
  const text = readChat(key).text.trim();
  if (text.length <= limit) return text;
  return `(earlier turns elided)\n\n${text.slice(text.length - limit)}`;
}

/**
 * Append one turn. The heading and the timestamp are ours in both directions.
 *
 * A closing message that arrives wearing its own `## ayin · …` heading is stripped of it rather than
 * nested under a second one: the model is told not to write headings, and this is what makes the file
 * one shape even when it does anyway.
 */
export function appendTurn(key: string, who: ChatWho, text: string): void {
  const p = chatPath(key);
  mkdirSync(chatDir(), { recursive: true });
  const body = text.replace(/^(?:\s*##\s+(?:you|ayin|note)\s+·\s+\S+[^\n]*\n)+/, '').trim();
  if (!body) return;
  appendFileSync(p, `\n## ${who} · ${new Date().toISOString()}\n\n${body}\n`);
}

/**
 * Every ticket thread, gone. What the red X on the board does.
 *
 * Only `*.md` in the chat directory — the run LOGS live beside it and are the only record of what a run
 * did, so clearing the conversation must not take the evidence with it. Returns how many threads died,
 * because a dialog that says "cleared" without a number cannot be checked.
 */
export function clearAllChats(): number {
  const dir = chatDir();
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    try { rmSync(join(dir, name), { force: true }); n++; }
    catch { /* already gone, or not ours to delete */ }
  }
  return n;
}
