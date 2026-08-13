/**
 * Logging: a NON-BLOCKING hook that anything can subscribe to.
 *
 * WHY IT IS A HOOK
 *
 * `tools/` imports this module more than any other — seven call sites, more than the LLM manager and
 * the UI combined. Every one of those imports pins a tool to ayin's source layout, which is what makes
 * `tools/` unmovable into a package of its own. A hook breaks that differently from an injected
 * logger: the tool keeps calling `log(...)` with no idea who is listening, and whoever wants the
 * stream — a host application gathering telemetry, a test, nothing at all — registers a sink and gets
 * every entry. Ayin does not learn about the collector, and the collector does not reach into ayin.
 *
 * WHY IT IS NON-BLOCKING, WHICH IT WAS NOT
 *
 * This used to call `appendFileSync` on every entry, on the agent's own thread. That is a disk write
 * in the hot path of a loop that logs each tool call, each round, each model call. A slow or busy
 * disk stalled the agent, and on a shared machine that is not hypothetical.
 *
 * So `log()` now only appends to an in-memory batch and returns. A deferred flush (unref'd, so it
 * never keeps the process alive) writes the batch to file asynchronously and fans it out to sinks.
 * Nothing in the agent's path touches the filesystem.
 *
 * WHAT THAT COSTS, AND WHAT PAYS IT BACK
 *
 * Deferred writes can be lost to a crash — the exact moment logs matter most. So the batch is drained
 * SYNCHRONOUSLY on `exit`, which is the one place a synchronous write is correct: nothing is waiting
 * on us any more. Between that and the flush interval, the window for loss is a hard kill (-9 or a
 * power cut), which loses at most `FLUSH_MS` of entries.
 *
 * THE RULES FOR A SINK, because a subscriber must never be able to break the agent:
 *  - it is called inside a try/catch, and a throwing sink is dropped after a few failures rather than
 *    being allowed to throw on every entry for the rest of the session;
 *  - it must RETURN IMMEDIATELY. It receives a batch off the hot path, but it is still ayin's thread.
 *    A sink that wants to do I/O queues it and returns.
 */

import { mkdirSync, appendFileSync, appendFile } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.ayin-cli', 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = join(LOG_DIR, `session-${ts}.log`);
const startTime = Date.now();

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

/** `t` is ms since process start — the field you actually read when finding what took the time. */
export interface LogEntry {
  t: number;
  ts: string;
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

/** A subscriber. Must return immediately; see the header. */
export type LogSink = (entry: LogEntry) => void;

/** How long an entry may sit in memory before it is written. Also the worst-case loss on a hard kill. */
const FLUSH_MS = 250;

/**
 * A ceiling on unflushed entries, so a wedged disk costs bounded memory instead of the process. The
 * OLDEST are dropped: debugging almost always starts from the most recent entries, and a drop is
 * announced in the stream rather than being silent — a log that quietly loses entries is worse than
 * one that stops, because it still looks complete.
 */
const MAX_PENDING = 5_000;

/** A sink that throws this many times is broken, not unlucky. Dropped, and the drop is logged. */
const SINK_FAILURE_LIMIT = 3;

let pending: LogEntry[] = [];
let timer: NodeJS.Timeout | null = null;
let writing = false;
let dropped = 0;

const sinks = new Map<LogSink, number>(); // sink → consecutive failures

/**
 * Subscribe to every entry from now on. Returns an unsubscribe function.
 *
 * Deliberately not replayed from history: a collector that attaches mid-session gets the stream from
 * that point, which is what a stream is. Anything wanting the whole session reads the file.
 */
export function addLogSink(sink: LogSink): () => void {
  sinks.set(sink, 0);
  return () => { sinks.delete(sink); };
}

/** For tests and for anyone reasoning about whether a collector is attached. */
export function logSinkCount(): number {
  return sinks.size;
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flushAsync(); }, FLUSH_MS);
  // Never hold the process open for a log write; the exit drain covers what is still pending.
  timer.unref?.();
}

function serialize(batch: LogEntry[]): string {
  return batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function fanOut(batch: LogEntry[]): void {
  if (sinks.size === 0) return;
  for (const [sink, failures] of sinks) {
    try {
      for (const entry of batch) sink(entry);
      if (failures) sinks.set(sink, 0); // recovered
    } catch {
      const next = failures + 1;
      if (next >= SINK_FAILURE_LIMIT) {
        sinks.delete(sink);
        // Straight onto the batch queue: calling log() here would recurse into the fan-out.
        pending.push({
          t: Date.now() - startTime, ts: new Date().toISOString(),
          level: 'WARN', event: 'log_sink_dropped', failures: String(next),
        });
      } else {
        sinks.set(sink, next);
      }
    }
  }
}

function takeBatch(): LogEntry[] {
  if (dropped > 0) {
    pending.unshift({
      t: Date.now() - startTime, ts: new Date().toISOString(),
      level: 'WARN', event: 'log_overflow', dropped: String(dropped),
    });
    dropped = 0;
  }
  const batch = pending;
  pending = [];
  return batch;
}

function flushAsync(): void {
  if (writing || pending.length === 0) return;
  const batch = takeBatch();
  fanOut(batch);
  writing = true;
  appendFile(LOG_FILE, serialize(batch), () => {
    writing = false;
    // Entries that arrived during the write, or a batch that lost its race with one.
    if (pending.length) scheduleFlush();
  });
}

/**
 * Drain synchronously. Correct at exit and in tests; wrong in the hot path, which is the whole point
 * of this module.
 */
export function flushLogs(): void {
  if (pending.length === 0) return;
  const batch = takeBatch();
  fanOut(batch);
  try { appendFileSync(LOG_FILE, serialize(batch)); } catch { /* nothing left to fall back to */ }
}

process.on('exit', flushLogs);

export function log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
  if (pending.length >= MAX_PENDING) {
    pending.shift();
    dropped++;
  }
  pending.push({
    t: Date.now() - startTime,
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  });
  scheduleFlush();
}

/**
 * Redirect suppressed console calls to the log.
 * Call once at startup after suppressing console.
 */
export function captureConsole(): void {
  console.log = (...args: unknown[]) => log('DEBUG', 'console.log', { msg: args.map(String).join(' ') });
  console.error = (...args: unknown[]) => log('ERROR', 'console.error', { msg: args.map(String).join(' ') });
  console.warn = (...args: unknown[]) => log('WARN', 'console.warn', { msg: args.map(String).join(' ') });
}

export function getLogFile(): string {
  return LOG_FILE;
}
