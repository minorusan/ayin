/**
 * progress.ts — the plan as LIVE STATE for the turn that is working it, not a document read once.
 *
 * WHAT WAS WRONG. `planContextBlock` rendered the plan into the turn's volatile block and nothing ever
 * touched it again: the same static index rode along in every round, with no record of which phase had
 * landed, no check that any of it had, and no way for what happened during execution to change what
 * was still planned. Plan-then-execute, with the back-edge missing. The document even told the model
 * "if a step turns out to be wrong, say which one and why, then adapt" — delegating adaptation to
 * prose that nothing reads, verifies or writes down.
 *
 * SO THREE THINGS LIVE HERE, and they are one mechanism:
 *
 *   1. STATE. Which phase is done, which is current, what its checks said. Rendered into the turn's
 *      context each round by `planProgressBlock`, so the model is told where the job actually is
 *      rather than re-deriving it from its own transcript.
 *   2. VERIFICATION at the phase boundary — `verifySteps` over that phase's steps. The boundary is the
 *      only seam available: ayin's phases are worked by the MODEL calling `subagent`, so the return of
 *      that call is where a harness can insert a check that is not itself a request.
 *   3. THE REPLAN. A phase whose checks FAILED has invalidated the assumptions the phases after it
 *      were drafted from, so those are re-drafted with the failure as a finding, and their files are
 *      rewritten in place. Bounded by `planReplans`, because a replan that can loop is worse than the
 *      drift it corrects — the same bound, for the same reason, as `planRepairPasses`.
 *
 * NOTHING HERE BLOCKS THE TURN. A verification that cannot run, a replan that will not draft, a phase
 * file that cannot be rewritten: each is reported and the work continues. The gate this belongs to is
 * QA, and a planner that can fail a turn is a planner nobody leaves switched on.
 */

import { writeFileSync } from 'node:fs';
import { log } from '../log.js';
import { getConfig } from '../prompts.js';
import { prompts as promptsService, packagePath } from '../prompts-service.js';
import { buildActionablePlan, type ActionablePlanInput, type PlanPhase, type PlanStep } from './plan.js';
import { renderVerification, verifySteps, type PhaseVerification } from './verify.js';

const progressPrompts = promptsService.register('plan', packagePath('prompts', 'plan')).bundle;

/** One phase as the turn works it: what was planned, where it lives, and what has happened to it. */
export interface PhaseRuntime {
  phase: PlanPhase;
  steps: PlanStep[];
  /** Absolute path of the phase's own plan file — the key the `subagent` tool is called with. */
  file: string;
  state: 'pending' | 'worked' | 'verified' | 'failed';
  verification: PhaseVerification | null;
  /** True once a replan rewrote this phase's file after an earlier phase failed its checks. */
  replanned: boolean;
}

interface ProgressState {
  /** The index document's path, for the operator-facing lines. */
  planPath: string;
  phases: PhaseRuntime[];
  /** Everything `buildActionablePlan` needs to draft a phase again. */
  input: ActionablePlanInput;
  /** Where the verification commands run. */
  cwd: string;
  replansSpent: number;
}

let state: ProgressState | null = null;

/**
 * Start tracking a phased plan for this turn. Called once the plan is APPROVED, never before — an
 * unapproved plan may still be revised, and progress against a document that is about to change is
 * noise.
 */
export function beginPlanProgress(init: Omit<ProgressState, 'replansSpent'>): void {
  state = { ...init, replansSpent: 0 };
  log('INFO', 'plan_progress_begin', { phases: String(init.phases.length), plan: init.planPath });
}

/** Forget the plan. Every turn starts with no progress, including one that was never planned. */
export function endPlanProgress(): void {
  state = null;
}

export function planProgressActive(): boolean {
  return state !== null && state.phases.length > 0;
}

/** The phase whose plan file is `file`, or null — the arbiter may pass a path that is not one. */
function phaseByFile(file: string): PhaseRuntime | null {
  if (!state) return null;
  const want = file.trim();
  return state.phases.find((p) => p.file === want) ?? null;
}

/**
 * A phase was worked: check it, and if the checks failed, re-plan what is left.
 *
 * Returns the text to append to the `subagent` tool result — the arbiter decides what to do next from
 * that result, so a check whose answer went only to a log would change nothing about the next round.
 * Returns '' when this call had nothing to do with a tracked phase, which is the ordinary case for a
 * subagent spawned outside plan mode.
 */
export async function notePhaseWorked(planFile: string | undefined, signal?: AbortSignal): Promise<string> {
  if (!state || !planFile) return '';
  const rt = phaseByFile(planFile);
  if (!rt) return '';
  rt.state = 'worked';

  const verification = await verifySteps(rt.steps, state.cwd, signal);
  rt.verification = verification;
  rt.state = verification.failed > 0 ? 'failed' : 'verified';
  log('INFO', 'plan_phase_verified', {
    phase: String(rt.phase.id), state: rt.state,
    passed: String(verification.passed), failed: String(verification.failed),
    unverified: String(verification.unverified), unchecked: String(verification.unchecked),
  });

  const lines = [renderVerification(verification)];
  if (rt.state === 'failed') {
    lines.push(
      `Phase ${rt.phase.id} is NOT done: "${rt.phase.goal.trim()}" is not true yet. Fix what the failing `
      + 'check names before starting the next phase.',
    );
    lines.push(await replanRemaining(rt));
  }
  return lines.filter(Boolean).join('\n\n');
}

/**
 * Re-draft every phase after the one that failed, with the failure as a finding.
 *
 * WHY THE PHASES AND NOT THE BREAKDOWN. The stages of the job did not change — "it serves the data"
 * is still a stage whatever broke in "the project builds". What changed is the ground each later
 * stage was planned against, which is exactly what `findings` carries. Re-deciding the breakdown here
 * would also renumber phases the operator is watching and orphan the files already on disk.
 */
