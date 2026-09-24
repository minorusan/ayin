/**
 * renames.ts — a file that is not where the corpus left it has usually MOVED, not died.
 *
 * WHY THIS EXISTS. `assessChunk` reports a citation whose file it cannot read as `missing`, and the
 * obvious reading of missing is deleted. On a real repository that reading is wrong most of the time:
 * measured on the first `indulge --update --dry-run` ever run, 377 of 943 live chunks — 40% of the
 * corpus — came back `missing`, and every one of them was a single refactor commit, *"Fold
 * Games/Shared/Codebase into Scripts/GameShared"*, which git records as `R100`: a hundred-percent
 * identical rename. Retiring those chunks would have thrown away 377 answers about code that still
 * exists, verbatim, one directory over.
 *
 * WHAT R100 ALSO MEANS is that nothing needs re-answering. The content is byte-identical, so the
 * chunk is not stale in substance — only its recorded PATH is wrong. Following the rename repairs it
 * for no model calls at all, which is the difference between a refresh that costs a night and one
 * that costs a second.
 *
 * THE COMMIT IS THE UNIT, NOT THE FILE. A refactor moves hundreds of files in one commit, so the
 * rename map is read once per commit and every path in it answered from that one read. Doing it per
 * file would be 377 `git show` calls over the same commit.
 *
 * Everything here is deterministic: git's own similarity detection, no model, no network.
 */

import { execFileSync } from 'node:child_process';

/** Git's similarity floor. 40% is git's own `-M` default, and a Unity refactor moves files whole. */
const FIND_RENAMES = '40%';
/** A refactor commit can be large; this bounds one read of its name-status. */
const MAX_BUFFER = 32 * 1024 * 1024;

function git(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf-8', timeout: 30_000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** old path → new path, for one commit. Built once per commit and reused by every path in it. */
const renameMaps = new Map<string, Map<string, string>>();
/** Answers already given, including the negative ones — a real delete must not be re-asked per chunk. */
const resolved = new Map<string, string | null>();

/** Every rename that commit performed. `R<score>\told\tnew` lines, which is what `-M` prints. */
function renameMapFor(repoPath: string, commit: string): Map<string, string> {
  const key = `${repoPath}\u0000${commit}`;
  const cached = renameMaps.get(key);
  if (cached) return cached;
  const map = new Map<string, string>();
  const out = git(repoPath, ['show', '-M', `--find-renames=${FIND_RENAMES}`, '--name-status', '--format=', commit]);
  for (const line of (out ?? '').split('\n')) {
    // R100\told\tnew — the score is part of the status word, so split on tabs and read the ends.
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[0].startsWith('R')) map.set(parts[1], parts[2]);
  }
  renameMaps.set(key, map);
  return map;
}

/**
 * Where this path went, or null when it was genuinely removed (or never tracked).
 *
 * Follows a CHAIN, because a file moved twice between the corpus being written and now is still the
 * same file — bounded, so a pathological history cannot spin here.
 */
export function followRename(repoPath: string, path: string, maxHops = 4): string | null {
  const key = `${repoPath}\u0000${path}`;
  if (resolved.has(key)) return resolved.get(key) ?? null;

  let current = path;
  let found: string | null = null;
  for (let hop = 0; hop < maxHops; hop++) {
    // The commit that removed or renamed it, most recent first. Nothing there means git never knew
    // this path at all — an untracked file, or one from a branch this checkout does not have.
    const commit = (git(repoPath, ['log', '--format=%H', '--diff-filter=DR', '-1', '--', current]) ?? '').trim();
    if (!commit) break;
    const next = renameMapFor(repoPath, commit).get(current);
    if (!next) break;      // the commit deleted it rather than moving it
    current = next;
    found = next;
  }

  resolved.set(key, found);
  return found;
}

/** Testing and long-running processes: the maps describe a history that a new commit changes. */
export function clearRenameCache(): void {
  renameMaps.clear();
  resolved.clear();
}
