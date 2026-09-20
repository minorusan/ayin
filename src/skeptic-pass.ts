/**
 * skeptic-pass.ts — "name what would prove you wrong, then go look."
 *
 * THE MEASUREMENT THIS EXISTS FOR. Across 20 real runs, the split was not by repo size
 * (r = 0.19, and the three LARGEST trees went 5/5). It was by whether the bug's symptom is something
 * the agent can observe:
 *
 *   computational / API behaviour        12/13 committed an edit
 *   symptom in RENDERED OUTPUT (PNG/PDF)  1/6
 *
 * And a real run said why, in its own words: it had the
 * correct root cause AND the correct one-line fix (`hlcode.strip()` in `visit_literal`) and declined to
 * apply it — "Unconfirmed: I did not run the LaTeX build to verify the exact rendered output."
 *
 * That is not a reasoning failure. The model could not SEE the artefact, so it would not commit. The
 * judge cannot help here: it asks "are you done?", which invites yes. This asks for an OBSERVATION,
 * which is an action and either happens or does not.
 *
 * Deliberately NOT a deterministic QA loop. We do not know what proof looks like for an arbitrary task
 * — rendering a PDF, importing a module, diffing a fixture, reading a PNG. The model does. So it is
 * asked to devise the check and then given real rounds and real tools to run it.
 */

import { log } from './log.js';

/** One pass per turn. A gate that can re-trigger on its own answer is a loop, not a gate. */
let passUsed = false;
let inPass = false;
let roundsLeftInPass = 0;

/**
 * VERIFICATION IS BUDGETED. Three attempts across the whole run, then the turn ends with an account.
 *
 * The pass used to expire and change nothing — the reserve ran out, `inPass` went false, and the loop
 * carried on exactly as if it had never opened. So an agent that would not conclude simply kept
 * verifying: measured on a live run, the correct one-line fix on disk from round 24, the pass opened
 * once, spent its eight rounds, expired, and the model went on running the same four test commands
 * indefinitely. Asking for a proof and then not caring whether one arrived is not a gate.
 *
 * Counted per RUN, not per turn, because a restart opens a fresh turn and would otherwise hand back a
 * full budget — three attempts would become three attempts per restart, forever.
 *
 * This is a budget on FAILING TO VERIFY, not on work. An agent that proves its change closes the pass
 * and never touches this; an agent that keeps finding new things keeps going. What it bounds is the
 * one behaviour that has no end state of its own.
 */
const VERIFY_ATTEMPTS = 3;
let attemptsThisRun = 0;
let lastExpired = false;

/**
 * TURNS SPENT TRYING TO CONFIRM A CHANGE THAT IS ALREADY ON DISK.
 *
 * Counting skeptic passes was the wrong unit, and the run that proved it is instructive: the pass
 * opens on an EDIT or on FINISH, so an agent that edits once and then verifies forever opens exactly
 * one pass, ever. Two restarts later the counter still read 1 and the budget could never engage —
 * a budget that cannot be spent by the behaviour it exists to bound.
 *
 * A TURN is the unit. Each begins with `beginVerifyTurn`, and any turn that starts with a change
 * already in the tree is a turn spent on confirmation rather than on finding the answer. Three of
 * those and the run says what it could not prove and stops. Finding the answer is still unbounded;
 * this counts only the part that has no end state of its own.
 */
let verifyTurns = 0;

/** Per RUN. Called once at the top of `runAgent`, never on a restart. */
export function resetSkepticRun(): void {
  attemptsThisRun = 0;
  lastExpired = false;
  verifyTurns = 0;
}

/**
 * Called at the top of every turn. `hasEdit` is whether the working tree already carries a change —
 * on the first turn it is false, and after a restart it is true for exactly the runs this bounds.
 */
export function beginVerifyTurn(hasEdit: boolean): void {
  if (hasEdit) verifyTurns++;
}

/** How many turns this run has spent confirming, and whether that budget is gone. */
export function verifyAttempts(): number { return verifyTurns; }
export function verifyBudgetSpent(): boolean { return verifyTurns >= VERIFY_ATTEMPTS; }

export function resetSkepticPass(): void {
  passUsed = false; inPass = false; roundsLeftInPass = 0;
}
export function inSkepticPass(): boolean { return inPass; }

/** How many rounds the model gets to prove itself, capped by what the turn has left. */
const PASS_ROUNDS = 8;

