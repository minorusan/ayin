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
import { trimToContext, compressOldest, noteRanCall, renderCallLedger, resetCallLedger, resetSessionLedger } from '../dist/agent.js';

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
if (!led.includes('Assets/Scripts/Fact.cs:12')) fail('the ledger dropped what the call returned');
// IT KEEPS WHAT THE CALL RETURNED, not merely that it ran. This used to assert the opposite — one line
// only, "it is a ledger, not a transcript" — and one line is the entire memory of a call once the
// window's compression has eaten the result. `bash(pytest …)` was remembered as its banner.
if (!led.includes('more lines')) fail('the ledger kept only one line — that is not enough to use the answer');
if (!/FAILED/.test(led)) fail('a failed call is not marked failed — the model cannot tell it may retry');

/**
 * HEAD, THE ERRORS FROM THE MIDDLE, AND THE TAIL.
 *
 * Head and tail alone miss the case that matters most: a long run whose failure is neither at the start
 * nor at the very end. A 200-line pytest puts its banner in the head and its summary in the tail and
 * leaves the assertion — the line naming what was expected and what arrived — in the 180 nobody sees.
 * The filter is deterministic: no model, no judgement, generous rather than precise, because this reads
 * tool output where a line containing "error" almost always is one.
 */
resetCallLedger();
const buildLog = [
  '> ayin@1.0.0 build', '> tsc',
  ...Array.from({ length: 40 }, (_, i) => `[info] compiling src/module_${i}.ts`),
  "src/plan/plan.ts(412,17): error TS2304: Cannot find name 'artifactHint'.",
  ...Array.from({ length: 40 }, (_, i) => `[info] compiling src/other_${i}.ts`),
  'Build step finished.', 'npm ERR! code 2',
].join('\n');
noteRanCall('bash', 'command=npm run build', false, buildLog);
const excerpt = renderCallLedger();
if (!/> tsc/.test(excerpt)) fail('the head of the output is missing');
if (!/npm ERR! code 2/.test(excerpt)) fail('the TAIL is missing — a failing command puts its summary at the end');
if (!/error TS2304/.test(excerpt)) fail('the error buried in the middle was not lifted out — the whole point of the filter');
if (!/line\(s\) omitted/.test(excerpt)) fail('the elision is not stated, so the model reads a sample as the whole');
if (/module_2[0-9]\.ts/.test(excerpt)) fail('the uninteresting middle was kept — the excerpt is not an excerpt');

// SHORT OUTPUT IS SHOWN WHOLE. Splitting fifteen lines into three sections invents structure to
// describe a thing that fits.
resetCallLedger();
noteRanCall('bash', 'command=ls', true, 'calc.py\ntest_calc.py\nvenv');
const short = renderCallLedger();
if (/omitted|last lines/.test(short)) fail('a short output was chopped into sections it does not need');
if (!/venv/.test(short)) fail('a short output lost its last line');

// THE BUDGET IS BOUNDED, AND EVERY CALL IS STILL LISTED.
resetCallLedger();
const long = [...Array.from({ length: 60 }, (_, i) => `line ${i} of a fairly long tool output here`), 'ERROR: broke', 'done'].join('\n');
for (let i = 0; i < 30; i++) noteRanCall('bash', `command=step-${i}`, false, long);
const budgeted = renderCallLedger();
if ((budgeted.match(/^\d+\. /gm) || []).length !== 30) fail('a call went unlisted — every call this turn must appear');
if (budgeted.length > 20000) fail(`the ledger blew its budget at ${budgeted.length} chars — bookkeeping must not crowd out the work`);
// A failure that could not afford its excerpt still has to say WHY it failed: degrading to the first
// line of a failed command shows its banner, which is the least informative line it has.
if ((budgeted.match(/ERROR: broke/g) || []).length < 20) {
  fail('out-of-budget failures lost their error line');
}
resetSessionLedger();
resetCallLedger();

