/**
 * Where a sentinel lives between runs — and the reason it survives a power cut.
 *
 * THE INVARIANT: state is written to disk BEFORE the thing it describes happens, never after. The
 * run counter is incremented and persisted before a shell is launched, not when it finishes. That
 * ordering is deliberate and it is the difference between two failure modes:
 *
 *   persist-then-act   → a crash mid-launch may cost one run that never happened. Bounded, boring.
 *   act-then-persist   → a crash mid-launch replays the run forever on every boot. Unbounded, and it
 *                        looks exactly like a working scheduler until you read the logs.
 *
 * Writes are atomic (temp file + rename) because a truncated JSON state file is indistinguishable
 * from a corrupted one and both mean "the sentinel silently stopped existing".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SentinelState } from './types.js';

export const SENTINEL_DIR = join(homedir(), '.ayin-cli', 'sentinaile');
/** The supervisor's own pid file — one supervisor per machine, not per sentinel. */
export const SUPERVISOR_PID_FILE = join(SENTINEL_DIR, 'supervisor.pid');

function ensureDir(): void {
  if (!existsSync(SENTINEL_DIR)) mkdirSync(SENTINEL_DIR, { recursive: true });
}

function stateFile(id: string): string {
  return join(SENTINEL_DIR, `${id}.json`);
}

/**
 * Atomic write: a reader either sees the whole previous state or the whole new one, never a
 * half-written file. `rename` is atomic within a filesystem, which is why the temp file is a sibling
 * rather than in /tmp.
 */
export function saveState(state: SentinelState): void {
  ensureDir();
  const target = stateFile(state.id);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  renameSync(tmp, target);
}

export function loadState(id: string): SentinelState | null {
  const f = stateFile(id);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf-8')) as SentinelState;
  } catch {
    return null; // unreadable state is a dead sentinel, not a crash
  }
}

/** Every sentinel on disk, stopped ones included — a stopped sentinel is a record worth keeping. */
export function listStates(): SentinelState[] {
  ensureDir();
  const out: SentinelState[] = [];
  for (const f of readdirSync(SENTINEL_DIR)) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    const s = loadState(f.replace(/\.json$/, ''));
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** The ones the supervisor still has work to do for. */
export function activeStates(): SentinelState[] {
  return listStates().filter((s) => !s.stoppedAt);
}

export function deleteState(id: string): void {
  const f = stateFile(id);
  if (existsSync(f)) unlinkSync(f);
}

/**
 * Is a process actually alive?
 *
 * `kill(pid, 0)` tests existence without signalling. A pid file that outlived its process is the
 * normal case after a power cut, and treating a stale pid as "running" is how a scheduler wedges
 * itself permanently — it waits forever for a process that died last Tuesday.
 */
export function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readSupervisorPid(): number {
  if (!existsSync(SUPERVISOR_PID_FILE)) return 0;
  const n = Number(readFileSync(SUPERVISOR_PID_FILE, 'utf-8').trim());
  return Number.isFinite(n) ? n : 0;
}

export function writeSupervisorPid(pid: number): void {
  ensureDir();
  writeFileSync(SUPERVISOR_PID_FILE, `${pid}\n`, 'utf-8');
}

export function clearSupervisorPid(): void {
  if (existsSync(SUPERVISOR_PID_FILE)) unlinkSync(SUPERVISOR_PID_FILE);
}
