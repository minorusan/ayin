/**
 * Plan mode — a big request gets a written plan BEFORE the agent touches anything.
 *
 * WHY. A 2000-character request is usually several features wearing one paragraph. Handed straight to
 * the round loop, the model starts on whichever sentence it read last, discovers the coupling in
 * round nine, and spends the rest of its budget repairing its own first guess. The cheapest fix is
 * the oldest one: look before you leap, and write down what you saw.
 *
 * TWO DOORS, BOTH DETERMINISTIC:
 *
 *   SIZE     prompt length ≥ planMinChars  →  ONE triage call: cross-feature / multi-feature?
 *                                             yes → plan.  no → straight through, nothing lost.
 *   EXPLICIT the literal substring `/plan` is in the prompt (see `hasExplicitPlanMarker`, and
 *            `/plan <text>` — the slash command in `index.ts` — which sets the same door via
 *            `forcePlanNextTurn()` since it strips the token before the text gets here)
 *                                          →  plan, at ANY length, and triage cannot veto it.
 *
 * Length alone would drag every long bug report into planning; triage alone would need an LLM call on
 * every single turn. Together: one extra cheap call, only for genuinely big prompts. And the explicit
 * door exists because "plan the auth rewrite" is nine words: size is a proxy for "this needs thought",
 * and a proxy must never overrule the person who can just say so. A prior version tried to widen this
 * door with a natural-language regex ("plan it", "deep investigate the codebase", …); retired — plan
 * mode is the most expensive gate in the system, and a fuzzy phrase match on it is exactly the kind of
 * thing that misfires unpredictably from outside one specific conversation. `/plan` is unambiguous.
 *
 * THE PLAN, IN ORDER (each step feeds the next):
 *   1. SURVEY   — deterministic: what this project is, what it can serve, how it can be observed.
 *   2. API RESEARCH — MANDATORY when a third-party API is involved: its CURRENT shape, off the web,
 *      because that is the one thing a model must never answer from memory (see `researchApis`).
 *      An Arduino project gets the same "don't recall it" treatment: `isArduinoProject` gates a
 *      deterministic dump of arduino_db's catalog into the prompt, so component facts are grounded in
 *      the shipped reference instead of guessed at.
 *   3. EXPLORE  — the context around the problem: what already exists, who calls it, what it assumes.
 *   4. DEPENDENCIES — for a new webview specifically: can this project even serve one? What's missing?
 *   5. GAPS     — what is still unknown or undecided, named rather than guessed at.
 *   6. FILES    — the key files to change, with the change outlined per file.
 *   7. OBSERVABILITY — the log coverage and debug affordances this system already provides, wired
 *      into the plan, so the feature can be watched working instead of merely believed.
 *
 * The document is written to `ayin-plan-<timestamp>.md` (cwd, or `AYIN_PLAN_DIR`) — on disk BEFORE
 * the agent starts, so a machine that dies mid-implementation leaves the thinking behind rather than
 * only half a feature. Then the user's prompt goes to the model with the plan already in context.
 *
 * Opt out with `AYIN_PLAN=0`; `planMinChars: 0` disables it from `prompts.json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llmChat } from '../llm/manager.js';
import { llmCall } from '../llm.js';
import { log } from '../log.js';
import { getConfig, getPrompt } from '../prompts.js';
import { prompts as promptsService, packagePath } from '../prompts-service.js';
import { recentPrompts } from '../session-record.js';
import { exploreExecute } from '../tools/explore.js';
import { webSearch } from '../tools/web-search.js';
import { isArduinoProject } from '../tools/arduino-explain.js';
import { ARDUINO_COMPONENTS } from '../tools/arduino-components-data.js';
import { catalogLine } from '../tools/arduino-db.js';
import { pushActivity, setActivityDetail } from '../activity.js';
import { addMessage, setAgentStatus } from '../ui.js';
import { renderSurvey, surveyProject, type Survey } from './survey.js';

/**
 * The `plan` namespace — everything plan mode *says* to a model that is not the two big documents
 * already in the `ayin` namespace: the two fixed exploration questions, the two "this API was not
 * researched" notices the plan is instructed to act on, and the `<plan>` pre-prompt block.
 */
const planPrompts = promptsService.register('plan', packagePath('prompts', 'plan')).bundle;

export interface PlanResult {
  path: string;
  body: string;
  features: string[];
}

/**
 * The explicit door: the literal substring `/plan` anywhere in the prompt. Deliberately NOT a
 * natural-language regex — a prior version matched "plan it", "deep investigate the codebase", "deep
 * dive" and similar verb phrases, tightly anchored to avoid English words like "what's the plan?" or
 * "the plan was to ship Friday". Retired anyway: a fuzzy phrase match on plan mode — the single most
 * expensive gate in the system (triage + survey + web searches + explore loops + a long document) — is
 * exactly the kind of thing that misfires in ways nobody can predict from outside a specific
 * conversation. `/plan` is unambiguous, greppable, and matches how every other explicit door in this
 * codebase works: one string, one sentence of documentation, no regression suite needed to keep
 * matching how people phrase things in English.
 */
export function hasExplicitPlanMarker(userInput: string): boolean {
  return userInput.includes('/plan');
}

