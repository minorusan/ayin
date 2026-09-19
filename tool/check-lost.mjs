/**
 * check-lost.mjs — the clap sees a CYCLE, not only a streak.
 *
 * Every threshold here is measured, not chosen, and the measurements are on real runs:
 *
 *   One real run, first loop  — 28 copies of one command, refusal streaks 2, 10, 25, 12. The 2 is
 *   its whole productive phase, BEFORE the correct fix landed. Streak rule: fires.
 *
 *   The same run, second loop — after the restart, the same agent cycled through four accepted
 *   commands: 9x, 9x, 4x, 3x. Longest refusal streak: ONE. Streak rule: blind. Within the last 20
 *   calls the most-repeated (call, result) pair appeared 11 times.
 *
 * So the pair rule is what this file mostly exists to pin.
 */
import {
  beginLostTurn, clapsUsed, lostReport, noteCall as rawNoteCall, resetLost, restartDepth,
  restartExhausted, unverifiedReport, ACCOUNT_REQUEST,
} from '../dist/lost.js';

/**
 * The gate speaks in VERDICTS — null, 'nudge' or 'clap'.
 *
 * A bare truthy check would let a nudge pass as a clap, and that distinction is now the whole point:
 * one keeps the model's context, the other destroys it. An assertion that cannot tell them apart
 * would have called the regression a pass.
 */
const noteCall = (...a) => rawNoteCall(...a)?.kind ?? null;

