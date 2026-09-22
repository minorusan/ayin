/**
 * THE CLAP — when the agent has stopped doing anything, stop it doing it.
 *
 * NO BUDGET LIVES HERE. Not rounds, not money, not a clock. `finish()` remains the only way out, and
 * this file never counts how much work has been done — only whether the last stretch of it was the
 * SAME work. A run that keeps learning things runs forever, by design.
 *
 * ── WHY THE FIRST VERSION WAS NOT ENOUGH ────────────────────────────────────────────────────────
 *
 * It fired on three consecutive REFUSALS. That caught one real run's first loop — 28 copies of one
 * command, 25 refusals in a row — and the restart worked: clean window, report delivered, correct diff
 * intact. Then the sober agent did it again, and the clap never fired, because the second loop was
 * made of calls that were ACCEPTED:
 *
 *     9x  git diff _axes.py && pytest test_hist_log
 *     9x  pytest test_axes.py::test_hist_density -x -q
 *     4x  pytest test_axes.py::test_hist_unequal_bins
 *     3x  git status --short && git diff _axes.py
 *
 * Each differs from the last by a few bytes, so each returns new output, so the echo guard correctly
 * allows every one. Measured on that live run: longest consecutive refusal streak = 1. A streak counter
 * cannot see a cycle.
 *
 * ── THE SHAPE: A WINDOW, NOT A STREAK ───────────────────────────────────────────────────────────
 *
 * A WINDOW, not a streak. The last `WINDOW` calls, and three independent scenarios. Measured against
 * the same live run: 11 identical (call, result) pairs inside the last 20 — it fires four times over
 * where the streak rule fired never.
 *
 * Keyed on the CALL AND ITS RESULT, never on the model's prose. Folding the model's stated reasoning
 * into the comparison is the obvious thing to do and it is wrong: a model that varies its narration
 * while issuing the identical call then looks like it is doing something new every time. Excluding
 * the prose costs nothing and closes that.
 */
import { createHash } from 'node:crypto';
import { log } from './log.js';

/** Calls kept in view. Twenty is enough to contain a cycle without remembering finished work. */
const WINDOW = 20;

/** Identical (call, result) pairs inside the window. */
const SAME_PAIR = 4;

/**
 * The same CALL, whatever it returned.
 *
 * Higher than `SAME_PAIR` because it is weaker evidence: output that differs might mean the world
 * moved. But it usually does not — a reproduction script that prints a timestamp, a float that lands
 * differently, an array whose formatting shifts, and every run is byte-different while nothing
 * whatsoever has changed. Measured on a live run: one `python -c` repro executed 21 times, echo guard
 * silent because no two outputs matched, pair rule silent for the same reason, and the model no
 * closer to an edit than on the first.
 *
 * Six, not four, so a genuine build-test-build-test rhythm has room to breathe.
 */
const SAME_CALL = 6;

/** Refusals in a row. The productive phase of a working run never exceeded two — see the header. */
const SAME_REFUSAL = 3;

/** Length of an A-B-A-B oscillation. Two calls taking turns is a cycle a repeat count cannot see. */
const ALTERNATION = 6;

/** Refused calls named in the report. Enough to show the shape of the loop, not to re-run it. */
const SHOWN = 6;

interface Call {
  round: number;
  tool: string;
  params: string;
  /** Hash of the call and what it returned. See the header on why the model's prose is not in it. */
  key: string;
  /**
   * Hash of the CALL ALONE, for the alternation test.
   *
   * Comparing the observation as well as the call at i and i+2 is the obvious form, and its own shape
   * defeats it: a test that prints a duration, a log with a timestamp, any output that wobbles by a
   * byte makes two turns of the same cycle unequal and the detector blind. Two calls taking turns six
   * times is a cycle whether or not their output is identical — that is the whole content of the claim.
   */
  callKey: string;
  refused: boolean;
}

let window: Call[] = [];
let streak = 0;
let claps = 0;
let depth = 0;

