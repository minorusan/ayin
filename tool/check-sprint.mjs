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

import { rmSync } from 'node:fs';
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

// ── the copy-link button, and the element change it forced ───────────────────────
//
// A card used to be a `<button>`. It now has to CONTAIN one, and a button inside a button is invalid
// HTML — the parser hoists the inner out of the outer, which wrecks the card's layout silently rather
// than failing anywhere a test would look. So the card is a div with role=button, and the keyboard
// path a real button gave for free is now ours to provide.

console.log('\ncopy-link');

const tkt = (k, t) => ({ key: k, title: t, issueType: 'Task', priority: 'High', updated: '2026-01-01', status: 'Open', statusCategory: 'To Do' });
const withSite = {
  me: 'me', browseBase: 'https://example.atlassian.net/browse', scope: 'S', generatedAt: '2026-01-01T00:00:00Z',
  total: 2, columns: [{ status: 'Open', category: 'To Do', issues: [tkt('AB-1', 'One'), tkt('AB-2', 'Two')] }],
};
const page = renderSprintPage(withSite);
const noSite = renderSprintPage({ ...withSite, browseBase: '' });

ok(!/<button class="card"/.test(page), 'a card is NOT a button — it has to contain one');
ok(/<div class="card" role="button" tabindex="0"/.test(page), 'it is a div with the button role and tab stop');
ok((page.match(/class="cp" data-url/g) || []).length === 2, 'one copy button per ticket');
ok(/data-url="https:\/\/example\.atlassian\.net\/browse\/AB-1"/.test(page),
  'the link is <site>/browse/<KEY>, built from the board not the renderer');
ok(/id="d-copy"/.test(page), 'the drawer carries one too');
ok(!/class="cp" data-url/.test(noSite),
  'no configured site → NO copy buttons, rather than one copying https://undefined/browse/KEY');
ok(/e\.stopPropagation\(\)/.test(page),
  'the click is stopped from bubbling — copying must not also open the drawer and fetch detail');
ok(/e\.key === 'Enter' \|\| e\.key === ' '/.test(page),
  'Enter and Space still open a card, since it is no longer a real button');

// The page's own script must parse: a template literal turns \n into a real newline, and one
// under-escaped sequence kills every interaction while the page still renders.
let sprintJsOk = false, sprintJsErr = '';
try { new Function(page.match(/<script>([\s\S]*?)<\/script>/)[1]); sprintJsOk = true; }
catch (e) { sprintJsErr = e.message; }
ok(sprintJsOk, 'the emitted page script parses', sprintJsErr);
ok(/id="refresh"/.test(page), 'and the refresh FAB is there');

// ── the agent thread: one markdown file per ticket ───────────────────────────────
//
// Deliberately NOT the diff comment store: no status machine, no poll for a payload. But BOTH turns are
// written by CODE — handing the model the path made it invent timestamps and insert its answer above the
// message that asked for it. What has to hold is the path guard, the turn split, that the prompt carries
// the ticket, the earlier turns and the question WITHOUT the path, and that a reply arriving with its own
// heading does not get a second one.

console.log('\nagent thread');

const chat = await import(`file://${join(ROOT, 'dist', 'sprint', 'chat.js')}`);

ok(chat.isTicketKey('AB-1') && chat.isTicketKey('PERF-13808'), 'a ticket key is accepted');
ok(!chat.isTicketKey('ab-1') && !chat.isTicketKey('../../etc') && !chat.isTicketKey(''),
  'lowercase, traversal and empty are not ticket keys');
let threw = false;
try { chat.chatPath('../../etc/passwd'); } catch { threw = true; }
ok(threw, 'chatPath THROWS on anything that is not a key — this value comes from a browser');
ok(chat.chatPath('AB-1').includes('.ayin-cli'),
  'the thread lives outside the repo: a discussion is not a change to the project');

