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

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Backtick-quoted spans first (the convention this codebase's own prompts favor for citing a path),
 *  then bare path-shaped tokens as a fallback for prose that didn't use backticks. */
const BACKTICK_RE = /`([^`\s]+)`/g;
const BARE_PATH_RE = /\b[A-Za-z0-9_][\w./-]*\.[A-Za-z0-9]{1,10}\b/g;

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:)\]'"!?]+$/, '');
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
  for (const raw of candidates) {
    const cleaned = raw.replace(/^["'(]+/, '');
    if (!cleaned || cleaned.length > 300) continue;
    const abs = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
    if (seenAbs.has(abs)) continue;
    if (!existsSync(abs)) continue;
    seenAbs.add(abs);
    found.push(cleaned);
    if (found.length >= limit) break;
  }
  return found;
}