/**
 * THE DEAD ENDS OF EVERY INCARNATION, NOT JUST THIS ONE.
 *
 * A restart wipes the context, so the report is the only thing the next agent knows — and the report
 * was built from `window`, which `beginLostTurn` had just cleared. Restart 7 was therefore handed the
 * dead ends of restart 6 and nothing else, and re-walked the first six from scratch, which is why depth
 * climbed instead of converging: twelve incarnations each discovering the same route was closed.
 *
 * Reset by `resetLost` only — this outlives the turn on purpose.
 */
let deadEnds = new Map<string, number>();

/** Everything, including the restart depth. Called once per RUN — see `clapsUsed`. */
export function resetLost(): void {
  window = [];
  streak = 0;
  claps = 0;
  depth = 0;
  deadEnds = new Map();
  nudged = new Set();
}

/**
 * The per-TURN reset. A restart is a new turn and gets its own clap: a chain of restarts is not a
 * budget being spent, it is the same rule applying again to a fresh context, and each one hands the
 * next agent a longer account of what has already failed. `depth` is deliberately NOT reset, so that
 * account can say which attempt this is.
 */
export function beginLostTurn(): void {
  window = [];
  streak = 0;
  claps = 0;
  nudged = new Set();
}

export function clapsUsed(): number { return claps; }
export function restartDepth(): number { return depth; }

/**
 * HOW MANY SOBER RESTARTS A RUN GETS. Past this, the turn reports and stops.
 *
 * A restart is not free and it is not a budget line — it is a WHOLE ATTEMPT. The context is wiped, so
 * the next incarnation re-reads, re-greps and re-derives from the same starting point, and a run's wall
 * clock is very nearly `(restarts + 1) x one attempt`. Measured across 28 consecutive runs on a
 * temperature-zero model:
 *
 *     restarts 0-3   13-32 min
 *     restarts 5     32 min, finished
 *     restarts 6     85 min, never finished
 *     restarts 8     66 min, never finished
 *     restarts 9     71 min, never finished
 *     restarts 12   244 min, never finished
 *
 * Every run that ever reached `finish` did so at depth 5 or less; every run past it produced nothing
 * and accounted for the entire long tail. Five is therefore the deepest restart ever observed to pay,
 * not a round number — capping here would have cost none of the recoveries and removed all of the waste.
 *
 * The turn ending is NOT the work being lost: the tree is whatever the run left in it, and the patch is
 * collected from the tree, not from a successful exit.
 */
const RESTART_MAX = 5;

/** True once the chain has spent every restart. The caller reports instead of relaunching. */
export function restartExhausted(): boolean { return depth >= RESTART_MAX; }

/**
 * ── FIRST TO PRUNE IF SOMETHING GOES WRONG ──────────────────────────────────────────────────────
 *
 * The same-call rule NUDGES before it claps. Everything else claps immediately.
 *
 * THE EVIDENCE FOR THIS IS ONE RUN, AND IT IS CONFOUNDED. A task that had been solved three times in
 * a row — identical patch, ~18 minutes, zero claps — instead restarted three times and produced no
 * edit at all. But three things shipped between those runs: the structure footer, the hunt trigger,
 * and this rule. Blaming this one is a judgement, not a measurement, and no experiment isolated it.
 *
 * The reasoning, such as it is: six runs of a reproduction script is plausibly a model building
 * understanding rather than spinning, and a restart throws that understanding away. The other four
 * signals are unambiguous — identical refusals, an identical call AND result, two calls alternating,
 * a round with no call at all. None of those is ever productive. This one can be.
 *
 * TO REVERT: delete `NUDGE_FIRST`, the `nudged` set, and the `kind` field; return the reason string
 * from every branch as before. The caller treats anything non-null as a clap.
 */
const NUDGE_FIRST = true;

/** Calls already nudged this turn. A second offence by the same call is no longer ambiguous. */
let nudged = new Set<string>();

export interface LostVerdict {
  /** `nudge` — tell the model and keep its context. `clap` — end the turn and restart sober. */
  kind: 'nudge' | 'clap';
  why: string;
}

/**
 * Record a call and say whether the agent is lost, and why.
 *
 * `result` is what came back — the tool's output, or the guard's label when the call never ran.
 */
