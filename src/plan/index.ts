/**
 * Plan mode — a big request gets a written plan BEFORE the agent touches anything.
 *
 * WHY. A 2000-character request is usually several features wearing one paragraph. Handed straight to
 * the round loop, the model starts on whichever sentence it read last, discovers the coupling in
 * round nine, and spends the rest of its budget repairing its own first guess. The cheapest fix is
 * the oldest one: look before you leap, and write down what you saw.
 *
 * OFF BY DEFAULT, then two doors, both deterministic. Plan mode does nothing at all for a session
 * until `/plan` (bare) toggles it on — the most expensive gate in the system (triage + mandatory API
 * research + explore loops + a long document) earns opt-in, not an implicit size guess nobody asked
 * to trust. Once toggled on:
 *
 *   SIZE     prompt length ≥ planMinChars  →  ONE triage call: cross-feature / multi-feature?
 *                                             yes → plan.  no → straight through, nothing lost.
 *   EXPLICIT `/planthis <text>` — the slash command in `index.ts` — sets `forcePlanNextTurn()` and
 *            strips the token before the text gets here, forcing a plan for THIS prompt at ANY
 *            length, triage cannot veto it, and — unlike the size door — it works EVEN WHEN THE
 *            SESSION TOGGLE IS OFF, for the one time you want a plan without turning the feature on.
 *
 * Length alone would drag every long bug report into planning; triage alone would need an LLM call on
 * every single turn. Together: one extra cheap call, only for genuinely big prompts. And the explicit
 * door exists because "plan the auth rewrite" is nine words: size is a proxy for "this needs thought",
 * and a proxy must never overrule the person who can just say so. A prior version tried to widen this
 * door with a natural-language regex ("plan it", "deep investigate the codebase", …); retired — plan
 * mode is the most expensive gate in the system, and a fuzzy phrase match on it is exactly the kind of
 * thing that misfires unpredictably from outside one specific conversation. `/planthis` is unambiguous.
 *
 * THE PLAN, IN ORDER (each step feeds the next):
 *   0. DETECT   — which KIND of project this is, from the tree and (when the tree is empty) from the
 *      request itself. That choice selects the PLAN EXECUTOR for every step below; see
 *      `executors/detect.ts` and `executors/plan/`. It is recomputed every turn, because the working
 *      directory changes and a stale answer would plan a Unity project with Arduino rules.
 *   1. SCAFFOLD (PREVIEWED) — deterministic file creation for the chosen project type, asked with
 *      `dryRun` so planning writes nothing. A README the project must have is a file operation rather
 *      than a criterion the agent is asked to remember and the QA gate spends a fix pass enforcing —
 *      but it lands when the operator approves, not while they are still reading. See
 *      `applyPlanScaffold` and `plan/approval.ts`.
 *   2. SURVEY   — what this project is, what it can serve, how it can be observed — IN ITS OWN TERMS.
 *      The generic survey talks about HTTP servers, bundlers and logger modules; on an Arduino sketch
 *      every one of those is wrong in a way that steers the plan toward work the project does not
 *      need. The executor decides what a survey of its project type says.
 *   3. API RESEARCH — MANDATORY when a third-party API is involved: its CURRENT shape, off the web,
 *      because that is the one thing a model must never answer from memory (see `researchApis`).
 *   4. DOMAIN GROUNDING — the executor's shipped reference material (for Arduino: the component
 *      catalog), so real-world facts come from a reviewed file rather than from recall. This is now
 *      keyed off the DETECTED project type, which is what finally makes it work on the turn that
 *      CREATES the project — the old `isArduinoProject(root)` check needed an `.ino` to already
 *      exist, so grounding was withheld on exactly the turn that needed it most.
 *   5. EXPLORE  — the context around the problem: what already exists, who calls it, what it assumes.
 *      Skipped entirely for a greenfield project: two agentic loops over an empty directory can only
 *      report "nothing found". Once the job has PHASES, one further call per phase is spent from a
 *      shared budget (`planPhaseExploreCalls`) so each stage is planned against its own part of the
 *      codebase rather than all of them against the same undifferentiated findings.
 *   6. DELIVERABLES — what must exist ON DISK when the work is done, stated by the executor and later
 *      checked by QA as files rather than as claims.
 *   7. GAPS     — what is still unknown or undecided, named rather than guessed at.
 *   8. FILES    — the key files to change, with the change outlined per file.
 *   9. OBSERVABILITY — how work in THIS kind of project is watched working: a logger module and an
 *      env switch in a service, Serial Monitor and `arduino-cli compile` in firmware.
 *
 * The document is written to `.ayin/plans/ayin-plan-<timestamp>.md` (or `AYIN_PLAN_DIR`) — on disk BEFORE
 * the agent starts, so a machine that dies mid-implementation leaves the thinking behind rather than
 * only half a feature.
 *
 * THEN THE OPERATOR IS ASKED. Nothing outside `.ayin/` has been touched at that point, and the turn
 * ENDS: `runPlan` returns `kind: 'awaiting'` and their next message is `go`, `cancel`, or the change to
 * make. `plan/approval.ts` owns that, including the pending record that survives a power cut. Headless
 * approves itself — there is nobody to ask. Once approved, the scaffold runs, the plan goes into the
 * turn's context, and `plan/progress.ts` tracks it: each phase's `verifyCmd`s are RUN at the phase
 * boundary, and a phase that fails its checks re-plans the phases after it.
 *
 * `AYIN_PLAN=0` is an absolute operator kill switch — it beats the session toggle AND `/planthis`.
 * `planMinChars: 0` (from `prompts.json`) disables just the size door once the session toggle is on.
 *
 * THE DOCUMENT ITSELF is now the ACTIONABLE plan in `plan.ts` — typed steps a deterministic validator
 * has already checked, not the nine prose sections above. `AYIN_PLAN_GRAPH=0` swaps them back. Every
 * gathering step (0-7, 9) is unchanged either way; only what the gathered context is written INTO moves.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llmChat } from '../llm/manager.js';
import { llmCall } from '../llm.js';
import { log } from '../log.js';
import { ensureAyinDir } from '../ayin-dir.js';
import { notePostmortemContext } from '../postmortem.js';
import { getConfig, getPrompt } from '../prompts.js';
import { prompts as promptsService, packagePath } from '../prompts-service.js';
import { recentPrompts } from '../session-record.js';
import { exploreExecute } from '../tools/explore/index.js';
import { webSearch } from '../tools/web-search.js';
import { pushActivity, setActivityDetail } from '../activity.js';
import { addMessage, setAgentStatus, formatToolCallForChat, formatToolResultForChat } from '../ui.js';
import { PLAN_CARD, PLAN_GLYPH, columns, phaseBody, shortPath } from './present.js';
import { checkDeliverables } from '../executors/deliverables.js';
import { classifyProjectType, requestNeedsMoreThanScaffold } from '../executors/classify.js';
import { detectProject, describeProject, isFreshDirectory } from '../executors/detect.js';
import { planExecutorFor } from '../executors/registry.js';
import type { ProjectContext } from '../executors/types.js';
import { ensureToolRuntime } from '../tool-wiring.js';
import { buildActionablePlan, buildPhasedPlan, isActionablePlanEnabled, renderDeliverableList, renderPhaseIndex } from './plan.js';
import type { PlanMode, PlanPhase } from './plan.js';
import {
  approvalNotice, approvalRequired, clearPending, loadPending, readAnswer, storePending, unclearNotice,
  type PendingPhase, type PendingPlan,
} from './approval.js';
import { beginPlanProgress, endPlanProgress, type PhaseRuntime } from './progress.js';
import type { PlanExecutor } from '../executors/types.js';

// This module imports tool implementations directly, so it must not depend on the registry having
// been loaded by someone else first. Idempotent.
ensureToolRuntime();

/**
 * The `plan` namespace — everything plan mode *says* to a model that is not the two big documents
 * already in the `ayin` namespace: the two fixed exploration questions, the two "this API was not
 * researched" notices the plan is instructed to act on, and the `<plan>` pre-prompt block.
 */
