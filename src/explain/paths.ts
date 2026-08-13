/**
 * paths — pulling real file paths out of `explore`'s prose answer.
 *
 * `explore` (`tools/explore.ts`) returns plain text, not structured findings — there is no
 * `files: string[]` anywhere in its result. `/explain` needs concrete paths to hand to `git log`, so
 * this scans the prose for path-shaped substrings and keeps only the ones a real `existsSync` confirms
 * — the same "don't trust the shape, check the disk" discipline `describeFile`/`suggestSimilarPaths`
 * already use elsewhere in this codebase. A path explore only mentioned in passing, or hallucinated,
 * is silently dropped rather than fed to git as if it were real.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { log } from '../log.js';

/** Backtick-quoted spans first (the convention this codebase's own prompts favor for citing a path),
 *  then bare path-shaped tokens as a fallback for prose that didn't use backticks. */
const BACKTICK_RE = /`([^`\s]+)`/g;
const BARE_PATH_RE = /\b[A-Za-z0-9_][\w./-]*\.[A-Za-z0-9]{1,10}\b/g;

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:)\]'"!?]+$/, '');
}

/**
 * BASENAME FALLBACK — `explore` very often names a file the way a human would in conversation
 * ("the core logic lives in `SessionController.cs`") rather than by its full repo-relative path.
 * Resolving that against `cwd` alone fails for anything not sitting at the repo root, so on a project
 * with any real directory depth EVERY cited file was dropped, `/explain` gathered no git history at all,
 * and the report honestly-but-uselessly said the author and origin "could not be recovered" for a
 * feature with hundreds of commits. Reproduced live against a real Unity project before this fix.
 *
 * The index is built from `git ls-files` (tracked files only, so build output and `node_modules` can't
 * pollute it) and cached per-root. A basename matching exactly one tracked file resolves to it; a
 * handful of matches all resolve (same-named files across a feature are usually all relevant); a
 * basename that is ambiguous across many directories (`Constants.cs`, `index.ts`) is left unresolved
 * rather than guessed at — a wrong file's history is worse evidence than no history.
 */
const MAX_BASENAME_MATCHES = 3;
const basenameIndexCache = new Map<string, Map<string, string[]>>();

function basenameIndex(root: string): Map<string, string[]> {
  const cached = basenameIndexCache.get(root);
  if (cached) return cached;

  const index = new Map<string, string[]>();
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd: root, timeout: 10_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    for (const line of out.split('\n')) {
      if (!line) continue;
      const base = basename(line);
      const list = index.get(base);
      if (list) list.push(line);
      else index.set(base, [line]);
    }
  } catch (err) {
    // Not a git repo, or git unavailable — the fallback simply contributes nothing, same degradation
    // philosophy as `gatherGitHistory`'s own per-path failure handling.
    log('WARN', 'explain_basename_index_failed', { root, error: err instanceof Error ? err.message : String(err) });
  }
  basenameIndexCache.set(root, index);
  return index;
}

/**
 * Extract real, existing file/directory paths mentioned in `text`, resolved against `cwd`. Dedup,
 * capped at `limit` so a rambling answer can't blow up the git-log fan-out that follows.
 */
export function extractExistingPaths(text: string, cwd: string, limit = 15): string[] {
  const candidates = new Set<string>();

  for (const m of text.matchAll(BACKTICK_RE)) candidates.add(stripTrailingPunctuation(m[1]));
  for (const m of text.matchAll(BARE_PATH_RE)) candidates.add(stripTrailingPunctuation(m[0]));

  const found: string[] = [];
  const seenAbs = new Set<string>();
  const unresolvedBasenames: string[] = [];

  const push = (relPath: string): boolean => {
    const abs = isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
    if (seenAbs.has(abs)) return false;
    seenAbs.add(abs);
    found.push(relPath);
    return true;
  };

  for (const raw of candidates) {
    const cleaned = raw.replace(/^["'(]+/, '');
    if (!cleaned || cleaned.length > 300) continue;
    const abs = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
    if (existsSync(abs)) {
      if (seenAbs.has(abs)) continue;
      seenAbs.add(abs);
      found.push(cleaned);
      if (found.length >= limit) return found;
      continue;
    }
    // Didn't resolve from cwd. If it's a bare basename, defer it to the git-backed lookup below —
    // done in a second pass so directly-resolvable paths always win the `limit` budget first.
    if (!cleaned.includes('/') && !cleaned.includes('\\')) unresolvedBasenames.push(cleaned);
  }

  if (found.length < limit && unresolvedBasenames.length > 0) {
    const index = basenameIndex(cwd);
    for (const base of unresolvedBasenames) {
      const matches = index.get(base);
      if (!matches || matches.length > MAX_BASENAME_MATCHES) continue;
      for (const m of matches) {
        if (!existsSync(resolve(cwd, m))) continue;
        if (push(m) && found.length >= limit) return found;
      }
    }
  }

  return found;
}
