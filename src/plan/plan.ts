/**
 * plan.ts — the ACTIONABLE plan. A LangGraph state machine that turns the context plan mode has
 * already gathered into typed, ordered, verifiable steps, and refuses to hand over a plan a
 * deterministic validator can prove is not executable.
 *
 * WHY THIS EXISTS BESIDE `planDocument`. The prose document is nine sections of markdown, and prose is
 * where a plan hides its holes: a step with no verification reads exactly like a step with one, and a
 * required deliverable that no step produces is invisible until QA spends a fix pass on it. Measured
 * research on plan-then-execute agents names the same failures — a static plan nobody can check, and
 * "step drift", where the executor reads a step and does something adjacent to it. The fix is not more
 * prose. It is a plan with a SHAPE: `{id, title, files, action, verify, dependsOn}`, which a program can
 * reject.
 *
 * WHAT THE VALIDATOR ENFORCES (no model involved, so it cannot be argued with):
 *   - ids are unique, positive, and dependencies point BACKWARDS — a plan cannot contain a cycle
 *   - every step says what proves it worked, in more than a handful of characters
 *   - at least one step names a file, because a plan that touches nothing is not a plan
 *   - every REQUIRED deliverable is named, by exact path, in the files of some step
 *
 * The last one is the one that pays: the deliverable list already existed and was already checked on
 * disk by QA, at the end, after the work. Checking it against the plan means the gap is found before a
 * single file is written, and the model is told to fix it while fixing costs one call.
 *
 * WHY LANGGRAPH AND NOT A `for` LOOP. The interesting part is not the straight line; it is the CYCLE:
 * draft → validate → repair → validate, bounded by `planRepairPasses`. LangGraph gives that a
 * declarable topology, a state snapshot per super-step (so a repair pass can be inspected rather than
 * inferred from logs) and one place where the bound lives. `graph.getGraph().drawMermaid()` prints the
 * topology, which means the diagram in the docs cannot drift from the code.
 *
 * THE STATE IS PLAIN DATA ON PURPOSE. `ProjectContext` and the executor are closed over, never put in a
 * channel, so every checkpointed value is JSON. The checkpointer here is `MemorySaver` — in-process, so
 * it survives a repair pass and NOT a power cut. Swapping it for a durable saver is the next step and
 * needs nothing from this file but the constructor argument.
 *
 * ON BY DEFAULT. This is what plan mode produces now; `AYIN_PLAN_GRAPH=0` goes back to the prose
 * document, which is kept because an operator who wants nine sections of narrative should not have to
 * fork to get them. Failure returns null and the caller falls back to that document anyway — the same
 * contract as the rest of plan mode: a planner that cannot plan must never block the request.
 */

import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { llmChat } from '../llm/manager.js';
import { log } from '../log.js';
import { getConfig } from '../prompts.js';
import { prompts as promptsService, packagePath } from '../prompts-service.js';
import { setActivityDetail } from '../activity.js';
import { patternMatchesPath } from '../executors/deliverables.js';
import type { Deliverable, PlanExecutor, ProjectContext } from '../executors/types.js';

/** Idempotent — `index.ts` registers the same namespace, and registering twice returns one bundle. */
const planPrompts = promptsService.register('plan', packagePath('prompts', 'plan')).bundle;

/** A step a coding agent can execute without asking a question, and a program can check. */
export interface PlanStep {
  id: number;
  title: string;
  /** Exact paths this step creates or edits. Empty only for a step that just runs a command. */
  files: string[];
  action: string;
  /** The command to run or the file to read that PROVES this step worked, and what it must show. */
  verify: string;
  /** Ids that must land first. Lower than `id`, so the list can never describe a cycle. */
  dependsOn: number[];
}

export interface ActionablePlan {
  steps: PlanStep[];
  gaps: string[];
  /** The plan as markdown — what goes on disk and into the turn's `<plan>` block. */
  markdown: string;
  /** How many model calls it took: 1 when the first draft validated, more when it was repaired. */
  attempts: number;
  /** Validator errors still standing when the repair budget ran out. Empty on a clean plan. */
  unresolved: string[];
}