const planPrompts = promptsService.register('plan', packagePath('prompts', 'plan')).bundle;

export interface PlanResult {
  /**
   * `plan` — the full written document. `grounding` — the project type's reference material only, no
   * document, no file on disk. `awaiting` — the document exists and is on disk, and the operator has
   * been asked; the turn ENDS here and their next message answers (see `plan/approval.ts`).
   *
   * THE SECOND MODE EXISTS BECAUSE THE FIRST ONE IS EXPENSIVE AND WAS BEING SPENT ON BLINK. Making a
   * triage veto yield to domain grounding fixed a real hole (a single-feature Arduino request got no
   * component catalog, no PWM rule, no sketch-naming rule — and shipped a sketch that could not
   * compile). But it fixed it by writing a full nine-section plan for "blink the built-in LED once per
   * second": measured at 193s versus 48s, ~145s of it one long generation nobody needed. What that
   * request needed was the four build-breaking rules, which cost nothing to inject — they are a
   * deterministic string.
   *
   * So the two purposes are separated. Triage says complex, or the user said `/planthis` → a plan.
   * Triage says simple but the project type has reference material → grounding alone, no document.
   */
  kind: 'plan' | 'grounding' | 'awaiting';
  /** `investigate` when this plan answers a question rather than changing the repository. */
  mode?: PlanMode;
  /** Where the document was written. Empty for `grounding` — there is no document. */
  path: string;
  body: string;
  features: string[];
  /**
   * The rendered deliverable list. Carried on the `grounding` result because the plan document was the
   * ONLY place the deliverables were ever stated, and dropping the document silently dropped them.
   *
   * Measured: on the grounding path the scaffolded README stayed an untouched stub, because nothing
   * told the agent to fill it in — and a stub is WORSE than no file, since it satisfies "the README
   * exists" while containing nothing. The diagram went missing for the same reason: the plan used to
   * carry "run arduino_diagram" as a step.
   */
  deliverables?: string;
  /**
   * How many phases the plan has — 0 when it was not decomposed.
   *
   * Carried because the turn's instructions have to state it. `planContext.txt` told the model "every
   * phase is part of the job: stopping after the first delivers a project nobody asked for", which is
   * right for five phases and is an instruction to OVERRUN when there is one. Measured: on a one-phase
   * plan the arbiter finished phase 1, announced "I will proceed to the second phase of the plan", and
   * invented both the phase and a plan file path for it.
   */
  phaseCount?: number;
}

/**
 * Plan mode is OFF by default for the session — it is the single most expensive gate in the system
 * (triage + mandatory API research + explore loops + a long written document), and a size threshold
 * alone was still a proxy nobody explicitly asked to trust. `/plan` (bare, in `index.ts`) TOGGLES this
 * for the rest of the session; with it on, the two doors below (size, or an explicit `/planthis`)
 * behave exactly as before. With it off — the default — NEITHER door applies; only `/planthis <text>`
 * still gets through, once, regardless of the toggle.
 */
/**
 * ON BY DEFAULT. `AYIN_PLAN=0` turns it off; `/plan` toggles it for the session.
 *
 * It was opt-in, and opt-in made it unreachable exactly where it matters most. Headless (`-p`) has no
 * TUI and therefore no way to type `/plan`, so every scripted run — a harness, a cron job, an operator
 * demonstrating the thing — silently got no plan, no phases, and no `executor.scaffold()`. Measured on
 * a greenfield request: without the flag the agent improvised a project and never entered plan mode at
 * all; with it, the same request produced a deterministic scaffold, a grounded plan and three
 * validated phases. A feature whose default is "off" in the mode nobody can toggle is a feature that
 * does not run.
 *
 * The cost is bounded and was already designed for: `runPlan` still returns before spending anything
 * on a request under `planToggledMinChars`, and triage's veto still refuses to plan a single-feature
 * ask. What changes is that the door is open.
 *
 * `AYIN_PLAN=1` is kept as an explicit force — it now agrees with the default rather than creating it,
 * and a harness that sets it keeps working.
 */
let sessionEnabled = process.env.AYIN_PLAN !== '0';

export function togglePlanSession(): boolean {
  sessionEnabled = !sessionEnabled;
  return sessionEnabled;
}

export function isPlanSessionEnabled(): boolean {
  return sessionEnabled;
}

/**
 * `/planthis <text>` (the interactive slash command in `index.ts`) sets this — force plan mode for
 * THIS one prompt, regardless of the session toggle. One-shot, and consumed even when planning then
 * fails — a flag that survived its turn would silently plan the NEXT unrelated prompt, which is the
 * sort of surprise that costs a GPU-minute and trust. (Named `forcePlanNextTurn` for history: this used
 * to be what bare `/plan <text>` set, before `/plan` became the session toggle and `/planthis` took
 * over the one-shot-force job.)
 */
let forced = false;

export function forcePlanNextTurn(): void {
  forced = true;
}

/**
 * WHAT THIS TURN IS FOR, as triage read it — or null when triage never ran.
 *
 * Read by the round loop, which has one decision that genuinely depends on it: whether a prose reply
 * arriving AFTER some tools have run is a report or a narrated intention. See `agent.ts`. Null is the
 * honest answer for every turn plan mode returns from early (kill switch, session toggle off, or a
 * request under `planToggledMinChars`), and it means "behave exactly as before".
 */
let turnKind: RequestKind | null = null;

export function turnRequestKind(): RequestKind | null {
  return turnKind;
}

/**
 * A plan the operator approved on THIS turn — `runPlan` returns it instead of planning again.
 *
 * Held here rather than passed through `runAgentTurn` because the approval is resolved before the
 * turn has started (the input has to be rewritten to the original request first) and consumed in the
 * middle of it, and threading a second parameter through for that would put plan mode's state machine
 * in `agent.ts`.
 */
let approvedThisTurn: { plan: PlanResult; pending: PendingPlan } | null = null;
/** The revision the operator asked for, folded into the request `runPlan` is about to plan. */
let revising = false;

/**
 * Read the operator's answer to a plan that is waiting, and say what this turn is actually about.
 *
 * Called at the very top of the turn, before anything has been pushed to the window, because an
 * approval turn does not work the word "go" — it works the request the plan was written FOR. That
 * substitution has to happen before `currentGoal`, the CTA extraction and the transcript see the
 * input, which is why this is a separate entry point rather than something `runPlan` could do on its
 * own two hundred lines later.
 *
 * Returns the input the turn should run, and a line to show for why it changed.
 */