// The split both writers must agree on, including the case where the agent forgets the heading.
const NL2 = String.fromCharCode(10);
const thread = [
  '', '## you · 2026-01-01T00:00:00Z', '', 'why two ids?', '',
  '## ayin · 2026-01-01T00:01:00Z', '', '## What I found', '', '- one prices', '',
].join(NL2);
const turns = chat.parseTurns(thread);
ok(turns.length === 2 && turns[0].who === 'you' && turns[1].who === 'ayin',
  'the thread splits into turns on the shared heading', turns.map((t) => t.who).join(','));
ok(turns[1].body.startsWith('## What I found'),
  "a heading INSIDE a turn is body, not a turn boundary — only 'you' and 'ayin' break it");
const orphan = chat.parseTurns('the agent forgot the heading');
ok(orphan.length === 1 && orphan[0].who === '',
  'prose with no heading is still a turn — losing an answer to bad formatting is the one failure this cannot afford');

// The routes, with the agent hook stubbed so nothing reaches a real session.
const srv = await import(`file://${join(ROOT, 'dist', 'sprint', 'server.js')}`);
let prompt = null;
let promptKey = null;
srv.wireSprintChat((k, p) => { promptKey = k; prompt = p; });
ok(srv.sprintChatWired(), 'the agent hook is wired');

const call = (method, path, body) => new Promise((resolve) => {
  const chunks = []; let status = 0; const L = {};
  const rq = { url: path, method, headers: { host: '127.0.0.1:1' }, on(e, f) { L[e] = f; }, destroy() {} };
  const rs = { writeHead(c) { status = c; }, end(b) { if (b) chunks.push(b); resolve({ status, body: chunks.join('') }); } };
  void srv.handleSprintRequest(rq, rs);
  if (body !== undefined) setImmediate(() => { L.data?.(Buffer.from(JSON.stringify(body))); L.end?.(); });
});

let cr = await call('GET', '/api/sprint/chat/..%2F..%2Fetc');
ok(cr.status === 400, 'a traversal key is refused by the route too', String(cr.status));
cr = await call('POST', '/api/sprint/chat', { key: 'AB-1', text: '' });
ok(cr.status === 400, 'an empty message is refused rather than waking the agent for nothing');

const KEY = 'ZZ-999';
cr = await call('POST', '/api/sprint/chat', { key: KEY, text: 'where is the counter read?' });
ok(cr.status === 200, 'a real message is accepted', cr.body.slice(0, 80));
ok(prompt !== null, 'and it reaches the agent');
ok(promptKey === KEY, 'with the ticket key alongside it — that is what the reply is appended to', String(promptKey));
ok(!prompt.includes(chat.chatPath(KEY)),
  'the prompt does NOT carry the thread path — a path the model never sees is a file it cannot corrupt');
ok(/where is the counter read/.test(prompt), 'it carries the question');
ok(prompt.includes(KEY), 'and the ticket key');
ok(/closing message IS the reply/.test(prompt), 'and says the closing message is the reply');
ok(/this is the first message about this ticket/.test(prompt),
  'an empty thread says so rather than leaving the earlier-turns block blank');

// The operator turn is already on disk before the agent is asked, so the page shows it immediately.
cr = await call('GET', `/api/sprint/chat/${KEY}`);
const got = JSON.parse(cr.body);
ok(got.turns.length >= 1 && got.turns[0].who === 'you', 'the message is already in the thread');
ok(got.version && got.version !== '0-0', 'and a version stamp is returned so the page can poll cheaply');
ok(/<p>/.test(got.turns[0].html), 'turns come back as rendered HTML, not raw markdown');

// The reply write app.ts performs when the turn ends: the heading and the clock are the code's, and a
// closing message that arrived wearing its own heading does not get nested under a second one.
chat.appendTurn(KEY, 'ayin', `## ayin \u00b7 2020-01-01T00:00:00Z${NL2}the counter is read in Foo.cs:12`);
const settled = chat.parseTurns(chat.readChat(KEY).text);
ok(settled.length === 2 && settled[1].who === 'ayin', 'the reply is one turn, appended at the END',
  settled.map((t) => t.who).join(','));
