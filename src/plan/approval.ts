/**
 * approval.ts — the plan is SHOWN AND AGREED TO before anything acts on it.
 *
 * WHY THIS EXISTS. Plan mode wrote a plan and handed it straight to the agent in the same turn. The
 * one artifact in the system whose entire value is that it is cheap to correct before execution was
 * never offered for correction: the prompt that produces it says "ordered steps a coding agent
 * executes without asking a question", `gaps` was rendered and blocked nothing, and by the time the
 * operator read any of it the subagents were already running. Every shipping plan mode — Cline and
 * Roo's Plan/Act split, Cursor's, Claude Code's — is the same shape for the same reason: plan, show,
 * approve, THEN act.
 *
 * THREE ANSWERS, AND THEY ARE DETERMINISTIC. `go` runs it, `cancel` drops it, and ANYTHING ELSE is
 * revision — the plan is re-drafted with what was typed as the requirement. The two token lists are
 * exact and short: this repo retired a natural-language regex on plan mode once already, and a fuzzy
 * match here would be worse, because the thing it misfires into is minutes of execution. Revision is
 * the default because it is the safe wrong answer — a request typed at the wrong moment becomes a
 * new plan to look at, never work nobody approved.
 *
 * HEADLESS APPROVES ITSELF, and that is not a loophole. `-p` has no operator to ask, and a gate that
 * blocks in a mode with nobody at the terminal is a feature that hangs a cron job. The same argument
 * that turned plan mode ON by default in headless. `planApproval: 0` is the operator's way to have
 * the old behaviour back in the TUI too.
 *
 * IT SURVIVES THE POWER CUT. The pending record goes to `.ayin/plans/pending.json` before the operator
 * is asked, so a machine that dies between the plan and the answer comes back with the plan still
 * offered rather than with minutes of triage, research and drafting silently lost. What cannot be
 * serialized is recomputed at approval time: the project context and its executor are a regex and a
 * directory read, so the scaffold a restored plan applies is the same one it would have applied.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAyinDir } from '../ayin-dir.js';
import { log } from '../log.js';
import { getConfig } from '../prompts.js';
import { HEADLESS } from '../ui.js';
import type { PlanMode, PlanPhase, PlanStep } from './plan.js';

/** One phase, as much of it as survives a restart: the stage, its steps, and where its file is. */
export interface PendingPhase {
  phase: PlanPhase;
  steps: PlanStep[];
  file: string;
}

/** Everything needed to run a plan the operator has not answered yet. Plain JSON, on purpose. */
export interface PendingPlan {
  /** The request the plan is FOR — the turn that approves it works this, never the word "go". */
  request: string;
  goal: string;
  /** Triage's folder name, so a restored approval detects the same context the plan was written in. */
  projectDir: string;
  planPath: string;
  /**
   * `investigate` when the plan ANSWERS rather than builds. Carried because approval is where the
   * scaffold runs, and an investigation must not write a README into somebody's repository on its
   * way to answering a question about it.
   */
  mode: PlanMode;
  /** What `planContextBlock` puts in front of the model — the phase index, or the flat plan. */
  contextBody: string;
  phases: PendingPhase[];
  cwd: string;
  createdAt: string;
}

function pendingPath(cwd: string): string {
  return join(ensureAyinDir(cwd, 'plans'), 'pending.json');
}

/** Is the operator asked at all? Never in headless, and never when they have switched the gate off. */
export function approvalRequired(): boolean {
  return !HEADLESS && getConfig('planApproval', 1) > 0;
}