/**
 * A STAGE OF THE WORK, which becomes a plan of its own.
 *
 * WHY A SECOND LEVEL EXISTS. A flat step list is written at ONE altitude, and the model picks the
 * lowest one — files. Measured on a real request: *"create directory testwebsite-1, build a beautiful
 * python website that fetches the weather, run it on whatever empty port, send me the link as
 * <host>:port, and research a public alarm API for a named city"* produced four steps, all
 * of them file creation. "Run it on a free port" got no step. "Send me the link" got no step at all —
 * it survived only as a sentence inside a README that step 4 wrote. Two of the five things asked for
 * were gone, and nothing in the plan or the validator could see that they were missing, because the
 * validator checks the SHAPE of steps and the presence of deliverables, not whether the job was
 * understood.
 *
 * Phases fix the altitude problem by separating the two questions. What stages does this job have is
 * asked once, of the whole request. What files does THIS stage touch is asked per stage, where the
 * answer is allowed to be file-shaped.
 *
 * DELIVERABLES ARE ASSIGNED, NOT BROADCAST. Each phase owns the patterns it produces, so the existing
 * per-plan validator runs unchanged against that phase's own list — and a required deliverable assigned
 * to no phase is caught before a single sub-plan is drafted.
 */
export interface PlanPhase {
  id: number;
  title: string;
  /** What is TRUE when this phase is done, stated so a person could check it. */
  goal: string;
  /** Required deliverable patterns THIS phase produces. Every required pattern belongs to exactly one. */
  deliverables: string[];
  /** Ids that must land first. Lower than `id`, so the list can never describe a cycle. */
  dependsOn: number[];
}

/** One phase, planned. `plan` is null when its sub-plan could not be drafted at all. */
export interface PhasePlan {
  phase: PlanPhase;
  plan: ActionablePlan | null;
}

/**
 * The whole job: the phase index, and one actionable plan per phase.
 *
 * `phases.length === 1` is the ordinary small request — the index is still written, because a plan that
 * sometimes has an index and sometimes does not is two formats for a reader to learn.
 */
export interface PhasedPlan {
  phases: PhasePlan[];
  /** The phase index as markdown — the top-level document. */
  markdown: string;
  /** Phase-level validator errors still standing when the repair budget ran out. */
  unresolved: string[];
  /** Model calls spent across the decomposition and every sub-plan. */
  attempts: number;
}

export interface ActionablePlanInput {
  request: string;
  goal: string;
  features: string[];
  /** Fresh web research on third-party APIs — the only permitted source for an API fact. */
  apiResearch: string;
  findings: string[];
  grounding: string;
  ctx: ProjectContext;
  executor: PlanExecutor;
  /**
   * The phase this plan is FOR, when the job was decomposed. Narrows the request to one stage and
   * narrows the required deliverables to the ones that stage owns, so a phase is never asked to
   * produce the whole project. Absent for a single-stage job, where the plan is the whole job.
   */
  phase?: PlanPhase;
}

/**
 * ON unless the operator says otherwise — `AYIN_PLAN_GRAPH=0` is the way back to the prose document.
 *
 * It shipped off by default for one release, because the prose document was what every existing install
 * and the Arduino benchmark measured, and the shape of a plan is not a thing to change under an operator
 * without asking. Asked, and answered: a plan a program can reject is the better default, and the `=0`
 * escape hatch is the same shape as `AYIN_PLAN=0` and `AYIN_QA=0` — one env var, one meaning.
 */
export function isActionablePlanEnabled(): boolean {
  return process.env.AYIN_PLAN_GRAPH !== '0';
}

/**
 * The deliverable list as prompt text — ONE renderer, used by the prose document, the grounding-only
 * block and the actionable plan. It lived in `index.ts`, which cannot be imported from here without a
 * cycle, and a second copy is how two of the three would eventually disagree.
 */
export function renderDeliverableList(deliverables: Deliverable[]): string {
  return deliverables
    .map((d) => `- ${d.label} — \`${d.patterns[0]}\`${d.required ? ' (REQUIRED)' : ' (optional)'}: ${d.why}`)
    .join('\n');
}

