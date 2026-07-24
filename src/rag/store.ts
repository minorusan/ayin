/**
 * Episode store — one JSON file per repo at ~/.ayin-cli/rag/<repo>/episodes.json.
 * The batch miner overwrites it; the auto-farm daemon dedup-merges into it as Claude sessions grow
 * (each Stop re-mines the whole session, so we key episodes and skip ones already stored).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { Episode } from './mine.js';

export function episodeStorePath(repo: string): string {
  return resolve(homedir(), '.ayin-cli', 'rag', basename(repo), 'episodes.json');
}

/** Stable identity for an episode within a session (so repeated mines of a growing session dedup). */
function episodeKey(e: Episode): string {
  return `${e.session}:${createHash('sha1').update(e.request).digest('hex').slice(0, 12)}`;
}

interface StoreFile { repo: string; updatedAt: string; total: number; verified: number; episodes: Episode[] }

function load(path: string): StoreFile | null {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null; } catch { return null; }
}
function save(path: string, data: StoreFile): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Full overwrite — used by the batch `ayin rag-mine`. */
export function writeEpisodeStore(repo: string, verified: Episode[], toWrite: Episode[], total: number, tsIso = new Date().toISOString()): string {
  const path = episodeStorePath(repo);
  save(path, { repo, updatedAt: tsIso, total, verified: verified.length, episodes: toWrite });
  return path;
}

/** Dedup-merge new verified episodes into the store — used by the auto-farm daemon. Returns how
 *  many were genuinely new. */
export function appendEpisodes(repo: string, newEps: Episode[], tsIso = new Date().toISOString()): { added: number; total: number } {
  const path = episodeStorePath(repo);
  const existing = load(path) ?? { repo, updatedAt: tsIso, total: 0, verified: 0, episodes: [] };
  const seen = new Set(existing.episodes.map(episodeKey));
  let added = 0;
  for (const e of newEps) { const k = episodeKey(e); if (!seen.has(k)) { seen.add(k); existing.episodes.push(e); added++; } }
  if (added > 0) { existing.updatedAt = tsIso; existing.verified = existing.episodes.length; existing.total = existing.episodes.length; save(path, existing); }
  return { added, total: existing.episodes.length };
}