export function resolvePlanApproval(rawInput: string): { input: string; notice: string; stop?: boolean } {
  approvedThisTurn = null;
  revising = false;
  const cwd = process.cwd();
  const pending = loadPending(cwd);
  if (!pending) return { input: rawInput, notice: '' };

  const answer = readAnswer(rawInput);
  if (answer.kind === 'cancel') {
    clearPending(cwd);
    log('INFO', 'plan_approval', { answer: 'cancel', plan: pending.planPath });
    return { input: rawInput, notice: `Plan dropped — ${pending.planPath} stays on disk, nothing ran.` };
  }
  if (answer.kind === 'approve') {
    clearPending(cwd);
    log('INFO', 'plan_approval', { answer: 'approve', plan: pending.planPath, phases: String(pending.phases.length) });
    approvedThisTurn = {
      pending,
      plan: {
        kind: 'plan',
        path: pending.planPath,
        body: pending.contextBody,
        features: [],
        phaseCount: pending.phases.length,
        mode: pending.mode,
      },
    };
    return { input: pending.request, notice: `Plan approved — working ${pending.planPath}.` };
  }

  /**
   * TOO SHORT TO BE A CHANGE — so ask, and KEEP THE PLAN WAITING.
   *
   * This is the branch the first real session needed and did not have. The operator answered in three
   * characters, "anything else is a revision" took it as one, the pending plan was dropped and 117
   * seconds of planning were spent again on a question that should never have been planned at all.
   * A guess that costs two minutes is not a safe default; a question that costs one line is.
   */
  if (answer.kind === 'unclear') {
    log('INFO', 'plan_approval', { answer: 'unclear', said: answer.said.slice(0, 40) });
    return { input: rawInput, notice: unclearNotice(answer.said), stop: true };
  }

  /**
   * REVISION. The plan is dropped and the request is re-planned with their words as the requirement.
   *
   * IT DOES NOT SET `forced`, and that was a real bug. `forced` means "/planthis" — the operator
   * explicitly demanded a plan — and it makes triage's verdict unable to veto. Setting it here
   * synthesised a demand nobody made: on the measured session the re-planned request came back from
   * triage as `answer`, which is the verdict that means "do not plan this at all", and the forced
   * flag overrode it and planned it anyway. A revision says what to change about a plan, not that a
   * plan must exist; if triage now says this was never work, that answer is the useful one.
   */
  clearPending(cwd);
  revising = true;
  log('INFO', 'plan_approval', { answer: 'revise', chars: String(answer.feedback.length) });
  return {
    input: planPrompts.get('planRevision', { REQUEST: pending.request, FEEDBACK: answer.feedback }),
    notice: 'Re-planning with your changes.',
  };
}

/**
 * Run the scaffold FOR REAL — the first act of execution, once there is something to execute.
 *
 * Planning calls `executor.scaffold(ctx, { dryRun: true })` and gets the same path list with nothing
 * written, so the deliverable arithmetic and the greenfield survey are unchanged while the tree is
 * not touched. This is the other half, and it is deliberately the only place in plan mode that
 * writes anything outside `.ayin/`.
 */
function applyPlanScaffold(ctx: ProjectContext, executor: PlanExecutor): string[] {
  const made = executor.scaffold(ctx);
  if (made.length) log('INFO', 'plan_scaffold_applied', { files: String(made.length), project: ctx.type });
  return made;
}

/** `ayin-plan-20260728-143012.md` — sortable, unique enough for a session, readable in a listing. */
function planFilename(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ayin-plan-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.md`;
}

/**
 * What the person gets at the end of this turn.
 *
 * `answer` is the one that was missing, and its absence had a cost. Plan mode's only shape was a list
 * of files to write, and `validateSteps` refused a plan without one — so a QUESTION could not be
 * planned, only converted into work, and when there was no work the planner invented some. Measured:
 * *"what would you like me to improve in your harness?"* became three phases whose middle one created
 * `HarnessDebugSwitch.cs` and an Editor script shelling out to a Python logger from an unrelated
 * folder the survey had found. Nothing in that plan was asked for and none of it could be.
 */
export type RequestKind = 'build' | 'investigate' | 'answer';

interface Triage {
  kind: RequestKind;
  complex: boolean;
  features: string[];
  apis: string[];
  projectDir: string;
  reason: string;
}

/** The model's `kind`, or `build` — the reading that is never a refusal to plan real work. */
function readKind(raw: unknown): RequestKind {
  const k = String(raw ?? '').trim().toLowerCase();
  return k === 'investigate' || k === 'answer' ? k : 'build';
}

/**
 * What KIND of request this is, is it actually multi-feature, whose APIs does it touch, and — when it
 * is setting a project up — WHICH FOLDER does it name? One cheap call, which already had to read the
 * request.
 *
 * `projectDir` rides along here rather than being pattern-matched out of the prose because the thing
 * being extracted is a name in a sentence, and this repo has retired one natural-language regex on
 * plan mode already. Nothing trusts the answer: `resolveTargetDir` refuses anything that is not a
 * single safe path segment naming a directory that is empty or absent (`executors/detect.ts`).
 */
async function triage(userInput: string): Promise<Triage> {
  try {
    const raw = await llmCall(getPrompt('planTriage', { REQUEST: userInput.slice(0, 6000) }));
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const obj = JSON.parse(raw.slice(start, end + 1)) as { kind?: unknown; complex?: unknown; features?: unknown; apis?: unknown; projectDir?: unknown; reason?: unknown };
      const features = Array.isArray(obj.features) ? obj.features.map((f) => String(f)).filter(Boolean).slice(0, 12) : [];
      const apis = Array.isArray(obj.apis) ? obj.apis.map((a) => String(a).trim()).filter(Boolean).slice(0, 6) : [];
      const complex = obj.complex === true || String(obj.complex).toLowerCase() === 'true' || features.length > 1;
      return { kind: readKind(obj.kind), complex, features, apis, projectDir: String(obj.projectDir ?? '').trim().slice(0, 120), reason: String(obj.reason ?? '').slice(0, 300) };
    }
    // No JSON — read it conservatively. Planning a simple request wastes minutes; skipping a plan
    // for a complex one only costs what we have today, so an unparseable answer means "no".
    const yes = /\b(complex|multi-?feature|cross-?feature|yes)\b/i.test(raw) && !/\bnot\s+complex\b/i.test(raw);
    return { kind: 'build', complex: yes, features: [], apis: [], projectDir: '', reason: raw.trim().slice(0, 200) };
  } catch (err) {
    log('WARN', 'plan_triage_failed', { error: err instanceof Error ? err.message : String(err) });
    return { kind: 'build', complex: false, features: [], apis: [], projectDir: '', reason: 'triage call failed' };
  }
}

/**
 * MANDATORY when the work touches somebody else's API: look the API up on the web, now.
 *
 * This step is not optional and not the model's choice, because a third-party API is the one thing a
 * model must never answer from memory. Auth schemes get replaced, fields get renamed, endpoints get
 * deprecated, whole versions get sunset — all after training. Code written from recall looks completely
 * reasonable and fails against the live service, which is the most expensive kind of wrong: it passes
 * review, it passes a read-through, and it breaks in production against a vendor you don't control.
 *
 * So the plan carries FRESH research: current base URL, current auth, current endpoints, rate limits,
 * deprecations, with sources the plan can cite. Two searches per API, capped at `planApiSearches` total.
 */
async function researchApis(apis: string[]): Promise<string> {
  const budget = getConfig('planApiSearches', 3);
  if (apis.length === 0 || budget <= 0) return '';
  const blocks: string[] = [];
  let spent = 0;
  for (const api of apis) {
    if (spent >= budget) {
      blocks.push(`### ${api}\n${planPrompts.get('apiResearchBudgetExhausted', { BUDGET: String(budget) })}`);
      continue;
    }
    setActivityDetail(`researching the ${api} API (current docs, not recall)`);
    try {
      const results = await webSearch(`${api} API official documentation current version authentication endpoints rate limits ${new Date().getFullYear()}`);
      spent++;
      blocks.push(`### ${api}\n${results.slice(0, 6000)}`);
      log('INFO', 'plan_api_research', { api, chars: String(results.length) });
    } catch (err) {
      spent++;
      const msg = err instanceof Error ? err.message : String(err);
      log('WARN', 'plan_api_research_failed', { api, error: msg });
      // An honest gap beats a confident guess: the plan says the lookup failed and makes it step one.
      blocks.push(`### ${api}\n${planPrompts.get('apiResearchFailed', { ERROR: msg, API: api })}`);
    }
  }
  return blocks.join('\n\n');
}