/**
 * Everything wrong with a phase breakdown, in the words the repair pass is handed. No model, no
 * network — the same contract as `validateSteps`, one level up.
 *
 * The deliverable rule is the one that pays. A pattern assigned to NO phase is a required file the job
 * has not planned to produce, caught before any sub-plan is drafted; a pattern assigned to TWO is two
 * phases racing to write the same file, which is how a later phase silently overwrites an earlier one's
 * work.
 */
export function validatePhases(phases: PlanPhase[], requiredPatterns: string[]): string[] {
  const errors: string[] = [];
  if (phases.length === 0) return ['the breakdown has no phases'];

  const ids = new Set<number>();
  for (const p of phases) {
    const at = `phase ${p.id}`;
    if (!Number.isInteger(p.id) || p.id < 1) errors.push(`${at}: id must be a positive whole number`);
    if (ids.has(p.id)) errors.push(`${at}: duplicate id`);
    ids.add(p.id);
    if (!p.title.trim()) errors.push(`${at}: no title`);
    if (!p.goal.trim()) errors.push(`${at}: no goal — say what is true when this phase is done`);
    for (const d of p.dependsOn) {
      if (!Number.isInteger(d)) errors.push(`${at}: dependsOn holds ${JSON.stringify(d)}, which is not a phase id`);
      else if (d === p.id) errors.push(`${at}: depends on itself`);
      else if (d > p.id) errors.push(`${at}: depends on phase ${d}, which comes later — a dependency must be an earlier phase`);
      else if (!phases.some((o) => o.id === d)) errors.push(`${at}: depends on phase ${d}, which does not exist`);
    }
  }

  for (const pattern of requiredPatterns) {
    const owners = phases.filter((p) => p.deliverables.some((d) => d.trim() === pattern));
    if (owners.length === 0) {
      errors.push(`required deliverable \`${pattern}\` is assigned to no phase — put it in the deliverables of the one phase that produces it`);
    } else if (owners.length > 1) {
      errors.push(`required deliverable \`${pattern}\` is assigned to phases ${owners.map((o) => o.id).join(', ')} — exactly one phase owns each`);
    }
  }

  const known = new Set(requiredPatterns);
  for (const p of phases) {
    for (const d of p.deliverables) {
      if (d.trim() && !known.has(d.trim())) {
        errors.push(`phase ${p.id}: \`${d}\` is not one of the required deliverables — assign only the patterns listed`);
      }
    }
  }
  return errors;
}

/** One phase list out of a model's answer, defensively coerced. Null when there is nothing usable. */
function parsePhases(raw: string): PlanPhase[] | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: { phases?: unknown };
  try { obj = JSON.parse(raw.slice(start, end + 1)) as { phases?: unknown }; } catch { return null; }
  if (!Array.isArray(obj.phases)) return null;
  return obj.phases.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const id = Number(o.id);
    return {
      id: Number.isFinite(id) ? Math.trunc(id) : i + 1,
      title: String(o.title ?? ''),
      goal: String(o.goal ?? ''),
      deliverables: Array.isArray(o.deliverables) ? o.deliverables.map((d) => String(d).trim()).filter(Boolean) : [],
      dependsOn: Array.isArray(o.dependsOn)
        ? o.dependsOn.map((d) => Number(d)).filter((d) => Number.isFinite(d)).map((d) => Math.trunc(d))
        : [],
    };
  });
}

/** Shortest `verify` that can name a command or a file and what it must show. */
const VERIFY_MIN_CHARS = 12;

/**
 * Everything wrong with this step list, in the words the repair pass is handed. Deterministic: no model,
 * no network, no filesystem — a plan is validated before any of its files exist.
 */
