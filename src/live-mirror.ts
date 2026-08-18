/**
 * live-mirror.ts — the diagnostic that is written BEFORE it is needed.
 *
 * THE BUG THIS EXISTS FOR. `/debug` collects everything worth knowing about a run — and it can only
 * run in an ayin that still answers. The one moment the bundle is needed is the one moment it cannot
 * be produced: a wedged session takes the keystroke, queues it behind the turn that is stuck, and
 * writes nothing. Diagnoses were made today from a bundle collected in a SECOND terminal, holding a
 * session seconds old and nothing about the hang at all.
 *
 * So the evidence is written continuously, to a path something else can read, whether or not ayin is
 * still healthy. A reader on another machine (a beacon's `read_file`) opens it at any moment and sees
 * where the process actually is — including "it has been in this phase for 74 seconds", which is the
 * whole question when a terminal shows nothing but a spinner.
 *
 * WHERE. `/private/tmp` on macOS and `/tmp` elsewhere, because those are the roots a beacon will
 * read; a home directory is not, deliberately. Override with `AYIN_LIVE_DIR`.
 *
 * OFF THE HOT PATH. Log lines arrive through the logger's sink API, already batched, and are appended
 * asynchronously. The status file is small and rewritten on change plus a slow heartbeat. Nothing here
 * may throw into the agent: every write is guarded, and a failing mirror disables itself rather than
 * failing the run it was meant to explain.
 *
 * BOUNDED. The mirror is truncated when it passes MAX_BYTES, keeping the tail — a diagnostic nobody
 * can open is a diagnostic nobody reads, and this one lives in a temp directory shared with the OS.
 */

import { appendFile, mkdirSync, readdirSync, rename, statSync, truncateSync, unlinkSync, writeFile } from 'node:fs';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { addLogSink, currentLogFile, type LogEntry } from './log.js';

const MAX_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 2_000;

export function liveDir(): string {
  if (process.env.AYIN_LIVE_DIR) return process.env.AYIN_LIVE_DIR;
  // macOS resolves /tmp to /private/tmp, and a reader's allow-list is a path TEST, not a resolution —
  // so name the real path or the read is refused for looking like an escape.
  const base = platform() === 'darwin' ? '/private/tmp' : tmpdir();
  return join(base, 'ayin-debug', 'live');
}

interface Status {
  pid: number;
  sessionId: string;
  cwd: string;
  version: string;
  logFile: string;
  startedAt: string;
  updatedAt: string;
  /** What the agent says it is doing, and since when — the answer to "it has been spinning a minute". */
  phase: string;
  phaseSince: string;
  phaseForMs: number;
  /** The model call, tracked around the fetch: issued -> returned/failed. `issued` and old is a stall. */
  llm: { state: 'idle' | 'issued' | 'returned' | 'failed'; at: string; url?: string; elapsedMs?: number; error?: string };
  /** The tool in flight — a connector waiting on an API looks exactly like a model that will not answer. */
  tool: { name: string; at: string } | null;
}

let enabled = false;
let failures = 0;
let mirrorPath = '';
let statusPath = '';
let phaseAt = Date.now();

const status: Status = {
  pid: process.pid, sessionId: '', cwd: process.cwd(), version: '', logFile: '',
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  phase: 'idle', phaseSince: new Date().toISOString(), phaseForMs: 0,
  llm: { state: 'idle', at: new Date().toISOString() }, tool: null,
};

/** A mirror that cannot write must not retry on every log line. It is a convenience; the run is not. */
function failed(): void {
  if (++failures >= 3) enabled = false;
}

/**
 * ONE WRITER, AND THE READER NEVER SEES HALF A FILE.
 *
 * Caught by this module's own smoke test: two updates in the same tick both called `writeFile` on the
 * same path, the second truncated while the first was still writing, and the result was a JSON file
 * with a fragment of the previous version welded onto its tail. Unparseable — from a file whose only
 * job is to be read by something else, at a moment nobody controls.
 *
 * So: writes are COALESCED (an update during a write sets a dirty flag rather than starting a second
 * one) and land via a temp file plus `rename`, which is atomic on the same filesystem. A reader
 * therefore sees the previous complete status or the next one, never a blend of the two.
 */
