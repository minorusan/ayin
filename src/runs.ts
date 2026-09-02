/**
 * runs.ts — every tool call this turn, as a thing you can look at from OUTSIDE the await.
 *
 * WHY THIS REPLACES TIMEOUTS. A tool that prints nothing is indistinguishable from a tool that has
 * hung, and until now ayin's only answer to that was a clock: `BACKGROUND_TIMEOUT` at 20 seconds,
 * `EXEC_TIMEOUT_MS` at two minutes, `subagentTimeoutMs` at fifteen, `pollMaxPerTurn` at six. A timeout
 * is a guess about how long work should take, made by someone who cannot see the work — and every one
 * of those guesses has been wrong here in a measured way. The subagent one cost a whole turn an hour
 * ago: backgrounded at 20s, polled six times, `blocked (poll cap 6)`, turn over, report never read,
 * while the child had finished the job correctly.
 *
 * The alternative is not a longer clock. It is knowing what is running:
 *
 *   currentRuns()   what is running, for how long, and the last thing it said
 *   cancelRun(id)   stop ONE call and let the turn continue
 *   cancelAll()     the operator pressed stop
 *   onRunsChanged() a subscription the UI paints from, ticked once a second
 *
 * A TOOL THAT NARRATES CANNOT LOOK HUNG. `RunContext.onStatus` lets a tool say what it is doing; each
 * note is stamped with the seconds since the previous one, so the timings of any two tools are
 * comparable. The ticker re-publishes every live run once a second whether or not it has spoken, which
 * turns "nothing is happening" into "23s — still running" at worst and into the actual work at best.
 *
 * CANCELLED IS NOT FAILED, AND IT IS DECIDED BY THE SIGNAL. A killed child usually returns its partial
 * output through the normal path rather than throwing, so a cancelled command comes back looking
 * exactly like a successful one — a green tick and a truncated result handed to the model as the
 * answer. `aborted` is the only honest source, so it is checked after the call returns, whatever the
 * call chose to do. Borrowed wholesale from Maradel's `tasks/service.ts`, which had it first and says
 * it was verified live before the fix.
 */

import { log } from './log.js';
import type { RunContext } from './tools/base.js';

// The tool contract owns its own types — `tools/` may not import from outside itself, so the
// dependency points this way. Re-exported so a caller needs one import, not two.
export type { RunContext } from './tools/base.js';

/** A live run, for anything that wants to look in from outside the await. */
export interface RunSnapshot {
  id: number;
  tool: string;
  params: string;
  startedAt: number;
  ms: number;
  /** The tool's most recent narration, or '' before it has said anything. */
  note: string;
  /**
   * EVERY note so far, `[+Δs]`-prefixed, newest last — what the tool's card paints while it runs.
   *
   * `note` alone is one line that the next one overwrites, and it was being painted into the status
   * bar at `.slice(0, 60)`. On a subagent that ran 133 seconds the operator saw
   * `subagent 133s — The previous str_replace failed due to content mismatch. I h…` and nothing else:
   * the interesting half cut off, the previous four minutes gone. The history is what makes a long run
   * followable, so the snapshot carries it.
   */
  notes: string;
}

export interface RunOutcome {
  id: number;
  tool: string;
  params: string;
  ok: boolean;
  /** True when this run was stopped on purpose. Never reported as a failure of the work. */
  cancelled: boolean;
  output: string;
  ms: number;
}

export interface StartedRun {
  id: number;
  done: Promise<RunOutcome>;
  /** Everything the tool has said so far, newest last, each line stamped `[+Δs]`. */
  notes(): string;
  cancel(why?: string): void;
}

interface LiveRun {
  snap: RunSnapshot;
  ctl: AbortController;
  notes: string;
}

let nextId = 1;
const live = new Map<number, LiveRun>();
const listeners = new Set<(runs: RunSnapshot[]) => void>();
let ticker: NodeJS.Timeout | null = null;

/** How often a running tool is re-published with its elapsed time. */
const TICK_MS = 1000;

function snapshots(): RunSnapshot[] {
  const now = Date.now();
  return [...live.values()].map((r) => ({ ...r.snap, ms: now - r.snap.startedAt, notes: r.notes }));
}