export function validateSteps(steps: PlanStep[], requiredPatterns: string[]): string[] {
  const errors: string[] = [];
  if (steps.length === 0) return ['the plan has no steps'];

  const ids = new Set<number>();
  for (const s of steps) {
    const at = `step ${s.id}`;
    if (!Number.isInteger(s.id) || s.id < 1) errors.push(`${at}: id must be a positive whole number`);
    if (ids.has(s.id)) errors.push(`${at}: duplicate id`);
    ids.add(s.id);
    if (!s.title.trim()) errors.push(`${at}: no title`);
    if (!s.action.trim()) errors.push(`${at}: no action — say what to do, concretely enough to execute`);
    if (s.verify.trim().length < VERIFY_MIN_CHARS) {
      errors.push(`${at}: verify is ${JSON.stringify(s.verify.trim())} — name the command to run or the file to read, and what it must show`);
    }
    for (const d of s.dependsOn) {
      if (!Number.isInteger(d)) errors.push(`${at}: dependsOn holds ${JSON.stringify(d)}, which is not a step id`);
      else if (d === s.id) errors.push(`${at}: depends on itself`);
      else if (d > s.id) errors.push(`${at}: depends on step ${d}, which comes later — a dependency must be an earlier step`);
      else if (!steps.some((o) => o.id === d)) errors.push(`${at}: depends on step ${d}, which does not exist`);
    }
  }

  if (!steps.some((s) => s.files.length > 0)) {
    errors.push('no step names a file — a plan that writes nothing cannot be executed');
  }

  const declared = steps.flatMap((s) => s.files);
  for (const pattern of requiredPatterns) {
    if (!declared.some((f) => patternMatchesPath(f, pattern))) {
      errors.push(`required deliverable \`${pattern}\` is produced by no step — name its exact path in the files of the step that writes it`);
    }
  }
  return errors;
}

/**
 * A STEP THAT TOUCHES A FILE AN EARLIER STEP TOUCHES DEPENDS ON IT. Write that down instead of asking.
 *
 * The ordering is already in the data: `files` says what each step opens, so two steps naming the same
 * path have an order between them and the later one is the dependent. There is nothing here for a model
 * to decide, and the model routinely does not bother — it lists `dependsOn: []` on a step that edits the
 * very file the step above creates.
 *
 * The consequence is quiet, because `dependsOn` is not executed here — it is RENDERED, as "· after step
 * 1", into the plan a coding agent then follows. A missing edge is a plan that does not state its own
 * ordering, handed to an executor that has no other way to learn it.
 *
 * Borrowed from Maradel, where the same omission was a hard validation error and cost a 9.4-second
 * repair pass on most plans to be told a fact already written in the arguments. The lesson transfers
 * even though the shape does not: what a program can derive, a program should derive.
 *
 * What the model DID declare survives — a step may legitimately depend on one it shares no file with
 * (a build must run after the code it compiles). Only backwards edges are added, so this cannot create
 * a cycle: the validator's "a dependency must be an earlier step" stays true by construction.
 */
export function inferDependencies(steps: PlanStep[]): PlanStep[] {
  return steps.map((s) => {
    const mine = new Set(s.files.map((f) => f.trim()).filter(Boolean));
    if (mine.size === 0) return s;
    const earlier = steps
      .filter((o) => o.id < s.id && o.files.some((f) => mine.has(f.trim())))
      .map((o) => o.id);
    if (earlier.length === 0) return s;
    const merged = [...new Set([...s.dependsOn, ...earlier])].sort((a, b) => a - b);
    return merged.length === s.dependsOn.length ? s : { ...s, dependsOn: merged };
  });
}

