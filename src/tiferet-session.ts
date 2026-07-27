/**
 * Sessions — a LOCAL, per-directory session store.
 *
 * Every run already writes an append-only record to `~/.ayin-cli/sessions/<id>.jsonl`
 * (`session-record.ts`: one JSON line per prompt / tool call / answer, each carrying `cwd`). This
 * module is the READ side of that store, plus a small checkpoint sidecar — which is what makes
 * `/resume` real.
 *
 * It replaces a stub that returned `[]` and `null` unconditionally: the agent dutifully called
 * `syncSession()` on every turn into an empty function, `listSessions()` always answered "no
 * sessions", and `/resume` could therefore never restore anything, while 34 perfectly good records
 * sat on disk.
 *
 * SCOPED TO THE DIRECTORY. `/resume` in a project lists that project's sessions — a session from a
 * different repo is noise you have to read past, and restoring one silently loads another codebase's
 * context. Cross-directory listing is opt-in (`all: true`).
 *
 * NOT VERSION-SCOPED. The old namespace was `sessions/cli/<VERSION>`, so every release made prior
 * sessions invisible ("No sessions found for this version" was in the UI). The store is keyed by
 * directory and time; the version is recorded per checkpoint as information, never as a filter.
 *
 * BOUNDED. A long session's record can reach megabytes, so listing never slurps whole files: one
 * chunked pass counts newlines and keeps the first and last complete lines. Reading is best-effort
 * throughout — a torn last line (power cut mid-append) is skipped, never fatal.
 */

import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Artifact } from './artifacts.js';
import { log } from './log.js';

function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readVersion();
/** Informational only — the store is NOT partitioned by it (see the header). */
export const SESSION_NAMESPACE = `sessions/cli (local, per-dir) · v${VERSION}`;

const SESSIONS_DIR = join(homedir(), '.ayin-cli', 'sessions');
/** How many turns of context a restore carries back into the window. */
const RECENT_TURNS = 20;
const MAX_CONTENT = 4000;

export interface CliSessionMeta {
  sessionId: string;
  title: string | null;
  updatedAt: string;
  messageCount: number;
  createdAt: string;
  /** Which directory the session ran in — the thing `/resume` scopes on. */
  cwd: string;
}

export interface CliSessionCheckpoint {
  version: string;
  cwd: string;
  summary: string;
  recent: Array<{ role: string; content: string }>;
  artifacts: unknown[];
  syncedAt: string;
}

let sessionId: string | null = null;

export function getSessionId(): string | null {
  return sessionId;
}

export function setSessionId(id: string): void {
  sessionId = id;
}

/** Create a fresh local session id for this run. */
export async function initSession(): Promise<string> {
  sessionId = randomUUID();
  log('INFO', 'session_created_local', { sessionId, namespace: SESSION_NAMESPACE });
  return sessionId;
}

// ── the record files ──────────────────────────────────────────────────

function recordPath(id: string): string { return join(SESSIONS_DIR, `${id}.jsonl`); }
function checkpointPath(id: string): string { return join(SESSIONS_DIR, `${id}.checkpoint.json`); }

function listRecordIds(): string[] {
  try {
    return readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length));
  } catch {
    return []; // no store yet — a first run, not an error
  }
}

/**
 * One chunked pass over a record: newline count plus the first and last COMPLETE lines. Never holds
 * more than CHUNK bytes, so a 50 MB session costs the same memory as a 5 KB one.
 */