function publish(): void {
  const runs = snapshots();
  for (const cb of listeners) {
    try { cb(runs); } catch { /* a display must never break a turn */ }
  }
}

function arm(): void {
  if (ticker) return;
  ticker = setInterval(publish, TICK_MS);
  // Never hold the process open for a progress ticker.
  ticker.unref?.();
}

function disarmIfIdle(): void {
  if (live.size || !ticker) return;
  clearInterval(ticker);
  ticker = null;
}

/** What is running right now. A copy — the caller may hold it without holding our map. */
export function currentRuns(): RunSnapshot[] {
  return snapshots();
}

/** Paint from this. Returns an unsubscribe. */
export function onRunsChanged(cb: (runs: RunSnapshot[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Stop ONE run. The rest of the turn continues — that is the whole reason it is per-id. */
export function cancelRun(id: number, why = 'cancelled by the operator'): boolean {
  const r = live.get(id);
  if (!r) return false;
  r.ctl.abort(why);
  log('INFO', 'run_cancelled', { id: String(id), tool: r.snap.tool, why });
  return true;
}

/** The operator pressed stop. Returns how many were running. */
export function cancelAllRuns(why = 'cancelled by the operator'): number {
  const n = live.size;
  for (const id of [...live.keys()]) cancelRun(id, why);
  return n;
}

/** Turn boundary. Cancels anything still live rather than orphaning it. */
export function resetRuns(): void {
  cancelAllRuns('the turn ended');
  live.clear();
  disarmIfIdle();
}

/**
 * Run one tool call. THE ONE DOOR — every path that executes a tool goes through here, so "what is
 * running" has one answer and cancellation has one implementation.
 *
 * Never throws: a tool that fails is a RESULT the model has to read and react to, not an exception
 * that ends the turn. The model asked for something and is owed an answer either way.
 */
export function startRun(
  tool: string,
  params: string,
  exec: (ctx: RunContext) => Promise<string>,
  opts: { signal?: AbortSignal } = {},
): StartedRun {
  const id = nextId++;
  const ctl = new AbortController();
  // Chained to the turn: cancelling the turn cancels its tools, and cancelling one tool leaves the
  // rest of the turn alone.
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', () => ctl.abort(opts.signal?.reason), { once: true });
  }

  const startedAt = Date.now();
  const entry: LiveRun = {
    snap: { id, tool, params, startedAt, ms: 0, note: '', notes: '' },
    ctl,
    notes: '',
  };
  live.set(id, entry);
  arm();

  let lastNoteAt = startedAt;
  const onStatus = (note: string): void => {
    const text = String(note ?? '').trim();
    if (!text) return;
    // Δ SINCE THE PREVIOUS NOTE, not since the start: it is what makes two tools' timings comparable,
    // and what shows which step of a long run is the slow one.
    const delta = ((Date.now() - lastNoteAt) / 1000).toFixed(1);
    lastNoteAt = Date.now();
    entry.notes += `${entry.notes ? '\n' : ''}[+${delta}s] ${text}`;
    entry.snap.note = text;
    publish();
  };

  log('INFO', 'run_start', { id: String(id), tool, params: params.slice(0, 120) });

  const done = (async (): Promise<RunOutcome> => {
    let output: string;
    let ok: boolean;
    try {
      output = await exec({ signal: ctl.signal, onStatus });
      ok = true;
    } catch (err) {
      output = `Error: ${err instanceof Error ? err.message : String(err)}`;
      ok = false;
    }
    const cancelled = ctl.signal.aborted;
    if (cancelled) {
      // See the header: a killed child returns its partial output normally, so the signal is the only
      // honest source. Whatever the tool returned, this run did not finish.
      ok = false;
      output = `Cancelled before it finished. What it had done up to that point stands.\n\n${output}`.trim();
    }
    live.delete(id);
    disarmIfIdle();
    publish();
    const ms = Date.now() - startedAt;
    log('INFO', 'run_done', { id: String(id), tool, ok: String(ok), cancelled: String(cancelled), ms: String(ms) });
    return { id, tool, params, ok, cancelled, output, ms };
  })();

  return { id, done, notes: () => entry.notes, cancel: (why) => { cancelRun(id, why); } };
}
