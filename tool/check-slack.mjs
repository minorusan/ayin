#!/usr/bin/env node
/**
 * check-slack — the guarantees the Slack connector is built on, exercised with no network.
 *
 * `npm run check:slack` (needs a build). Hermetic: `fetch` is stubbed and the credential comes from
 * the environment, so this makes no real network call and passes on a fresh clone with no Slack
 * configured. Mirrors `check-jira.mjs`'s shape.
 *
 * WHAT IT PINS, and the failure each assertion comes from:
 *   · READ-ONLY IS AN EXACT SET. `chat.postMessage` must not slip in behind `chat.`, and a write
 *     method must never reach `fetch` at all.
 *   · SLACK ANSWERS HTTP 200 WITH `{ok:false, error}` for nearly every failure. A caller checking only
 *     the HTTP status reports a dead token as "no results" — indistinguishable from a true negative.
 *   · A BOT TOKEN IS REFUSED TWICE: at `/slack-auth` time (before any network call — the prefix
 *     already says everything) and again at query time, if one is configured directly.
 *   · WIRE FORMAT MUST DECODE, or `<@U02P4BE6KA6>` reads as nobody.
 *   · `conversations.history` (newest-first) and `conversations.replies` (oldest-first) must both
 *     come out ASCENDING by `ts` — a blind `.reverse()` fixes one and presents the other backwards.
 *   · A CURSOR MUST BE ON THE FIRST LINE of a rendered block. Truncation for the prompt eats the end
 *     of a block first; a trailing cursor is exactly what that truncation would eat.
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

// A credential that goes nowhere real: every request is answered by the stub below.
process.env.SLACK_USER_TOKEN = 'xoxp-NOT-A-REAL-TOKEN-FIXTURE';
delete process.env.SLACK_TEAM_ID;

/** Every request made, so an assertion can be about the REQUEST and not only the reply. */
let seen = [];
/** `(url) => { status, body, headers? }` — the test sets this per-case. */
let answer = () => ({ status: 404, body: {} });
globalThis.fetch = async (url) => {
  seen.push(String(url));
  const r = answer(String(url));
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: { get: (name) => r.headers?.[name.toLowerCase()] ?? null },
    json: async () => {
      if (r.throwOnJson) throw new Error('not json');
      return r.body;
    },
  };
};
const fresh = () => { seen = []; };

(await import(`file://${join(ROOT, 'dist', 'tool-wiring.js')}`)).ensureToolRuntime();
const { tool: slack } = await import(`file://${join(ROOT, 'dist', 'tools', 'defs', 'slack.js')}`);
const { tool: slackAuth } = await import(`file://${join(ROOT, 'dist', 'tools', 'defs', 'slack_auth.js')}`);
const client = await import(`file://${join(ROOT, 'dist', 'tools', 'connectors', 'slack', 'client.js')}`);
const { configureSlack } = await import(`file://${join(ROOT, 'dist', 'tools', 'connectors', 'slack', 'auth.js')}`);
const { _internals: loopInternals } = await import(`file://${join(ROOT, 'dist', 'tools', 'connectors', 'slack', 'loop.js')}`);
const { discoverTools } = await import(`file://${join(ROOT, 'dist', 'tools', 'loader.js')}`);

// ── reachability ──────────────────────────────────────────────────────────────────

console.log('\nreachability (a connector is an agentic loop the OPERATOR runs, never the agent mid-turn)');
ok(slack.slashOnly === true, 'the `slack` connector is slash-only');
ok(slack.slash?.command === 'slack', 'reachable as /slack');
ok(slackAuth.slashOnly === true && slackAuth.slash?.secret === true, 'slack_auth is slash-only and its argument is a secret');
const loaded = await discoverTools([]);
ok(loaded.tools.some((t) => t.name === 'slack') && loaded.tools.some((t) => t.name === 'slack_auth'),
  'both are found by discovery', `${loaded.tools.length} tools total`);
ok(loaded.duplicates.length === 0, 'no name collision introduced');

// ── the allowlist is an EXACT set, never a prefix match ──────────────────────────

console.log('\nread-only allowlist (exact set, not a prefix)');
const EXPECTED = new Set([
  'auth.test', 'search.messages', 'search.files', 'conversations.list', 'conversations.history',
  'conversations.replies', 'conversations.info', 'conversations.members', 'users.conversations',
  'users.info', 'users.list', 'users.lookupByEmail', 'users.profile.get', 'files.list', 'files.info',
  'reactions.get', 'team.info',
]);
ok(client.ALLOWED.size === EXPECTED.size, `exactly ${EXPECTED.size} methods allowed`, `got ${client.ALLOWED.size}`);
ok([...EXPECTED].every((m) => client.ALLOWED.has(m)) && [...client.ALLOWED].every((m) => EXPECTED.has(m)),
  'the allowed set matches the specified set exactly');
ok(!client.ALLOWED.has('chat.postMessage'), 'chat.postMessage is not allowed');