async function replanRemaining(failed: PhaseRuntime): Promise<string> {
  if (!state) return '';
  const budget = getConfig('planReplans', 1);
  const later = state.phases.filter((p) => p.phase.id > failed.phase.id && p.steps.length > 0);
  if (later.length === 0) return '';
  if (state.replansSpent >= budget) {
    log('INFO', 'plan_replan_skipped', { reason: 'budget spent', spent: String(state.replansSpent) });
    return `The phases after this one were NOT re-planned — the replan budget (planReplans=${budget}) is spent. `
      + 'Read them against what just failed before you work them.';
  }
  state.replansSpent++;

  const finding = progressPrompts.get('replanFinding', {
    PHASE: `${failed.phase.id} — ${failed.phase.title}`,
    GOAL: failed.phase.goal.trim(),
    FAILURES: failed.verification?.results
      .filter((r) => r.state === 'failed')
      .map((r) => `- step ${r.step} (${r.title}): \`${r.cmd}\` exited ${r.code}\n${r.output}`.trim())
      .join('\n') ?? '',
  });

  const rewritten: number[] = [];
  for (const rt of later) {
    let drafted;
    try {
      drafted = await buildActionablePlan({
        ...state.input,
        phase: rt.phase,
        findings: [...state.input.findings, finding],
      });
    } catch (err) {
      log('WARN', 'plan_replan_failed', { phase: String(rt.phase.id), error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    // A phase that will not re-draft keeps the plan it had. Half a plan is still the plan the
    // operator approved, and replacing it with nothing is the one outcome worse than a stale one.
    if (!drafted) continue;
    rt.steps = drafted.steps;
    rt.replanned = true;
    try {
      writeFileSync(rt.file, [
        `<!-- Phase ${rt.phase.id}: ${rt.phase.title} -->`,
        `<!-- Index: ${state.planPath} -->`,
        `<!-- RE-PLANNED after phase ${failed.phase.id} failed its checks. -->`,
        '',
        `# Phase ${rt.phase.id} — ${rt.phase.title}`,
        '',
        `**Done when:** ${rt.phase.goal.trim()}`,
        '',
        drafted.markdown.trim(),
        '',
      ].join('\n'));
      rewritten.push(rt.phase.id);
    } catch (err) {
      log('WARN', 'plan_replan_write_failed', { file: rt.file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  log('INFO', 'plan_replan', { after: String(failed.phase.id), rewritten: String(rewritten.length) });
  if (rewritten.length === 0) return '';
  return `RE-PLANNED: phase${rewritten.length === 1 ? '' : 's'} ${rewritten.join(', ')} ${rewritten.length === 1 ? 'was' : 'were'} `
    + 'drafted before this failure and have been rewritten against it. Their plan files on disk are new — '
    + 'the subagent you hand them to reads the file, so pass the same path and it gets the new version.';
}

/** Anything still unverified, checked once before the turn ends. Returns '' when there is nothing to say. */
export async function finishPlanProgress(signal?: AbortSignal): Promise<string> {
  if (!state) return '';
  // THE ARBITER MAY NEVER HAVE USED `subagent`. `planContext.txt` tells it to work the phases itself
  // when the tool is not among its own, and a turn that took that path would otherwise end with every
  // check unrun — the exact hole this module exists to close, left open by its own primary seam.
  const unchecked = state.phases.filter((p) => p.verification === null && p.steps.length > 0);
  if (unchecked.length === 0) return '';
  const lines: string[] = [];
  for (const rt of unchecked) {
    const verification = await verifySteps(rt.steps, state.cwd, signal);
    rt.verification = verification;
    rt.state = verification.failed > 0 ? 'failed' : 'verified';
    if (verification.results.length === 0) continue;
    lines.push(`Phase ${rt.phase.id} — ${rt.phase.title}\n${renderVerification(verification)}`);
  }
  if (lines.length) log('INFO', 'plan_progress_final', { phases: String(lines.length) });
  return lines.join('\n\n');
}

/**
 * The live block for the turn's volatile context — where the job IS, as facts rather than as the
 * model's recollection of its own rounds.
 *
 * Empty until something has actually happened, because a block that says "3 phases, all pending" is
 * the index the plan block already carries, restated one screen lower. Position is load-bearing and
 * the budget is attention: this earns its characters only once it can report something the plan
 * document cannot.
 */
export function planProgressBlock(): string {
  if (!state || state.phases.length === 0) return '';
  if (state.phases.every((p) => p.state === 'pending')) return '';
  const glyph = { pending: '·', worked: '▸', verified: '✓', failed: '✗' } as const;
  const rows = state.phases.map((p) => {
    const v = p.verification;
    const checks = v && v.results.length
      ? ` — checks: ${v.passed} passed, ${v.failed} failed, ${v.unverified} unverified`
      : '';
    return `${glyph[p.state]} phase ${p.phase.id} ${p.phase.title} — ${p.state}${checks}${p.replanned ? ' (re-planned)' : ''}`;
  });
  const next = state.phases.find((p) => p.state === 'pending' || p.state === 'failed');
  return progressPrompts.get('progressContext', {
    ROWS: rows.join('\n'),
    NEXT: next
      ? next.state === 'failed'
        ? `Phase ${next.phase.id} FAILED its checks and is not done. Fix it before anything else.`
        : `Next: phase ${next.phase.id} — ${next.phase.title}. Its plan is ${next.file}.`
      : 'Every phase has been worked and checked.',
  });
}