/** Write the pending record BEFORE asking, so the question survives the machine that asked it. */
export function storePending(p: PendingPlan): void {
  try {
    writeFileSync(pendingPath(p.cwd), JSON.stringify(p, null, 1));
    log('INFO', 'plan_pending_stored', { plan: p.planPath, phases: String(p.phases.length) });
  } catch (err) {
    // A plan that cannot be remembered across a crash is still a plan worth offering right now.
    log('WARN', 'plan_pending_store_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** The plan awaiting an answer, or null. Never throws — a corrupt record is the same as none. */
export function loadPending(cwd: string): PendingPlan | null {
  const path = pendingPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const p = JSON.parse(readFileSync(path, 'utf8')) as PendingPlan;
    // A record from another directory is not this session's question. `cwd` moves mid-session
    // (`cd ../other-thing`), and answering "go" there must not run a plan written elsewhere.
    if (!p.request || p.cwd !== cwd) return null;
    return p;
  } catch (err) {
    log('WARN', 'plan_pending_unreadable', { path, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export function clearPending(cwd: string): void {
  try { rmSync(pendingPath(cwd), { force: true }); } catch { /* already gone */ }
}

/**
 * The exact words that mean yes and no. Everything else is revision — see the header.
 *
 * Whole-input matches only, after trimming and dropping trailing punctuation: "go" is approval and
 * "go and also rename the module" is a revision, which is the reading that cannot lose work.
 */
const APPROVE = new Set([
  'go', 'yes', 'y', 'ok', 'okay', 'approve', 'approved', 'run it', 'do it', 'proceed', 'ship it', 'go ahead',
]);
const CANCEL = new Set([
  'no', 'n', 'cancel', 'stop', 'abort', 'drop it', 'forget it', 'never mind', 'nevermind',
]);

export type Answer =
  | { kind: 'approve' }
  | { kind: 'cancel' }
  | { kind: 'revise'; feedback: string }
  | { kind: 'unclear'; said: string };

/**
 * SHORTER THAN THIS AND IT CANNOT BE A REVISION — it is an answer that missed.
 *
 * "Anything else is a revision" is the safe default for a sentence and a trap for a token. Measured
 * on the first real session this shipped into: the operator replied with THREE CHARACTERS, it was
 * read as a revision, the plan was thrown away and 117 seconds of planning were spent again. Nobody
 * revises a fourteen-step plan in three characters; they say yes in a word this list does not happen
 * to contain. Under this length, an unrecognised reply is a question back — the plan STAYS pending,
 * so the wrong guess costs one line instead of two minutes.
 */
const SHORTEST_REVISION = 12;

export function readAnswer(input: string): Answer {
  // Trailing punctuation only. Anything that strips more is a matcher pretending to understand.
  const word = input.trim().replace(/[.!?]+$/, '').toLowerCase();
  if (APPROVE.has(word)) return { kind: 'approve' };
  if (CANCEL.has(word)) return { kind: 'cancel' };
  if (word.length < SHORTEST_REVISION) return { kind: 'unclear', said: input.trim() };
  return { kind: 'revise', feedback: input.trim() };
}

/**
 * What the operator is shown while the plan waits. Painted, never sent to a model.
 *
 * THE PLAN IS SHOWN, NOT FILED. This printed a shape and a path — "5 phases · 24 steps" and a
 * filename — and then asked for `go`. Approving something you have not read is not approval, and the
 * one thing the gate exists to buy is a person looking at the proposal before anything is written.
 * Sending the reader to a file to do that spends the turn they were about to answer in.
 *
 * ONE LINE PER STEP: its title and the paths it touches, which is what distinguishes a step worth
 * stopping for from a step worth skimming. The rationale and the verify command stay in the file,
 * because they are what you read AFTER deciding to look closer, and the path is still printed for
 * exactly that.
 */
export function approvalNotice(
  planPath: string,
  phases: number,
  steps: number,
  detail: ReadonlyArray<PendingPhase> = [],
): string {
  const shape = phases > 0
    ? `${phases} phase${phases === 1 ? '' : 's'} · ${steps} step${steps === 1 ? '' : 's'}`
    : `${steps} step${steps === 1 ? '' : 's'}`;
  const lines = [`PLAN READY — ${shape}. Nothing has been changed on disk.`, ''];
  for (const p of detail) {
    // A flat plan is tracked as one synthetic phase titled "the plan"; it has no goal worth a header.
    const head = detail.length === 1 && p.phase.title === 'the plan'
      ? null
      : `  ${p.phase.id}. ${p.phase.title}${p.phase.goal ? ` — ${p.phase.goal}` : ''}`;
    if (head) lines.push(head);
    for (const st of p.steps) {
      const where = st.files.length ? ` · ${st.files.join(', ')}` : '';
      lines.push(`${head ? '     ' : '  '}${st.id}. ${st.title}${where}`);
    }
    if (head) lines.push('');
  }
  if (detail.length && !lines[lines.length - 1]) lines.pop();
  if (detail.length) lines.push('');
  lines.push(`  ${planPath}`);
  lines.push('  Reply `go` to run it, `cancel` to drop it, or say what to change and it will be re-planned.');
  return lines.join('\n');
}

/** Asked back when a short reply matched nothing. The plan is still waiting — say so, and stop. */
export function unclearNotice(said: string): string {
  return `I did not read ${JSON.stringify(said)} as an answer, and it is too short to be a change to make — `
    + 'so the plan is still waiting, nothing has run.\n'
    + '  `go` to run it · `cancel` to drop it · or a sentence saying what to change.';
}
