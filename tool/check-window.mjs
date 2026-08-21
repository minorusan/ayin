/**
 * check-window.mjs — the context window must be evicted in ONE BITE, not one message per round.
 *
 * This is a PERFORMANCE contract, and it is invisible in any output: an agent that trims to exactly
 * the budget is correct in every answer it gives and takes 27 seconds per round to give it, because
 * the server's KV cache matches nothing after the first evicted message and reprocesses the whole
 * prompt. Measured through the gateway: 920 prompt tokens -> 0.56s, 17,594 -> 26.9s.
 *
 * So the gate asserts the property that keeps the cache alive: after a trim, there is HEADROOM — the
 * next rounds can append without evicting again.
 */
import { trimToContext, compressOldest, noteRanCall, renderCallLedger, resetCallLedger } from '../dist/agent.js';

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const msg = (role, chars) => ({ role, content: 'x'.repeat(chars) });

// CONSERVATIVE_CONTEXT is 16384 when no model has resolved; reserve is 2000; 3 chars per token.
const CTX = 16384, RESERVE = 2000, CPT = 3;
const budget = CTX - RESERVE;
const tokens = (ms) => ms.reduce((n, m) => n + Math.ceil(m.content.length / CPT), 0);

// A window well over budget: system + 60 history messages + the volatile turn.
const history = Array.from({ length: 60 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 1500));
const messages = [msg('system', 3000), ...history, msg('user', 600)];
if (tokens(messages) <= budget) fail('fixture is not over budget — the gate would prove nothing');

const trimmed = trimToContext(messages);
const after = tokens(trimmed);
if (after > budget) fail(`trim left ${after} tokens, over the ${budget} budget`);

// THE POINT: headroom. Trimming to exactly the budget re-evicts every round and kills the cache.
const headroom = budget - after;
if (headroom < budget * 0.15) {
  fail(`trimmed to ${after}/${budget} — only ${headroom} tokens of headroom, so the next round evicts again `
     + 'and the KV cache is invalidated every round (this is the 27s-per-round bug)');
}

// The system message must survive untouched — it is the cached prefix.
if (trimmed[0].content !== messages[0].content) fail('the system message was altered or dropped');
// The volatile turn (this round's instruction) must survive.
if (trimmed[trimmed.length - 1].content !== messages[messages.length - 1].content) {
  fail('the last message (this round\'s instruction) was dropped');
}

// Under budget: nothing may be touched at all.
const small = [msg('system', 300), msg('user', 300)];
if (trimToContext(small).length !== 2) fail('a window under budget was trimmed');

// ── compression fires on the BUDGET, never on message age ────────────────────────────────
//
// The old rule compressed every tool result older than the four most recent, permanently, whatever the
// window looked like. Measured cost: a session climbed to 21.4k tokens, fell to 15.7k as the first
// results aged out, and sat near 13.8k for ten more rounds with 42,000 tokens unused. There is no
// output in which that is visible — the answers just get worse — so it is asserted here.

const tr = (chars) => ({ role: 'user', content: `<tool_response>\n${'y'.repeat(chars)}\n</tool_response>` });

// A window that FITS: not one character may be touched, however old the results are. Every result here
// is over the 2,000-char compression size, so they are all ELIGIBLE — the only reason to leave them
// alone is that the budget does not need them, which is the property under test.
const roomy = Array.from({ length: 8 }, () => tr(2500));
const roomyBefore = roomy.map((m) => m.content.length);
if (tokens(roomy) + 3000 > budget * 0.75) fail('fixture does not fit the compression threshold — the gate would prove nothing');
const quiet = compressOldest(roomy, 3000);
if (quiet.count !== 0 || quiet.dropped !== 0) {
  fail(`compressed ${quiet.count} result(s) in a window that fits — this is the starvation bug: `
     + `${tokens(roomy)} tokens against a ${budget} budget and it still cut history`);
}
if (roomy.some((m, i) => m.content.length !== roomyBefore[i])) fail('a result was mutated while the window fit');

// A window that does NOT fit: compress, oldest first, and STOP once it fits.
//
// Sized so compression CAN reach the target with results to spare — that is the only fixture in which
// "it stopped early" and "it ran out of things to cut" are distinguishable. Seven large old results
// over a small recent tail: removing about five of them is enough, so two must survive untouched.
const tight = [...Array.from({ length: 7 }, () => tr(4800)), ...Array.from({ length: 4 }, () => tr(500))];
const tightBefore = tight.map((m) => m.content.length);
if (tokens(tight) + 500 <= budget * 0.75) fail('fixture is under the compression threshold — the gate would prove nothing');
const cut = compressOldest(tight, 500);
if (cut.count === 0) fail('a window well over budget was not compressed at all');
if (cut.dropped <= 0) fail('compression reported no characters dropped');

