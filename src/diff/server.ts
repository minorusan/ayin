/**
 * diff/server.ts — the review page as a route, not a file.
 *
 * WHY SERVED. The page used to be written to disk and opened as `file://`, which is right for a page
 * that only needs reading. The moment a line can be COMMENTED it stops being a document and becomes a
 * client, and a `file://` document is a bad client: its origin is `null`, so every POST needs CORS and
 * a preflight; it cannot know which of several ayin sessions to talk to, so the port has to be baked
 * into the HTML at render time; and a fix that changes the diff means a NEW file at a NEW path, so
 * "reload when done" becomes "navigate to a URL the page has to be told about".
 *
 * Serving it deletes all three. Relative `/api/…` goes back to the exact session that served the page,
 * so there is nothing to bake in and no cross-origin request to allow. The route RE-RENDERS from the
 * working tree on every request, so the URL is stable and "the fix landed" is `location.reload()`.
 *
 * The disk page stays for the case that has no session — `ayin diff` in a plain shell still writes a
 * self-contained file that works with no network, with the comment affordance absent rather than
 * broken. See diff/index.ts.
 *
 * WHAT THIS ENDPOINT IS. A POST here becomes an agent turn, and the agent runs shell commands. That is
 * a larger authority than the prompt editor it shares a port with, which is itself larger than it
 * looks. Two things hold: the socket is bound to loopback only (prompt-server.ts owns the bind), and a
 * comment is refused unless its `cwd` is this session's own — the page is served by the session that
 * owns the repo, so a comment arriving for a different tree is not a mistake to route around.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectDiff } from './collect.js';
import { renderDiffPage } from './render.js';
import { createComment, getComment, readComments } from './comments.js';
import { log } from '../log.js';

/** How a comment reaches the agent. Wired by app.ts at boot; absent in any process without a TUI. */
type Submit = (commentId: string, prompt: string) => void;
let submit: Submit | null = null;

export function wireDiffComments(fn: Submit): void {
  submit = fn;
}

export function diffCommentsWired(): boolean {
  return submit !== null;
}

/** A rev is operator input from a browser. execFileSync takes an argv array, so this is a sanity gate
 *  rather than a shell-injection one — but a rev that cannot be a rev should fail here, loudly, and
 *  not as a confusing git error three frames down. */
function validRev(rev: string): boolean {
  return rev.length > 0 && rev.length <= 200 && /^[A-Za-z0-9._/~^@{}-]+$/.test(rev);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      // A comment is a sentence, not an upload. Without a ceiling this is a memory sink reachable
      // by anything that can open a socket to loopback.
      if (body.length > limit) { reject(new Error('comment body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * The page. Re-collected per request — that is the whole point: after the agent edits a file, a plain
 * reload shows the new tree, with no path to publish and no cache to invalidate.
 */
function servePage(res: ServerResponse, cwd: string, rev: string): void {
  const set = collectDiff(cwd, rev);
  const html = renderDiffPage(set, {
    interactive: true,
    rev,
    comments: readComments(cwd),
  });
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    // The tree changes under this URL constantly; a cached copy of a review page is a wrong review.
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

async function postComment(req: IncomingMessage, res: ServerResponse, cwd: string, url: URL): Promise<void> {
  if (!submit) {
    json(res, 503, { error: 'no interactive session is wired to take comments in this process' });
    return;
  }
  const raw = await readBody(req);
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw) as Record<string, unknown>; }
  catch { json(res, 400, { error: 'body is not JSON' }); return; }

  // Fail loud on a bad shape, naming the field. A comment silently dropped because `lineNo` arrived as
  // a string is a comment the operator believes they sent.
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const file = typeof b.file === 'string' ? b.file : '';
  const lineNo = typeof b.lineNo === 'number' ? b.lineNo : NaN;
  const side = b.side === 'old' || b.side === 'new' ? b.side : null;
  const lineText = typeof b.lineText === 'string' ? b.lineText : '';
  const rev = typeof b.rev === 'string' && b.rev ? b.rev : 'HEAD';
  if (!text) { json(res, 400, { error: 'text: empty comment' }); return; }
  if (!file) { json(res, 400, { error: 'file: missing' }); return; }
  if (!Number.isInteger(lineNo) || lineNo < 1) { json(res, 400, { error: 'lineNo: expected a positive integer' }); return; }
  if (!side) { json(res, 400, { error: "side: expected 'old' or 'new'" }); return; }
  if (!validRev(rev)) { json(res, 400, { error: `rev: ${rev} cannot be a git rev` }); return; }

  const c = createComment({ cwd, rev, file, side, lineNo, lineText, text });
  // The page URL the agent is told about is the one that will show its work — same route, same rev.
  const pageUrl = `${url.origin}/diff?rev=${encodeURIComponent(rev)}`;
  const { commentPrompt } = await import('./comments.js');
  submit(c.id, commentPrompt(c, pageUrl));
  json(res, 200, { id: c.id, status: c.status });
}

/**
 * Returns true when the request was ours. Anything else falls through to the prompt editor's routes.
 */
export async function handleDiffRequest(req: IncomingMessage, res: ServerResponse, cwd: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;

  if (path === '/diff' && req.method === 'GET') {
    const rev = url.searchParams.get('rev') || 'HEAD';
    if (!validRev(rev)) { json(res, 400, { error: `rev: ${rev} cannot be a git rev` }); return true; }
    try { servePage(res, cwd, rev); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('WARN', 'diff_page_failed', { error: msg });
      json(res, 500, { error: msg });
    }
    return true;
  }

  if (path === '/api/diff/comment' && req.method === 'POST') {
    try { await postComment(req, res, cwd, url); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('WARN', 'diff_comment_post_failed', { error: msg });
      json(res, 400, { error: msg });
    }
    return true;
  }

  if (path.startsWith('/api/diff/comment/') && req.method === 'GET') {
    const id = decodeURIComponent(path.slice('/api/diff/comment/'.length));
    const c = getComment(cwd, id);
    if (!c) { json(res, 404, { error: `no comment ${id}` }); return true; }
    json(res, 200, { id: c.id, status: c.status, response: c.response, error: c.error });
    return true;
  }

  return false;
}