/** The plan as markdown: numbered, each step carrying what it touches, what to do, and its proof. */
export function renderPlan(steps: PlanStep[], gaps: string[], unresolved: string[]): string {
  const lines: string[] = ['## Steps', ''];
  for (const s of steps) {
    const after = s.dependsOn.length ? ` · after step ${s.dependsOn.join(', ')}` : '';
    const files = s.files.length ? s.files.map((f) => `\`${f}\``).join(', ') : '(no file — a command)';
    lines.push(`${s.id}. **${s.title}**${after}`);
    lines.push(`   - files: ${files}`);
    lines.push(`   - do: ${s.action.trim()}`);
    lines.push(`   - proves it worked: ${s.verify.trim()}`);
    lines.push('');
  }
  if (gaps.length) {
    lines.push('## Gaps and open questions', '');
    for (const g of gaps) lines.push(`- ${g}`);
    lines.push('');
  }
  if (unresolved.length) {
    lines.push('## Unresolved — the validator still rejects this plan', '');
    for (const e of unresolved) lines.push(`- ${e}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Every balanced `{…}` object in the text, STRING-AWARE — a brace inside a string value is not a brace.
 *
 * Borrowed from Maradel's `llm/salvage.ts`, which learned it the same way: a regex cannot do this. A
 * non-greedy `\{[\s\S]*?\}` breaks on the first nested object and on any brace inside a quoted value,
 * and a plan's `action` field routinely contains both.
 */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  // A STACK, not a depth counter with one start index. The counter only ever emitted objects that
  // closed back to depth 0 — and on the reply this exists for, the OUTER `{"steps":[…]}` is exactly
  // the object that never closes, so every complete step inside it was unreachable. The stack emits a
  // balanced object at whatever depth it sits.
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { starts.push(i); continue; }
    if (c === '}') {
      const start = starts.pop();
      if (start !== undefined) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

/**
 * The step objects a TRUNCATED reply still contains.
 *
 * A draft that ran out of tokens mid-object is not a broken plan, it is a short one — and throwing all
 * of it away costs a whole re-draft to recover steps already written. Measured: phase 1 of a four-phase
 * job came back at 2,841 characters cut off inside step 3's title, three times running, because the
 * model was inlining entire file bodies into `action`. The outer `{"steps":[…]}` never closes, so the
 * whole-object parse below cannot work — but steps 1 and 2 are complete objects sitting right there.
 *
 * Only objects that look like a STEP are taken (an id and an action), so prose containing a JSON
 * example cannot become a plan.
 */
function salvageSteps(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const block of balancedObjects(raw)) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(block) as Record<string, unknown>; } catch { continue; }
    if (Array.isArray(o.steps)) return o.steps;
    if (o.id !== undefined && typeof o.action === 'string') out.push(o);
  }
  return out;
}

/**
 * One JSON object out of a model's answer, defensively coerced. Null when there is nothing usable.
 *
 * Exported for `check:plan`, like `validateSteps` and `inferDependencies`: the salvage below is the
 * part with real logic in it, and a parser nobody can test is a parser nobody knows the shape of.
 */
export function parsePlan(raw: string): { steps: PlanStep[]; gaps: string[] } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  let obj: { steps?: unknown; gaps?: unknown } = {};
  if (start >= 0 && end > start) {
    try { obj = JSON.parse(raw.slice(start, end + 1)) as { steps?: unknown; gaps?: unknown }; } catch { /* salvage below */ }
  }
  if (!Array.isArray(obj.steps)) {
    const salvaged = salvageSteps(raw);
    if (salvaged.length === 0) return null;
    log('INFO', 'plan_steps_salvaged', { steps: String(salvaged.length), chars: String(raw.length) });
    obj = { steps: salvaged, gaps: [] };
  }

  const steps: PlanStep[] = (obj.steps as unknown[]).map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const id = Number(o.id);
    return {
      id: Number.isFinite(id) ? Math.trunc(id) : i + 1,
      title: String(o.title ?? ''),
      files: Array.isArray(o.files) ? o.files.map((f) => String(f).trim()).filter(Boolean) : [],
      action: String(o.action ?? ''),
      verify: String(o.verify ?? ''),
      dependsOn: Array.isArray(o.dependsOn)
        ? o.dependsOn.map((d) => Number(d)).filter((d) => Number.isFinite(d)).map((d) => Math.trunc(d))
        : [],
    };
  });
  const gaps = Array.isArray(obj.gaps) ? obj.gaps.map((g) => String(g).trim()).filter(Boolean) : [];
  return { steps, gaps };
}

/** The step list as the JSON the repair pass is asked to correct. */
function stepsAsJson(steps: PlanStep[]): string {
  return JSON.stringify({ steps }, null, 1);
}

/**
 * The channels. Plain JSON only — `ctx` and the executor are closed over by the nodes instead, so a
 * durable checkpointer can serialize every value in this state without knowing ayin's types.
 */
const PlanState = Annotation.Root({
  survey: Annotation<string>,
  observability: Annotation<string>,
  deliverables: Annotation<string>,
  requiredPatterns: Annotation<string[]>,
  steps: Annotation<PlanStep[]>,
  gaps: Annotation<string[]>,
  errors: Annotation<string[]>,
  attempts: Annotation<number>,
  markdown: Annotation<string>,
});

/**
 * Build the graph. Separate from running it so the topology can be printed — `drawMermaid()` on this is
 * the docs' diagram, which is why the docs cannot describe a shape the code does not have.
 */
export function actionablePlanGraph(input: ActionablePlanInput) {
  const { ctx, executor } = input;

  /** Deterministic: what the executor knows about this project type. No model, no network. */
  const gather = () => {
    const deliverables = executor.deliverables(ctx);
    const required = deliverables.filter((d) => d.required).map((d) => d.patterns[0]);
    // SCOPED TO THE PHASE, when there is one. A phase asked to satisfy the whole project's deliverable
    // list would draft the whole project — which is the flat plan this level exists to replace.
    const owned = input.phase ? required.filter((r) => input.phase!.deliverables.includes(r)) : required;
    return {
      survey: executor.survey(ctx),
      observability: executor.observability(ctx),
      deliverables: renderDeliverableList(deliverables.filter((d) => !d.required || owned.includes(d.patterns[0]))),
      requiredPatterns: owned,
      steps: [],
      gaps: [],
      errors: [],
      attempts: 0,
      markdown: '',
    };
  };

  /**
   * Every node, timed to the log.
   *
   * "Why did planning take a minute" should be answerable by the thing that took the minute, not by
   * someone reconstructing it from wall clocks. Borrowed from Maradel, where exactly this turned "the
   * plan is slow" into "60 of the 98 seconds are one embedding loop" in a single run.
   */
  const timed =
    <T, R>(name: string, fn: (s: T) => R | Promise<R>) =>
    async (s: T): Promise<R> => {
      const t0 = Date.now();
      try {
        return await fn(s);
      } finally {
        log('INFO', 'plan_phase', { phase: name, ms: String(Date.now() - t0) });
      }
    };

  const draft = async (s: typeof PlanState.State) => {
    setActivityDetail('drafting the actionable plan');
    const raw = await llmChat([{
      role: 'user',
      content: planPrompts.get('actionablePlan', {
        PHASE: input.phase
          ? `THIS PLAN IS ONE PHASE OF THE JOB — phase ${input.phase.id}, "${input.phase.title}".\n`
            + `It is done when: ${input.phase.goal}\n`
            + 'Plan ONLY this phase. Earlier phases have already run; later phases will follow. Do not '
            + 'restate their work and do not reach past this phase\'s goal.'
          : '',
        GOAL: input.goal || '(none derived)',
        REQUEST: input.request.slice(0, 8000),
        FEATURES: input.features.length ? input.features.map((f) => `- ${f}`).join('\n') : '- (not decomposed by triage)',
        SURVEY: s.survey,
        FINDINGS: input.findings.length
          ? input.findings.map((f, i) => `### Exploration ${i + 1}\n${f}`).join('\n\n')
          : ctx.greenfield
            ? '(nothing on disk yet — this plan creates the project from scratch; do not describe existing code)'
            : '(exploration produced nothing — say so in gaps)',
        API_RESEARCH: input.apiResearch || '(no third-party API involved)',
        DOMAIN_REFERENCE: input.grounding || '(no domain reference for this project type)',
        DELIVERABLES: s.deliverables,
        OBSERVABILITY: s.observability,
      }),
    }], { declareTools: false });
    const parsed = parsePlan(raw);
    if (!parsed) {
      log('WARN', 'plan_steps_unparsed', { chars: String(raw.length) });
      // THE RAW REPLY, ON DISK. "2,262 characters that would not parse" is not a diagnosis, and the
      // reply is gone the moment this returns — so the one question worth asking (did the model emit
      // bad JSON, or does `parsePlan` mishandle good JSON?) had no evidence either way.
      void import('../session-record.js').then((r) => r.recordRaw(s.attempts, `plan draft did not parse${input.phase ? ` · phase ${input.phase.id} ${input.phase.title}` : ''}`, raw));
      return { steps: [], gaps: [], attempts: s.attempts + 1 };
    }
    return { steps: parsed.steps, gaps: parsed.gaps, attempts: s.attempts + 1 };
  };

  /** The only judge of a plan in this file, and it is a program. */
  /**
   * It NORMALISES before it judges — see `inferDependencies`. An ordering the `files` already imply is
   * not a disagreement to take to a model.
   */
  const validate = (s: typeof PlanState.State) => {
    const steps = inferDependencies(s.steps);
    return { steps, errors: validateSteps(steps, s.requiredPatterns) };
  };

  const repair = async (s: typeof PlanState.State) => {
    setActivityDetail(`repairing the plan (${s.errors.length} problem(s) the validator found)`);
    log('INFO', 'plan_steps_repair', { attempt: String(s.attempts), errors: String(s.errors.length) });
    const raw = await llmChat([{
      role: 'user',
      content: planPrompts.get('actionablePlanRepair', {
        PLAN: stepsAsJson(s.steps),
        ERRORS: s.errors.map((e) => `- ${e}`).join('\n'),
        DELIVERABLES: s.deliverables,
      }),
    }], { declareTools: false });
    const parsed = parsePlan(raw);
    // A repair that cannot be read leaves the previous steps standing: the validator's complaints are
    // then reported honestly with the plan rather than replaced by an empty one.
    if (!parsed) return { attempts: s.attempts + 1 };
    return { steps: parsed.steps, gaps: parsed.gaps, attempts: s.attempts + 1 };
  };

  const render = (s: typeof PlanState.State) => ({ markdown: renderPlan(s.steps, s.gaps, s.errors) });

  /**
   * The bound. `planRepairPasses` model calls at most, then the plan ships with its faults named.
   *
   * AN UNPARSED DRAFT IS RE-DRAFTED, NOT REPAIRED. Zero steps is not a plan with problems — it is no
   * plan, and `actionablePlanRepair` would be handed an empty list and asked to correct it. This used
   * to route straight to `render`, which returned null and dropped the plan; harmless when there was
   * one plan and a prose fallback behind it, and not harmless once a plan is one PHASE of a job.
   * Measured: phase 1 of four came back as 2,262 characters that would not parse, was never retried,
   * and the phase vanished from the plan carrying all three of its required deliverables while the
   * other three phases planned cleanly around the hole.
   */
  const route = (s: typeof PlanState.State): 'draft' | 'repair' | 'render' => {
    if (s.steps.length === 0) return s.attempts > getConfig('planRepairPasses', 1) ? 'render' : 'draft';
    if (s.errors.length === 0) return 'render';
    if (s.attempts > getConfig('planRepairPasses', 1)) return 'render';
    return 'repair';
  };

  return new StateGraph(PlanState)
    .addNode('gather', timed('gather', gather))
    .addNode('draft', timed('draft', draft))
    .addNode('validate', timed('validate', validate))
    .addNode('repair', timed('repair', repair))
    .addNode('render', timed('render', render))
    .addEdge(START, 'gather')
    .addEdge('gather', 'draft')
    .addEdge('draft', 'validate')
    .addConditionalEdges('validate', route, { draft: 'draft', repair: 'repair', render: 'render' })
    .addEdge('repair', 'validate')
    .addEdge('render', END);
}