const failures = [];
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };
const is = (got, want, m) => (got === want ? ok(`${m} — ${JSON.stringify(got)}`) : fail(`${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

/** n refused calls, all different, so only the streak rule can see them. */
const refuse = (n) => { let w = null; for (let i = 0; i < n; i++) w = noteCall(i, 'bash', `{"c":"x${i}"}`, `blocked${i}`, true) ?? w; return w; };
/** n ACCEPTED calls, identical call and identical result — the cycle the first version missed. */
const same = (n) => { let w = null; for (let i = 0; i < n; i++) w = noteCall(i, 'bash', '{"c":"pytest -x"}', 'ok, 1 passed', false) ?? w; return w; };

resetLost();
is(refuse(2), null, 'two refusals do not clap — that is the productive phase of a working run');
resetLost();
is(refuse(3), 'clap', 'three refusals in a row CLAP — never a nudge, that signal is unambiguous');

// THE REGRESSION THIS FILE EXISTS FOR.
resetLost();
is(same(3), null, 'three identical accepted calls are not yet a cycle');
resetLost();
is(same(4), 'clap', 'FOUR identical accepted calls CLAP — identical output is not thinking');

// Interleaving must not save it: 13989 cycled through four commands, not one.
resetLost();
for (let i = 0; i < 3; i++) {
  noteCall(i, 'bash', '{"c":"pytest A"}', 'A passed', false);
  noteCall(i, 'bash', '{"c":"git diff"}', 'the diff', false);
  noteCall(i, 'bash', '{"c":"pytest B"}', 'B passed', false);
}
const cycled = noteCall(9, 'bash', '{"c":"pytest A"}', 'A passed', false);
is(typeof cycled, 'string', 'a cycle of three commands is caught once any pair hits four');

/**
 * THE SAME CALL WITH WOBBLING OUTPUT — the shape that defeats every result-keyed rule.
 *
 * A reproduction script that prints a float, a timestamp, an array whose formatting shifts: every run
 * is byte-different, so the echo guard stays silent and the pair rule never matches, while nothing
 * about the world has changed. Measured on a live run: one `python -c` repro run 21 times, echo=1.
 */
const wobble = (n) => {
  let w = null;
  for (let i = 0; i < n; i++) w = noteCall(i, 'bash', '{"c":"python -c repro"}', `elapsed ${i}.${i}s`, false) ?? w;
  return w;
};
resetLost();
is(wobble(5), null, 'five runs of one command with differing output is not yet a verdict');
resetLost();
is(wobble(6), 'nudge', 'six IS — but it NUDGES first, keeping the context');
resetLost();
wobble(6);
is(wobble(6), 'clap', 'and claps only if the same call comes round again after the nudge');

// Build-test-build-test must survive: the same test between real edits is work, not a loop.
resetLost();
let rhythm = null;
for (let i = 0; i < 4; i++) {
  rhythm = noteCall(i, 'str_replace', `{"p":"f${i}.py"}`, `edited ${i}`, false) ?? rhythm;
  rhythm = noteCall(i, 'bash', '{"c":"pytest"}', `run ${i}: 1 failed`, false) ?? rhythm;
}
is(rhythm, null, 'four edit-then-test cycles are work, not a loop');

// A-B-A-B: two calls taking turns, neither reaching four.
resetLost();
let alt = null;
for (let i = 0; i < 3; i++) {
  alt = noteCall(i, 'bash', '{"c":"A"}', `A${i}`, false) ?? alt;
  alt = noteCall(i, 'bash', '{"c":"B"}', `B${i}`, false) ?? alt;
}
is(typeof alt, 'string', 'A-B-A-B alternation is caught even though no pair repeats');

// REAL WORK MUST SURVIVE. Distinct calls with distinct results, forever.
resetLost();
let working = null;
for (let i = 0; i < 60; i++) working = noteCall(i, 'bash', `{"c":"grep thing${i}"}`, `found ${i}`, false) ?? working;
is(working, null, '60 rounds of genuinely different work never clap — there is no budget here');

// The window slides: an old repeat drops out of view.
resetLost();
same(3);
for (let i = 0; i < 20; i++) noteCall(i, 'bash', `{"c":"new${i}"}`, `r${i}`, false);
is(noteCall(99, 'bash', '{"c":"pytest -x"}', 'ok, 1 passed', false), null, 'a repeat that scrolled out of the window is forgotten');

// One clap per TURN, and a restart is a new turn — chains are allowed, budgets are not.
resetLost();
same(4);
is(clapsUsed(), 1, 'the first cycle claps');
is(same(4), null, 'a second cycle in the SAME turn does not clap again');
is(restartDepth(), 1, 'restart depth is 1');
beginLostTurn();
is(typeof same(4), 'string', 'after a restart the new turn gets its own clap');
is(restartDepth(), 2, 'and the depth records which attempt this is');

// The two mandates.
resetLost();
same(4);
const withEdit = lostReport('fix it', ['lib/_axes.py'], '-  a\n+  b', 'the same call returned the same result 4 times');
const noEdit = lostReport('fix it', [], '', 'x');
is(/a SINGLE time/.test(withEdit), true, 'an edited run is told to verify exactly once');
is(/do not run the same command twice/.test(withEdit), true, 'and told explicitly not to repeat it');
/**
 * The lesson from a CORRECT one-line fix that was re-verified for dozens of rounds against a test
 * that had already been failing before it was written. The agent was not being stupid — the only
 * evidence it could reach was lying to it, and nothing told it to check that. True in any repository.
 */
is(/also fails without your change/.test(withEdit), true, 'and told a pre-existing failure is not its own');
is(/cannot find a test that covers it/.test(withEdit), true, 'and told not to substitute a different test');
is(/an outcome, not a failure/.test(withEdit), true, 'and that being unable to verify is a valid ending');
is(/Nothing has been changed yet/.test(noEdit), true, 'an unedited run is told the tree is clean');
is(/a SINGLE time/.test(noEdit), false, 'and is NEVER told to verify a fix that does not exist');
is(withEdit.includes('lib/_axes.py') && withEdit.includes('+  b'), true, 'the report carries the files and the diff');
is(/4×/.test(withEdit), true, 'and shows the loop with its repeat counts');

/**
 * THE REPORT MUST NOT EAT ITSELF.
 *
 * A restart runs the turn again with `originalTask + report`. If the NEXT report writes that composed
 * string under "## The task", each one nests inside the one before it and the prompt doubles every
 * restart. Measured on a live run before this was caught: 493,324 bytes of report against a
 * 40,000-token window, and the relaunched agent could no longer read its own mandate.
 *
 * So: the report is built from the ORIGINAL task every time, and its size must stay flat across a
 * chain. Ten restarts here — if it doubles, this is 1000x and the assertion is unmissable.
 */
resetLost();
const TASK = 'fix the thing';
let composed = TASK;
let first = 0;
for (let n = 0; n < 10; n++) {
  beginLostTurn();
  same(4);
  const r = lostReport(TASK, ['a.py'], '-a\n+b', 'why');   // always the ORIGINAL task
  if (!first) first = r.length;
  composed = `${TASK}\n\n---\n\n${r}`;
}
const last = lostReport(TASK, ['a.py'], '-a\n+b', 'why').length;
is(last < first * 1.5, true, `the report stays flat across 10 restarts — ${first}B then ${last}B`);
is(composed.length < 8000, true, `and the relaunch prompt stays small — ${composed.length}B`);

/**
 * A ROUND THAT MADE NO TOOL CALL IS STILL A ROUND THAT DID NOTHING.
 *
 * The third loop shape, and the one nothing could see: not repeated calls, not refused calls — NO
 * calls. The agent replies in prose, the round is discarded so history is unchanged, and a
 * temperature-zero model rebuilds from identical context and says the identical thing. Measured on a
 * live run before this was wired: 300 model calls, 90 tool calls, 245 discarded rounds, roughly
 * nineteen full-context generations per minute producing nothing.
 *
 * The agent loop reports these to `noteCall` as refused calls of a pseudo-tool with the reply as its
 * result, so the ordinary streak and window rules apply and the remedy is the ordinary restart —
 * which is also the only thing that can break a deterministic loop, since retrying cannot.
 */
const idle = (n, text = 'I will now examine the file.') => {
  let w = null;
  for (let i = 0; i < n; i++) w = noteCall(i, 'reply', '', text, true) ?? w;
  return w;
};

resetLost();
is(idle(2), null, 'two prose rounds are not yet a refusal to act');
resetLost();
is(typeof idle(3), 'string', 'three identical prose rounds with no tool call DO clap');

/**
 * The legitimate case: it narrates, then actually does something, then narrates differently.
 *
 * DISTINCT prose on purpose. Four IDENTICAL replies inside one window is stuck whether or not a tool
 * call sits between them — the window rule catches that, correctly — so reusing one sentence here
 * would test the window rule while claiming to test the streak.
 */
resetLost();
idle(2, 'Looking at the axis code now.');
noteCall(3, 'bash', '{"c":"pytest"}', 'ok', false);
is(idle(2, 'Now checking the ticker.'), null, 'a real tool call between differing prose rounds resets the streak');

// Prose that VARIES but cycles is caught by the window rule, not the streak rule.
resetLost();
let cyc = null;
for (let i = 0; i < 3; i++) {
  cyc = noteCall(i, 'reply', '', 'Let me check the axis code.', true) ?? cyc;
  cyc = noteCall(i, 'bash', '{"c":"grep x"}', 'found', false) ?? cyc;
}
is(typeof cyc, 'string', 'prose alternating with work is still caught once a pair repeats four times');

// Depth is visible to the next agent once it is more than the first attempt.
resetLost();
same(4); beginLostTurn(); same(4);
is(/This is attempt 2/.test(lostReport('g', [], '', 'x')), true, 'a second restart says so, so the next agent knows');

/**
 * THE VERIFICATION BUDGET COUNTS TURNS, NOT SKEPTIC PASSES.
 *
 * The first version counted passes and could never be spent by the behaviour it existed to bound: the
 * pass opens on an EDIT or on a FINISH, so an agent that edits once and then confirms forever opens
 * exactly one pass, ever. Measured on a live run — two restarts in, the counter still read 1.
 *
 * A turn that BEGINS with a change already in the tree is a turn spent confirming rather than finding.
 * Three of those and the run stops with an account. A run still searching never spends any of it, and
 * that asymmetry is the whole point: finding the answer is unbounded, confirming it is not.
 */
const sk = await import('../dist/skeptic-pass.js');
sk.resetSkepticRun();
sk.beginVerifyTurn(false);
is(sk.verifyAttempts(), 0, 'a turn that starts with a clean tree costs nothing');
sk.beginVerifyTurn(true);
sk.beginVerifyTurn(true);
is(sk.verifyBudgetSpent(), false, 'two turns with an edit on disk is not yet the budget');
sk.beginVerifyTurn(true);
is(sk.verifyBudgetSpent(), true, 'the THIRD is — and the run stops with an account');
sk.resetSkepticRun();
for (let i = 0; i < 8; i++) sk.beginVerifyTurn(false);
is(sk.verifyBudgetSpent(), false, 'eight turns still searching spend none of it — finding is unbounded');

/**
 * THE UNVERIFIED HANDOFF — not a failure report.
 *
 * The agent did the part it could do; this is the part that needs a person. The mechanical sections
 * are derivable, so the one that matters is the agent's OWN account of what observation was missing
 * and what prevented it. A reader cannot reconstruct that from the diff, and a report that faked it
 * would be worse than one that admits it is absent.
 */
const REP = unverifiedReport('fix the thing', ['a.py'], '-x\n+y', 3, 'No network to install pytest-mpl.');
is(/Verification was attempted 3 times/.test(REP), true, 'the report says how many attempts were spent');
is(REP.includes('+y'), true, 'and carries the diff itself');
is(/No network to install pytest-mpl/.test(REP), true, "and the agent's own account, verbatim");
is(/not the same as the change being wrong/.test(REP), true, 'and never calls the change wrong');
is(/the agent gave no account/.test(unverifiedReport('t', ['a.py'], '-x\n+y', 3)), true,
  'a missing account is stated plainly, never invented');
is(/no tool calls/.test(ACCOUNT_REQUEST), true, 'the request asks for prose, not another command');
is(/do not call finish/.test(ACCOUNT_REQUEST), true, 'and forbids finishing, so the account is the last word');

/**
 * THE RESTART CHAIN IS BOUNDED, AND ITS DEAD ENDS SURVIVE THE WIPE.
 *
 * Both assertions exist because a run spent four hours on twelve restarts. The bound was a comment
 * citing a function nobody imported; the dead ends were rebuilt from a window the restart had just
 * cleared, so each incarnation re-walked the routes the last one had closed.
 */
resetLost();
is(restartExhausted(), false, 'a fresh run has its restarts');
const routes = [];
for (let attempt = 1; attempt <= 9 && !restartExhausted(); attempt++) {
  beginLostTurn();
  // Three refusals is the unambiguous shape — one clap per turn, one restart per clap.
  for (let i = 0; i < 3; i++) noteCall(i, 'bash', `attempt${attempt}`, 'blocked', true);
  routes.push(lostReport('t', [], '', 'stuck'));
}
is(restartDepth(), 5, 'the chain stops at five restarts, not at whatever the model will tolerate');
is(restartExhausted(), true, 'and says so, so the caller reports instead of relaunching');
is(/attempt1/.test(routes[routes.length - 1]), true,
  "the last report still names the FIRST attempt's dead end — the wipe does not erase what is closed");
is(/attempt5/.test(routes[routes.length - 1]), true, 'alongside the most recent one');
resetLost();
is(restartDepth(), 0, 'and a new run starts the chain over');
is(/attempt1/.test(lostReport('t', [], '', 'stuck')), false, 'with no dead ends carried across runs');

/**
 * A NUDGE MUST SURVIVE THE NEXT CALL. It did not: the six copies that triggered it stayed in the
 * window, so the model's very next call re-satisfied the rule with the key already nudged, and it
 * clapped one round later every time. Nudge at round 37, clap at 38, zero refusals — twice, live.
 */
resetLost();
beginLostTurn();
for (let i = 0; i < 5; i++) noteCall(i, 'bash', 'pytest -x', `run ${i}`, false);
is(noteCall(5, 'bash', 'pytest -x', 'run 5', false), 'nudge', 'six of the same call nudges');
is(noteCall(7, 'read_file', 'a.py', 'contents', false), null,
  'and the very next call is NOT a clap — the nudge has room to be obeyed');
is(noteCall(8, 'grep', 'thing', 'hits', false), null, 'nor the one after it');
for (let i = 9; i < 14; i++) noteCall(i, 'bash', 'pytest -x', `run ${i}`, false);
is(noteCall(14, 'bash', 'pytest -x', 'run 14', false), 'clap',
  'but six MORE of the same call, after being told, is the unambiguous case');

console.log(failures.length ? `\nlost check: ${failures.length} FAILED` : '\nlost check: ok');
process.exit(failures.length ? 1 : 0);
