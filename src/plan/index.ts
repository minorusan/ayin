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
 *   1. SCAFFOLD — deterministic file creation for the chosen project type. A README the project must
 *      have is written NOW, as a file operation, rather than left as a criterion the agent is asked
 *      to remember and the QA gate spends a whole fix pass enforcing.
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
 *      report "nothing found".
 *   6. DELIVERABLES — what must exist ON DISK when the work is done, stated by the executor and later
 *      checked by QA as files rather than as claims.
 *   7. GAPS     — what is still unknown or undecided, named rather than guessed at.
 *   8. FILES    — the key files to change, with the change outlined per file.
 *   9. OBSERVABILITY — how work in THIS kind of project is watched working: a logger module and an
 *      env switch in a service, Serial Monitor and `arduino-cli compile` in firmware.
 *
 * The document is written to `ayin-plan-<timestamp>.md` (cwd, or `AYIN_PLAN_DIR`) — on disk BEFORE
 * the agent starts, so a machine that dies mid-implementation leaves the thinking behind rather than
 * only half a feature. Then the user's prompt goes to the model with the plan already in context.
 *
 * `AYIN_PLAN=0` is an absolute operator kill switch — it beats the session toggle AND `/planthis`.
 * `planMinChars: 0` (from `prompts.json`) disables just the size door once the session toggle is on.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llmChat } from '../llm/manager.js';
import { llmCall } from '../llm.js';
import { log } from '../log.js';
import { getConfig, getPrompt } from '../prompts.js';
import { prompts as promptsService, packagePath } from '../prompts-service.js';
import { recentPrompts } from '../session-record.js';
import { exploreExecute } from '../tools/explore/index.js';
import { webSearch } from '../tools/web-search.js';
import { pushActivity, setActivityDetail } from '../activity.js';
import { addMessage, setAgentStatus } from '../ui.js';
import { detectProject, describeProject } from '../executors/detect.js';
import { planExecutorFor } from '../executors/registry.js';
import type { Deliverable, ProjectContext } from '../executors/types.js';
import { ensureToolRuntime } from '../tool-wiring.js';

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
   * document, no file on disk.
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
  kind: 'plan' | 'grounding';
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
 * `AYIN_PLAN=1` is the mirror of the existing `AYIN_PLAN=0` kill switch: force the session toggle ON
 * from the environment. It exists because headless (`-p`) has no TUI and therefore no way to type
 * `/plan`, which made plan mode untestable in any automated harness — including the Arduino benchmark,
 * whose whole subject is how well ayin plans. A feature that can only be exercised by a human pressing
 * keys cannot be regression-tested.
 */
let sessionEnabled = process.env.AYIN_PLAN === '1';

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
 * The deliverable list as prompt text. One renderer, used by BOTH the plan document and the
 * grounding-only block — they were separate, and the grounding path simply had no deliverables,
 * which is how a scaffolded README stayed an empty stub and a required diagram went unwritten.
 */
function renderDeliverableList(deliverables: Deliverable[]): string {
  return deliverables
    .map((d) => `- ${d.label} — \`${d.patterns[0]}\`${d.required ? ' (REQUIRED)' : ' (optional)'}: ${d.why}`)
    .join('\n');
}