export function noteCall(round: number, tool: string, params: string, result: string, refused: boolean): LostVerdict | null {
  const h = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);
  // Joined with a byte that cannot appear in either half, so two different calls can never collide
  // into one key by the accident of where one string ends and the next begins.
  const callKey = h([tool, params].join("\u0001"));
  const key = h([callKey, result].join("\u0001"));
  window.push({ round, tool, params: params.replace(/\s+/g, ' ').slice(0, 160), key, callKey, refused });
  if (window.length > WINDOW) window.shift();
  streak = refused ? streak + 1 : 0;
  if (claps > 0) return null;

  let why: string | null = null;
  /** Set only by the same-call rule — the one signal that can be productive work. */
  let soft = false;
  if (streak >= SAME_REFUSAL) {
    why = `${streak} calls in a row were refused`;
  } else {
    const counts = new Map<string, number>();
    for (const c of window) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
    const worst = [...counts.values()].reduce((a, b) => Math.max(a, b), 0);
    const byCall = new Map<string, number>();
    for (const c of window) byCall.set(c.callKey, (byCall.get(c.callKey) ?? 0) + 1);
    const sameCall = [...byCall.values()].reduce((a, b) => Math.max(a, b), 0);
    if (worst >= SAME_PAIR) {
      why = `the same call returned the same result ${worst} times within the last ${window.length}`;
    } else if (sameCall >= SAME_CALL) {
      why = `the same call has been made ${sameCall} times within the last ${window.length}, and its `
        + `changing output has not changed what you do`;
      // The offending call is the one at the top of the count — nudge that key, not the window.
      const worstCall = [...byCall.entries()].sort((a, b) => b[1] - a[1])[0][0];
      soft = NUDGE_FIRST && !nudged.has(worstCall);
      if (soft) {
        nudged.add(worstCall);
        /**
         * EVIDENCE ONCE SPENT IS NOT COUNTED AGAIN — or the nudge cannot be obeyed.
         *
         * Without this, a nudge lasts exactly one round and always has. The six copies that triggered
         * it stay in the window, so the model's NEXT call — any call — still finds `sameCall >= 6`,
         * `nudged` now holds the key, and it claps. Measured twice on live runs: nudge at round 37,
         * clap at round 38 on the identical condition, zero refusals in the whole run. Clearing the
         * window for a fresh trajectory to grow into is the fix.
         *
         * A model that then runs the same call six MORE times has been told and carried on, which is
         * the unambiguous case the clap is for.
         */
        window = window.filter((c) => c.callKey !== worstCall);
      }
    } else if (window.length >= ALTERNATION) {
      // A,B,A,B,A,B — every entry equals the one two before it. Two calls taking turns.
      const tail = window.slice(-ALTERNATION);
      if (tail.every((c, i) => i < 2 || c.callKey === tail[i - 2].callKey) && tail[0].callKey !== tail[1].callKey) {
        why = `two calls have been alternating for ${ALTERNATION} turns without either changing anything`;
      }
    }
  }
  if (!why) return null;
  /**
   * A NUDGE COSTS NOTHING AND KEEPS THE CONTEXT. It is not counted as a clap, so the turn's one
   * restart is still available if the model ignores it and the same call comes round again.
   */
  if (soft) {
    log('INFO', 'agent_nudged', { round: String(round), why, tool });
    return { kind: 'nudge', why };
  }
  claps++;
  depth++;
  log('WARN', 'agent_lost', { round: String(round), why, tool, depth: String(depth) });
  return { kind: 'clap', why };
}

/**
 * What a NUDGED model is told — one paragraph, appended to the result it just got.
 *
 * It names the observation and hands back the decision. No instruction to stop, because the model may
 * be mid-thought and the whole point of nudging rather than clapping is that we are not sure. What it
 * must not do is run the same thing again expecting a different answer, and saying that plainly is
 * cheaper than taking its context away.
 */
/**
 * THE ACCOUNT A RUN OWES WHEN IT COULD NOT VERIFY.
 *
 * Not a failure report. The change may be correct — three of this shape scored — and the patch is
 * collected either way. What is being reported is the STATE OF THE EVIDENCE: what was changed, how
 * verification was attempted, and why it did not settle the question. A reader who was not watching
 * has to be able to decide whether to trust the diff, and "it ran for an hour" does not help them.
 */
