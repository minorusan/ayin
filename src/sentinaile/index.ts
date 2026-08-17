/**
 * `/sentinaile <instruction>` — arm a standing watch.
 *
 *     /sentinaile                      what is armed right now
 *     /sentinaile stop                 stop the active one
 *     /sentinaile check CI every 10m   plan it, write the plan, arm it
 *
 * ONE ACTIVE SENTINEL AT A TIME, per the requested behaviour: arming a new one stops the current one
 * first. Stopped sentinels stay on disk as a record — a watch that ran for a week and was replaced is
 * evidence, and deleting it to keep the directory tidy throws away the only account of what was
 * watching while nobody was looking.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { draftPlan } from './plan.js';
import { renderPlanFile, writePlanFile } from './planfile.js';
import { describeSchedule, firstDueAt } from './schedule.js';
import { activeStates, isAlive, listStates, saveState } from './store.js';
import { ensureSupervisor } from './supervisor.js';
import type { SentinelState } from './types.js';

export const PLAN_FILENAME = 'sentinaile_plan.md';

/** Stop every active sentinel, killing a run in flight. Returns how many were stopped. */
export function stopAll(reason: string): number {
  const active = activeStates();
  for (const s of active) {
    if (s.runningPid && isAlive(s.runningPid)) {
      try { process.kill(s.runningPid, 'SIGTERM'); } catch { /* already gone */ }
    }
    saveState({ ...s, stoppedReason: reason, stoppedAt: Date.now(), runningPid: undefined });
  }
  return active.length;
}

/** Human-readable status of what is armed, for `/sentinaile` with no argument. */
export function statusReport(now: number): string {
  const active = activeStates();
  if (active.length === 0) {
    const past = listStates().slice(0, 3);
    if (past.length === 0) return 'sentinaile: nothing armed. `/sentinaile <what to watch, how often>` to arm one.';
    const lines = past.map((s) => `  ${s.id.slice(0, 8)}  ${s.runsDone} run(s)  stopped: ${s.stoppedReason ?? 'unknown'}`);
    return `sentinaile: nothing armed. Recently:\n${lines.join('\n')}`;
  }
  return active.map((s) => {
    const inSec = Math.max(0, Math.round((s.nextDueAt - now) / 1000));
    const running = s.runningPid && isAlive(s.runningPid) ? ` — RUNNING (pid ${s.runningPid})` : '';
    return [
      `sentinaile ${s.id.slice(0, 8)}${running}`,
      `  ${s.request}`,
      `  ${describeSchedule(s.schedule, now)} · ${s.runsDone} run(s) done · next in ${inSec}s`,
      `  plan: ${s.planPath}`,
    ].join('\n');
  }).join('\n\n');
}

/**
 * Plan and arm a sentinel. The single model call happens here, once — every later run is handed the
 * resulting file and decides nothing about scheduling.
 */
export async function armSentinel(request: string, cwd: string, now: number): Promise<{ state: SentinelState; summary: string }> {
  const replaced = stopAll('replaced by a new sentinaile');

  const draft = await draftPlan(request, cwd, now);
  const id = randomUUID();
  const state: SentinelState = {
    id,
    request,
    cwd,
    schedule: draft.schedule,
    planPath: join(cwd, PLAN_FILENAME),
    createdAt: now,
    runsDone: 0,
    lastRunAt: 0,
    nextDueAt: firstDueAt(draft.schedule, now),
  };

  // The plan file exists BEFORE the sentinel is armed, so there is no window in which the supervisor
  // could find a due sentinel whose plan has not been written yet.
  writePlanFile(state.planPath, renderPlanFile(draft, state, now));
  saveState(state);
  ensureSupervisor();

  const inSec = Math.max(0, Math.round((state.nextDueAt - now) / 1000));
  const summary = [
    replaced ? `sentinaile: stopped ${replaced} existing watch(es).` : '',
    `sentinaile armed · ${id.slice(0, 8)}`,
    `  ${draft.title}`,
    `  ${describeSchedule(draft.schedule, now)} · first run in ${inSec}s`,
    `  ${draft.steps.length} step(s) — plan written to ${state.planPath}`,
    '  Edit that file to change what each run does; every run reads it fresh.',
  ].filter(Boolean).join('\n');
  return { state, summary };
}

/** Dispatch for the slash command. `arg` is everything after `/sentinaile`. */
export async function handleSentinaile(arg: string, cwd: string): Promise<string> {
  const text = arg.trim();
  const now = Date.now();
  if (!text) return statusReport(now);
  if (text.toLowerCase() === 'stop') {
    const n = stopAll('stopped by operator');
    return n ? `sentinaile: stopped ${n} watch(es).` : 'sentinaile: nothing was armed.';
  }
  try {
    const { summary } = await armSentinel(text, cwd, now);
    return summary;
  } catch (e) {
    return `sentinaile: could not plan that — ${e instanceof Error ? e.message : String(e)}`;
  }
}
