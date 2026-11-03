/**
 * Session goal — the one-line, auto-determined DIRECTION the user wants this session: a recap
 * the agent keeps in view so it doesn't wander off into tangents.
 *
 * It is LLM-distilled (`refreshGoal`) from the user's message — not the verbatim text — then
 * stays stable across the back-and-forth (that stability is the anti-wander anchor). Shown in
 * the chat's blank area in cursive, injected into the agent's context each round, and
 * overridable any time with `/goal <text>`. Pure in-memory session state; cleared on /resume.
 *
 * THE PARAPHRASE IS A LABEL, NOT A SPEC. A ≤16-word distillation drops whatever the distiller
 * thinks is detail — and the user's numbered steps are exactly that. Measured 2026-11-02 (session
 * 40f33c6c): "match the dream, format Dream N/title/Location/Characters, append or update" became
 * "format and update diary entries for later RAG indexing" (RAG came from the user's *reason*
 * sentence), the agent built a page reformatter, and QA/skeptic passed it — they judged against the
 * same paraphrase. So the agent and every gate get `getTaskSpec()`: the user's own words, verbatim.
 * A derived goal is UI-only; a goal the USER typed with /goal is their words and joins the spec.
 */

import { llmCall } from './llm.js';
import { getPrompt } from './prompts.js';
import { log } from './log.js';

let goal = '';
let goalFromUser = false;
let deriving = false;
/** Every task prompt of the session, verbatim, in order. */
let requests: string[] = [];
/** Spec budget. The first request (it states the task) is always kept whole; newest fill the rest. */
const SPEC_MAX_CHARS = 8000;
const subscribers = new Set<() => void>();

export function getGoal(): string {
  return goal;
}

/** Set the goal (whitespace-collapsed, single line). No-op if unchanged; notifies on change. */
export function setGoal(text: string, fromUser = false): void {
  goalFromUser = fromUser;
  const next = text.trim().replace(/\s+/g, ' ');
  if (next === goal) return;
  goal = next;
  for (const fn of subscribers) fn();
}

export function clearGoal(): void {
  requests = [];
  setGoal('');
}

/** Record a task prompt verbatim (app.ts, before the agent loop). */
export function recordRequest(text: string): void {
  const t = text.trim();
  if (t) requests.push(t);
}

/**
 * The task as the USER stated it — what the agent works toward and what every gate judges against.
 * Empty when nothing was recorded (callers fall back to the raw current input).
 */
export function getTaskSpec(): string {
  const parts: string[] = [];
  if (goalFromUser && goal) parts.push(`Goal (set by the user): ${goal}`);
  if (requests.length) {
    const [first, ...rest] = requests;
    const kept: string[] = [];
    let budget = SPEC_MAX_CHARS - first.length;
    for (let i = rest.length - 1; i >= 0 && rest[i].length <= budget; i--) {
      kept.unshift(rest[i]);
      budget -= rest[i].length;
    }
    const omitted = rest.length - kept.length;
    parts.push([first, ...(omitted ? [`[${omitted} earlier follow-up message(s) omitted]`] : []), ...kept]
      .map((r, i) => (r.startsWith('[') ? r : `--- user message ${i + 1} ---\n${r}`)).join('\n\n'));
  }
  return parts.join('\n\n');
}

/** Subscribe to goal changes (the chat widget re-renders on change). Returns an unsubscribe fn. */
export function onGoalChange(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * Auto-determine (or refine) the goal from a user message via one cheap LLM call — a rolling
 * recap of the direction. Safe to await before the agent loop; on any failure (LLM down, empty
 * result) the existing goal is kept. Concurrency-guarded so overlapping turns don't stack calls.
 */
export async function refreshGoal(userMessage: string): Promise<void> {
  if (deriving || !userMessage.trim()) return;
  deriving = true;
  try {
    const prompt = getPrompt('goal', {
      CURRENT_GOAL: goal || '(none yet)',
      USER_MESSAGE: userMessage.slice(0, 1000),
    });
    const line = (await llmCall(prompt)).trim().split('\n')[0].replace(/^["']|["']$/g, '').trim();
    if (line.length > 2) {
      setGoal(line, false);
      log('DEBUG', 'goal_derived', { goal });
    }
  } catch {
    // LLM unavailable — keep whatever goal we have.
  } finally {
    deriving = false;
  }
}
