/**
 * Session — standalone (vendored into Maradel).
 *
 * The egregor build persisted CLI sessions remotely on Tiferet via Merkavah so
 * any device could resume. The standalone Maradel build doesn't have that
 * network, so this is a LOCAL stub: a session id exists (so per-run state works)
 * but checkpoint sync is a no-op and /resume finds nothing. Drop-in replacement —
 * same exported surface, no @egregor imports.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
export const SESSION_NAMESPACE = `sessions/cli/${VERSION}`;

export interface CliSessionMeta {
  sessionId: string;
  title: string | null;
  updatedAt: string;
  messageCount: number;
  createdAt: string;
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

/** No-op in standalone mode (no remote persistence). Kept for API compatibility. */
export async function syncSession(
  _summary: string,
  _recent: Array<{ role: string; content: string }>,
  _rawArtifacts: Artifact[],
  _readArtifactFn: (a: Artifact) => string,
  _cwd: string,
): Promise<void> {
  // intentionally empty — sessions are per-run only in the Maradel build
}

export async function listSessions(): Promise<CliSessionMeta[]> {
  return [];
}

export async function loadSessionCheckpoint(_id: string): Promise<CliSessionCheckpoint | null> {
  return null;
}
