/**
 * Plan mode — a big request gets a written plan BEFORE the agent touches anything.
 *
 * WHY. A 2000-character request is usually several features wearing one paragraph. Handed straight to
 * the round loop, the model starts on whichever sentence it read last, discovers the coupling in
 * round nine, and spends the rest of its budget repairing its own first guess. The cheapest fix is
 * the oldest one: look before you leap, and write down what you saw.
 *
 * THE CONDITION IS DETERMINISTIC, THE JUDGEMENT IS NOT:
 *
 *     prompt length ≥ planMinChars   →   ONE triage call: is this cross-feature / multi-feature?
 *                                        yes → plan mode.   no → straight through, nothing lost.
 *
 * Length alone would drag every long bug report into planning; triage alone would need an LLM call on
 * every single turn. Together: one extra cheap call, only for genuinely big prompts.
 *
 * THE PLAN, IN ORDER (each step feeds the next):
 *   1. SURVEY   — deterministic: what this project is, what it can serve, how it can be observed.
 *   2. API RESEARCH — MANDATORY when a third-party API is involved: its CURRENT shape, off the web,
 *      because that is the one thing a model must never answer from memory (see `researchApis`).
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
import { recentPrompts } from '../session-record.js';
import { exploreExecute } from '../tools/explore.js';
import { webSearch } from '../tools/web-search.js';
import { addMessage, setAgentStatus } from '../ui.js';
import { renderSurvey, surveyProject, type Survey } from './survey.js';

export interface PlanResult {
  path: string;
  body: string;
  features: string[];
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
      blocks.push(`### ${api}\nNOT RESEARCHED — the search budget (planApiSearches=${budget}) ran out. `
        + `The plan must say so and make looking this up the first implementation step.`);
      continue;
    }
    setAgentStatus(`Planning — researching the ${api} API (current docs)…`);
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
      blocks.push(`### ${api}\nRESEARCH FAILED (${msg}). Treat every detail of this API as UNVERIFIED: `
        + `the plan must make "fetch and read the current ${api} documentation" an explicit first step, and must `
        + `not state endpoints, field names or auth flows as if they were known.`);
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
    `What already exists in this codebase that relates to: ${subject}? Name the actual files, the functions/classes, `
    + `who calls them, and what they currently assume. Report file paths with what each one does.`,
    `To implement: ${subject} — which existing files would have to change, and what is each one's current `
    + `responsibility? Name concrete paths and the specific functions/blocks that would be touched.`,
  ].slice(0, budget);

  const findings: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    setAgentStatus(`Planning — exploring context (${i + 1}/${questions.length})…`);
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
  const minChars = getConfig('planMinChars', 2000);
  if (minChars <= 0 || userInput.length < minChars) return null;

  try {
    setAgentStatus('Large request — checking whether it needs a plan…');
    const t = await triage(userInput);
    log('INFO', 'plan_triage', { complex: String(t.complex), features: String(t.features.length), chars: String(userInput.length), reason: t.reason.slice(0, 160) });
    if (!t.complex) {
      addMessage('system', `Plan mode: not needed — single-feature request (${userInput.length} chars).`);
      return null;
    }

    addMessage('system', `Plan mode: ${t.features.length || 'multiple'} feature(s) detected — planning before executing.${t.reason ? ` ${t.reason}` : ''}`);

    setAgentStatus('Planning — surveying the project…');
    const survey = surveyProject();
    // Mandatory, before exploration: if somebody else's API is involved, get its CURRENT shape from
    // the web. Everything downstream (the plan, then the implementation) is written against this
    // instead of against recall.
    const apiResearch = await researchApis(t.apis);
    if (t.apis.length) addMessage('system', `Plan mode: third-party API research — ${t.apis.join(', ')}`);
    const findings = await exploreContext(userInput, t.features, survey);

    setAgentStatus('Planning — writing the plan…');
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
      }),
    }]);

    const dir = process.env.AYIN_PLAN_DIR || process.cwd();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, planFilename());
    const header = [
      '<!-- Written by ayin plan mode before implementation started. -->',
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

    log('INFO', 'plan_written', { path, chars: String(body.length), explorations: String(findings.length) });
    addMessage('system', `Plan written: ${path}`);
    return { path, body: body.trim(), features: t.features };
  } catch (err) {
    log('WARN', 'plan_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    setAgentStatus('');
  }
}

/** The plan as the pre-prompt block for this turn's base call. */
export function planContextBlock(plan: PlanResult): string {
  return `<plan>\nThis request was large and cross-feature, so a PLAN was produced and written to disk `
    + `BEFORE this turn: ${plan.path}\n\n${plan.body.slice(0, 12_000)}\n\n`
    + `When you work:\n`
    + `- FOLLOW this plan. It already contains the exploration, the affected files and the observability step.\n`
    + `- Do NOT re-explore what the plan already establishes, and do NOT re-plan.\n`
    + `- Work the steps in order. If a step turns out to be wrong, say which one and why, then adapt — do not silently drift.\n`
    + `- Implement the logging/debug step too; it is part of the deliverable, not an optional extra.\n`
    + `- Reference the plan file by path if you tell the user what you are doing.\n`
    + `</plan>`;
}
