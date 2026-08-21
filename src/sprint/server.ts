/**
 * sprint/server.ts — the board as a route on the session's own loopback server.
 *
 * WHY SERVED AND NEVER A FILE. A board is live: cards move, comments arrive, and a comment POSTS to Jira.
 * A `file://` page cannot do the last one without CORS and a port baked into the HTML, and a snapshot of a
 * board is a board that is wrong by the time it is read. So `/sprint` re-fetches on every request — a
 * reload is how you see what changed — and there is no static fallback: no session, no page, said plainly.
 *
 * A POST HERE WRITES TO AN EXTERNAL SERVICE, in the operator's name, and cannot be taken back. Three
 * things hold: the socket is loopback-only (prompt-server.ts owns the bind), every non-GET is behind the
 * cross-origin refusal that guards the prompt editor, and the comment is refused unless it names a ticket
 * ON THE BOARD THAT WAS SERVED — a page cannot be talked into commenting on an arbitrary key.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { addComment, issueDetail } from '../tools/connectors/jira/client.js';
import { collectSprint } from './collect.js';
import { renderSprintPage } from './render.js';
import { log } from '../log.js';
import { appendTurn, chatPath, isTicketKey, parseTurns, readChat, threadBefore } from './chat.js';
import { renderWebMarkdown } from '../web-markdown.js';
import { prompts as promptService, packagePath } from '../prompts-service.js';

/** The sprint namespace's prompts. Registering twice is idempotent and returns the same bundle. */
const sprintPrompts = (): { get: (id: string, vars?: Record<string, string>) => string } =>
  promptService.register('sprint', packagePath('prompts', 'sprint')).bundle;

const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/**
 * The keys the last served board actually held. A comment or a detail fetch is only accepted for one of
 * these, so the page can only reach tickets the operator was already looking at.
 */
let served = new Set<string>();

/** For the gate, and for a session that never opened the board. */
export function servedKeys(): string[] {
  return [...served];
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req: IncomingMessage, limit = 32 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      // A comment is a sentence. Without a ceiling this is a memory sink reachable from any page.
      if (body.length > limit) { reject(new Error('comment body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function servePage(res: ServerResponse): Promise<void> {
  const board = await collectSprint();
  served = new Set(board.columns.flatMap((c) => c.issues.map((i) => i.key.toUpperCase())));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    // A cached board is a wrong board.
    'Cache-Control': 'no-store',
  });
  res.end(renderSprintPage(board));
}

async function postComment(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw) as Record<string, unknown>; }
  catch { json(res, 400, { error: 'body is not JSON' }); return; }

  const key = typeof b.key === 'string' ? b.key.trim().toUpperCase() : '';
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!KEY.test(key)) { json(res, 400, { error: `key: ${key || '(missing)'} is not a ticket key` }); return; }
  if (!text) { json(res, 400, { error: 'text: empty comment' }); return; }
  if (!served.has(key)) {
    json(res, 403, { error: `${key} is not on the board this page served — open /sprint again` });
    return;
  }

  try {
    const comment = await addComment(key, text);
    log('INFO', 'sprint_comment_posted', { key, chars: String(text.length) });
    json(res, 200, { comment });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('WARN', 'sprint_comment_failed', { key, error: msg });
    // 502: Jira refused, not the operator. The page prints this verbatim rather than "failed".
    json(res, 502, { error: msg });
  }
}

/** Returns true when the request was ours. Anything else falls through to the other routes. */
/**
 * How a ticket message reaches the agent. Wired by app.ts at boot; absent in any process with no TUI.
 *
 * The KEY travels with the prompt because the reply is written HERE-side, not by the agent: app.ts holds
 * the key until the turn ends and then appends the closing message to that ticket's thread. A prompt
 * alone would leave nothing to append it to.
 */
type ChatSubmit = (key: string, prompt: string) => void;
let chatSubmit: ChatSubmit | null = null;

export function wireSprintChat(fn: ChatSubmit): void {
  chatSubmit = fn;
}

export function sprintChatWired(): boolean {
  return chatSubmit !== null;
}

