/**
 * Episode store — persisted CENTRALLY on the backend (nuk) through the resource door
 * (`logs` resource, `rag.episodes.append`), so every machine's ayin farms into ONE store instead
 * of scattering JSON in each machine's ~/.ayin-cli. Local disk is only a FALLBACK for when the
 * backend is unreachable (offline / pre-deploy), so nothing is lost — but the source of truth is
 * maradel. The repo key is the repo dir basename (matches how `ayin rag` keys its store).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { resourceOp } from '../resource-client.js';
import type { Episode } from './mine.js';

export function episodeStorePath(repo: string): string {
  return resolve(homedir(), '.ayin-cli', 'rag', basename(repo), 'episodes.json');
}
function episodeKey(e: Episode): string {
  return `${e.session}:${createHash('sha1').update(e.request).digest('hex').slice(0, 12)}`;
}

interface StoreFile { repo: string; updatedAt: string; total: number; episodes: Episode[] }
export interface AppendResult { added: number; total: number; where: 'backend' | 'local' }

/** Dedup-merge into the LOCAL fallback store (used only when the backend is unreachable). */
function appendLocal(repo: string, newEps: Episode[]): AppendResult {
  const path = episodeStorePath(repo);
  const existing: StoreFile = (existsSync(path) ? safeJson(path) : null) ?? { repo, updatedAt: '', total: 0, episodes: [] };
  const seen = new Set(existing.episodes.map(episodeKey));
  let added = 0;
  for (const e of newEps) { const k = episodeKey(e); if (!seen.has(k)) { seen.add(k); existing.episodes.push(e); added++; } }
  if (added > 0) {
    existing.updatedAt = new Date().toISOString(); existing.total = existing.episodes.length;
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(existing, null, 2));
  }
  return { added, total: existing.episodes.length, where: 'local' };
}
function safeJson(path: string): StoreFile | null { try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; } }

/**
 * Persist verified episodes: backend first (central store on the nuk), local fallback if the
 * resource door isn't there (backend down, or the op not yet deployed). Dedup-merge either way.
 */
export async function appendEpisodes(repo: string, newEps: Episode[]): Promise<AppendResult> {
  if (newEps.length === 0) return { added: 0, total: 0, where: 'backend' };
  const res = await resourceOp('logs', 'rag.episodes.append', { repo: basename(repo), episodes: newEps }, 20_000);
  if (res && typeof res.added === 'number') return { added: res.added, total: res.total, where: 'backend' };
  return appendLocal(repo, newEps); // backend unreachable / op not deployed → keep locally, don't lose it
}
