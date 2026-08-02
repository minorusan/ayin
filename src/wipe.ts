import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSessionId, listSessions } from './session-store.js';
import { getLogFile, log } from './log.js';
import { isTranscribing, transcriptPath } from './transcript.js';

/**
 * `/wipe` — delete ayin's own saved state, deliberately and visibly.
 *
 * Nothing under `~/.ayin-cli` has ever been pruned, so it only grows: sessions, one artifact file per
 * tool call, one log file per process launch. Most of it is from runs whose behaviour no longer
 * resembles the current build, and stale debugging data is worse than none — you trust it.
 *
 * THE SAFETY RULES, all of them enforced here rather than trusted to the caller:
 *  1. **Plan, then execute.** `planWipe()` only reads. It returns the exact file list and byte total,
 *     which is what the confirmation dialog shows — the operator approves a number, not a verb.
 *  2. **Never the live files.** The session being recorded right now, the transcript being written
 *     right now, and this process's own log file are excluded from every scope, always. Deleting a
 *     file that is mid-append is how you turn "clear old data" into "corrupt today's run".
 *  3. **Pattern-matched, never recursive.** Each scope deletes only files whose names match the shape
 *     that scope owns, inside one known directory. There is no `rm -rf` anywhere in this file, and a
 *     stray file someone parked in those directories is left alone.
 *  4. **Transcripts are not part of the default.** They exist to be read later, are opt-in to create,
 *     and are the one record with no clipped copy elsewhere. They go only when named explicitly.
 */

const ROOT = join(homedir(), '.ayin-cli');
const DIRS = {
  sessions: join(ROOT, 'sessions'),
  artifacts: join(ROOT, 'artifacts'),
  logs: join(ROOT, 'logs'),
  transcripts: join(ROOT, 'transcripts'),
} as const;

export type WipeScope = 'sessions' | 'sessions-all' | 'artifacts' | 'logs' | 'transcripts';

export interface WipePlan {
  scope: WipeScope;
  /** What the dialog says out loud, e.g. "12 sessions in this directory". */
  label: string;
  files: string[];
  bytes: number;
  /** Files deliberately left behind, and why — shown so an exclusion never looks like a bug. */
  kept: number;
  keptReason: string;
}

function sizeOf(files: string[]): number {
  let n = 0;
  for (const f of files) {
    try {
      n += statSync(f).size;
    } catch {
      /* vanished between listing and sizing — it simply won't be deleted either */
    }
  }
  return n;
}

function listDir(dir: string, match: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(match)
    .map((n) => join(dir, n));
}

/** Read-only: what WOULD be deleted. */
export async function planWipe(scope: WipeScope): Promise<WipePlan> {
  const liveSession = getSessionId();
  const liveTranscript = isTranscribing() ? transcriptPath() : '';
  const liveLog = getLogFile();

  if (scope === 'sessions' || scope === 'sessions-all') {
    const all = scope === 'sessions-all';
    const metas = await listSessions({ all, limit: 100_000 });
    const doomed = metas.filter((m) => m.sessionId !== liveSession);
    const files: string[] = [];
    for (const m of doomed) {
      files.push(join(DIRS.sessions, `${m.sessionId}.jsonl`));
      const cp = join(DIRS.sessions, `${m.sessionId}.checkpoint.json`);
      if (existsSync(cp)) files.push(cp);
    }
    const kept = metas.length - doomed.length;
    return {
      scope,
      label: `${doomed.length} session${doomed.length === 1 ? '' : 's'}${all ? ' (every directory)' : ' in this directory'}`,
      files: files.filter(existsSync),
      bytes: sizeOf(files),
      kept,
      keptReason: kept ? 'the session running right now' : '',
    };
  }

  if (scope === 'artifacts') {
    const files = listDir(DIRS.artifacts, (n) => n.endsWith('.txt'));
    return {
      scope,
      label: `${files.length} tool-output artifact${files.length === 1 ? '' : 's'}`,
      files,
      bytes: sizeOf(files),
      kept: 0,
      keptReason: '',
    };
  }

  if (scope === 'logs') {
    const all = listDir(DIRS.logs, (n) => n.endsWith('.log'));
    const files = all.filter((f) => f !== liveLog);
    return {
      scope,
      label: `${files.length} log file${files.length === 1 ? '' : 's'}`,
      files,
      bytes: sizeOf(files),
      kept: all.length - files.length,
      keptReason: all.length - files.length ? "this process's own log" : '',
    };
  }

  // transcripts — both halves of each one (the spine and the formatted document)
  const all = listDir(DIRS.transcripts, (n) => n.endsWith('.transcript.json') || n.endsWith('.transcript.jsonl'));
  const files = all.filter((f) => !liveTranscript || (f !== liveTranscript && f !== `${liveTranscript}l`));
  return {
    scope,
    label: `${files.length} transcript file${files.length === 1 ? '' : 's'}`,
    files,
    bytes: sizeOf(files),
    kept: all.length - files.length,
    keptReason: all.length - files.length ? 'the transcript being written right now' : '',
  };
}

/**
 * Delete the planned files. Never throws — a file that refuses to go is counted, not fatal.
 *
 * `bytes` is measured HERE, per file, as each one is actually removed — not copied from
 * `plan.bytes`. Reporting the planned total would announce "freed 36 MB" after a run where half the
 * unlinks failed on permissions, and a cleanup tool that lies about what it freed is worse than one
 * that refuses to run.
 */
export function executeWipe(plan: WipePlan): { deleted: number; failed: number; bytes: number } {
  let deleted = 0;
  let failed = 0;
  let bytes = 0;
  for (const f of plan.files) {
    let size = 0;
    try {
      size = statSync(f).size;
    } catch {
      /* already gone — unlink below will report it */
    }
    try {
      unlinkSync(f);
      deleted++;
      bytes += size;
    } catch {
      failed++;
    }
  }
  log('INFO', 'wipe', { scope: plan.scope, deleted: String(deleted), failed: String(failed), bytes: String(bytes) });
  return { deleted, failed, bytes };
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Every scope's current size — the menu the operator picks from. */
export async function wipeOverview(): Promise<Array<{ scope: WipeScope; plan: WipePlan }>> {
  const scopes: WipeScope[] = ['sessions', 'sessions-all', 'artifacts', 'logs', 'transcripts'];
  const out: Array<{ scope: WipeScope; plan: WipePlan }> = [];
  for (const scope of scopes) out.push({ scope, plan: await planWipe(scope) });
  return out;
}
