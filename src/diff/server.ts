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
import { autoStage, safeRepoPath, stageOne, unstageOne } from './stage.js';
import { commitStaged, draftCommit, readCommitDraft, rephraseSubject } from '../commit-draft.js';
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
    // Re-read per request, from git, for the same reason the diff is re-collected: the operator may
    // have edited the message in their client since the last render, and a cached copy would show
    // them their own stale draft.
    commitDraft: readCommitDraft(cwd),
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
 * The index writes the page's buttons make.
 *
 * These are `git add` / `git restore --staged` on the session's OWN repo, reached from a page that
 * session served, over a socket bound to loopback (prompt-server.ts owns the bind). That is the same
 * envelope the comment route already runs in, and a smaller authority than it: a comment becomes an
 * agent turn that can run shell commands, whereas these two move the index and nothing else. Both are
 * reversible by the button beside them, and neither touches the working tree — `restore --staged`
 * specifically leaves the file on disk exactly as it is.
 *
 * The path is still validated. It arrives from a browser, and `git add -- <path>` with an unchecked
 * argument is how `--something` becomes a flag and `../..` becomes another repo.
 */
async function postIndex(req: IncomingMessage, res: ServerResponse, cwd: string, act: 'stage' | 'unstage'): Promise<void> {
  const raw = await readBody(req);
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw) as Record<string, unknown>; }
  catch { json(res, 400, { error: 'body is not JSON' }); return; }
  const path = typeof b.path === 'string' ? b.path : '';
  if (!path) { json(res, 400, { error: 'path: missing' }); return; }
  if (!safeRepoPath(cwd, path)) { json(res, 400, { error: `path: ${path} is not a file in this repo` }); return; }
  try {
    if (act === 'stage') stageOne(cwd, path); else unstageOne(cwd, path);
    json(res, 200, { path, act });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('WARN', 'diff_index_failed', { act, path, error: msg });
    json(res, 500, { error: msg });
  }
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

  if ((path === '/api/diff/stage' || path === '/api/diff/unstage') && req.method === 'POST') {
    const act = path.endsWith('/stage') ? 'stage' : 'unstage';
    try { await postIndex(req, res, cwd, act); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('WARN', 'diff_index_post_failed', { error: msg });
      json(res, 400, { error: msg });
    }
    return true;
  }

  // The project-type pass. Slower than the two above — it can spend a model call per changed `.cs` —
  // so it answers with the OUTCOME PER FILE rather than a count: the reason a file was NOT staged is
  // the half worth reading, and a bare "staged 7" throws it away.
  if (path === '/api/diff/autostage' && req.method === 'POST') {
    try {
      const { outcomes, policy } = await autoStage(cwd);
      json(res, 200, { policy, outcomes });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('WARN', 'diff_autostage_failed', { error: msg });
      json(res, 500, { error: msg });
    }
    return true;
  }

  // Drafting spends a model call and only when Jira confirmed a ticket, so it answers with WHY when it
  // declined — an operator who pressed a button and got nothing needs the reason, not a shrug.
  if (path === '/api/diff/draft' && req.method === 'POST') {
    try {
      const r = await draftCommit(cwd);
      json(res, 200, {
        drafted: r.drafted, text: r.text, why: r.why,
        tickets: r.ctx.tickets.map((t) => ({ key: t.key, status: t.status, title: t.title })),
        candidates: r.ctx.candidates,
        sessionTurns: r.ctx.session.turns.length,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('WARN', 'diff_draft_failed', { error: msg });
      json(res, 500, { error: msg });
    }
    return true;
  }

  // The one route here that creates history. Still inside the same envelope as the rest — loopback
  // bind, this session's own repo — and reversible with `git reset --soft HEAD~1`, which the reply
  // says out loud so the operator is not left guessing how to undo it.
  if (path === '/api/diff/commit' && req.method === 'POST') {
    try {
      // The page's fields, not the file: they are editable and the operator's edit must win.
      const raw = await readBody(req);
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(raw) as Record<string, unknown>; } catch { /* empty body → stored draft */ }
      const subject = typeof b.subject === 'string' ? b.subject.trim() : '';
      const body = typeof b.body === 'string' ? b.body.trim() : '';
      const message = subject ? (body ? `${subject}\n\n${body}\n` : `${subject}\n`) : '';
      const r = commitStaged(cwd, message);
      json(res, r.ok ? 200 : 400, { ok: r.ok, why: r.why, sha: r.sha });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('WARN', 'diff_commit_route_failed', { error: msg });
      json(res, 500, { error: msg });
    }
    return true;
  }

  if (path === '/api/diff/rephrase' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(raw) as Record<string, unknown>; } catch { /* no body — rephrase from scratch */ }
      const r = await rephraseSubject(cwd, typeof b.subject === 'string' ? b.subject : '');
      json(res, r.subject ? 200 : 400, { subject: r.subject, note: r.note, why: r.note });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('WARN', 'diff_rephrase_failed', { error: msg });
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
