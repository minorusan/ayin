/**
 * Artifacts — every tool result kept as a file the agent can go back and read.
 *
 * WHY THIS IS NOT JUST THE Ctrl+O BROWSER. The window compresses and evicts old observations, which is
 * what keeps a long turn affordable — and it means a result the model was given twenty rounds ago is,
 * from its side, indistinguishable from a call it never made. The call ledger already says what ran; the
 * only thing missing was WHERE the answer is. So each result is a file, and the ledger names it. A
 * 200 KB grep costs one line in the prompt and stays readable in full for the rest of the session.
 *
 * ONE FOLDER PER SESSION, because a flat shared directory is unreadable after a week and impossible to
 * prune safely — two sessions writing `grep-1755764812345.txt` into the same place have no way to tell
 * whose is whose. Ids are short and sequential (`t1`, `t7`) rather than timestamps: they go in a prompt,
 * every character of which is taken from the attention available to every other token, and `t7` is a
 * name a model can hold and repeat back.
 *
 * PRUNED ON BOOT, by session count. Tool output is the largest thing ayin writes — one indulge run can
 * leave hundreds of megabytes — and a cache nobody deletes is a disk that fills up silently. Whole
 * folders go, oldest first, so a surviving session keeps every result it has rather than some of them.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './log.js';

const ARTIFACTS_DIR = join(homedir(), '.ayin-cli', 'artifacts');

/** How many past sessions' results survive a boot. Enough to look back at yesterday, not forever. */
const KEEP_SESSIONS = 20;

export interface Artifact {
  /** `t7` — short because it is written into the prompt on every round. */
  id: string;
  tool: string;
  params: string;     // short description of what was called
  timestamp: number;
  filepath: string;
  bytes: number;
}

const sessionArtifacts: Artifact[] = [];
let sessionDir = '';
let counter = 0;

/**
 * Where this session's results go. Called once the session id exists; until then results land in the
 * root, which is what an early crash-time result should do rather than being dropped.
 */
export function startArtifactSession(sessionId: string): void {
  sessionDir = join(ARTIFACTS_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  pruneOldSessions();
}

function currentDir(): string {
  if (sessionDir) return sessionDir;
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  return ARTIFACTS_DIR;
}

/** Oldest session folders first, keeping the newest `KEEP_SESSIONS`. Never touches the live one. */
function pruneOldSessions(): void {
  try {
    const entries = readdirSync(ARTIFACTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const p = join(ARTIFACTS_DIR, e.name);
        let mtime = 0;
        try { mtime = statSync(p).mtimeMs; } catch { /* raced with another session */ }
        return { path: p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of entries.slice(KEEP_SESSIONS)) {
      if (stale.path === sessionDir) continue;
      rmSync(stale.path, { recursive: true, force: true });
      log('INFO', 'artifacts_pruned', { dir: stale.path });
    }
  } catch { /* a cache that cannot be pruned is not a reason to fail a boot */ }
}

/** A file name that says what it holds without needing the map: `t7-grep.txt`. */
const safeTool = (tool: string): string => tool.replace(/[^A-Za-z0-9_-]/g, '_');

export function saveArtifact(tool: string, params: string, output: string): Artifact {
  const dir = currentDir();
  counter++;
  const id = `t${counter}`;
  const filepath = join(dir, `${id}-${safeTool(tool)}.txt`);
  try {
    writeFileSync(filepath, output, 'utf-8');
  } catch (err) {
    // A result that cannot be cached is still a result the turn has in hand. Say so and carry on.
    log('WARN', 'artifact_write_failed', { tool, error: err instanceof Error ? err.message : String(err) });
  }
  const artifact: Artifact = { id, tool, params, timestamp: Date.now(), filepath, bytes: Buffer.byteLength(output) };
  sessionArtifacts.push(artifact);
  return artifact;
}

export function getSessionArtifacts(): Artifact[] {
  return sessionArtifacts;
}

/** The newest artifact for a tool+params, or null — how the ledger finds the file for a call. */
export function artifactFor(tool: string, params: string): Artifact | null {
  for (let i = sessionArtifacts.length - 1; i >= 0; i--) {
    const a = sessionArtifacts[i];
    if (a.tool === tool && a.params === params) return a;
  }
  return null;
}

export function readArtifact(artifact: Artifact): string {
  try {
    return readFileSync(artifact.filepath, 'utf-8');
  } catch {
    return '(artifact file not found)';
  }
}

export function getArtifactsDir(): string {
  return ARTIFACTS_DIR;
}

/** This session's folder, for the prompt line that states it once instead of per call. */
export function artifactSessionDir(): string {
  return sessionDir;
}

/** `8.1 KB` / `204 KB` / `1.2 MB` — a size a reader can decide against. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Whether anything was cached at all — the ledger only mentions files when there are some. */
export function hasArtifacts(): boolean {
  return sessionArtifacts.length > 0 && Boolean(sessionDir);
}
