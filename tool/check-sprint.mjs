#!/usr/bin/env node
/**
 * check-sprint — the board, its cards, and the one route that WRITES.
 *
 * `npm run check:sprint` (needs a build). Hermetic: `fetch` is stubbed and the credential comes from the
 * environment, so nothing here reaches Jira and it passes on a clone with no Jira configured.
 *
 * The assertions are about the two things that cost real money to get wrong:
 *   · a ticket must not VANISH. Columns come from whatever statuses the site reports, because a workflow
 *     invents its own ("Ready For QA"), and a hardcoded column set drops the rest off the board silently.
 *   · a comment is a WRITE to an external service, in the operator's name, that cannot be taken back. It
 *     is refused for a key that was not on the served board, refused empty, sent in the body format the
 *     site's own flavour requires (ADF on v3, a plain string on v2), and reported to the page only after
 *     Jira confirmed it.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

process.env.JIRA_SITE = 'jira.example.net';
process.env.JIRA_TOKEN = 'not-a-real-token';
process.env.JIRA_EMAIL = 'someone@example.net';

let seen = [];
let answer = () => ({ status: 404 });
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
  const r = answer(String(url), init);
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
};

const issue = (key, status, category, title = 'a ticket') => ({
  key,
  fields: {
    summary: title,
    status: { name: status, statusCategory: { name: category } },
    priority: { name: 'High' },
    issuetype: { name: 'Bug' },
    updated: '2026-02-01T10:00:00.000+0000',
    reporter: { displayName: 'A Reporter' },
    description: 'plain text description',
    comment: { comments: [{ author: { displayName: 'A Dev' }, created: '2026-02-02T09:00:00.000+0000', body: 'agreed' }] },
    // The Sprint field, whose id the client looks up (`/rest/api/3/field`) and whose ACTIVE entry is what
    // makes an issue part of the current sprint. Without it the client keeps nothing, which is correct.
    customfield_1: [{ id: 5, name: 'Sprint 1', state: 'active', boardId: 9 }],
  },
});

const { toColumns } = await import(`file://${join(ROOT, 'dist', 'sprint', 'collect.js')}`);
const { renderSprintPage } = await import(`file://${join(ROOT, 'dist', 'sprint', 'render.js')}`);
const { handleSprintRequest, servedKeys } = await import(`file://${join(ROOT, 'dist', 'sprint', 'server.js')}`);
const { resetApiVersion } = await import(`file://${join(ROOT, 'dist', 'tools', 'connectors', 'jira', 'client.js')}`);

// ── columns ──────────────────────────────────────────────────────────────────────

console.log('\ncolumns (a status the code never heard of must still be a column)');
const cols = toColumns([
  { key: 'P-3', title: 'c', status: 'Ready For QA', statusCategory: 'In Progress', priority: 'Low', issueType: 'Bug', updated: '', reporter: '' },
  { key: 'P-1', title: 'a', status: 'Done', statusCategory: 'Done', priority: 'Low', issueType: 'Bug', updated: '', reporter: '' },
  { key: 'P-2', title: 'b', status: 'Open', statusCategory: 'To Do', priority: 'Low', issueType: 'Bug', updated: '', reporter: '' },
  { key: 'P-4', title: 'd', status: 'Weird', statusCategory: '', priority: 'Low', issueType: 'Bug', updated: '', reporter: '' },
]);
ok(cols.map((c) => c.status).join(' → ') === 'Open → Ready For QA → Done → Weird',
  'To Do → In Progress → Done, and an unknown bucket sorts LAST, not first',
  cols.map((c) => c.status).join(' → '));
ok(cols.reduce((n, c) => n + c.issues.length, 0) === 4, 'every ticket is on the board — nothing is dropped for having an odd status');

// ── the page ─────────────────────────────────────────────────────────────────────

console.log('\nthe page');
const board = {
  me: 'A Person', scope: 'Sprint 1 · board 9', generatedAt: '2026-02-03T11:22:33.000Z', total: 2,
  columns: toColumns([
    { key: 'P-1', title: 'closes </script><img src=x>', status: 'Open', statusCategory: 'To Do', priority: 'High', issueType: 'Bug', updated: '2026-02-01', reporter: '' },
    { key: 'P-2', title: 'second', status: 'Done', statusCategory: 'Done', priority: 'Low', issueType: 'Task', updated: '2026-02-02', reporter: '' },
  ]),
};
const html = renderSprintPage(board);
ok(/data-key="P-1"/.test(html) && /data-key="P-2"/.test(html), 'every ticket is a clickable card');
ok(!/<\/script><img/.test(html) && /&lt;\/script&gt;/.test(html),
  'a ticket title cannot close the page\'s script — every value goes through esc');
ok(/id="d-add"[^>]*>\+</.test(html), 'the comment section carries the + button');
ok(/\/api\/sprint\/comment/.test(html) && /\/api\/sprint\/ticket\//.test(html),
  'the page talks to relative routes — nothing about the port is baked in');
ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(html.replace(/https?:\/\/www\.w3\.org[^"']*/g, '')),
  'no external asset — the board opens on a machine with no network');
ok(/posted to/.test(html) && /confirmed|only now|server/i.test(html),
  'the client only shows a comment after the server confirmed it');
const emptyPage = renderSprintPage({ ...board, total: 0, columns: [] });
ok(/that is the board, not an error/i.test(emptyPage), 'an empty sprint says so, rather than looking broken');

// ── the routes ───────────────────────────────────────────────────────────────────