/**
 * `/plan <text>` (the interactive slash command in `index.ts`) sets this. It exists because that
 * dispatcher STRIPS the `/plan` token before the text ever reaches `runPlan` — so the substring test
 * above would otherwise never see it for that path. One-shot, and consumed even when planning then
 * fails — a flag that survived its turn would silently plan the NEXT unrelated prompt, which is the
 * sort of surprise that costs a GPU-minute and trust.
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
async function exploreContext(userInput: string, features: string[], survey: Survey): Promise<string[]> {
  const budget = getConfig('planExploreCalls', 2);
  if (budget <= 0) return [];
  const subject = features.length ? features.join('; ') : userInput.slice(0, 400);
  const questions = [
    planPrompts.get('exploreExisting', { SUBJECT: subject }),
    planPrompts.get('exploreChanges', { SUBJECT: subject }),
  ].slice(0, budget);

  const findings: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    setActivityDetail(`exploring the code (${i + 1}/${questions.length})`);
    try {
      const r = await exploreExecute({ question: questions[i], context: `Project: ${survey.kind} at ${survey.root}` });
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

  // Two doors. SIZE is the automatic one; an EXPLICIT ASK is the other, and it ignores the size
  // threshold entirely — "plan the auth rewrite" is nine words and deserves a plan more than a
  // 2000-character bug report does.
  const explicit = forced || hasExplicitPlanMarker(userInput);
  forced = false; // one-shot, consumed here whatever happens next
  const minChars = getConfig('planMinChars', 2000);
  if (!explicit && (minChars <= 0 || userInput.length < minChars)) return null;

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
    if (!explicit && !t.complex) {
      addMessage('system', `Plan mode: not needed — single-feature request (${userInput.length} chars).`);
      return null;
    }

    const why = explicit
      ? 'you asked for it'
      : `${t.features.length || 'multiple'} feature(s) detected in ${userInput.length} chars`;
    addMessage('system', `Plan mode: ${why} — planning before executing.${!explicit && t.reason ? ` ${t.reason}` : ''}`);

    setActivityDetail('surveying the project');
    const survey = surveyProject();
    // Mandatory, before exploration: if somebody else's API is involved, get its CURRENT shape from
    // the web. Everything downstream (the plan, then the implementation) is written against this
    // instead of against recall.
    const apiResearch = await researchApis(t.apis);
    if (t.apis.length) addMessage('system', `Plan mode: third-party API research — ${t.apis.join(', ')}`);
    const findings = await exploreContext(userInput, t.features, survey);

    // Arduino projects get the SAME "don't recall it, look it up" treatment as a third-party API —
    // deterministic (no LLM call, arduino_db is a plain keyword catalog), so the writer has real
    // component facts instead of guessing at pinouts/identification from training data. Component
    // WIRING LEGS aren't dumped here (would bloat the prompt); the block instructs the plan to send
    // implementation to the arduino_db TOOL for those, and to web_search only for what the catalog
    // doesn't cover (a specific datasheet, a library's own API).
    const arduino = isArduinoProject(survey.root);
    if (arduino) addMessage('system', 'Plan mode: Arduino project detected — grounding the plan in arduino_db\'s component catalog');

    setActivityDetail('writing the plan');
    const prompts = recentPrompts(12);
    const body = await llmChat([{
      role: 'user',
      content: getPrompt('planDocument', {
        REQUEST: userInput.slice(0, 8000),
        PROMPTS: prompts.map((p, i) => `${i + 1}. ${p.slice(0, 600)}`).join('\n') || '(this is the first prompt)',
        GOAL: goal || '(none derived)',
        FEATURES: t.features.length ? t.features.map((f) => `- ${f}`).join('\n') : '- (not decomposed by triage)',
        SURVEY: renderSurvey(survey),
        FINDINGS: findings.length ? findings.map((f, i) => `### Exploration ${i + 1}\n${f}`).join('\n\n') : '(exploration produced nothing — say so in the Gaps section)',
        APIS: t.apis.length ? t.apis.join(', ') : '(none identified)',
        API_RESEARCH: apiResearch || '(no third-party API involved — omit the API section)',
        ARDUINO_BLOCK: arduino
          ? `ARDUINO PROJECT DETECTED. Ground every component fact below in this shipped catalog (query the arduino_db tool for the full entry — legs, wiring notes — during implementation; this list is names/identify only):\n${ARDUINO_COMPONENTS.map(catalogLine).join('\n')}\n\nUse web_search only for what this catalog doesn't cover (a specific datasheet, a library's own API). Never guess a pinout or wiring fact from memory when arduino_db has an entry for it.`
          : '(not an Arduino project — omit the Arduino reference section)',
      }),
    }]);

    const dir = process.env.AYIN_PLAN_DIR || process.cwd();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, planFilename());
    const header = [
      '<!-- Written by ayin plan mode before implementation started. -->',
      // Provenance: a plan read back a week later should say why it exists at all — an explicit ask
      // and an automatic size trigger are different claims about how much the operator wanted this.
      `<!-- Triggered by: ${explicit ? '/plan' : `size (${userInput.length} chars) + triage`} -->`,
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
    return { path, body: body.trim(), features: t.features };
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
  return planPrompts.get('planContext', { PATH: plan.path, BODY: plan.body.slice(0, 12_000) });
}