/**
 * THE LEDGER MUST SAY WHERE THE ANSWER IS, not only that a call happened.
 *
 * The window compresses old observations, so a result given twenty rounds ago is — from the model's side
 * — indistinguishable from a call it never made. Every result is also a file in the session's cache, and
 * naming it is what makes the ledger usable rather than merely informative: one line instead of 200 KB.
 */
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

/**
 * THE MAP MUST SURVIVE THE TURN BOUNDARY.
 *
 * The turn's detail is cleared — a new question searches again — but the files stay on disk for the whole
 * session, and dropping the pointer to them meant "read the controller I inspected two questions ago" had
 * nowhere to point. Only what is needed to fetch it is carried: the call and its file, never the gist.
 */
resetCallLedger();
const nextTurn = renderCallLedger();
if (!/From earlier turns this session/.test(nextTurn)) fail('the cache map did not survive the turn boundary');
if (!/t\d+-grep\.txt/.test(nextTurn)) fail('the carried entry does not name its file');
if (/Assets\/Widget\.cs:12/.test(nextTurn)) fail('the gist was carried too — that belonged to the turn that asked');
if (!/nothing yet in this turn/.test(nextTurn)) fail('the empty current turn is not stated, so the list reads as this turn\'s work');
resetSessionLedger();
if (renderCallLedger() !== '') fail('a session with no calls at all still rendered a ledger');
// A gate that leaves a session folder behind every run is a gate that fills the cache it is testing.
(await import('node:fs')).rmSync(artifactSessionDir(), { recursive: true, force: true });

/**
 * EVERY CALL IS LISTED; the CHARACTERS are what is bounded.
 *
 * This used to render only the last 60 calls, so on a long turn the model was told about its own recent
 * work and nothing about the rest — which is the same hole the ledger exists to close, moved further
 * down the turn. What must stay bounded is the cost: the detail budget is spent newest-first and
 * DEGRADES (full excerpt, then the errors alone, then the call line by itself) rather than stopping, so
 * a 300-call turn still names all 300 without putting a quarter of the window in front of the work.
 */