/**
 * Step 2 — explore the context around the problem, in bounded parallel-in-sequence passes.
 *
 * `explore` is its own agentic loop, so each call is real GPU time; the count is capped by
 * `planExploreCalls` and the questions are fixed rather than model-chosen. Two questions cover the
 * ground that matters: what exists already, and what would have to change.
 */
async function exploreContext(userInput: string, features: string[], ctx: ProjectContext): Promise<string[]> {
  const budget = getConfig('planExploreCalls', 2);
  if (budget <= 0) return [];
  // A greenfield project has NO code to explore. Two `explore` calls against an empty directory are
  // two full agentic loops that can only report "nothing found" — pure GPU time for an answer the
  // detector already gave us. Skipping them is most of the reason a "create a new project" plan used
  // to take minutes.
  if (ctx.greenfield) {
    log('INFO', 'plan_explore_skipped', { reason: 'greenfield — nothing on disk to explore' });
    return [];
  }
  const subject = features.length ? features.join('; ') : userInput.slice(0, 400);
  const questions = [
    planPrompts.get('exploreExisting', { SUBJECT: subject }),
    planPrompts.get('exploreChanges', { SUBJECT: subject }),
  ].slice(0, budget);

  const findings: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    setActivityDetail(`exploring the code (${i + 1}/${questions.length})`);
    try {
      const r = await exploreExecute({ question: questions[i], context: `Project: ${ctx.type} at ${ctx.root}` });
      if (r && r.length > 40) findings.push(r.slice(0, 8000));
    } catch (err) {
      log('WARN', 'plan_explore_failed', { index: String(i), error: err instanceof Error ? err.message : String(err) });
    }
  }
  return findings;
}

/**
 * One `explore` call for ONE phase — the research at the same altitude as the plan.
 *
 * Bounded by `buildPhasedPlan`, which owns the budget because it is the thing that knows how many
 * phases there are. Returns null rather than throwing: the caller falls back to the global findings.
 */
async function explorePhase(phase: PlanPhase, ctx: ProjectContext): Promise<string | null> {
  // Nothing on disk to explore, and two full agentic loops over an empty directory are exactly the
  // cost the global skip already refuses to pay. Same reason, one level down.
  if (ctx.greenfield) return null;
  const r = await exploreExecute({
    question: planPrompts.get('explorePhase', { TITLE: phase.title, GOAL: phase.goal }),
    context: `Project: ${ctx.type} at ${ctx.root}`,
  });
  return r && r.length > 40 ? r.slice(0, 8000) : null;
}

/**
 * Build the plan and write it down. Returns null when planning does not apply or fails — the caller
 * then proceeds exactly as it does today, because a failed planner must never block a request.
 */
