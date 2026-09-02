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
 * The document is written to `.ayin/plans/ayin-plan-<timestamp>.md` (or `AYIN_PLAN_DIR`) — on disk BEFORE
 * the agent starts, so a machine that dies mid-implementation leaves the thinking behind rather than
 * only half a feature. Then the user's prompt goes to the model with the plan already in context.
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
import { repoState } from '../executors/plan/git.js';
import { checkDeliverables } from '../executors/deliverables.js';
import { detectProject, describeProject } from '../executors/detect.js';
import { planExecutorFor } from '../executors/registry.js';
import type { ProjectContext } from '../executors/types.js';
import { ensureToolRuntime } from '../tool-wiring.js';
import { buildActionablePlan, buildPhasedPlan, isActionablePlanEnabled, renderDeliverableList, renderPhaseIndex } from './plan.js';

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

/** `ayin-plan-20260728-143012.md` — sortable, unique enough for a session, readable in a listing. */
function planFilename(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ayin-plan-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.md`;
}

/**
 * Is this big request actually multi-feature, whose APIs does it touch, and — when it is setting a
 * project up — WHICH FOLDER does it name? One cheap call, which already had to read the request.
 *
 * `projectDir` rides along here rather than being pattern-matched out of the prose because the thing
 * being extracted is a name in a sentence, and this repo has retired one natural-language regex on
 * plan mode already. Nothing trusts the answer: `resolveTargetDir` refuses anything that is not a
 * single safe path segment naming a directory that is empty or absent (`executors/detect.ts`).
 */
async function triage(userInput: string): Promise<{ complex: boolean; features: string[]; apis: string[]; projectDir: string; reason: string }> {
  try {
    const raw = await llmCall(getPrompt('planTriage', { REQUEST: userInput.slice(0, 6000) }));
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const obj = JSON.parse(raw.slice(start, end + 1)) as { complex?: unknown; features?: unknown; apis?: unknown; projectDir?: unknown; reason?: unknown };
      const features = Array.isArray(obj.features) ? obj.features.map((f) => String(f)).filter(Boolean).slice(0, 12) : [];
      const apis = Array.isArray(obj.apis) ? obj.apis.map((a) => String(a).trim()).filter(Boolean).slice(0, 6) : [];
      const complex = obj.complex === true || String(obj.complex).toLowerCase() === 'true' || features.length > 1;
      return { complex, features, apis, projectDir: String(obj.projectDir ?? '').trim().slice(0, 120), reason: String(obj.reason ?? '').slice(0, 300) };
    }
    // No JSON — read it conservatively. Planning a simple request wastes minutes; skipping a plan
    // for a complex one only costs what we have today, so an unparseable answer means "no".
    const yes = /\b(complex|multi-?feature|cross-?feature|yes)\b/i.test(raw) && !/\bnot\s+complex\b/i.test(raw);
    return { complex: yes, features: [], apis: [], projectDir: '', reason: raw.trim().slice(0, 200) };
  } catch (err) {
    log('WARN', 'plan_triage_failed', { error: err instanceof Error ? err.message : String(err) });
    return { complex: false, features: [], apis: [], projectDir: '', reason: 'triage call failed' };
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
    log('INFO', 'plan_triage', {
      complex: String(t.complex), explicit: String(explicit), features: String(t.features.length),
      chars: String(userInput.length), reason: t.reason.slice(0, 160),
    });

    // Detected before the floor above (a greenfield request must not be filtered out by length) and
    // REUSED here — one regex pass, not two.
    //
    // Re-detected in exactly one case: triage named a folder to create the project in. `projectDir`
    // does not exist until triage has answered, so `early` was necessarily computed without it, and
    // the target is what turns "build a python site in testwebsite-2" into a greenfield context
    // pointed at that folder. Validated inside `detectProject`, which refuses anything that is not an
    // empty or absent single path segment.
    const ctx = t.projectDir ? detectProject(process.cwd(), userInput, t.projectDir) : early;
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
      // Scaffolding still happens: a README that must exist is a file operation either way, and it is
      // the thing the QA gate would otherwise spend a whole fix pass creating.
      const scaffoldedNow = executor.scaffold(ctx);
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

    // Deterministic scaffolding, BEFORE the plan is written: a project that must have a README gets
    // one now, as a file operation, instead of being a criterion the agent is asked to remember and
    // the QA gate spends a whole fix pass enforcing.
    const scaffolded = executor.scaffold(ctx);
    if (scaffolded.length) {
      // The commit is read back from the repository rather than reported by `scaffold()`, whose
      // contract is PATHS — see `commitScaffold`. Reading it also means the card states what is
      // actually true on disk, not what a function said it did.
      const repo = repoState(projectRoot);
      const committed = repo.own && repo.commits > 0 ? ` · committed ${repo.head}` : '';
      card(PLAN_CARD.scaffold, PLAN_GLYPH.scaffold,
        `${scaffolded.length} file${scaffolded.length === 1 ? '' : 's'} created${committed}`,
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
      const statuses = checkDeliverables(projectRoot, executor.deliverables(ctx)).filter((s) => s.deliverable.required);
      const required = statuses.map((s) => s.deliverable);
      const outstanding = statuses.filter((s) => !s.satisfied);
      if (statuses.length > 0 && outstanding.length === 0) {
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
    const planInput = { request: userInput, goal, features: t.features, apiResearch, findings, grounding, ctx, executor };

    // TWO LEVELS: the stages of the job, then the steps of each stage. See `PlanPhase` — a flat step
    // list is written at one altitude and the model picks files, so "run it on a free port" and "send
    // me the link" got no step at all on a request that asked for both.
    const phased = isActionablePlanEnabled() ? await buildPhasedPlan(planInput) : null;
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
    if (phased) {
      const stem = path.replace(/\.md$/, '');
      const phaseFiles: string[] = [];
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
    return { kind: 'plan', path, body: contextBody.trim(), features: t.features, phaseCount: phased?.phases.length ?? 0 };
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
  return planPrompts.get('planContext', {
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