function scanRecord(path: string): { lines: number; first: string; last: string; bytes: number } | null {
  const CHUNK = 256 * 1024;
  let fd: number | null = null;
  try {
    const bytes = statSync(path).size;
    if (bytes === 0) return null;
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(CHUNK);
    let lines = 0;
    let first = '';
    let lastComplete = '';
    let carry = ''; // partial line spanning a chunk boundary
    let pos = 0;
    while (pos < bytes) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, bytes - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + buf.toString('utf8', 0, n);
      const parts = text.split('\n');
      carry = parts.pop() ?? ''; // last element is incomplete (or '' when the chunk ended on \n)
      for (const p of parts) {
        if (!p) continue;
        lines++;
        if (!first) first = p;
        lastComplete = p;
      }
    }
    // A trailing line with no final newline still counts — the writer appends and flushes per event,
    // so the newest turn is often exactly that.
    const last = carry.trim() ? carry : lastComplete;
    if (carry.trim()) lines++;
    return { lines, first, last, bytes };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

interface RecordLine { ts?: string; kind?: string; cwd?: string; text?: string; tool?: string }

function parseLine(s: string): RecordLine | null {
  try { return JSON.parse(s) as RecordLine; } catch { return null; }
}

/** A short, human title for a session: its first prompt, one line. */
function titleFrom(first: RecordLine | null): string | null {
  const t = (first?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > 72 ? `${t.slice(0, 71)}…` : t;
}

/**
 * Sessions on this machine, newest first. Scoped to `cwd` (default: the current directory) unless
 * `all` is set. Files that can't be read or parsed are skipped, not fatal.
 */
export async function listSessions(opts: { cwd?: string; all?: boolean; limit?: number } = {}): Promise<CliSessionMeta[]> {
  const wantCwd = opts.all ? null : (opts.cwd ?? process.cwd());
  const out: CliSessionMeta[] = [];

  for (const id of listRecordIds()) {
    const scan = scanRecord(recordPath(id));
    if (!scan || !scan.first) continue;
    const first = parseLine(scan.first);
    const last = parseLine(scan.last) ?? first;
    const cwd = first?.cwd ?? last?.cwd ?? '';
    if (wantCwd && cwd !== wantCwd) continue;
    out.push({
      sessionId: id,
      title: titleFrom(first),
      createdAt: first?.ts ?? new Date(0).toISOString(),
      updatedAt: last?.ts ?? first?.ts ?? new Date(0).toISOString(),
      messageCount: scan.lines,
      cwd,
    });
  }

  out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** Resolve a full id or an unambiguous prefix. null when unknown or ambiguous. */
export function resolveSessionId(idOrPrefix: string): string | null {
  const q = idOrPrefix.trim();
  if (!q) return null;
  const ids = listRecordIds();
  if (ids.includes(q)) return q;
  const matches = ids.filter((i) => i.startsWith(q));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Rebuild a session's context: the rolling summary from the checkpoint sidecar (when the session
 * wrote one) plus the last turns replayed from the append-only record. Tool calls are deliberately
 * left out of `recent` — they are in the record for reading, but replaying them into the window
 * would spend the context budget on output the model already acted on.
 */
export async function loadSessionCheckpoint(idOrPrefix: string): Promise<CliSessionCheckpoint | null> {
  const id = resolveSessionId(idOrPrefix);
  if (!id) return null;

  let summary = '';
  let cwd = '';
  let syncedAt = '';
  try {
    if (existsSync(checkpointPath(id))) {
      const side = JSON.parse(readFileSync(checkpointPath(id), 'utf8')) as Partial<CliSessionCheckpoint>;
      summary = typeof side.summary === 'string' ? side.summary : '';
      cwd = side.cwd ?? '';
      syncedAt = side.syncedAt ?? '';
    }
  } catch { /* a corrupt sidecar must not block a resume — the record is the source of truth */ }

  const recent: Array<{ role: string; content: string }> = [];
  try {
    const raw = readFileSync(recordPath(id), 'utf8');
    for (const line of raw.split('\n')) {
      const ev = parseLine(line);
      if (!ev) continue;
      if (!cwd && ev.cwd) cwd = ev.cwd;
      if (ev.kind === 'prompt') recent.push({ role: 'user', content: (ev.text ?? '').slice(0, MAX_CONTENT) });
      else if (ev.kind === 'answer') recent.push({ role: 'assistant', content: (ev.text ?? '').slice(0, MAX_CONTENT) });
    }
  } catch {
    return null; // no record → nothing to resume
  }
  if (!recent.length && !summary) return null;

  return {
    version: VERSION,
    cwd,
    summary,
    recent: recent.slice(-RECENT_TURNS),
    artifacts: [],
    syncedAt: syncedAt || new Date().toISOString(),
  };
}

/**
 * Persist the rolling summary for this session so a resume restores real CONTEXT, not just the last
 * few turns. Called every turn from the agent loop, so it is cheap (one small file) and silent:
 * write-then-rename, so a crash mid-write can never leave a half-parsed checkpoint.
 */
export async function syncSession(
  summary: string,
  recent: Array<{ role: string; content: string }>,
  rawArtifacts: Artifact[],
  _readArtifactFn: (a: Artifact) => string,
  cwd: string,
): Promise<void> {
  const id = sessionId;
  if (!id) return;
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const payload: CliSessionCheckpoint & { artifactCount: number } = {
      version: VERSION,
      cwd: cwd || process.cwd(),
      summary,
      recent: recent.slice(-RECENT_TURNS),
      artifacts: [],
      artifactCount: rawArtifacts.length,
      syncedAt: new Date().toISOString(),
    };
    const tmp = `${checkpointPath(id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, checkpointPath(id));
  } catch {
    /* checkpointing is best-effort — the append-only record is the durable truth */
  }
}