/** `ayin-plan-20260728-143012.md` — sortable, unique enough for a session, readable in a listing. */
function planFilename(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ayin-plan-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.md`;
}

/** Is this big request actually multi-feature, and whose APIs does it touch? One cheap call. */
async function triage(userInput: string): Promise<{ complex: boolean; features: string[]; apis: string[]; reason: string }> {
  try {
    const raw = await llmCall(getPrompt('planTriage', { REQUEST: userInput.slice(0, 6000) }));
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const obj = JSON.parse(raw.slice(start, end + 1)) as { complex?: unknown; features?: unknown; apis?: unknown; reason?: unknown };
      const features = Array.isArray(obj.features) ? obj.features.map((f) => String(f)).filter(Boolean).slice(0, 12) : [];
      const apis = Array.isArray(obj.apis) ? obj.apis.map((a) => String(a).trim()).filter(Boolean).slice(0, 6) : [];
      const complex = obj.complex === true || String(obj.complex).toLowerCase() === 'true' || features.length > 1;
      return { complex, features, apis, reason: String(obj.reason ?? '').slice(0, 300) };
    }
    // No JSON — read it conservatively. Planning a simple request wastes minutes; skipping a plan
    // for a complex one only costs what we have today, so an unparseable answer means "no".
    const yes = /\b(complex|multi-?feature|cross-?feature|yes)\b/i.test(raw) && !/\bnot\s+complex\b/i.test(raw);
    return { complex: yes, features: [], apis: [], reason: raw.trim().slice(0, 200) };
  } catch (err) {
    log('WARN', 'plan_triage_failed', { error: err instanceof Error ? err.message : String(err) });
    return { complex: false, features: [], apis: [], reason: 'triage call failed' };
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
 * Build the plan and write it down. Returns null when planning does not apply or fails — the caller
 * then proceeds exactly as it does today, because a failed planner must never block a request.
 */
export async function runPlan(userInput: string, goal: string): Promise<PlanResult | null> {
  if (process.env.AYIN_PLAN === '0') return null;

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
  if (!explicit && userInput.length < getConfig('planToggledMinChars', 60)) return null;

  // One named phase for the whole planning pass. The wait narrator leads its line with this and the
  // status bar keeps `▣ PLAN` lit, so minutes of triage → research → exploration → writing never look
  // like an ordinary "thinking". See activity.ts.
  const endPhase = pushActivity('PLAN', `triaging a ${userInput.length}-char request`);
  try {
    // Triage still runs when the ask was explicit — it is the cheapest way to decompose the work and
    // to NAME THE APIS the mandatory research step needs. What changes is that its `complex` verdict
    // no longer decides anything: a model must not be able to veto a user who said "plan it".
    const t = await triage(userInput);
    log('INFO', 'plan_triage', {
      complex: String(t.complex), explicit: String(explicit), features: String(t.features.length),
      chars: String(userInput.length), reason: t.reason.slice(0, 160),
    });

    // Detected here rather than after the veto, because the veto has to be able to consult it.
    const ctx = detectProject(process.cwd(), userInput);
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
    if (!explicit && !t.complex && !hasDomainGrounding) {
      addMessage('system', `Plan mode: not needed — single-feature request (${userInput.length} chars).`);
      return null;
    }
    // GROUNDING-ONLY: the cheap path. The facts reach the model; no document is generated and none is
    // written. Costs nothing beyond the triage call that already happened — `grounding` is a
    // deterministic string, so this branch adds zero LLM calls.
    if (!explicit && !t.complex && hasDomainGrounding) {
      log('INFO', 'plan_grounding_only', { project: ctx.type, chars: String(grounding.length) });
      addMessage('system', `Plan mode: single-feature — skipping the plan document, but injecting the ${ctx.type} reference material so nothing is answered from recall.`);
      // Scaffolding still happens: a README that must exist is a file operation either way, and it is
      // the thing the QA gate would otherwise spend a whole fix pass creating.
      const scaffoldedNow = executor.scaffold(ctx);
      if (scaffoldedNow.length) addMessage('system', `Created ${scaffoldedNow.join(', ')}`);
      return { kind: 'grounding', path: '', body: grounding, features: t.features, deliverables: renderDeliverableList(executor.deliverables(ctx)) };
    }

    const why = explicit
      ? 'you asked for it'
      : `${t.features.length || 'multiple'} feature(s) detected in ${userInput.length} chars`;
    addMessage('system', `Plan mode: ${why} — planning before executing.${!explicit && t.reason ? ` ${t.reason}` : ''}`);

    setActivityDetail('surveying the project');
    // `ctx` and `executor` were resolved above the triage veto — the veto needs to consult whether
    // this project type has domain grounding. Detection is from the REQUEST as well as the tree, which
    // is what makes it work on the turn that CREATES the project: every Arduino hook used to key off
    // `isArduinoProject(root)`, which needs an `.ino` to already exist, so the catalog was withheld
    // exactly when it mattered most. See executors/detect.ts.
    log('INFO', 'plan_executor', { project: describeProject(ctx), executor: executor.config.id });
    addMessage('system', `Plan mode: ${describeProject(ctx)} → "${executor.config.id}" plan executor.`);

    // Deterministic scaffolding, BEFORE the plan is written: a project that must have a README gets
    // one now, as a file operation, instead of being a criterion the agent is asked to remember and
    // the QA gate spends a whole fix pass enforcing.
    const scaffolded = executor.scaffold(ctx);
    if (scaffolded.length) addMessage('system', `Plan mode: created ${scaffolded.join(', ')}`);

    // Mandatory, before exploration: if somebody else's API is involved, get its CURRENT shape from
    // the web. Everything downstream (the plan, then the implementation) is written against this
    // instead of against recall.
    const apiResearch = await researchApis(t.apis);
    if (t.apis.length) addMessage('system', `Plan mode: third-party API research — ${t.apis.join(', ')}`);
    const findings = await exploreContext(userInput, t.features, ctx);

    // `grounding` was resolved above the triage veto (it decides whether a veto applies at all). The
    // user's own words were the retrieval query — see `PlanExecutor.grounding`; retrieving rather than
    // dumping the corpus is what keeps the Arduino catalog block at ~2.5k characters instead of 10.2k.
    if (grounding) addMessage('system', `Plan mode: grounding the plan in the ${ctx.type} reference material rather than recall.`);

    const deliverables = executor.deliverables(ctx);

    setActivityDetail('writing the plan');
    const prompts = recentPrompts(12);
    const body = await llmChat([{
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
    }]);

    const dir = process.env.AYIN_PLAN_DIR || process.cwd();
    mkdirSync(dir, { recursive: true });
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
    writeFileSync(path, `${header}${body.trim()}\n`);

    log('INFO', 'plan_written', { path, chars: String(body.length), explorations: String(findings.length), trigger: explicit ? 'explicit' : 'size' });
    addMessage('system', `Plan written: ${path}`);
    return { kind: 'plan', path, body: body.trim(), features: t.features };
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
  return planPrompts.get('planContext', { PATH: plan.path, BODY: plan.body.slice(0, 12_000) });
}
