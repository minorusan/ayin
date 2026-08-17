/**
 * The supervisor — owns WHEN, owns no work of its own.
 *
 * It is a poll loop, not a set of timers, and that is the same choice `ayin watch` makes for the same
 * reason: a timer lives in memory and dies with the process, while a poll over persisted state
 * rebuilds itself from disk every tick. Ask "what is due?" every few seconds and a reboot costs one
 * tick — no re-arming, no catch-up bookkeeping, no in-memory schedule to lose.
 *
 * ONE SUPERVISOR PER MACHINE, guarded by a pid file that is verified with `kill(pid, 0)` rather than
 * trusted. A pid file that outlived its process is the NORMAL state after a power cut, and a
 * scheduler that treats a stale pid as "already running" wedges itself permanently while looking
 * perfectly healthy.
 *
 * EACH RUN IS A SEPARATE DETACHED PROCESS. It gets its own correlation id, so the backend's GPU queue
 * shows one entry per run and nothing is shared with the interactive session — which is what keeps
 * requestId attribution honest when a sentinel fires while somebody is typing.
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPrompt } from '../prompts.js';
import { readPlanFile } from './planfile.js';
import { isDue, isExhausted, nextDueAfterRun } from './schedule.js';
import {
  activeStates, clearSupervisorPid, isAlive, loadState, readSupervisorPid, saveState,
  SENTINEL_DIR, writeSupervisorPid,
} from './store.js';
import type { SentinelState } from './types.js';

/** How often to ask "is anything due?". Cheap: a few file reads. */
const POLL_MS = 5_000;
/** A run that has not finished in this long is presumed wedged and is killed. */
const RUN_TIMEOUT_MS = 30 * 60_000;

/** ayin's own entry point, for spawning a run shell. */
function ayinEntry(): string {
  // …/dist/sentinaile/supervisor.js → …/dist/index.js
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'index.js');
}

function runLogPath(state: SentinelState, runNumber: number): string {
  const dir = join(SENTINEL_DIR, state.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `run-${String(runNumber).padStart(4, '0')}.log`);
}

/** The instruction one run receives: the plan file as written, wrapped in its reporting contract. */
export function buildRunPrompt(state: SentinelState, runNumber: number): string | null {
  const plan = readPlanFile(state.planPath);
  if (!plan) return null; // the operator deleted the plan — that is a stop, not a run
  return getPrompt('sentinaileRun', {
    PLAN: plan,
    RUN_NUMBER: String(runNumber),
    RUN_OF: state.schedule.maxRuns ? ` of ${state.schedule.maxRuns}` : '',
    CWD: state.cwd,
  });
}

/**
 * Launch one run.
 *
 * PERSIST BEFORE SPAWNING. The counter is incremented and written to disk first, so a crash between
 * the two costs at most one run that never happened. The other order — spawn, then record — turns a
 * crash into a run that replays on every boot forever, and it looks exactly like a working scheduler.
 */