/** The phase index as markdown: the stages, what each is done when, and where its plan lives. */
export function renderPhaseIndex(phases: PhasePlan[], files: string[], unresolved: string[]): string {
  const lines: string[] = ['## Phases', ''];
  phases.forEach((p, i) => {
    const after = p.phase.dependsOn.length ? ` · after phase ${p.phase.dependsOn.join(', ')}` : '';
    const steps = p.plan ? `${p.plan.steps.length} step(s)` : 'NOT PLANNED — the sub-plan could not be drafted';
    lines.push(`${p.phase.id}. **${p.phase.title}**${after}`);
    lines.push(`   - done when: ${p.phase.goal.trim()}`);
    lines.push(`   - produces: ${p.phase.deliverables.length ? p.phase.deliverables.map((d) => `\`${d}\``).join(', ') : '(no required deliverable)'}`);
    lines.push(`   - plan: ${files[i] ? `\`${files[i]}\`` : '(not written)'} — ${steps}`);
    lines.push('');
  });
  if (unresolved.length) {
    lines.push('## Unresolved — the validator still rejects this breakdown', '');
    for (const e of unresolved) lines.push(`- ${e}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Decompose the job into phases, then plan each one. The two-level plan.
 *
 * ONE EXTRA MODEL CALL BUYS THE DECOMPOSITION, and each phase then costs what a plan has always cost.
 * A single-phase answer is the ordinary small request and costs exactly one call more than before —
 * which is the price of asking "what stages does this have" instead of assuming the answer is one.
 *
 * EAGER, NOT LAZY. Every sub-plan is drafted and written before any work starts, because that is the
 * invariant plan mode already promises: the thinking is on disk before the machine can die holding it.
 * Expanding a phase only when the one before it finishes would be cheaper and would adapt to what
 * actually happened; it also means a power cut between phases loses everything not yet expanded.
 *
 * Returns null when the decomposition itself failed, so the caller falls back to a flat plan rather
 * than to nothing.
 */
export async function buildPhasedPlan(input: ActionablePlanInput): Promise<PhasedPlan | null> {
  const deliverables = input.executor.deliverables(input.ctx);
  const required = deliverables.filter((d) => d.required).map((d) => d.patterns[0]);
  const rendered = renderDeliverableList(deliverables);
  const started = Date.now();
  let attempts = 0;

  setActivityDetail('breaking the job into phases');
  const ask = async (prompt: string) => {
    attempts++;
    return llmChat([{ role: 'user', content: prompt }], { declareTools: false });
  };

  let phases = parsePhases(await ask(planPrompts.get('planPhases', {
    GOAL: input.goal || '(none derived)',
    REQUEST: input.request.slice(0, 8000),
    FEATURES: input.features.length ? input.features.map((f) => `- ${f}`).join('\n') : '- (not decomposed by triage)',
    SURVEY: input.executor.survey(input.ctx),
    DELIVERABLES: rendered,
  })));
  if (!phases) {
    log('WARN', 'plan_phases_unparsed', {});
    return null;
  }

  let errors = validatePhases(phases, required);
  // The same bound as the step-level repair, for the same reason: a repair that can loop is worse than
  // the fault it corrects.
  for (let pass = 0; errors.length && pass < getConfig('planRepairPasses', 1); pass++) {
    setActivityDetail(`repairing the phase breakdown (${errors.length} problem(s))`);
    log('INFO', 'plan_phases_repair', { pass: String(pass + 1), errors: String(errors.length) });
    const repaired = parsePhases(await ask(planPrompts.get('planPhasesRepair', {
      PHASES: JSON.stringify({ phases }, null, 1),
      ERRORS: errors.map((e) => `- ${e}`).join('\n'),
      DELIVERABLES: rendered,
    })));
    if (!repaired) break;
    phases = repaired;
    errors = validatePhases(phases, required);
  }

  const planned: PhasePlan[] = [];
  for (const phase of phases) {
    setActivityDetail(`planning phase ${phase.id}/${phases.length} — ${phase.title}`);
    const plan = await buildActionablePlan({ ...input, phase });
    if (plan) attempts += plan.attempts;
    planned.push({ phase, plan });
  }

  log('INFO', 'plan_phases', {
    phases: String(phases.length),
    steps: String(planned.reduce((n, p) => n + (p.plan?.steps.length ?? 0), 0)),
    unplanned: String(planned.filter((p) => !p.plan).length),
    unresolved: String(errors.length),
    attempts: String(attempts),
    ms: String(Date.now() - started),
  });

  // Every phase failing to plan is the same as no plan at all — say so and let the caller fall back.
  if (planned.every((p) => !p.plan)) return null;
  return { phases: planned, markdown: '', unresolved: errors, attempts };
}

/**
 * Run the graph. Returns null when nothing usable came back, so `runPlan` falls through to the prose
 * document rather than writing a plan with no steps in it.
 */
export async function buildActionablePlan(input: ActionablePlanInput): Promise<ActionablePlan | null> {
  const graph = actionablePlanGraph(input).compile({ checkpointer: new MemorySaver() });
  const started = Date.now();
  const out = await graph.invoke({}, { configurable: { thread_id: `plan-${started}` } });
  if (out.steps.length === 0) {
    log('WARN', 'plan_steps_empty', { attempts: String(out.attempts) });
    return null;
  }
  log('INFO', 'plan_steps', {
    steps: String(out.steps.length),
    attempts: String(out.attempts),
    unresolved: String(out.errors.length),
    ms: String(Date.now() - started),
  });
  return { steps: out.steps, gaps: out.gaps, markdown: out.markdown, attempts: out.attempts, unresolved: out.errors };
}