export interface FinishContext {
  /** 'edit' — a change just landed. 'finish' — the model says it is done. */
  at?: 'edit' | 'finish';
  /** Files this turn actually changed, by path. Empty ⇒ nothing to prove. */
  changedFiles: string[];
  /** Did a command run AFTER the last mutation and exit 0? Then proof already exists. */
  provenSinceEdit: boolean;
  /** `finish(cause:)` with no edit is a diagnosis, not a claim about a change. */
  isDiagnosisOnly: boolean;
  /** Rounds remaining in the turn. */
  roundsLeft: number;
}

/**
 * Should `finish()` be held for a proof attempt? Returns the injection, or null to honour it.
 *
 * Every skip here is a case where the pass would spend rounds and learn nothing — which is the failure
 * mode that would make this get switched off.
 */
export function skepticInjection(ctx: FinishContext): string | null {
  if (passUsed) return null;                       // one per turn, always
  // NO ROUNDS-LEFT SKIP. It made the gate unreachable.
  //
  // Measured on a real run: `finish` was called exactly ONCE, at round 89 of 90, so roundsLeft
  // was 1 and the pass skipped. That is not bad luck — the convergence ladder tells the model "only 3
  // round(s) left, write your final answer now", so finishing at the end of the budget is the behaviour
  // we asked for. A verification budget carved out of the investigation budget is therefore always
  // empty by the time it is needed. The pass gets its OWN reserve instead; see PASS_ROUNDS.
  if (!ctx.changedFiles.length) return null;       // nothing was changed; nothing to falsify
  if (ctx.isDiagnosisOnly) return null;            // an honest "here is the cause, I did not fix it"
  if (ctx.provenSinceEdit) return null;            // a test already passed after the last edit

  passUsed = true;
  inPass = true;
  attemptsThisRun++;
  lastExpired = false;
  // Its own reserve, granted on top of whatever the turn had left — proving a change is not the same
  // activity as investigating one, and must not be paid for out of the same purse.
  roundsLeftInPass = PASS_ROUNDS;
  log('INFO', 'skeptic_pass_opened', {
    files: String(ctx.changedFiles.length), rounds: String(roundsLeftInPass),
  });

  // ORDER MATTERS: name the expectation BEFORE making the observation. Otherwise the model runs
  // something, sees whatever it sees, and calls that agreement — the prediction has to be in the
  // window before the result arrives so a mismatch is visible to it and to us.
  return [
    ctx.at === 'edit'
      ? `That change is on disk. Before you build anything on top of it, prove it does what you think.`
      : `Not yet. Before this is accepted, prove it.`,
    ``,
    `You changed: ${ctx.changedFiles.join(', ')}`,
    ``,
    `1. State the ONE observation that would look different if your change works than if it does not.`,
    `   Say what you expect to see, before you look.`,
    `2. Then go and make that observation.`,
    ``,
    `You may run anything that is NOT destructive, costs no money, and touches nothing outside this`,
    `working tree: build it, render it, import it, execute the failing case, diff the output. If the`,
    `evidence is visual — a plot, a PDF, a rendered page — produce a PNG and call look(path) on it.`,
    `You will be shown the image and can judge it yourself.`,
    ``,
    `A failure is only YOURS if the same thing passes without your change. Before you believe one,`,
    `check that — stash the change, run it again, restore. Something that was already broken tells you`,
    `nothing about what you did, and treating it as a verdict is how a correct fix gets rewritten.`,
    ``,
    `If your expectation and the observation disagree, you were wrong: keep working, do not finish.`,
    `If no such observation is possible, say exactly that and call finish again, naming what stays`,
    `unconfirmed. You have ~${roundsLeftInPass} round(s) for this.`,
  ].join('\n');
}

/** Counts a round spent inside the pass; the pass ends when the budget runs out. */
export function tickSkepticPass(): void {
  if (!inPass) return;
  roundsLeftInPass--;
  if (roundsLeftInPass <= 0) {
    inPass = false;
    lastExpired = true;
    log("INFO", "skeptic_pass_expired", { attempt: String(attemptsThisRun), of: String(VERIFY_ATTEMPTS) });
  }
}

/** Closed because the model called finish again — the normal exit. */
export function closeSkepticPass(): void {
  if (!inPass) return;
  inPass = false;
  lastExpired = false;
  log('INFO', 'skeptic_pass_closed', {});
}
