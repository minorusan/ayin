/**
 * Session goal — the one-line, auto-determined DIRECTION the user wants this session: a recap
 * the agent keeps in view so it doesn't wander off into tangents.
 *
 * It is LLM-distilled (`refreshGoal`) from the user's message — not the verbatim text — then
 * stays stable across the back-and-forth (that stability is the anti-wander anchor). Shown in
 * the chat's blank area in cursive, injected into the agent's context each round, and
 * overridable any time with `/goal <text>`. Pure in-memory session state; cleared on /resume.
 */

import { llmCall } from './llm.js';
import { getPrompt } from './prompts.js';
import { log } from './log.js';

let goal = '';
let deriving = false;
const subscribers = new Set<() => void>();

export function getGoal(): string {
  return goal;
}

/** Set the goal (whitespace-collapsed, single line). No-op if unchanged; notifies on change. */
export function setGoal(text: string): void {
  const next = text.trim().replace(/\s+/g, ' ');
  if (next === goal) return;
  goal = next;
  for (const fn of subscribers) fn();
}

export function clearGoal(): void {
  setGoal('');
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
      setGoal(line);
      log('DEBUG', 'goal_derived', { goal });
    }
  } catch {
    // LLM unavailable — keep whatever goal we have.
  } finally {
    deriving = false;
  }
}