ok(settled[1].body === 'the counter is read in Foo.cs:12',
  'with the model\'s own heading stripped — code owns the heading', settled[1].body.slice(0, 40));
ok(settled[1].when !== '2020-01-01T00:00:00Z' && !Number.isNaN(Date.parse(settled[1].when)),
  'and a real timestamp rather than the one the model made up', settled[1].when);

// The earlier turns reach the next turn as TEXT, and the message being answered is not in them twice.
const earlier = chat.threadBefore(KEY);
ok(earlier.includes('where is the counter read') && earlier.includes('Foo.cs:12'),
  'threadBefore carries what was already said');
ok(chat.threadBefore(KEY, 40).startsWith('(earlier turns elided)'),
  'and clips the OLDEST end when the thread outgrows the budget');

rmSync(chat.chatPath(KEY), { force: true });

// ── live progress ────────────────────────────────────────────────────────────────
//
// A spinner cannot tell four seconds from four minutes, and the session already knows the answer —
// `setAgentState` carries `tool · Running grep(...)`. What has to hold: the recorder's clock is
// honest, the row is hidden until something is actually asked, and it STOPS. A progress row that
// keeps pulsing after the answer landed is worse than none, because it makes the answer look absent.

console.log('\nlive progress');

const act = await import(`file://${join(ROOT, 'dist', 'agent-activity.js')}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

act.noteAgentState('idle');
const turns0 = act.agentActivity().turns;
act.noteAgentState('thinking');
const t0 = act.agentActivity().since;
await sleep(25);
act.noteAgentState('thinking', 'Running grep(ScoringId)');
ok(act.agentActivity().since === t0,
  'the clock HOLDS across a label change — a tool label moves several times inside one phase, and resetting it would make a long wait look like a series of short ones');
ok(act.agentActivity().label === 'Running grep(ScoringId)', 'while the label is the new one');
await sleep(25);
act.noteAgentState('tool', 'Running read_file(x)');
ok(act.agentActivity().since > t0, 'and MOVES when the state changes');
ok(act.agentActivity().turns === turns0 + 1,
  'one turn was counted for the whole idle→active→… run, not one per state', String(act.agentActivity().turns));
act.noteAgentState('idle');
ok(act.agentActivity().state === 'idle' && act.agentActivity().label === '',
  'going idle clears the label rather than leaving the last tool call on screen forever');

// The page side. The row is markup plus a poll; both are in the emitted page.
ok(/id="d-prog"[^>]*hidden/.test(page),
  'the row ships HIDDEN — it appears when something was asked, not on every page load');
ok(/id="d-what"/.test(page) && /id="d-el"/.test(page),
  'and carries both slots: what the agent is doing, and how long it has been doing it');
ok(/fetch\('\/api\/agent\/state'\)/.test(page),
  'it reads the session\'s own state over a relative route — nothing about the port is baked in');
ok(/last\.who === 'ayin'\) stopProg\(\)/.test(page),
  'it STOPS when the answer lands — the same file-grew signal the thread already uses, not a second completion mechanism');
ok(/function stopChat\(\)[\s\S]{0,200}stopProg\(\)/.test(page),
  'and when the drawer closes, so a closed ticket leaves no timer running');
ok(/queued/.test(page) && /stalled/.test(page),
  'idle while we are still waiting says QUEUED rather than pulsing confidently — the turn is behind something else');
ok(/\.drawer\.open ~ \.fab\{display:none\}/.test(page),
  'the refresh FAB steps aside for an open drawer — it sat on top of the elapsed clock');

console.log(fails ? `\nsprint check: ${fails} FAILURE(S)\n` : '\nsprint check: ok\n');
process.exit(fails ? 1 : 0);