export async function handleSprintRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;

  if (path === '/sprint' && req.method === 'GET') {
    try { await servePage(res); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('WARN', 'sprint_page_failed', { error: msg });
      // The page IS the error — an operator who opened a browser must read why it is empty there, not
      // have to go back to the terminal for it.
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:28px;background:#0a0c12;color:#e6ebf5">`
        + `<h1 style="font-size:15px">sprint could not be read</h1><pre style="color:#f0666f;white-space:pre-wrap">${msg
          .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`
        + `<p style="color:#a3aec4">Run <code>/jira-auth</code> if the credential is the problem, then reload.</p></body>`);
    }
    return true;
  }

  if (path.startsWith('/api/sprint/ticket/') && req.method === 'GET') {
    const key = decodeURIComponent(path.slice('/api/sprint/ticket/'.length)).toUpperCase();
    if (!KEY.test(key)) { json(res, 400, { error: `${key} is not a ticket key` }); return true; }
    if (!served.has(key)) { json(res, 403, { error: `${key} is not on the board this page served` }); return true; }
    try { json(res, 200, await issueDetail(key)); }
    catch (e) { json(res, 502, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  // ── the agent thread for one ticket ────────────────────────────────────────
  // GET returns the raw markdown plus a version stamp, so the page can poll cheaply and re-render only
  // when the file actually grew — which is how the agent's reply appears without any status machinery.
  if (path.startsWith('/api/sprint/chat/') && req.method === 'GET') {
    const key = decodeURIComponent(path.slice('/api/sprint/chat/'.length)).toUpperCase();
    if (!isTicketKey(key)) { json(res, 400, { error: `not a ticket key: ${key}` }); return true; }
    try {
      const c = readChat(key);
      // Rendered HERE, with the same hardened renderer the diff replies use: the agent writes markdown
      // and a second renderer in the browser would be a second place for the escaping to be wrong.
      json(res, 200, {
        version: c.version,
        turns: parseTurns(c.text).map((t) => ({ who: t.who, when: t.when, html: renderWebMarkdown(t.body) })),
      });
    }
    catch (e) { json(res, 500, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  // POST appends what the operator said and hands the agent the ticket, the earlier turns AS TEXT and the
  // question. It is never given the thread path: the reply is appended by app.ts when the turn ends, so
  // the file has exactly one writer and a turn cannot land above the message that asked for it.
  if (path === '/api/sprint/chat' && req.method === 'POST') {
    try {
      if (!chatSubmit) {
        json(res, 503, { error: 'no interactive session is wired to take this' });
        return true;
      }
      const raw = await readBody(req);
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(raw) as Record<string, unknown>; } catch { /* guarded below */ }
      const key = String(b.key ?? '').toUpperCase();
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      if (!isTicketKey(key)) { json(res, 400, { error: `not a ticket key: ${key}` }); return true; }
      if (!text) { json(res, 400, { error: 'text: empty message' }); return true; }

      // Read the thread BEFORE the operator's turn goes in — it is the question, and it travels in COMMENT.
      const earlier = threadBefore(key);
      appendTurn(key, 'you', text);

      // The ticket is fetched fresh rather than taken from the page: the browser's copy is as old as
      // the last render, and the agent is about to reason about status and description.
      let issue: { key: string; title: string; status: string; description?: string } | null = null;
      try { issue = await issueDetail(key); } catch { /* unreachable Jira must not lose the message */ }

      const prompts = sprintPrompts();
      chatSubmit(key, prompts.get('chatTurn', {
        KEY: key,
        STATUS: issue?.status ?? '(status unavailable)',
        TITLE: issue?.title ?? '(title unavailable)',
        DESCRIPTION: (issue?.description ?? '(description unavailable)').slice(0, 8000),
        THREAD: earlier || '(nothing — this is the first message about this ticket)',
        COMMENT: text,
      }));
      json(res, 200, { ok: true, path: chatPath(key) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('WARN', 'sprint_chat_failed', { error: msg });
      json(res, 500, { error: msg });
    }
    return true;
  }

  if (path === '/api/sprint/comment' && req.method === 'POST') {
    try { await postComment(req, res); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('WARN', 'sprint_comment_post_failed', { error: msg });
      json(res, 400, { error: msg });
    }
    return true;
  }

  return false;
}