let writing = false;
let dirty = false;

function writeStatus(): void {
  if (!enabled) return;
  if (writing) { dirty = true; return; }
  writing = true;
  status.updatedAt = new Date().toISOString();
  status.phaseForMs = Date.now() - phaseAt;
  const tmp = `${statusPath}.tmp`;
  writeFile(tmp, `${JSON.stringify(status, null, 2)}\n`, (e) => {
    if (e) { writing = false; failed(); return; }
    rename(tmp, statusPath, (e2) => {
      writing = false;
      if (e2) { failed(); return; }
      if (dirty) { dirty = false; writeStatus(); }
    });
  });
}

/** Start mirroring. Called once at boot; a failure here silently disables the mirror. */
export function startLiveMirror(opts: { sessionId: string; version: string }): void {
  try {
    const dir = liveDir();
    mkdirSync(dir, { recursive: true });
    // PER PROCESS. One fixed path meant every ayin on the machine wrote the same file, and a reader
    // got whichever wrote last — measured: a session idle for an hour kept overwriting the status of
    // the session actually being debugged, with `phase: starting`, every two seconds. The file that
    // exists to end guessing was producing it. Several ayin processes at once is NORMAL (a headless
    // run, the watch daemon, a second terminal), so the reader picks the freshest `updatedAt`.
    mirrorPath = join(dir, `log-${process.pid}.ndjson`);
    statusPath = join(dir, `status-${process.pid}.json`);
    status.sessionId = opts.sessionId;
    status.version = opts.version;
    status.logFile = currentLogFile();
    enabled = true;
  } catch { enabled = false; return; }

  addLogSink((entry: LogEntry) => {
    if (!enabled) return;
    try {
      // Truncation keeps the TAIL by starting over: a hang is diagnosed from the last entries, and
      // rewriting megabytes to preserve the middle is the wrong cost in a temp directory.
      let size = 0;
      try { size = statSync(mirrorPath).size; } catch { /* not created yet */ }
      if (size > MAX_BYTES) truncateSync(mirrorPath, 0);
      appendFile(mirrorPath, `${JSON.stringify(entry)}\n`, (e) => { if (e) failed(); });
    } catch { failed(); }
  });

  const beat = setInterval(writeStatus, HEARTBEAT_MS);
  beat.unref?.();
  writeStatus();
  pruneStale(join(liveDir()));
}

/**
 * Drop the files of processes that are gone, so the directory stays readable by a human.
 *
 * Per-process files accumulate — every headless run leaves one. A reader facing forty of them is back
 * to guessing, which is the thing this module exists to stop. Nothing here may throw: a mirror that
 * cannot tidy up is still a mirror.
 */
function pruneStale(dir: string): void {
  try {
    for (const f of readdirSync(dir)) {
      const m = /^(?:status|log)-(\d+)\.(?:json|ndjson)$/.exec(f);
      if (!m || Number(m[1]) === process.pid) continue;
      try { process.kill(Number(m[1]), 0); continue; } catch { /* no such process — its files are litter */ }
      try { unlinkSync(join(dir, f)); } catch { /* someone else got there first */ }
    }
  } catch { /* unreadable dir — nothing to tidy */ }
}

/** What the agent is doing now. The "since" clock resets only when the phase actually changes. */
export function livePhase(phase: string): void {
  if (!enabled || phase === status.phase) return;
  status.phase = phase || 'idle';
  phaseAt = Date.now();
  status.phaseSince = new Date().toISOString();
  writeStatus();
}

/** Around the model call, so `issued` with a growing age names a stall the terminal cannot show. */
export function liveLlm(
  state: Status['llm']['state'],
  detail?: { url?: string; elapsedMs?: number; error?: string },
): void {
  if (!enabled) return;
  status.llm = { state, at: new Date().toISOString(), ...(detail ?? {}) };
  writeStatus();
}

/** Around a tool run. */
export function liveTool(name: string | null): void {
  if (!enabled) return;
  status.tool = name ? { name, at: new Date().toISOString() } : null;
  writeStatus();
}