console.log('\nwrite methods are refused before any network call');
fresh();
for (const method of ['chat.postMessage', 'chat.delete', 'conversations.create', 'files.upload', 'reactions.add', 'users.setPresence']) {
  let threw = false;
  try { await client.rawCall(method, {}); } catch (err) { threw = /READ-ONLY/.test(err.message); }
  ok(threw, `${method} is refused as READ-ONLY`);
}
ok(seen.length === 0, 'and NONE of them reached fetch', `${seen.length} request(s)`);

// ── {ok:false} is a thrown, DIAGNOSED error — never a swallowed empty result ─────

console.log('\nSlack HTTP-200-but-ok:false failures are mapped, not swallowed');
const asFail = (error, extra = {}) => ({ status: 200, body: { ok: false, error, ...extra } });

fresh();
answer = () => asFail('missing_scope', { needed: 'search:read', provided: 'channels:read' });
let msg = '';
try { await client.history('C1'); } catch (err) { msg = err.message; }
ok(/missing_scope/.test(msg) && /search:read/.test(msg) && /REINSTALL/.test(msg),
  'missing_scope names the needed scope and says REINSTALL', msg);

fresh();
answer = () => asFail('not_allowed_token_type');
try { await client.search('x'); } catch (err) { msg = err.message; }
ok(/not_allowed_token_type/.test(msg) && /USER token/.test(msg), 'not_allowed_token_type explains the bot-token limit', msg);

for (const code of ['invalid_auth', 'token_revoked', 'account_inactive']) {
  fresh();
  answer = () => asFail(code);
  try { await client.history('C1'); } catch (err) { msg = err.message; }
  ok(new RegExp(code).test(msg) && /dead/.test(msg), `${code} is reported as a dead token`, msg);
}

fresh();
answer = () => ({ status: 429, headers: { 'retry-after': '30' } });
try { await client.history('C1'); } catch (err) { msg = err.message; }
ok(/retry.after/i.test(msg) && /30/.test(msg), 'HTTP 429 reports the retry-after value', msg);

fresh();
answer = () => ({ status: 200, throwOnJson: true });
try { await client.history('C1'); } catch (err) { msg = err.message; }
ok(/non-JSON/.test(msg), 'a non-JSON 200 body is reported, not thrown as a generic parse error', msg);

fresh();
answer = () => asFail('some_new_code_slack_invents');
try { await client.history('C1'); } catch (err) { msg = err.message; }
ok(/some_new_code_slack_invents/.test(msg), "an unrecognised code is surfaced VERBATIM, never swallowed as 'no results'", msg);

// ── a bot token is refused twice: at auth time, and at query time ───────────────

console.log('\na bot token (xoxb-) is refused, never stored, never queried');
fresh();
const botAuth = await configureSlack('xoxb-NOT-A-REAL-TOKEN-FIXTURE');
ok(/BOT token/.test(botAuth) && /refused/.test(botAuth), 'auth-time refusal names it a bot token', botAuth.split('\n')[0]);
ok(seen.length === 0, 'and no network call was made to find that out — the prefix already says it', `${seen.length}`);

fresh();
const had = process.env.SLACK_USER_TOKEN;
process.env.SLACK_USER_TOKEN = 'xoxb-NOT-A-REAL-TOKEN-FIXTURE';
try { await client.search('x'); } catch (err) { msg = err.message; }
process.env.SLACK_USER_TOKEN = had;
ok(/BOT token/.test(msg), 'query-time refusal fires too, if a bot token is configured directly', msg);
ok(seen.length === 0, 'and again, no request was sent', `${seen.length}`);

// ── wire format decodes, or a ping reads as a raw id ─────────────────────────────

console.log('\nwire format decoding');
client._internals.userNames.set('U100', 'Alice');
client._internals.channelNames.set('C200', 'general');
ok(client.readable('<@U100> hi') === '@Alice hi', 'a resolved mention becomes @name');
ok(client.readable('<@U999> hi') === '@U999 hi', 'an unresolved mention keeps the raw id, not nothing');
ok(client.readable('<!here> now') === '@here now', '<!here> decodes');
ok(client.readable('<!channel>') === '@channel', '<!channel> decodes');
ok(client.readable('<!subteam^S1|@qa> check') === '@qa check', 'a subteam mention uses its label');
ok(client.readable('<#C300|eng>') === '#eng', 'a channel ref with a name uses the name');
ok(client.readable('<#C200|>') === '#general', 'a channel ref with NO inline name falls back to the cache — ids can be C/G/D, not only C');
ok(client.readable('<https://x.example/doc|Docs>') === 'Docs (https://x.example/doc)', 'a labelled link becomes "label (url)"');
ok(client.readable('<https://x.example/doc>') === 'https://x.example/doc', 'a bare link is unwrapped');
ok(client.readable('a &amp;&lt;b&gt;') === 'a &<b>', 'entities decode');
const ids = client._internals.idsIn([{ user: 'U1', text: 'ping <@U2> and <@U3>' }]);
ok(ids.length === 3 && ids.includes('U1') && ids.includes('U2') && ids.includes('U3'),
  'idsIn collects the AUTHOR and every id mentioned in the text', ids.join(','));