/**
 * ASKED BEFORE THE TURN ENDS, so the report carries the one thing only the model knows.
 *
 * The rest of the account is derivable — the diff, the commands, the count. What is NOT derivable is
 * which observation was missing and what prevented it: no internet for a dependency, a suite that will
 * not run in this container, an artefact nobody can see, a test that was already red. That sentence is
 * the whole value of the handoff, and it has to come from the agent while it can still answer.
 */
export const ACCOUNT_REQUEST = [
  'Verification has been attempted three times without settling, so this turn is ending now.',
  '',
  'Before it does, answer two things in plain prose — no tool calls:',
  '1. What is the ONE observation still missing that would show your change works?',
  '2. What stopped you making it? Name the concrete obstacle — a dependency that would not install, a',
  '   suite that cannot run here, an artefact you cannot see, a test that was already failing before',
  '   you touched anything.',
  '',
  'Be specific enough that someone else can make that observation in one command. Do not re-run',
  'anything, do not edit, do not call finish. Your next reply is the last word and it is kept verbatim.',
].join('\n');

/**
 * `changed === null` means THE TREE COULD NOT BE READ — there is no repository here.
 *
 * Distinct from an empty list, which means a repository reported no changes. Printing "the working
 * tree is clean" for the first case is a claim about a tree nobody looked at, and it was acted on:
 * a turn that had written a working file was told it had written nothing.
 */
export function unverifiedReport(goal: string, changed: string[] | null, diff: string, attempts: number, account = ''): string {
  const tried = [...new Map(window.map((c) => [c.callKey, c])).values()]
    .filter((c) => c.tool === 'bash')
    .slice(-8)
    .map((c) => `- \`${c.params}\``)
    .join('\n');
  return `# Unverified change\n\n`
    + `The work below is on disk. Verification was attempted ${attempts} times and did not settle, so the `
    + `turn ended rather than continuing to re-check the same things.\n\n`
    + `## The task\n${goal}\n\n`
    + (changed === null
      ? `## What changed\nUNKNOWN — this directory is not a git repository, so the tree cannot be read. `
        + `Work may well be on disk; this report cannot say what.\n\n`
      : changed.length
      ? `## What changed\n${changed.map((c) => `- ${c}`).join('\n')}\n\n\`\`\`diff\n${diff.slice(0, 4000)}\n\`\`\`\n\n`
      : `## What changed\nNothing. The working tree is clean.\n\n`)
    + `## How verification was attempted\n${tried || '- (nothing recorded)'}\n\n`
    + `## Why it did not settle\nNone of the above produced a result that distinguished the change working `
    + `from the change not working. That is not the same as the change being wrong — a test may not exist, `
    + `may have been failing already, or may not cover this path.\n\n`
    + `## What would settle it — in the agent's own words\n${account.trim() || '(the agent gave no account)'}\n`;
}

export function lostNudge(why: string): string {
  return `\n\n[${why}. Running it again will not tell you more than it already has. Either act on what `
    + `it told you — make the edit, or check a different thing — or say what you are still missing.]`;
}

/**
 * What the next agent is told. Deterministic: the diff, the calls that went nowhere, and ONE mandate.
 *
 * Two mandates, because "verify the fix" is an instruction about nothing when there is no fix. A run
 * that edited is a run with a claim to check; a run that did not is a run with dead ends to avoid.
 *
 * WHO IS READING IT. Everything above assumes a successor process, because in headless there always is
 * one: this document IS the next turn's prompt. Interactive has no successor — the clap exits with a
 * reply instead of restarting — and it was handing the operator this same document unchanged. What a
 * person asking "is this icon set dynamically?" got back was a briefing addressed to a machine:
 * "# Report from the previous agent", and then "## Your job — Nothing has been changed yet… Make the
 * edit the task asks for." Reported by the operator, who read it, correctly, as something that was
 * never meant for them.
 *
 * So the audience is stated rather than assumed. The FACTS are identical either way — why it stopped,
 * the task, what changed, which routes are closed — because they are the same facts. What changes is
 * the mandate, which only exists to instruct a successor: with nobody to instruct, there is nothing to
 * say, and inventing an instruction for the operator would be ayin telling a person what their job is.
 */
