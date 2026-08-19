#!/usr/bin/env node
/**
 * check-jira — a ticket is reachable BY KEY, in one request, whatever the board says.
 *
 * `npm run check:jira` (needs a build). Hermetic: `fetch` is stubbed and the credential comes from the
 * environment, so this makes no network call and passes on a fresh clone with no Jira configured.
 *
 * WHAT IT PINS, and the failure each assertion comes from:
 *   · the agent can read a ticket at all. `jira` is `slashOnly` — an inner agentic loop the operator may
 *     run and the agent may not — and nothing replaced it, so a headless run had no way to read the
 *     ticket its task named. It worked from a paraphrase, or shelled out to `curl`.
 *   · sprint membership does not gate it. A coding agent's tickets are closed, someone else's, or two
 *     releases old; the board is context, never the guard.
 *   · a bare number is refused rather than guessed. `13492` exists in every project.
 *   · the API flavour is LEARNED. `issueDetail` read `apiVersion ?? '3'`, which is only correct after a
 *     search has already run — called first, on a Data Center site, its guess 404s and reads as "no such
 *     ticket".
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

// A credential that goes nowhere: every request below is answered by the stub.
process.env.JIRA_SITE = 'jira.example.net';
process.env.JIRA_TOKEN = 'not-a-real-token';
process.env.JIRA_EMAIL = 'someone@example.net';

/** Every request the code makes, so an assertion can be about the REQUESTS and not only the reply. */
let seen = [];
let answer = () => ({ status: 404 });
globalThis.fetch = async (url) => {
  seen.push(String(url));
  const r = answer(String(url));
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    json: async () => r.body,
  };
};

const issue = (key) => ({
  key,
  fields: {
    summary: 'Booster uses the wrong duration',
    status: { name: 'Done' },
    priority: { name: 'High' },
    issuetype: { name: 'Bug' },
    updated: '2026-02-01T10:00:00.000+0000',
    reporter: { displayName: 'A Reporter' },
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Use the config value.' }] }] },
    comment: { comments: [{ author: { displayName: 'A Dev' }, created: '2026-02-02T09:00:00.000+0000', body: 'agreed' }] },
  },
});

(await import(`file://${join(ROOT, 'dist', 'tool-wiring.js')}`)).ensureToolRuntime();
const { tool: jiraTicket } = await import(`file://${join(ROOT, 'dist', 'tools', 'defs', 'jira_ticket.js')}`);
const { tool: jira } = await import(`file://${join(ROOT, 'dist', 'tools', 'defs', 'jira.js')}`);
const { resetApiVersion, issuesByKeys } = await import(`file://${join(ROOT, 'dist', 'tools', 'connectors', 'jira', 'client.js')}`);
const { discoverTools } = await import(`file://${join(ROOT, 'dist', 'tools', 'loader.js')}`);

const fresh = () => { seen = []; resetApiVersion(); };

// ── the agent can reach it ────────────────────────────────────────────────────────

console.log('\nreachability (the gap: `jira` is slash-only, so the agent had nothing)');
ok(jira.slashOnly === true, 'the `jira` connector is still slash-only — an inner loop is not an agent tool');
ok(!jiraTicket.slashOnly, 'jira_ticket is NOT slash-only: it is in the model\'s catalogue');
const loaded = await discoverTools([]);
ok(loaded.tools.some((t) => t.name === 'jira_ticket'), 'and discovery finds it', `${loaded.tools.length} tools`);
ok(jiraTicket.parameters.length === 1 && jiraTicket.parameters[0].name === 'key',
  'one parameter, the key — nothing to compose, no JQL');

// ── one request, by key, no board ────────────────────────────────────────────────

console.log('\ndirect fetch (Cloud)');
fresh();
answer = (url) => (url.includes('/rest/api/3/issue/PROJ-1234') ? { status: 200, body: issue('PROJ-1234') } : { status: 404 });
const out = await jiraTicket.execute({ key: 'PROJ-1234' });
ok(seen.length === 1, 'exactly ONE request', `${seen.length}: ${seen.join(' ')}`);
ok(/\/rest\/api\/3\/issue\/PROJ-1234/.test(seen[0] ?? ''), 'a GET on the issue itself, not a search');
ok(!seen.some((u) => /search|sprint|board/.test(u)), 'no sprint, no board, no JQL — membership cannot gate it');
ok(/PROJ-1234 · Done · Bug\/High/.test(out), 'status, type and priority are rendered', out.split('\n')[0]);
ok(/Use the config value\./.test(out), 'the description arrives as text, not as ADF JSON');
ok(/A Dev \(2026-02-02\): agreed/.test(out), 'comments arrive with author and date');
fresh();
ok((await jiraTicket.execute({ key: 'proj-1234' })).includes('PROJ-1234'), 'a lowercase key is normalised');