// ── ascending ts, whichever order the endpoint used ──────────────────────────────

console.log('\nchronological ordering');
const newestFirst = [{ ts: '3' }, { ts: '2' }, { ts: '1' }]; // conversations.history shape
const oldestFirst = [{ ts: '1' }, { ts: '2' }, { ts: '3' }]; // conversations.replies shape
const a = client.chronological(newestFirst).map((m) => m.ts);
const b = client.chronological(oldestFirst).map((m) => m.ts);
ok(a.join(',') === '1,2,3', 'newest-first input comes out ascending', a.join(','));
ok(b.join(',') === '1,2,3', 'oldest-first input stays ascending — not reversed a second time', b.join(','));

// ── the cursor/page is on the FIRST line of every rendered block ────────────────

console.log('\ncursor/page-in-the-header (truncation eats the END of a block first)');

fresh();
answer = (url) => (url.includes('conversations.history')
  ? { status: 200, body: { ok: true, messages: [{ ts: '1', user: 'U1', text: 'hi' }], has_more: true, response_metadata: { next_cursor: 'CURSOR_ABC' } } }
  : { status: 404, body: {} });
let out = await loopInternals.runCommand('read C0123');
ok(out.split('\n')[0].includes('CURSOR_ABC'), 'read: the cursor is in line 1, not buried in the body', out.split('\n')[0]);

fresh();
answer = (url) => (url.includes('conversations.replies')
  ? { status: 200, body: { ok: true, messages: [{ ts: '1', user: 'U1', text: 'hi' }], has_more: true, response_metadata: { next_cursor: 'CURSOR_XYZ' } } }
  : { status: 404, body: {} });
out = await loopInternals.runCommand('thread C0123 1699999999.000100');
ok(out.split('\n')[0].includes('CURSOR_XYZ'), 'thread: same rule', out.split('\n')[0]);

fresh();
answer = (url) => (url.includes('users.conversations')
  ? { status: 200, body: { ok: true, channels: [{ id: 'C1', name: 'general' }], response_metadata: { next_cursor: 'CURSOR_CH' } } }
  : { status: 404, body: {} });
out = await loopInternals.runCommand('channels');
ok(out.split('\n')[0].includes('CURSOR_CH'), 'channels: same rule', out.split('\n')[0]);

fresh();
answer = (url) => (url.includes('search.messages')
  ? { status: 200, body: { ok: true, messages: { total: 45, pagination: { page: 1, page_count: 3 }, matches: [] } } }
  : { status: 404, body: {} });
out = await loopInternals.runCommand('search "site is down"');
ok(/page 1\/3/.test(out.split('\n')[0]) && /page=2/.test(out.split('\n')[0]),
  'search: page AND the next-page hint are both in line 1', out.split('\n')[0]);

// ── SLACK_TEAM_ID rides only on search.*, per Enterprise Grid ────────────────────

console.log('\nSLACK_TEAM_ID is added to search.* calls only');
process.env.SLACK_TEAM_ID = 'T0EG1234';
fresh();
answer = () => ({ status: 200, body: { ok: true, messages: { total: 0, matches: [] } } });
await client.search('x');
ok(seen.some((u) => /team_id=T0EG1234/.test(u)), 'search.messages carries team_id', seen.join(' '));
fresh();
answer = () => ({ status: 200, body: { ok: true, messages: [] } });
await client.history('C1');
ok(!seen.some((u) => /team_id=/.test(u)), 'conversations.history does NOT', seen.join(' '));
delete process.env.SLACK_TEAM_ID;

// ── an unrecognised line is neither an answer nor a crash ───────────────────────

console.log('\nan unrecognised command line');
ok((await loopInternals.runCommand('frobnicate the widget')) === null, 'runCommand returns null rather than guessing');

// ── the per-turn read budget, not just per-call caps (a 50k-message channel is real) ─────────────

console.log('\nthe accumulated observations are budget-capped, not just each call');
ok(loopInternals.obsText([]) === '(nothing read yet)', 'empty reads render as an honest placeholder');
const small = ['first read', 'second read'];
ok(loopInternals.obsText(small) === small.join('\n\n'), 'under budget, nothing is dropped or noted');
const huge = Array.from({ length: 50 }, (_, i) => `read #${i}: `.padEnd(500, 'x'));
const capped = loopInternals.obsText(huge);
ok(capped.length <= 12_100, 'over budget, the text is capped near the limit, not left to grow unbounded', `${capped.length} chars`);
ok(/earlier read\(s\) dropped/.test(capped), 'and the drop is stated, not silent');
ok(capped.includes(huge[huge.length - 1].trim().slice(0, 10)), 'the MOST RECENT read survives — the next round reasons from it, not from what is already stale');

console.log(fails ? `\nslack check: ${fails} FAILURE(S)\n` : '\nslack check: ok\n');
process.exit(fails ? 1 : 0);