export function lostReport(goal: string, changed: string[] | null, diff: string, why: string,
                           audience: 'agent' | 'operator' = 'agent'): string {
  // The loop's own shape, most-repeated first — that is the evidence, not the last few calls in order.
  const counts = new Map<string, { n: number; c: Call }>();
  for (const c of window) {
    const e = counts.get(c.key) ?? { n: 0, c };
    e.n++;
    counts.set(c.key, e);
  }
  for (const e of [...counts.values()].sort((a, b) => b.n - a.n).slice(0, SHOWN)) {
    const call = `${e.c.tool}(${e.c.params})`;
    // The higher count wins: how many times a route was walked in ITS WORST incarnation is the fact.
    deadEnds.set(call, Math.max(deadEnds.get(call) ?? 0, e.n));
  }
  // Oldest first: the earliest incarnations found the routes that have been closed longest.
  const worst = [...deadEnds].slice(-SHOWN * 3).map(([call, n]) => `- ${n}× \`${call}\``).join('\n');

  // Three states, not two. `null` is "no repository, so unreadable" — see `unverifiedReport`.
  const unreadable = changed === null;
  const edited = changed !== null && changed.length > 0;
  const attempt = depth > 1 ? ` This is attempt ${depth}; earlier restarts did not break the pattern.` : '';
  const head = `${audience === 'operator' ? '# Stopped — it was going in circles' : '# Report from the previous agent'}\n\n`
    + `It stopped because ${why}: it was repeating itself and nothing it did changed the working tree `
    + `or told it anything new.${attempt}\n\n`
    + `## The task\n${goal}\n\n`;
  const work = unreadable
    ? `## What it changed\nUNKNOWN — not a git repository, so the tree cannot be read.\n\n`
    : edited
    ? `## What it changed\n${changed.map((c) => `- ${c}`).join('\n')}\n\n\`\`\`diff\n${diff.slice(0, 4000)}\n\`\`\`\n\n`
    : `## What it changed\nNothing. The working tree is clean.\n\n`;
  const dead = `## Routes already closed — by this attempt and every earlier one\n${worst || '- (none recorded)'}\n\n`;
  const mandate = edited
    /**
     * THREE THINGS THAT ARE TRUE IN ANY REPOSITORY.
     *
     * The first version said "run the test that covers it, then say whether it passed", which assumes
     * such a test is reachable and that its verdict is about this change. Neither is guaranteed
     * anywhere: a test named in an issue may not exist yet, and a test that was already failing says
     * nothing about a diff written afterwards. An agent that treats a pre-existing failure as its own
     * runs the same command until something stops it — observed, repeatedly, on a correct one-line fix.
     *
     * So the instruction is about EVIDENCE, not about a test: a failure is only yours if the same test
     * passes without your change. That check is one command and it ends the question either way.
     */
    ? `## Your job\nThe diff above is already on disk. Confirm it, once, then call finish.\n`
      + `- Run the test that covers it a SINGLE time. If it fails, check whether it also fails without `
      + `your change (stash it, run, restore). A test that was already failing is not evidence about `
      + `your diff — say so and finish.\n`
      + `- If you cannot find a test that covers it, say that and finish. Do not substitute a different `
      + `test and treat its verdict as yours.\n`
      + `- Being unable to verify is an outcome, not a failure. Report what you changed and why.\n`
      + `Do not re-derive the fix, do not run the same command twice, and do not edit unless a test has `
      + `shown you the diff is wrong.`
    : unreadable
    /**
     * NEVER ORDER AN EDIT THE TREE CANNOT VOUCH FOR.
     *
     * "Nothing has been changed yet" is the sentence that made a restarted turn redo work already on
     * disk. With no repository to read, the file itself is the only witness — so the instruction is to
     * look before writing, not to write.
     */
    ? `## Your job\nWhat the previous attempt changed could not be read — this is not a git repository. `
      + `READ THE FILE the task names before you edit anything: the work may already be done, and `
      + `redoing it is how one correct fix becomes two conflicting ones. Then either finish, or take a `
      + `different route from the dead ends above.`
    : `## Your job\nNothing has been changed yet. The calls above are dead ends — take a different route. `
      + `Make the edit the task asks for, or call finish and state why the cause resists one.`;
  return head + work + dead + (audience === 'operator' ? '' : mandate);
}