// ── a bare number is refused, not guessed ───────────────────────────────────────

console.log('\nbare number (guessing a prefix fetches a DIFFERENT ticket that exists)');
fresh();
const bare = await jiraTicket.execute({ key: '13492' });
ok(/Error/.test(bare) && /PROJ-13492/.test(bare), 'refused, and the required shape is shown', bare.split('.')[0]);
ok(seen.length === 0, 'and nothing was requested — the refusal is deterministic');
fresh();
ok(/Error/.test(await jiraTicket.execute({ key: 'not a key' })), 'garbage is refused too');
ok(/Error/.test(await jiraTicket.execute({ key: '' })), 'a missing key is refused');
ok(seen.length === 0, 'still no request');

// ── the API flavour is learned, not guessed ─────────────────────────────────────

console.log('\nData Center (v3 does not exist there)');
fresh();
answer = (url) => (url.includes('/rest/api/2/issue/PROJ-77') ? { status: 200, body: issue('PROJ-77') } : { status: 404 });
const dc = await jiraTicket.execute({ key: 'PROJ-77' });
ok(/PROJ-77 · Done/.test(dc), 'the ticket resolves on the second flavour', dc.split('\n')[0]);
ok(seen.length === 2 && /api\/3/.test(seen[0]) && /api\/2/.test(seen[1]), 'v3 tried once, then v2', seen.join(' '));
const second = await jiraTicket.execute({ key: 'PROJ-77' });
ok(seen.length === 3 && /api\/2/.test(seen[2]), 'and the answer is remembered — no re-probe', seen[2]);
ok(/PROJ-77/.test(second), 'the remembered flavour still resolves');

// The two endpoints are versioned INDEPENDENTLY. A by-key fetch that succeeded on v3 must not pin the
// search path to v3 — an install exists where `/api/3/issue` serves and `/api/3/search/jql` does not, and
// pinning it there leaves search 404ing with nothing to fall back to.
console.log('\nthe issue flavour is learned SEPARATELY from the search flavour');
fresh();
answer = (url) => (url.includes('/rest/api/3/issue/') || url.includes('/rest/api/2/search')
  ? { status: 200, body: url.includes('issue') ? issue('PROJ-5') : { issues: [issue('PROJ-5')] } }
  : { status: 404 });
await jiraTicket.execute({ key: 'PROJ-5' });
seen = [];
const found = await issuesByKeys(['PROJ-5']);
ok(found.length === 1, 'a search still resolves after a by-key fetch', `${found.length} issue(s)`);
ok(seen.some((u) => /api\/3\/search/.test(u)) && seen.some((u) => /api\/2\/search/.test(u)),
  'and it still probes its OWN flavour rather than inheriting one', seen.join(' '));

// The learned flavour has nothing to retry, and that is exactly where the message regressed: a real
// probe of a nonexistent key returned Jira's raw `not found (HTTP 404): /rest/api/3/issue/X`, which reads
// as a broken endpoint rather than as a key that does not exist.
console.log('\nnot found on an ALREADY-LEARNED flavour');
seen = [];
answer = () => ({ status: 404 });
const goneLearned = await jiraTicket.execute({ key: 'PROJ-4242' });
ok(/does not exist/.test(goneLearned) && !/HTTP 404/.test(goneLearned),
  'the reply says what a 404 means, never the raw endpoint', goneLearned.trim());
ok(seen.length === 1, 'and the known flavour is not re-probed', String(seen.length));

console.log('\nnot found (both flavours 404)');
fresh();
answer = () => ({ status: 404 });
const missing = await jiraTicket.execute({ key: 'PROJ-9999' });
ok(/PROJ-9999/.test(missing) && /does not exist/.test(missing) && /cannot see it/.test(missing),
  'says both things a 404 can mean — a permission problem is not a missing ticket', missing.trim());
ok(seen.length === 2, 'after trying both flavours', String(seen.length));

console.log('\nrejected credential (must not look like a missing ticket)');
fresh();
answer = () => ({ status: 401 });
const denied = await jiraTicket.execute({ key: 'PROJ-1' });
ok(/rejected the credential/.test(denied) && /jira-auth/.test(denied), 'the token is named as the cause', denied.trim());
ok(seen.length === 1, 'and a 401 is not retried on the other flavour', String(seen.length));

console.log(fails ? `\njira check: ${fails} FAILURE(S)\n` : '\njira check: ok\n');
process.exit(fails ? 1 : 0);