function launchRun(state: SentinelState, now: number): void {
  const runNumber = state.runsDone + 1;

  // EVERYTHING THAT CAN FAIL PREDICTABLY HAPPENS BEFORE THE COUNTER MOVES. Persisting first is right
  // for a CRASH — an interrupted launch should cost one run rather than replay forever — but it is
  // wrong for an ordinary exception, which would burn a run that never happened and do it again next
  // tick. Observed: `spawn` rejected the log stream, the throw escaped, and `runsDone` climbed while
  // nothing ever ran.
  const prompt = buildRunPrompt(state, runNumber);
  if (!prompt) {
    stop(state, 'plan file is gone');
    return;
  }
  let logFd: number;
  try {
    // A RAW DESCRIPTOR, not a WriteStream. `createWriteStream` returns an object whose `fd` is still
    // null until its `open` event fires, and `spawn` validates stdio synchronously — so handing it a
    // fresh stream throws ERR_INVALID_ARG_VALUE every time.
    logFd = openSync(runLogPath(state, runNumber), 'a');
  } catch (e) {
    process.stderr.write(`sentinaile: cannot open run log — ${e instanceof Error ? e.message : String(e)}\n`);
    return; // no counter moved; the next tick tries again
  }

  const next: SentinelState = {
    ...state,
    runsDone: runNumber,
    lastRunAt: now,
    // A PROVISIONAL floor only. The real next-due is recomputed from the COMPLETION time in the exit
    // handler below, because the interval means "wait this long after finishing", not "after
    // starting". Set here as well so a crash mid-run still leaves a sane time on disk.
    nextDueAt: nextDueAfterRun(state.schedule, now),
  };
  saveState(next);

  const child = spawn(process.execPath, [ayinEntry(), '-p', prompt], {
    cwd: state.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      // A scheduled run is background work and must yield to a human at the keyboard. Without this it
      // would take the foreground grant `ayin -p` normally asks for and queue AHEAD of the operator.
      AYIN_ACQUIRE_LLM: '0',
      AYIN_SENTINEL_ID: state.id,
    },
  });

  next.runningPid = child.pid ?? 0;
  saveState(next);

  const timer = setTimeout(() => {
    if (next.runningPid && isAlive(next.runningPid)) {
      try { process.kill(next.runningPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, RUN_TIMEOUT_MS);
  timer.unref();

  child.on('exit', () => {
    clearTimeout(timer);
    try { closeSync(logFd); } catch { /* already closed */ }
    const fresh = loadState(state.id);
    if (!fresh) return;
    const done: SentinelState = { ...fresh };
    delete done.runningPid;
    // THE INTERVAL IS A GAP BETWEEN RUNS, NOT A PERIOD FROM LAUNCH.
    //
    // Computing it from launch time is correct only while runs are shorter than the interval. When a
    // run outlasts it — a 7-minute web-search-and-report on a 1-minute schedule — the stored time is
    // already in the past the moment the run ends, so the next tick fires instantly and the sentinel
    // runs BACK TO BACK forever. Observed in real use: "every 1 minute" became "continuously", and a
    // watch meant to sip the shared GPU held it permanently, starving the person at the keyboard.
    done.nextDueAt = nextDueAfterRun(done.schedule, Date.now());
    saveState(done);
    if (isExhausted(done)) stop(done, 'completed every scheduled run');
  });
  child.unref();
}

function stop(state: SentinelState, reason: string): void {
  saveState({ ...state, stoppedReason: reason, stoppedAt: Date.now(), runningPid: undefined });
}

/**
 * One tick. Separated from the loop so a test can drive it with an arbitrary clock, and so the boot
 * path can run it once without waiting five seconds to find out whether anything is due.
 */
export function tick(now: number): void {
  for (const state of activeStates()) {
    // A pid recorded before a reboot names a process that no longer exists; believing it would block
    // this sentinel forever. Clear it and let the normal due-check decide.
    if (state.runningPid && !isAlive(state.runningPid)) {
      const cleared: SentinelState = { ...state };
      delete cleared.runningPid;
      saveState(cleared);
      if (isExhausted(cleared)) { stop(cleared, 'completed every scheduled run'); continue; }
      if (isDue(cleared, now)) launchRun(cleared, now);
      continue;
    }
    // Exhausted with no pid: the exit handler that would have stopped it belonged to a supervisor
    // that is gone (replaced, or rebooted). Without this it stays "active" forever, reporting a watch
    // that will never run again.
    if (isExhausted(state)) { stop(state, 'completed every scheduled run'); continue; }
    if (isDue(state, now)) launchRun(state, now);
  }
}

/** True when a live supervisor already owns this machine. */
export function supervisorRunning(): boolean {
  return isAlive(readSupervisorPid());
}

/** The supervisor process itself: claim the pid file, then poll until killed. */
export function runSupervisor(): void {
  if (supervisorRunning()) {
    process.stderr.write('sentinaile: a supervisor is already running\n');
    process.exit(0);
  }
  writeSupervisorPid(process.pid);
  const bye = (): void => { clearSupervisorPid(); process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);

  process.stdout.write(`sentinaile supervisor up (pid ${process.pid}) — polling every ${POLL_MS / 1000}s\n`);
  tick(Date.now()); // answer "is anything due right now?" before the first sleep
  // NOT unref'd, deliberately: this timer IS the program. Unref'ing it lets node decide the event
  // loop has nothing to do and exit(0) — which it did, silently and instantly, leaving a plan file
  // and a state file describing a watch that would never fire. A scheduler that exits cleanly is
  // indistinguishable from one that is working, which is the worst way for this to fail.
  setInterval(() => {
    try {
      tick(Date.now());
    } catch (e) {
      process.stderr.write(`sentinaile: tick failed — ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }, POLL_MS);
}

/** Start a detached supervisor if none is live. Returns true when one is running afterwards. */
export function ensureSupervisor(): boolean {
  if (supervisorRunning()) return true;
  const child = spawn(process.execPath, [ayinEntry(), 'sentinaile-supervisor'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return true;
}
