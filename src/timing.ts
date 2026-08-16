/**
 * timing.ts — finding out where a turn actually went.
 *
 * A turn that takes ten minutes tells you nothing about WHICH ten minutes. The status line says
 * "Thinking…" for a model call, a tool run, a QA pass and a presenter pass alike, so the operator's
 * only evidence is that ayin is slow — and the usual conclusion, "the model is slow", was wrong at
 * least three times in one day: it was a 16k window silently truncating, a stage that sent the same
 * file 26 times, and a sub-loop being handed tools it then called.
 *
 * So every phase is measured, and anything past the threshold announces itself **on screen** as it
 * happens rather than in a log nobody opens mid-turn. The per-turn tally is kept so the end of a slow
 * turn can say where it went, in order.
 *
 * Threshold is two minutes by default (`longOperationMs`). Low enough to catch a bottleneck, high
 * enough that a normal turn says nothing — a marker that fires constantly is a marker nobody reads.
 */

import { log } from './log.js';
import { getConfig } from './prompts.js';

export interface PhaseTiming {
  phase: string;
  ms: number;
  detail: string;
}

const DEFAULT_LONG_MS = 120_000;

let turn: PhaseTiming[] = [];

/**
 * Every long operation this PROCESS has seen, not just this turn.
 *
 * A debug bundle is usually collected after the fact — "it was slow twenty minutes ago" — and the
 * turn tally is gone by then. Bounded so a long session cannot grow it without limit.
 */
const LONG_HISTORY_MAX = 200;
const longHistory: Array<PhaseTiming & { at: string }> = [];

export function longOperations(): ReadonlyArray<PhaseTiming & { at: string }> {
  return longHistory;
}

export function longOperationMs(): number {
  return getConfig('longOperationMs', DEFAULT_LONG_MS);
}

export function resetTurnTimings(): void {
  turn = [];
}

export function turnTimings(): readonly PhaseTiming[] {
  return turn;
}

/** `4m 12s` / `95s` — short enough to sit inside a status line. */
export function human(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Measure one phase. Returns whatever the phase returned; never swallows an error.
 *
 * A phase that THREW is still timed and still reported — a call that hung for eight minutes and then
 * failed is the most interesting measurement in the turn, and the one a naive `try/finally`-less
 * wrapper loses.
 */
export async function timed<T>(
  phase: string, detail: string, fn: () => Promise<T>, onLong?: (line: string) => void,
): Promise<T> {
  const started = Date.now();
  let failed = false;
  try {
    return await fn();
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    const ms = Date.now() - started;
    turn.push({ phase, ms, detail });
    if (ms >= longOperationMs()) {
      const line = `[LONG OPERATION] ${phase} — ${human(ms)}${detail ? ` · ${detail}` : ''}${failed ? ' · FAILED' : ''}`;
      log('WARN', 'long_operation', { phase, ms: String(ms), detail, failed: String(failed) });
      longHistory.push({ phase, ms, detail: detail + (failed ? ' · FAILED' : ''), at: new Date().toISOString() });
      if (longHistory.length > LONG_HISTORY_MAX) longHistory.shift();
      onLong?.(line);
    }
  }
}

/**
 * The turn's phases, slowest first — printed when a turn was slow enough to wonder about.
 *
 * Grouped by phase rather than listed one line per call: a turn with fourteen rounds produces
 * fourteen model calls, and "llm ×14 — 6m 20s total, slowest 55s" is the sentence that identifies a
 * bottleneck, while fourteen separate lines are the same information arranged so nobody reads it.
 */
export function formatTurnTimings(): string | null {
  if (!turn.length) return null;
  const total = turn.reduce((n, t) => n + t.ms, 0);
  if (total < longOperationMs()) return null;

  const byPhase = new Map<string, { n: number; ms: number; max: number; worst: string }>();
  for (const t of turn) {
    const e = byPhase.get(t.phase) ?? { n: 0, ms: 0, max: 0, worst: '' };
    e.n++; e.ms += t.ms;
    if (t.ms > e.max) { e.max = t.ms; e.worst = t.detail; }
    byPhase.set(t.phase, e);
  }
  const rows = [...byPhase.entries()].sort((a, b) => b[1].ms - a[1].ms);
  const lines = [`where the turn went — ${human(total)} across ${turn.length} phase(s)`];
  for (const [phase, e] of rows) {
    lines.push(`  ${human(e.ms).padStart(7)}  ${phase} ×${e.n}`
      + (e.n > 1 ? ` · slowest ${human(e.max)}` : '')
      + (e.worst ? ` · ${e.worst.slice(0, 60)}` : ''));
  }
  return lines.join('\n');
}
