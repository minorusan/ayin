/**
 * When is the next run due? Pure arithmetic — no clock reads inside the decisions, no I/O, no model.
 *
 * Every function here takes `now` as an argument rather than calling `Date.now()`. That is what makes
 * the scheduler testable at all: "does a sentinel that missed six hours of runs fire six times or
 * once?" is a question you can only answer cheaply if you can hand the code an arbitrary clock.
 */

import type { Schedule, SentinelState } from './types.js';

/** Below this, a repeat is a busy-loop rather than a schedule. */
export const MIN_INTERVAL_SECONDS = 30;

/**
 * Clamp a model-proposed schedule into one that cannot hurt the machine.
 *
 * The schedule comes from a language model reading a vague sentence, so it is untrusted input in the
 * ordinary sense: "every second" is a plausible thing for it to emit from "keep an eye on it", and a
 * sentinel that spawns an agent shell every second would take the GPU and the box with it.
 */
export function sanitizeSchedule(s: Schedule): Schedule {
  const out: Schedule = {};
  if (typeof s.startAt === 'number' && Number.isFinite(s.startAt) && s.startAt > 0) {
    out.startAt = Math.floor(s.startAt);
  }
  if (typeof s.everySeconds === 'number' && Number.isFinite(s.everySeconds) && s.everySeconds > 0) {
    out.everySeconds = Math.max(MIN_INTERVAL_SECONDS, Math.floor(s.everySeconds));
  }
  if (typeof s.maxRuns === 'number' && Number.isFinite(s.maxRuns) && s.maxRuns > 0) {
    out.maxRuns = Math.floor(s.maxRuns);
  }
  return out;
}

/** A schedule with no repeat and no count runs exactly once. */
export function isOneShot(s: Schedule): boolean {
  return !s.everySeconds;
}

/** When the FIRST run becomes due, given when the sentinel was armed. */
export function firstDueAt(s: Schedule, armedAt: number): number {
  return typeof s.startAt === 'number' ? Math.max(s.startAt, armedAt) : armedAt;
}

/**
 * The next due time after a run completes.
 *
 * NO CATCH-UP, DELIBERATELY. A sentinel that was asleep for six hours on a ten-minute schedule has
 * "missed" 36 runs, and firing 36 agent shells the moment the machine wakes is a stampede that helps
 * nobody — the six-hour-old check is not six hours more valuable, it is stale. The next run is
 * scheduled from NOW, so waking up costs exactly one run. This is the same reason the interval is a
 * floor rather than a deadline: lateness is normal and must not compound.
 */
export function nextDueAfterRun(s: Schedule, completedAt: number): number {
  if (!s.everySeconds) return Number.POSITIVE_INFINITY; // one-shot: never again
  return completedAt + s.everySeconds * 1000;
}

/** Has this sentinel done everything it was asked to do? */
export function isExhausted(state: SentinelState): boolean {
  const { schedule, runsDone } = state;
  if (typeof schedule.maxRuns === 'number' && runsDone >= schedule.maxRuns) return true;
  if (isOneShot(schedule) && runsDone >= 1) return true;
  return false;
}

/** Should a run start right now? The single question the supervisor's poll loop asks. */
export function isDue(state: SentinelState, now: number): boolean {
  if (state.stoppedAt) return false;
  if (state.runningPid) return false;      // never two runs of one sentinel at once
  if (isExhausted(state)) return false;
  return now >= state.nextDueAt;
}

/**
 * Human-readable schedule, for the plan file and the TUI.
 *
 * Written from the STATE rather than re-derived from the operator's sentence, so what is displayed is
 * what will actually happen — a summary that quotes the request back would hide a mis-parse.
 */
export function describeSchedule(s: Schedule, now: number): string {
  const parts: string[] = [];
  if (s.everySeconds) {
    const m = s.everySeconds / 60;
    parts.push(m >= 1 && Number.isInteger(m) ? `every ${m} minute${m === 1 ? '' : 's'}` : `every ${s.everySeconds}s`);
  } else {
    parts.push('once');
  }
  if (typeof s.startAt === 'number') {
    const delta = s.startAt - now;
    parts.push(delta > 0 ? `starting in ${Math.round(delta / 1000)}s` : 'starting immediately');
  }
  if (typeof s.maxRuns === 'number') parts.push(`${s.maxRuns} time${s.maxRuns === 1 ? '' : 's'}`);
  return parts.join(', ');
}