export async function runPlan(userInput: string, goal: string): Promise<PlanResult | null> {
  // Every turn starts with no progress and no verdict — including one that is about to establish
  // both, and including one that was never planned at all.
  endPlanProgress();
  turnKind = null;
  if (process.env.AYIN_PLAN === '0') return null;

  /**
   * THE APPROVED PLAN SHORT-CIRCUITS EVERYTHING BELOW. It was drafted, validated and written on the
   * previous turn; re-entering triage, research and exploration for it would spend the whole gate
   * again to arrive at a document that is already on disk and already agreed to.
   *
   * This is also where the scaffold finally runs — see `applyPlanScaffold`. Approval is the boundary
   * between looking and touching, and it is one line of code wide.
   */
  if (approvedThisTurn) {
    const { plan, pending } = approvedThisTurn;
    approvedThisTurn = null;
    // The turn that WORKS an investigation is an investigating turn, and triage does not run on it —
    // the plan was drafted last turn. Without this the relaxation in the round loop would apply to
    // the turn that planned the reading and not to the turn that does it.
    turnKind = pending.mode === 'investigate' ? 'investigate' : 'build';
    const ctx = pending.projectDir
      ? detectProject(pending.cwd, pending.request, pending.projectDir)
      : detectProject(pending.cwd, pending.request);
    const executor = planExecutorFor(ctx);
    const projectRoot = ctx.targetDir ? join(ctx.root, ctx.targetDir) : ctx.root;
    const made = pending.mode === 'build' ? applyPlanScaffold(ctx, executor) : [];
    if (made.length) addMessage('system', `Scaffolded ${made.length} path(s) — ${made.map((f) => shortPath(f, projectRoot)).join(', ')}`);
    if (pending.phases.length) {
      beginPlanProgress({
        planPath: pending.planPath,
        cwd: projectRoot,
        phases: pending.phases.map((p): PhaseRuntime => ({
          phase: p.phase, steps: p.steps, file: p.file,
          state: 'pending', verification: null, replanned: false,
        })),
        // RESTORED PLANS REPLAN WITH LESS. `findings` and the API research are the expensive half of
        // the gate and are not carried across the approval boundary; grounding and the survey are
        // deterministic and are recomputed here. A replan after a failed phase is therefore grounded
        // in the project but not in the original exploration, which is stated rather than hidden.
        input: {
          request: pending.request, goal: pending.goal, features: [], apiResearch: '',
          findings: [], grounding: executor.grounding(ctx, pending.request), ctx, executor,
        },
      });
    }
    return plan;
  }

  // `/planthis` bypasses the session toggle entirely — consumed here whatever happens next, so a
  // flag that survives a failed/no-op attempt never silently plans the NEXT unrelated prompt.
  const explicit = forced;
  forced = false;

  // Off by default: with no session toggle and no explicit /planthis, plan mode never applies, full
  // stop — neither door below is even evaluated. `/plan` (bare) flips this for the rest of the session.
  if (!explicit && !sessionEnabled) return null;

  // The size door, now that the feature applies at all this turn.
  //
  // THE THRESHOLD USED TO BE 2000 CHARACTERS, AND THAT WAS WRONG ONCE `/plan` BECAME AN OPT-IN
  // SESSION TOGGLE. It made sense when plan mode was implicitly available on every turn: a length
  // proxy kept a cheap triage call off ordinary conversation. But an operator who has explicitly
  // typed `/plan` has already said "plan my work this session", and then watched a 150-character
  // request — "create an Arduino project that cycles an RGB LED, button toggles it" — sail straight
  // past the gate with no plan and no explanation, because it was not two thousand characters long.
  // A request being short is not evidence that it is simple; it is evidence that it is well phrased.
  //
  // So with the toggle on, the floor is only high enough to keep "hi" and "yes" from spending a
  // triage call (`planToggledMinChars`, default 60), and triage — one cheap call — makes the real
  // decision. `planMinChars: 0` remains the operator's absolute off switch for the automatic door.
  const minChars = getConfig('planMinChars', 2000);
  if (!explicit && minChars <= 0) return null;

  /**
   * A GREENFIELD REQUEST IS NEVER TOO SHORT TO PLAN — it is the one that needs the SCAFFOLD.
   *
   * The floor below exists to keep "hi" and "yes" from spending a triage call, and the comment above
   * it says a short request is well phrased rather than simple. Then the floor reproduced exactly
   * that mistake one size down: "give me an empty note ts endpoint" is 33 characters and means
   * "bootstrap a project", and it returned here before triage, before detection, and therefore before
   * `executor.scaffold()` ever ran. Measured — that request produced a single Express file importing
   * a package that was not installed, in a directory with no manifest and no tsconfig.
   *
   * Checked BEFORE the floor and costs nothing: `detectProject` is a regex over the request plus a
   * shallow directory read, with no model call anywhere in it. `greenfield` is true only when the
   * directory holds no project AND the request named a type — precisely the case where there is
   * something to bootstrap.
   */
  const early = detectProject(process.cwd(), userInput);
  if (!explicit && !early.greenfield && userInput.length < getConfig('planToggledMinChars', 60)) return null;

  // One named phase for the whole planning pass. The wait narrator leads its line with this and the
  // status bar keeps `▣ PLAN` lit, so minutes of triage → research → exploration → writing never look
  // like an ordinary "thinking". See activity.ts.
  const endPhase = pushActivity('PLAN', `triaging a ${userInput.length}-char request`);
  try {
    // Triage still runs when the ask was explicit — it is the cheapest way to decompose the work and
    // to NAME THE APIS the mandatory research step needs. What changes is that its `complex` verdict
    // no longer decides anything: a model must not be able to veto a user who said "plan it".
    const t = await triage(userInput);
    turnKind = t.kind;
    log('INFO', 'plan_triage', {
      kind: t.kind,
      complex: String(t.complex), explicit: String(explicit), features: String(t.features.length),
      chars: String(userInput.length), reason: t.reason.slice(0, 160),
    });

    /**
     * A QUESTION THE CODEBASE CANNOT ANSWER GETS NO PLAN. Not a shorter one — none.
     *
     * This is the gate's cheapest correct answer and it was missing entirely. "What do you think of
     * your tools", "should we use X or Y", "why is this annoying" — there is nothing on disk to
     * survey, nothing to deliver and nothing to verify, and plan mode's one shape is a list of files
     * to write. Asked to fill it anyway, the planner fills it: measured on *"what would you like me
     * to improve in your harness for unity?"*, which produced three phases whose middle one created
     * `HarnessDebugSwitch.cs` and an Editor script shelling out to a Python logger belonging to an
     * unrelated folder in the tree. The agent read the plan, said it was garbage, and ignored it —
     * which is the good outcome. The bad one is the agent that follows it.
     *
     * Costs one triage call, which had already been spent. `/planthis` still wins: an operator who
     * explicitly asked for a plan gets one, as an INVESTIGATION — the shape a question can actually
     * take — because a proxy must never overrule the person who can simply say so.
     */
    if (t.kind === 'answer' && !explicit) {
      log('INFO', 'plan_skipped_conversational', { reason: t.reason.slice(0, 160) });
      addMessage('system', `Plan mode: this is a question, not work — no plan. ${t.reason}`.trim());
      return null;
    }

    /**
     * A QUESTION ABOUT THE CODE GETS A PLAN THAT READS. See `PlanMode` in plan.ts for the two
     * measured failures this exists for; the short version is that `validateSteps` demanded a step
     * that names a file, so "is this icon baked in or set at runtime" was planned as four steps each
     * declaring `files:` — one of them instructing the agent to parse a Unity prefab as JSON.
     */
    const mode: PlanMode = t.kind === 'build' ? 'build' : 'investigate';

    // Detected before the floor above (a greenfield request must not be filtered out by length) and
    // REUSED here — one regex pass, not two.
    //
    // Re-detected in exactly one case: triage named a folder to create the project in. `projectDir`
    // does not exist until triage has answered, so `early` was necessarily computed without it, and
    // the target is what turns "build a python site in testwebsite-2" into a greenfield context
    // pointed at that folder. Validated inside `detectProject`, which refuses anything that is not an
    // empty or absent single path segment.
    let ctx = t.projectDir ? detectProject(process.cwd(), userInput, t.projectDir) : early;

    /**
     * THE REGEXES MISSED, AND THE DIRECTORY IS EMPTY — so ask, rather than fall to `base`.
     *
     * Measured on "Set me up a nodets project here!": no pattern matches `nodets` (`\bnode\b` does
     * not, `\bts\b` does not, and `\bweb\b` does not match `website`), so the type came back
     * `unknown`. That makes `greenfield` false, which took the base executor instead of node,
     * scaffolded one README instead of a project, left nothing for the short-circuit to satisfy, and
     * ran two `explore` calls over an empty directory — because the greenfield skip is keyed on the
     * same flag. One unmatched word, and the entire turn went sideways silently.
     *
     * Patterns stay first because they are free and they catch the common phrasings. This is the last
     * resort, and only where there is genuinely nothing on disk to read instead: one short call, on
     * exactly the turn that creates a project, to answer the question the tree cannot.
     */
    if (ctx.type === 'unknown' && isFreshDirectory(ctx.root)) {
      setActivityDetail('working out what kind of project this is');
      const guessed = await classifyProjectType(userInput);
      if (guessed) {
        ctx = { ...ctx, type: guessed, evidence: 'worked out from your request', greenfield: true };
        log('INFO', 'plan_type_classified', { type: guessed });
      }
    }
    const executor = planExecutorFor(ctx);

    // TRIAGE'S VETO IS ABOUT FEATURE COUNT, AND THAT IS NOT THE ONLY REASON TO PLAN.
    //
    // A project type with its own DOMAIN REFERENCE has facts a model must never answer from memory,
    // and a plan is where those get stated before any code is written. Triage does not know that: it
    // asks "is this several features wearing one paragraph", and for "build a reaction timer" the
    // honest answer is no. Observed in a benchmark run — that exact request was vetoed with
    // "single-feature request (255 chars)", so the Arduino block never reached the model at all: no
    // component catalog, no PWM-pin rule, no sketch-naming rule. It then shipped a sketch whose
    // filename did not match its folder and therefore could not compile. One feature, three facts it
    // needed and did not get.
    //
    // So a veto is only honoured when this project type brings nothing extra to ground in. Computed
    // once here and reused as the prompt block further down — the user's own words are the retrieval
    // query, so this is the same string either way.
    const grounding = executor.grounding(ctx, userInput);
    const hasDomainGrounding = grounding.trim().length > 0;

    /**
     * A GREENFIELD PROJECT HAS SOMETHING TO DO EVEN WHEN IT HAS NOTHING TO GROUND.
     *
     * The veto below spares a project type that brings reference material. It did not consider the
     * other reason this pass is worth running: the SCAFFOLD. A Node project has no domain catalog, so
     * `hasDomainGrounding` is false, so a greenfield TS request was vetoed and returned before
     * `executor.scaffold()` — which is the one thing it actually needed. Measured: "give me an empty
     * note ts endpoint" was vetoed as "single-feature request (33 chars)" and produced one Express
     * file importing a package that was not installed, with no manifest and no tsconfig beside it.
     *
     * Grounding is knowledge the model must not invent; scaffolding is a file operation it should
     * never have been asked to remember. Either is reason enough not to skip.
     */
    const hasWork = hasDomainGrounding || ctx.greenfield;
    if (!explicit && !t.complex && !hasWork) {
      addMessage('system', `Plan mode: not needed — single-feature request (${userInput.length} chars).`);
      return null;
    }
    // GROUNDING-ONLY: the cheap path. The facts reach the model; no document is generated and none is
    // written. Costs nothing beyond the triage call that already happened — `grounding` is a
    // deterministic string, so this branch adds zero LLM calls.
    if (!explicit && !t.complex && hasWork) {
      log('INFO', 'plan_grounding_only', {
        project: ctx.type, chars: String(grounding.length), greenfield: String(ctx.greenfield),
      });
      // Say which of the two reasons applied, because "injecting reference material" is a lie when
      // there is none and the real work was the bootstrap.
      addMessage('system', hasDomainGrounding
        ? `Plan mode: single-feature — skipping the plan document, but injecting the ${ctx.type} reference material so nothing is answered from recall.`
        : `Plan mode: single-feature on a greenfield ${ctx.type} project — skipping the plan document, but bootstrapping the project first.`);
      // Scaffolding still happens, and FOR REAL here: a README that must exist is a file operation
      // either way, and it is the thing the QA gate would otherwise spend a whole fix pass creating.
      //
      // NOT A HOLE IN THE READ-ONLY RULE. What that rule protects is "a plan nobody has agreed to does
      // not touch the tree"; this branch writes no plan and asks for no approval — the turn proceeds
      // to the work immediately on the operator's own request, so the scaffold IS the first act of
      // execution, which is exactly where it belongs.
      const scaffoldedNow = applyPlanScaffold(ctx, executor);
      if (scaffoldedNow.length) addMessage('system', `Created ${scaffoldedNow.join(', ')}`);
      return { kind: 'grounding', path: '', body: grounding, features: t.features, deliverables: renderDeliverableList(executor.deliverables(ctx)) };
    }

    // The project the paths below are relative to. Resolved once — every card uses it.
    const projectRoot = ctx.targetDir ? join(ctx.root, ctx.targetDir) : ctx.root;

    /**
     * One stage of the pass, as a card that rolls in when the stage finishes.
     *
     * The same two-message shape `agent.ts` uses for a tool call — header, then result — so plan
     * stages sit in the transcript exactly like the tool cards around them instead of being a second
     * visual language the reader has to learn.
     */
    const startedAt = Date.now();
    let lastCard = startedAt;
    const card = (id: string, glyph: string, headline: string, body = ''): void => {
      const now = Date.now();
      addMessage('tool', formatToolCallForChat(id, headline, glyph));
      addMessage('tool', formatToolResultForChat(id, body, now - lastCard));
      lastCard = now;
    };

    const why = explicit
      ? 'you asked for it'
      : `${t.features.length || 'multiple'} feature${t.features.length === 1 ? '' : 's'} in ${userInput.length} chars`;
    addMessage('system', `PLAN — ${why}, planning before executing`);
    card(PLAN_CARD.triage, PLAN_GLYPH.triage, why, !explicit && t.reason ? t.reason : '');

    setActivityDetail('surveying the project');
    // `ctx` and `executor` were resolved above the triage veto — the veto needs to consult whether
    // this project type has domain grounding. Detection is from the REQUEST as well as the tree, which
    // is what makes it work on the turn that CREATES the project: every Arduino hook used to key off
    // `isArduinoProject(root)`, which needs an `.ino` to already exist, so the catalog was withheld
    // exactly when it mattered most. See executors/detect.ts.
    log('INFO', 'plan_executor', { project: describeProject(ctx), executor: executor.config.id });
    card(PLAN_CARD.survey, PLAN_GLYPH.survey, `${describeProject(ctx)} → ${executor.config.id}`);

    /**
     * WHAT THE SCAFFOLD WILL WRITE — computed now, written after approval.
     *
     * Planning is read-only: the operator is about to be shown a plan and asked whether to run it,
     * and a gate that has already created files and made a commit has answered that question on
     * their behalf. `dryRun` returns exactly the paths a real call would create, spawning nothing —
     * so everything downstream (the deliverable arithmetic, the greenfield survey, this card) sees
     * the same list it always did, and `applyPlanScaffold` writes it once there is a yes.
     */
    const scaffolded = executor.scaffold(ctx, { dryRun: true });
    if (scaffolded.length) {
      card(PLAN_CARD.scaffold, PLAN_GLYPH.scaffold,
        `${scaffolded.length} file${scaffolded.length === 1 ? '' : 's'} to create — written when you approve`,
        columns(scaffolded.map((f) => shortPath(f, projectRoot))));
    }

    /**
     * SCAFFOLDED AND ALREADY COMPLETE — so there is nothing to plan, and planning it costs minutes.
     *
     * Measured on "set up an empty typescript web ui project": the scaffold ran in 35ms and produced a
     * project that installs, tests 4/4, typechecks, builds and serves its page. Plan mode then spent
     * **121 seconds** writing a plan whose single phase was *"Verify existing project integrity"*, and
     * the agent spent a further **239 seconds** in a subagent running `npm install`, `tsc` and
     * `npm test` through model round-trips — three commands that take about three seconds when run.
     * Eight minutes fifty-one in total, for a project that was finished before the first token.
     *
     * So: when the directory was greenfield and every REQUIRED deliverable now exists, the job the
     * plan would describe is already done. Return grounding instead of a document — the agent still
     * gets its turn and still does anything the request asked for beyond a bare project, it simply
     * does not get handed a plan to re-create files that are already there.
     *
     * DELIBERATELY KEYED ON THE DELIVERABLES, not on "was it greenfield". A request that asks for more
     * than a bare project has deliverables the scaffold does not write, and falls through to the full
     * plan exactly as before.
     */
    if (ctx.greenfield && scaffolded.length) {
      // `checkDeliverables` is the same disk check QA runs at the END of a turn. Asking it here, before
      // planning, is the whole trick: the question "is this already done" has one answer and one
      // implementation, and it was only ever being asked too late to save anything.
      // `scaffolded` is the dry run, so the paths it names are counted as present — they are written
      // between this plan being approved and the first round, which is before anything could read
      // them. Asking the bare disk here would report every one of them missing and put the phase
      // this short-circuit exists to delete back into the plan.
      const statuses = checkDeliverables(projectRoot, executor.deliverables(ctx), scaffolded).filter((s) => s.deliverable.required);
      const required = statuses.map((s) => s.deliverable);
      const outstanding = statuses.filter((s) => !s.satisfied);
      // AND THE REQUEST ITSELF HAS TO BE DONE, which the deliverables cannot tell us. They describe
      // the shape of a PROJECT; none of them is a ping pong game. Asked only once the cheap check has
      // already passed, so a request that clearly has work left never spends the call.
      const needsMore = statuses.length > 0 && outstanding.length === 0
        ? await requestNeedsMoreThanScaffold(userInput)
        : true;
      if (statuses.length > 0 && outstanding.length === 0 && !needsMore) {
        // NO PLAN IS WRITTEN HERE AND NOTHING IS ASKED, so the turn goes straight to the work — which
        // makes this the first act of execution and the right place for the real scaffold. Same
        // argument as the grounding-only branch above.
        applyPlanScaffold(ctx, executor);
        const done = `The project already exists — `
          + `${scaffolded.length} path(s) were scaffolded deterministically before this turn, and every `
          + `required deliverable is on disk:\n`
          + `${required.map((d) => `  ${d.patterns[0]} — ${d.label}`).join('\n')}\n\n`
          + 'None of it was written by a model and it is identical every time. Do NOT re-create these '
          + 'files, plan steps that produce them, or "verify the project structure" by reading them '
          + 'back one at a time — running the project\'s own commands is the only check worth making, '
          + 'and it is one shell call.\n\n'
          + `${grounding}`;
        card(PLAN_CARD.phases, PLAN_GLYPH.phases, 'nothing to plan — the scaffold satisfies the request',
          required.map((d) => `✓ ${d.patterns[0]}`).join('\n'));
        log('INFO', 'plan_skipped_scaffold_complete', { deliverables: String(required.length) });
        return {
          kind: 'grounding', path: '', body: done, features: t.features,
          deliverables: renderDeliverableList(executor.deliverables(ctx), projectRoot),
        };
      }
    }

    // Mandatory, before exploration: if somebody else's API is involved, get its CURRENT shape from
    // the web. Everything downstream (the plan, then the implementation) is written against this
    // instead of against recall.
    const apiResearch = await researchApis(t.apis);
    if (t.apis.length) card(PLAN_CARD.research, PLAN_GLYPH.research, `${t.apis.length} third-party API(s)`, t.apis.join('\n'));
    const findings = await exploreContext(userInput, t.features, ctx);

    // `grounding` was resolved above the triage veto (it decides whether a veto applies at all). The
    // user's own words were the retrieval query — see `PlanExecutor.grounding`; retrieving rather than
    // dumping the corpus is what keeps the Arduino catalog block at ~2.5k characters instead of 10.2k.
    if (grounding) {
      card(PLAN_CARD.grounding, PLAN_GLYPH.grounding, `${ctx.type} reference material, not recall`);
    }

    const deliverables = executor.deliverables(ctx);

    setActivityDetail('writing the plan');
    const prompts = recentPrompts(12);

    // THE ACTIONABLE PLAN — the default, `AYIN_PLAN_GRAPH=0` opts out. A LangGraph draft → validate →
    // repair cycle producing typed steps a program has already checked (see plan/plan.ts), instead of
    // nine sections of prose in which a step with no verification is indistinguishable from a step with
    // one. Null when nothing usable came back, and then the prose document below runs as it always has.
    const planInput = { request: userInput, goal, features: t.features, apiResearch, findings, grounding, ctx, executor, mode };

    // TWO LEVELS: the stages of the job, then the steps of each stage. See `PlanPhase` — a flat step
    // list is written at one altitude and the model picks files, so "run it on a free port" and "send
    // me the link" got no step at all on a request that asked for both.
    /**
     * PROGRESS WHILE THE PLAN IS WRITTEN. Three sub-plans are three long generations, and the operator
     * used to watch 76 seconds of nothing before a single card appeared with all of it. The breakdown
     * is announced as soon as it exists — so you know how many documents are coming — and then each
     * one as it is finished, so you know which it is on.
     */
    const phased = isActionablePlanEnabled()
      ? await buildPhasedPlan(planInput, (p) => {
        if (p.done === 0) {
          card(PLAN_CARD.phases, PLAN_GLYPH.phases,
            `${p.total} phase${p.total === 1 ? '' : 's'} — writing a plan for each`,
            p.phases.map((ph) => `${ph.id} ▸ ${ph.title}`).join('\n'));
          return;
        }
        const ph = p.latest?.phase;
        const steps = p.latest?.plan?.steps.length;
        card(PLAN_CARD.steps, PLAN_GLYPH.steps,
          `${p.done}/${p.total} · ${ph?.title ?? 'phase'} · ${steps === undefined ? '⚠️ could not be planned' : `${steps} step${steps === 1 ? '' : 's'}`}`,
          ph?.goal?.trim() ? `✓ done when: ${ph.goal.trim()}` : '');
      }, (phase) => explorePhase(phase, ctx))
      : null;
    // The phase layer failing must not cost the plan: a flat plan is what ayin produced before it
    // existed, and it is still better than no plan.
    const actionable = phased ? null : (isActionablePlanEnabled() ? await buildActionablePlan(planInput) : null);
    if (actionable) {
      addMessage('system', `Plan mode: ${actionable.steps.length} actionable step(s) in ${actionable.attempts} model call(s)`
        + `${actionable.unresolved.length ? `, ${actionable.unresolved.length} problem(s) the validator still rejects` : ', validated'}.`);
    }

    const body = phased ? '' : actionable ? actionable.markdown : await llmChat([{
      role: 'user',
      content: getPrompt('planDocument', {
        REQUEST: userInput.slice(0, 8000),
        PROMPTS: prompts.map((p, i) => `${i + 1}. ${p.slice(0, 600)}`).join('\n') || '(this is the first prompt)',
        GOAL: goal || '(none derived)',
        FEATURES: t.features.length ? t.features.map((f) => `- ${f}`).join('\n') : '- (not decomposed by triage)',
        SURVEY: executor.survey(ctx),
        FINDINGS: findings.length
          ? findings.map((f, i) => `### Exploration ${i + 1}\n${f}`).join('\n\n')
          : ctx.greenfield
            ? '(nothing on disk yet — this plan creates the project from scratch; do not describe existing code)'
            : '(exploration produced nothing — say so in the Gaps section)',
        APIS: t.apis.length ? t.apis.join(', ') : '(none identified)',
        API_RESEARCH: apiResearch || '(no third-party API involved — omit the API section)',
        DOMAIN_REFERENCE: grounding || '(no domain reference for this project type — omit the domain reference section)',
        DELIVERABLES: renderDeliverableList(deliverables),
        OBSERVABILITY: executor.observability(ctx),
      }),
    }], { declareTools: false });

    // `.ayin/plans/`, not the working directory. A plan is ayin's working note, not the project's
    // file, and one per planned turn plus one per phase used to accumulate at the repo root among the
    // actual source. `AYIN_PLAN_DIR` still wins where a harness has set it. See `ayin-dir.ts`.
    const dir = ensureAyinDir(process.cwd(), 'plans');
    const path = join(dir, planFilename());
    const header = [
      '<!-- Written by ayin plan mode before implementation started. -->',
      // Provenance: a plan read back a week later should say why it exists at all — an explicit ask
      // and an automatic size trigger are different claims about how much the operator wanted this.
      `<!-- Triggered by: ${explicit ? '/planthis' : `size (${userInput.length} chars) + triage`} -->`,
      `<!-- Session goal: ${goal || '(none)'} -->`,
      '',
      '# Plan',
      '',
      '## The request, verbatim',
      '',
      '```text',
      userInput.trim(),
      '```',
      '',
      prompts.length > 1 ? `## Earlier prompts this session\n\n${prompts.slice(0, -1).map((p, i) => `${i + 1}. ${p.replace(/\n+/g, ' ').slice(0, 400)}`).join('\n')}\n` : '',
      '---',
      '',
    ].filter((l) => l !== undefined).join('\n');
    // EACH PHASE IS ITS OWN FILE, and the top-level document is the index that points at them. That is
    // what makes a phase readable on its own — the sub-plan a person opens is the stage they are on,
    // not twenty steps of four stages interleaved — and it is what lets a phase be re-read, or
    // re-planned, without touching the rest.
    let planBody = body;
    /** What the turn's `<plan>` block carries — the index plus every phase inline. */
    let contextBody = body;
    /** Where each phase's file landed, positionally. Hoisted: the approval record needs it too. */
    const phaseFilesWritten: string[] = [];
    if (phased) {
      const stem = path.replace(/\.md$/, '');
      const phaseFiles = phaseFilesWritten;
      for (const p of phased.phases) {
        if (!p.plan) { phaseFiles.push(''); continue; }
        const slug = p.phase.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'phase';
        const file = `${stem}-${p.phase.id}-${slug}.md`;
        writeFileSync(file, [
          `<!-- Phase ${p.phase.id} of ${phased.phases.length}: ${p.phase.title} -->`,
          `<!-- Index: ${path} -->`,
          '',
          `# Phase ${p.phase.id} — ${p.phase.title}`,
          '',
          `**Done when:** ${p.phase.goal.trim()}`,
          '',
          p.plan.markdown.trim(),
          '',
        ].join('\n'));
        phaseFiles.push(file);
      }
      planBody = renderPhaseIndex(phased.phases, phaseFiles, phased.unresolved);
      // WHAT THE FILE HOLDS AND WHAT THE MODEL SEES ARE DIFFERENT ON PURPOSE. The index on disk points
      // at the phase files, which is what makes each stage readable on its own and re-readable after a
      // crash. The model gets the index AND every phase's steps inline: telling it to go and open four
      // files first spends four tool calls to learn what the prompt could simply have carried.
      // THE INDEX ONLY. Inlining every phase is what broke the first real request this shipped against:
      // five phases totalling 27,138 characters against a 12,000-character cap, so phases 4 and 5 were
      // CUT OFF — and phase 5 was "run the server and give the user the link", which is what the request
      // was for. The plan then cost 4,000 tokens of every round to say less than the index does.
      //
      // Each phase's steps live in its own file, and the agent hands that file to a SUBAGENT rather than
      // reading it itself. That is the whole point of the two levels: this agent arbitrates, and never
      // holds twenty-four steps in its head.
      contextBody = planBody;
      const steps = phased.phases.reduce((n, p) => n + (p.plan?.steps.length ?? 0), 0);
      const unplanned = phased.phases.filter((p) => !p.plan).length;
      // THE PHASE BREAKDOWN IS THE CARD WORTH READING. It used to be a count followed by a column of
      // absolute filenames — the two facts that matter, what each stage IS and how it will be judged,
      // were in neither. A phase with no sub-plan is a hole in the job and says so here, because the
      // operator reads this while the turn is still running and the index file only afterwards.
      const headline = `${phased.phases.length} phase${phased.phases.length === 1 ? '' : 's'} · ${steps} step${steps === 1 ? '' : 's'}`
        + ` · ${phased.attempts} model call${phased.attempts === 1 ? '' : 's'}`
        + `${phased.unresolved.length ? ` · ⚠️ ${phased.unresolved.length} unresolved` : ' · validated'}`
        + `${unplanned ? ` · ⚠️ ${unplanned} unplanned` : ''}`;
      card(PLAN_CARD.phases, PLAN_GLYPH.phases, headline, phaseBody(
        phased.phases.map((p, i) => ({
          id: p.phase.id,
          title: p.phase.title,
          goal: p.phase.goal,
          steps: p.plan ? p.plan.steps.length : null,
          file: phaseFiles[i] ?? '',
        })),
        projectRoot,
      ));
    }
    writeFileSync(path, `${header}${planBody.trim()}\n`);

    // A run killed mid-plan should say WHICH plan it was working, not only that there was one.
    notePostmortemContext({ plan: path });
    log('INFO', 'plan_written', { path, chars: String(planBody.length), phases: String(phased?.phases.length ?? 0), explorations: String(findings.length), trigger: explicit ? 'explicit' : 'size' });
    card(PLAN_CARD.write, PLAN_GLYPH.write, shortPath(path, projectRoot));

    /** The phases as the approval record and the progress tracker both need them. */
    const runtime: PendingPhase[] = phased
      ? phased.phases.flatMap((p, i) => (p.plan && phaseFilesWritten[i]
        ? [{ phase: p.phase, steps: p.plan.steps, file: phaseFilesWritten[i] }]
        : []))
      : actionable
        ? [{
          // A FLAT PLAN IS TRACKED AS ONE PHASE. It has steps and therefore checks, and a progress
          // mechanism that only works on the phased path would leave the fallback — the path taken
          // whenever the breakdown fails — with no verification at all.
          phase: { id: 1, title: 'the plan', goal: 'every step has landed', deliverables: [], dependsOn: [] },
          steps: actionable.steps,
          file: path,
        }]
        : [];
    const stepCount = runtime.reduce((n, p) => n + p.steps.length, 0);

    /**
     * THE GATE. Nothing has been written outside `.ayin/` at this point — not the scaffold, not a
     * commit — so the operator is being shown a proposal, which is the only thing a plan was ever
     * supposed to be before somebody said yes.
     *
     * The turn ENDS here. `agent.ts` returns on an `awaiting` result, and the next message is the
     * answer: `go`, `cancel`, or the change to make. See `plan/approval.ts` for why those three and
     * why anything else is read as a revision.
     */
    if (approvalRequired()) {
      storePending({
        request: userInput, goal, projectDir: t.projectDir, planPath: path, mode,
        contextBody: contextBody.trim(), phases: runtime, cwd: process.cwd(),
        createdAt: new Date().toISOString(),
      });
      addMessage('system', approvalNotice(shortPath(path, projectRoot), phased?.phases.length ?? 0, stepCount));
      return { kind: 'awaiting', path, body: '', features: t.features, phaseCount: phased?.phases.length ?? 0, mode };
    }

    // HEADLESS, OR THE GATE SWITCHED OFF — the plan runs now, so this is where the scaffold lands.
    // Never for an investigation: answering a question about a repository does not entitle us to
    // write a README into it.
    const made = mode === 'build' ? applyPlanScaffold(ctx, executor) : [];
    if (made.length) card(PLAN_CARD.scaffold, PLAN_GLYPH.scaffold, `${made.length} path(s) scaffolded`, columns(made.map((f) => shortPath(f, projectRoot))));
    if (runtime.length) {
      beginPlanProgress({ planPath: path, cwd: projectRoot, phases: runtime.map((p): PhaseRuntime => ({ ...p, state: 'pending', verification: null, replanned: false })), input: planInput });
    }
    return { kind: 'plan', path, body: contextBody.trim(), features: t.features, phaseCount: phased?.phases.length ?? 0, mode };
  } catch (err) {
    log('WARN', 'plan_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    endPhase();
    setAgentStatus('');
  }
}

/** The plan as the pre-prompt block for this turn's base call. */
export function planContextBlock(plan: PlanResult): string {
  // A `grounding` result has no document and no path, so the `<plan>` wrapper — which instructs the
  // model to FOLLOW the plan, work its steps in order and cite its path — would be describing a file
  // that does not exist. That is the kind of confidently wrong context that produces a model inventing
  // step numbers to follow.
  if (plan.kind === 'grounding') {
    return planPrompts.get('groundingContext', {
      BODY: plan.body.slice(0, 12_000),
      DELIVERABLES: plan.deliverables ?? '(none declared for this project type)',
    });
  }
  const n = plan.phaseCount ?? 0;
  // AN INVESTIGATION IS TOLD SOMETHING ELSE. `planContext.txt` closes with "implement the
  // logging/debug step too; it is part of the deliverable" — handed to an agent answering a question,
  // that is an instruction to start editing.
  return planPrompts.get(plan.mode === 'investigate' ? 'investigationContext' : 'planContext', {
    PATH: plan.path,
    BODY: plan.body.slice(0, 12_000),
    // The count, in words the model cannot round up. "Every phase is part of the job" was the only
    // thing said about how many there were, and it reads as "there are more".
    PHASE_RULE: n > 1
      ? `This plan has EXACTLY ${n} phases, listed above with their plan files. Work all ${n}, in order. `
        + 'Stopping after the first delivers a project nobody asked for.'
      : n === 1
        ? 'This plan has EXACTLY ONE phase, listed above with its plan file. Work it, then you are DONE — '
          + 'there is no second phase. Do not invent one, and do not pass a `plan` path that is not '
          + 'printed above.'
        : 'This plan was not split into phases — work its steps yourself, in order.',
  });
}
