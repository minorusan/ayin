/**
 * sprint/chat.ts — one markdown file per ticket, and that file IS the thread.
 *
 * DELIBERATELY NOT the diff comment store. That one tracks pending/working/done per comment, polls for
 * a response payload, and reattaches replies to a file and line — machinery a diff needs because the
 * thing being discussed moves under it. A ticket does not move. So the whole mechanism here is: append
 * what the operator said to `~/.ayin-cli/sprint/chat/<KEY>.md`, hand the agent that PATH plus the
 * ticket, and let it append its own answer with the file tools it already has.
 *
 * THE AGENT'S WRITE IS THE REPLY. Nothing marks a turn done, because nothing needs to: the page reads
 * the file, and when the file grows the answer is there. That removes the status machine, the poll for a
 * payload, and every way those two can disagree about whether a reply exists.
 *
 * OUTSIDE THE REPO, always. `~/.ayin-cli/sprint/chat/` — a discussion about a ticket is not a change to
 * the project, and writing it into the working tree would put it in the next diff, the next commit and
 * eventually someone's review.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * Split the thread into turns on the heading both writers produce.
 *
 * Anything before the first heading is kept as a turn attributed to nobody rather than dropped: if the
 * agent ever appends without the heading, its answer must still be visible — losing prose because it
 * was formatted wrong is the one failure this file cannot afford.
 */
export function parseTurns(text: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const re = /^##\s+(you|ayin)\s+·\s+(\S+)\s*$/gm;
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

/** Append one turn under a heading the agent is told to match, so both writers produce one shape. */
export function appendTurn(key: string, who: 'you' | 'ayin', text: string): void {
  const p = chatPath(key);
  mkdirSync(chatDir(), { recursive: true });
  const body = text.trim();
  if (!body) return;
  appendFileSync(p, `\n## ${who} · ${new Date().toISOString()}\n\n${body}\n`);
}
