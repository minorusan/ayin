/**
 * The one model call in the whole feature: a vague sentence becomes an explicit plan, once.
 *
 * Everything after this is deterministic. The runs do not re-plan, do not re-read the operator's
 * sentence, and do not decide their own schedule — they are handed a file. That split is what makes a
 * sentinel auditable: the plan is on disk in `sentinaile_plan.md`, a human can read it, edit it, and
 * know exactly what will happen at 03:00 without running anything.
 *
 * The model's output is UNTRUSTED. It arrives as JSON, is validated field by field, and its schedule
 * is clamped (`sanitizeSchedule`) before it can reach a timer. "Every second" is a plausible thing to
 * derive from "keep an eye on it", and it must never become a process spawning an agent every second.
 */

import { llmChat } from '../llm/manager.js';
import { getPrompt } from '../prompts.js';
import { sanitizeSchedule } from './schedule.js';
import type { PlanDraft, PlanStep, Schedule } from './types.js';

/** Longest request we will plan from — beyond this it is a document, not an instruction. */
const MAX_REQUEST = 4_000;

/**
 * Pull the JSON object out of a reply that may carry prose or a code fence around it.
 *
 * Brace-matching rather than a regex: a `{...}` regex is greedy or lazy in ways that both break on
 * nested objects, and the steps array contains them.
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Validate and clamp what the model returned. Returns null when it is not usable. */
export function parsePlanDraft(raw: string): PlanDraft | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const rawSteps = Array.isArray(o.steps) ? o.steps : [];
  const steps: PlanStep[] = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object') continue;
    const step = s as Record<string, unknown>;
    const instruction = typeof step.instruction === 'string' ? step.instruction.trim() : '';
    if (!instruction) continue;
    const rationale = typeof step.rationale === 'string' ? step.rationale.trim() : '';
    steps.push(rationale ? { instruction, rationale } : { instruction });
  }
  // A plan with no steps is not a degraded plan, it is the absence of one — and running an agent with
  // "do nothing in particular, forever" is exactly the runaway this feature must not become.
  if (steps.length === 0) return null;

  const rawSchedule = (o.schedule && typeof o.schedule === 'object' ? o.schedule : {}) as Record<string, unknown>;
  const schedule: Schedule = sanitizeSchedule({
    startAt: typeof rawSchedule.startAt === 'number' ? rawSchedule.startAt : undefined,
    everySeconds: typeof rawSchedule.everySeconds === 'number' ? rawSchedule.everySeconds : undefined,
    maxRuns: typeof rawSchedule.maxRuns === 'number' ? rawSchedule.maxRuns : undefined,
  });

  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 120) : 'sentinel';
  return { title, schedule, steps };
}

/** Ask the model to turn the request into a plan. Throws with the raw reply when it cannot be parsed. */
export async function draftPlan(request: string, cwd: string, now: number): Promise<PlanDraft> {
  const reply = await llmChat(
    [{ role: 'user', content: getPrompt('sentinailePlan', {
      REQUEST: request.slice(0, MAX_REQUEST),
      CWD: cwd,
      NOW_MS: String(now),
    }) }],
    // No tools: this call reasons about a sentence, it does not touch the repository. Declaring the
    // catalogue here would invite the planner to start doing the work it is supposed to be describing.
    { declareTools: false },
  );
  const draft = parsePlanDraft(reply);
  if (!draft) throw new Error(`could not parse a plan from the model reply: ${reply.slice(0, 300)}`);
  return draft;
}