const req = (url, method = 'GET', body = null) => {
  const handlers = {};
  const r = {
    url, method, headers: { host: '127.0.0.1:1234' },
    on(ev, fn) { handlers[ev] = fn; return r; },
    destroy() {},
  };
  if (body !== null) {
    setImmediate(() => { handlers.data?.(Buffer.from(body)); handlers.end?.(); });
  }
  return r;
};
const res = () => {
  const out = { code: 0, headers: {}, body: '', headersSent: false };
  return Object.assign(out, {
    writeHead(code, headers) { out.code = code; out.headers = headers ?? {}; out.headersSent = true; },
    end(s) { out.body = s ?? ''; },
  });
};
const jsonOf = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };

console.log('\nGET /sprint');
seen = []; resetApiVersion();
answer = (url) => {
  if (url.includes('/myself')) return { status: 200, body: { displayName: 'A Person' } };
  if (url.includes('/field')) return { status: 200, body: [{ id: 'customfield_1', name: 'Sprint' }] };
  if (url.includes('/board')) return { status: 200, body: { values: [{ id: 9, name: 'b' }] } };
  if (url.includes('/sprint')) return { status: 200, body: { values: [{ id: 5, name: 'Sprint 1', state: 'active' }] } };
  if (url.includes('/search')) return { status: 200, body: { issues: [issue('P-1', 'Open', 'To Do'), issue('P-2', 'Done', 'Done')] } };
  if (/\/issue\/P-1\?/.test(url)) return { status: 200, body: issue('P-1', 'Open', 'To Do') };
  return { status: 404 };
};
let r = res();
let handled = await handleSprintRequest(req('/sprint'), r);
ok(handled && r.code === 200, 'the board is served', `handled=${handled} code=${r.code}`);
ok(r.headers['Cache-Control'] === 'no-store', 'and never cached — a cached board is a wrong board');
ok(servedKeys().sort().join(',') === 'P-1,P-2', 'the served keys are remembered', servedKeys().join(','));

console.log('\nGET /api/sprint/ticket/<KEY>');
r = res();
await handleSprintRequest(req('/api/sprint/ticket/P-1'), r);
ok(r.code === 200 && jsonOf(r).description === 'plain text description', 'a card on the board fetches its detail', String(r.code));
r = res();
await handleSprintRequest(req('/api/sprint/ticket/OTHER-9'), r);
ok(r.code === 403, 'a key that was NOT on the served board is refused — the page cannot reach arbitrary tickets', String(r.code));
r = res();
await handleSprintRequest(req('/api/sprint/ticket/nonsense'), r);
ok(r.code === 400, 'a malformed key is refused before any request', String(r.code));

console.log('\nPOST /api/sprint/comment (a write to an external service)');
seen = [];
answer = (url) => (/\/rest\/api\/3\/issue\/P-1\/comment/.test(url)
  ? { status: 200, body: { author: { displayName: 'A Person' }, created: '2026-02-03T00:00:00.000+0000', body: 'my comment' } }
  : { status: 404 });
r = res();
await handleSprintRequest(req('/api/sprint/comment', 'POST', JSON.stringify({ key: 'P-1', text: 'my comment' })), r);
ok(r.code === 200 && jsonOf(r).comment?.body === 'my comment', 'the comment is posted and returned from Jira\'s own answer', String(r.code));
const post = seen.find((s) => s.method === 'POST');
ok(post && /\/issue\/P-1\/comment$/.test(post.url), 'to the ticket\'s comment endpoint', post?.url ?? '(none)');
ok(post?.body?.body?.type === 'doc', 'as an ADF document on v3 — a plain string there is a 400, not a comment',
  JSON.stringify(post?.body ?? {}).slice(0, 90));

r = res();
await handleSprintRequest(req('/api/sprint/comment', 'POST', JSON.stringify({ key: 'P-1', text: '   ' })), r);
ok(r.code === 400, 'an empty comment is refused', String(r.code));
r = res();
await handleSprintRequest(req('/api/sprint/comment', 'POST', JSON.stringify({ key: 'OTHER-1', text: 'hi' })), r);
ok(r.code === 403, 'a ticket that was not on the board is refused — a page cannot be talked into commenting anywhere',
  String(r.code));
r = res();
seen = [];
await handleSprintRequest(req('/api/sprint/comment', 'POST', 'not json'), r);
ok(r.code === 400 && seen.length === 0, 'a malformed body is refused with no request made', String(r.code));

console.log('\nData Center: the body format follows the site');
resetApiVersion();
seen = [];
answer = (url) => {
  if (/\/rest\/api\/3\//.test(url)) return { status: 404 };
  if (/\/rest\/api\/2\/issue\/P-1\/comment/.test(url)) {
    return { status: 200, body: { author: { displayName: 'A Person' }, created: '2026-02-03', body: 'dc comment' } };
  }
  return { status: 404 };
};
r = res();
await handleSprintRequest(req('/api/sprint/comment', 'POST', JSON.stringify({ key: 'P-1', text: 'dc comment' })), r);
ok(r.code === 200, 'it lands on the second flavour', String(r.code));
const dcPost = seen.filter((s) => s.method === 'POST').pop();
ok(typeof dcPost?.body?.body === 'string', 'as a PLAIN STRING on v2 — ADF is refused there',
  JSON.stringify(dcPost?.body ?? {}).slice(0, 60));

console.log('\nJira down');
resetApiVersion();
answer = () => ({ status: 500 });
r = res();
await handleSprintRequest(req('/sprint'), r);
ok(r.code === 502 && /could not be read/.test(r.body), 'the PAGE carries the reason — the operator is in a browser, not the terminal',
  `${r.code} ${r.body.slice(0, 60)}`);
ok(/jira-auth/.test(r.body), 'and names the fix');

console.log(fails ? `\nsprint check: ${fails} FAILURE(S)\n` : '\nsprint check: ok\n');
process.exit(fails ? 1 : 0);