resetCallLedger();
for (let i = 0; i < 300; i++) noteRanCall('bash', `cmd=echo ${i}`, true, `line ${i}`);
const big = renderCallLedger();
const lines = big.split('\n').filter((l) => /^\d+\. /.test(l));
// ACCOUNTED FOR, not necessarily LISTED. "Every call gets its own line" was affordable only at the
// 12-char parameters this case uses; see the long-parameter case below for what it cost in the field.
// The invariant that survives is that no call vanishes silently: it is listed, or it is in the tally.
const tallied = /Earlier in this turn \((\d+) call\(s\)/.exec(big);
const accounted = lines.length + (tallied ? Number(tallied[1]) : 0);
if (accounted !== 300) fail(`${accounted} of 300 calls accounted for — a call vanished from the ledger`);
if (big.length > 14000) fail(`300 short calls rendered ${big.length} chars — the render must stay bounded`);

/**
 * LONG PARAMETERS — the case this gate did not have, and the one that actually happened.
 *
 * Every case above used a 12-character parameter, so the unbounded `${c.params}` in the call line never
 * showed up. In the field a `bash` command is a multi-line Python heredoc: measured on pylint-4551, 379
 * calls averaging 142 parameter chars put ~19,200 tokens of bare call lines into a 40,000 window, on
 * every one of 348 rounds. The detail budget was holding perfectly; the line it prefixes was not bounded
 * at all.
 */
resetCallLedger();
const fatParam = 'command=cd /testbed && python -c "' + 'import astroid; code = ' + "'''".repeat(3)
  + Array.from({ length: 12 }, (_, i) => `class C${i}(object):    def __init__(self, a: str = None): self.a = a`).join(' ')
  + '"';
for (let i = 0; i < 380; i++) noteRanCall('bash', `${fatParam} # ${i}`, true, `line ${i}`);
const fat = renderCallLedger();
if (fat.length > 20000) fail(`380 long-parameter calls rendered ${fat.length} chars — parameters are not clipped`);
const fatTally = /Earlier in this turn \((\d+) call\(s\)/.exec(fat);
const fatListed = fat.split('\n').filter((l) => /^\d+\. /.test(l)).length;
if (fatListed + (fatTally ? Number(fatTally[1]) : 0) !== 380) fail('a long-parameter call vanished from the ledger');
if (!fat.includes('…')) fail('long parameters were not clipped');

resetCallLedger();
const longOut = Array.from({ length: 60 }, (_, i) => `output line ${i} which is reasonably long for a tool result`).join('\n');
for (let i = 0; i < 300; i++) noteRanCall('bash', `cmd=step ${i}`, false, longOut);
const huge = renderCallLedger();
if ((huge.split('\n').filter((l) => /^\d+\. /.test(l))).length !== 300) fail('a call went unlisted on a long turn');
if (huge.length > 30000) fail(`300 LONG failing calls rendered ${huge.length} chars — the degradation ladder is not holding`);
// The old render dropped calls past 60 and printed a "[N earlier call(s) not listed]" seam to admit it.
// Nothing is dropped now, so the seam must NOT appear — it would be describing an elision that no
// longer happens, which is worse than no seam at all.
if (/earlier call\(s\) not listed/.test(big)) fail('the render still prints a drop seam, but nothing is dropped any more');
if (!big.includes('cmd=echo 299')) fail('the render kept the oldest calls instead of the most recent');
resetCallLedger();

/**
 * FILE VIEWS — materialize once, then say what changed.
 *
 * The case these exist for: pylint-4551 read the same files for 348 rounds and every copy landed in
 * full, because the guard appended an INCREMENTING "[REPEAT n:" to exactly the messages that were
 * repeats, so no two were byte-equal and the dedupe never fired. 101 warnings, 18 dedupes.
 */
const fv = await import('../dist/file-view.js');
// A REALISTIC SIZE. The first draft used a 60-char file and asserted the pointer was shorter than it —
// which it is not, and cannot be: a pointer that explains itself costs ~200 chars. The claim worth
// testing is that the CONTENTS are not re-sent, not that the reply is short in absolute terms.
const FILE = Array.from({ length: 80 }, (_, i) => `    def method_${i}(self, a: str = None):  # line ${i}`).join('\n')
  + '\n    def __init__(self, a: str = None):\n        self.a = a\n';
const win = [];
const push = (body) => { win.push({ role: 'user', content: '<tool_response>' + body + '</tool_response>' }); return body; };

fv.resetFileViews();
const first = fv.shapeFileResult('read_file', { path: 'f.py' }, FILE, FILE, win);
if (first.body !== FILE) fail('a first read must materialize the file in full');
push(first.body);

const again = fv.shapeFileResult('read_file', { path: 'f.py' }, FILE, FILE, win);
if (again.body.includes('method_40')) fail('an unchanged re-read re-sent the file contents');
if (again.body.length > 400) fail(`an unchanged re-read cost ${again.body.length} chars — it must be a pointer`);
if (!/unchanged/.test(again.body)) fail('an unchanged re-read must say so');
if (!again.suppressRepeatNote) fail('the REPEAT note must be suppressed — it is what broke dedupe');

const EDITED = FILE.replace('    def __init__(self, a: str = None):', '    def __init__(self, a: int = 0):');
const diffed = fv.shapeFileResult('read_file', { path: 'f.py' }, EDITED, EDITED, win);
if (!/CHANGED/.test(diffed.body)) fail('a changed re-read must report the change');
if (!/^\+.*a: int/m.test(diffed.body)) fail('the diff must show the new line');
if (diffed.body.includes('method_40')) fail('a small edit re-sent the whole file instead of a diff');

// A DIFFERENT REGION IS A DIFFERENT QUESTION — never answered with a diff of bytes never seen.
const region = fv.shapeFileResult('read_file', { path: 'f.py', offset: 40, limit: 10 }, FILE, FILE, win);
if (region.body !== FILE) fail('a new region must materialize, not diff against another region');

// EVICTION: if the copy is gone from the window, there is no copy — materialize again.
win.length = 0;
const afterEvict = fv.shapeFileResult('read_file', { path: 'f.py' }, EDITED, EDITED, win);
if (afterEvict.body !== EDITED) fail('after eviction the file must be materialized again, not diffed');
fv.resetFileViews();
console.log('             file views: materialize / unchanged / diff / region / eviction all hold');

/**
 * ECHO REFUSAL — the same BYTES, not the same parameters.
 *
 * pylint-4551 with a healthy context: 573 rounds, zero edits, 372 `git status && git diff` calls all
 * returning "(no output)". The parameters varied (`&&` vs `;`, a trailing `ls`) so a parameter key saw
 * four calls; `git status` names no path so the content witness had nothing to hash. The output was
 * identical every time.
 */
const tg = await import('../dist/tool-guard.js');
tg.resetOutputEchoes();
if (tg.refuseIfEcho('bash', '') !== null) fail('a first result must pass through');
if (tg.refuseIfEcho('bash', '') !== null) fail('a second identical result is a confirmation, not a loop');
const third = tg.refuseIfEcho('bash', '');
if (third === null) fail('a third identical result must be refused');
if (!/REFUSED/.test(third)) fail('the refusal must say so');
// NEW BYTES ARE THEIR OWN QUESTION — "does the test pass now" keeps working because a different
// answer has its own count, not because it clears anybody else's.
if (tg.refuseIfEcho('bash', 'now it fails differently') !== null) fail('a changed result must pass through');
if (tg.refuseIfEcho('bash', 'now it fails differently') !== null) fail('a second new-byte result is a confirmation');

/**
 * INTERLEAVED — the case the first implementation got wrong, and the only case that mattered.
 *
 * Keying on the tool and comparing against the PREVIOUS result alone gave 25 refusals on requests-1142
 * and ZERO on pylint-4551, the run with 372 identical `git status` calls: one `pytest` between any two
 * of them reset the counter. Consecutiveness was never the property; recurrence is.
 */
tg.resetOutputEchoes();
let refusedInterleaved = 0;
for (let i = 0; i < 6; i++) {
  if (tg.refuseIfEcho('bash', 'ON BRANCH MAIN\nnothing to commit') !== null) refusedInterleaved++;
  tg.refuseIfEcho('bash', `pytest run ${i} — different every time`);   // the interleaving call
}
if (refusedInterleaved === 0) fail('an interleaved identical result was never refused — the loop is still invisible');
if (refusedInterleaved < 3) fail(`only ${refusedInterleaved} of 6 interleaved repeats refused`);
// The exit and the mutators are never refused.
tg.resetOutputEchoes();
for (let i = 0; i < 5; i++) {
  if (tg.refuseIfEcho('finish', 'done') !== null) fail('finish must never be refused');
  if (tg.refuseIfEcho('perform_edit', 'ok') !== null) fail('an edit must never be refused');
}
tg.resetOutputEchoes();
console.log('             echo refusal: 3rd identical refused, new bytes reset, finish/edit exempt');

console.log(`check-window: OK — trimmed to ${after}/${budget} tokens, ${headroom} of headroom, prefix intact`);
console.log(`             compression: ${quiet.count} cuts when it fits, ${cut.count} when it does not (${cut.dropped} chars)`);
console.log(`             ledger: ${lines.length} lines rendered from 300 calls, newest kept`);

// Exit explicitly: importing the agent drags in modules that hold the event loop open (the blessed
// screen, a keep-alive HTTP pool). A gate that hangs is a gate that gets deleted.
process.exit(0);
