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
 * OFF BY DEFAULT. `AYIN_PLAN_GRAPH=1` selects this path; without it plan mode writes the prose document
 * exactly as before. Failure returns null and the caller falls back — the same contract as the rest of
 * plan mode: a planner that cannot plan must never block the request.
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
}

/**
 * `AYIN_PLAN_GRAPH=1` — the third door, and the only way into this file. Off by default because the
 * prose document is what every existing install and the Arduino benchmark currently measure, and a plan
 * shape is not a thing to change under an operator without asking.
 */
export function isActionablePlanEnabled(): boolean {
  return process.env.AYIN_PLAN_GRAPH === '1';
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

/** One JSON object out of a model's answer, defensively coerced. Null when there is nothing usable. */
function parsePlan(raw: string): { steps: PlanStep[]; gaps: string[] } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: { steps?: unknown; gaps?: unknown };
  try { obj = JSON.parse(raw.slice(start, end + 1)) as { steps?: unknown; gaps?: unknown }; } catch { return null; }
  if (!Array.isArray(obj.steps)) return null;

  const steps: PlanStep[] = obj.steps.map((s, i) => {
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
    return {
      survey: executor.survey(ctx),
      observability: executor.observability(ctx),
      deliverables: renderDeliverableList(deliverables),
      requiredPatterns: deliverables.filter((d) => d.required).map((d) => d.patterns[0]),
      steps: [],
      gaps: [],
      errors: [],
      attempts: 0,
      markdown: '',
    };
  };

  const draft = async (s: typeof PlanState.State) => {
    setActivityDetail('drafting the actionable plan');
    const raw = await llmChat([{
      role: 'user',
      content: planPrompts.get('actionablePlan', {
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
    }]);
    const parsed = parsePlan(raw);
    if (!parsed) {
      log('WARN', 'plan_steps_unparsed', { chars: String(raw.length) });
      return { steps: [], gaps: [], attempts: s.attempts + 1 };
    }
    return { steps: parsed.steps, gaps: parsed.gaps, attempts: s.attempts + 1 };
  };

  /** The only judge of a plan in this file, and it is a program. */
  const validate = (s: typeof PlanState.State) => ({ errors: validateSteps(s.steps, s.requiredPatterns) });

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
    }]);
    const parsed = parsePlan(raw);
    // A repair that cannot be read leaves the previous steps standing: the validator's complaints are
    // then reported honestly with the plan rather than replaced by an empty one.
    if (!parsed) return { attempts: s.attempts + 1 };
    return { steps: parsed.steps, gaps: parsed.gaps, attempts: s.attempts + 1 };
  };

  const render = (s: typeof PlanState.State) => ({ markdown: renderPlan(s.steps, s.gaps, s.errors) });

  /** The bound. `planRepairPasses` model calls at most, then the plan ships with its faults named. */
  const route = (s: typeof PlanState.State): 'repair' | 'render' => {
    if (s.errors.length === 0) return 'render';
    if (s.steps.length === 0) return 'render';
    if (s.attempts > getConfig('planRepairPasses', 1)) return 'render';
    return 'repair';
  };

  return new StateGraph(PlanState)
    .addNode('gather', gather)
    .addNode('draft', draft)
    .addNode('validate', validate)
    .addNode('repair', repair)
    .addNode('render', render)
    .addEdge(START, 'gather')
    .addEdge('gather', 'draft')
    .addEdge('draft', 'validate')
    .addConditionalEdges('validate', route, { repair: 'repair', render: 'render' })
    .addEdge('repair', 'validate')
    .addEdge('render', END);
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
