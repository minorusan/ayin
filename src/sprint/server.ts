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