// Oldest first: the compressed ones must be a PREFIX of the window.
const shrunk = tight.map((m, i) => m.content.length < tightBefore[i]);
const lastShrunk = shrunk.lastIndexOf(true);
if (shrunk.slice(0, lastShrunk + 1).some((v) => !v)) {
  fail('compression skipped an older result and took a newer one — eviction order must be oldest-first');
}
// The four most recent are never touched, whatever the pressure.
if (shrunk.slice(-4).some(Boolean)) fail('one of the four most recent results was compressed');
// And it must STOP, not flatten everything it is allowed to touch.
if (shrunk.slice(0, -4).every(Boolean)) {
  fail('every eligible result was compressed — it must stop as soon as the prompt fits, or this is the '
     + 'old behaviour with a budget check bolted on the front');
}
// Written back into the caller's array: compression is one-way, or the KV prefix moves every round.
if (tight[0].content.length >= tightBefore[0]) fail('compression was not written back — next round re-does it');

// ── the ledger: what already ran, always in the prompt ─────────────────────────────
//
// It exists because a result that was compressed or evicted is, from the model's side, a call it never
// made — measured as a 36-call turn re-running greps it had already been given.

resetCallLedger();
if (renderCallLedger() !== '') fail('an empty ledger rendered something');

noteRanCall('grep', 'pattern=ScoringId', true, 'Assets/Scripts/Fact.cs:12: ScoringId;\nmore lines');
noteRanCall('read_file', 'path=Fact.cs', false, 'ENOENT: no such file');
const led = renderCallLedger();
if (!led.includes('grep(pattern=ScoringId)')) fail('the ledger does not name the call it recorded');
if (!led.includes('Assets/Scripts/Fact.cs:12')) fail('the ledger dropped the outcome gist');
if (led.includes('more lines')) fail('the ledger kept a second line — it is a ledger, not a transcript');
if (!/FAILED/.test(led)) fail('a failed call is not marked failed — the model cannot tell it may retry');

/**
 * THE LEDGER MUST SAY WHERE THE ANSWER IS, not only that a call happened.
 *
 * The window compresses old observations, so a result given twenty rounds ago is — from the model's side
 * — indistinguishable from a call it never made. Every result is also a file in the session's cache, and
 * naming it is what makes the ledger usable rather than merely informative: one line instead of 200 KB.
 */
resetCallLedger();
const { saveArtifact, startArtifactSession, artifactSessionDir } = await import('../dist/artifacts.js');
startArtifactSession(`check-window-${process.pid}`);
saveArtifact('grep', 'pattern=Widget', 'x'.repeat(4096));
noteRanCall('grep', 'pattern=Widget', true, 'Assets/Widget.cs:12: Widget;');
const withFile = renderCallLedger();
if (!/t\d+-grep\.txt/.test(withFile)) fail('the ledger does not name the file holding the full result');
if (!/4\.0 KB/.test(withFile)) fail('the ledger does not say how big that result is — the reader cannot decide against reading it');
if (!withFile.includes(artifactSessionDir())) fail('the cache folder is not stated anywhere in the ledger');
if ((withFile.match(new RegExp(artifactSessionDir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length !== 1) {
  fail('the folder is repeated per line — it must be stated once, not sixty times');
}
noteRanCall('read_file', 'path=NeverRan.cs', false, 'ENOENT');
if (/NeverRan\.cs\)[^\n]*\[.* KB/.test(renderCallLedger())) fail('a call with no cached result was given a file anyway');
resetCallLedger();
// A gate that leaves a session folder behind every run is a gate that fills the cache it is testing.
(await import('node:fs')).rmSync(artifactSessionDir(), { recursive: true, force: true });

// Bounded render: a long turn must not put its own bookkeeping in front of the model.
resetCallLedger();
for (let i = 0; i < 300; i++) noteRanCall('bash', `cmd=echo ${i}`, true, `line ${i}`);
const big = renderCallLedger();
const lines = big.split('\n').filter((l) => /^\d+\. /.test(l));
if (lines.length > 60) fail(`${lines.length} ledger lines rendered — the render must be bounded`);
if (!/earlier call\(s\) not listed/.test(big)) fail('calls were dropped from the render with no seam saying so');
if (!big.includes('cmd=echo 299')) fail('the render kept the oldest calls instead of the most recent');
resetCallLedger();

console.log(`check-window: OK — trimmed to ${after}/${budget} tokens, ${headroom} of headroom, prefix intact`);
console.log(`             compression: ${quiet.count} cuts when it fits, ${cut.count} when it does not (${cut.dropped} chars)`);
console.log(`             ledger: ${lines.length} lines rendered from 300 calls, newest kept`);

// Exit explicitly: importing the agent drags in modules that hold the event loop open (the blessed
// screen, a keep-alive HTTP pool). A gate that hangs is a gate that gets deleted.
process.exit(0);
