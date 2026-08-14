/**
 * indulge/staleness.ts — how old is what we know, and can the agent still trust it.
 *
 * A corpus assists an agent that EDITS CODE, so it goes stale during the very session it is helping.
 * That makes staleness the difference between a useful corpus and a dangerous one: a chunk saying
 * "Ingest runs before Configure" injected right after that ordering changed is a confident lie with
 * a citation attached, and the citation makes it *more* believable, not less.
 *
 * The answer is not to drop stale chunks — a chunk written on `dev` describing a file you have since
 * edited is usually still broadly true, and dropping it throws away real knowledge. It is to say
 * exactly what is known and how old it is, and let the agent reason about the gap:
 *
 *     [corpus] answered 2026-08-14 on dev — cited files unchanged
 *     [corpus · STALE] answered 2026-08-14 on dev · src/Match.cs +12 −3 since · line refs as of then
 *     [corpus · STALE] answered 2026-08-14 on dev · src/Match.cs has uncommitted changes
 *     [corpus · DIVERGENT] answered 2026-08-14 on other-branch, not in your current history
 *
 * **The label leads with the BRANCH, not the sha.** `dev` and `release` carry meaning a hash never
 * will; making an agent resolve a sha to a branch name is a tool call spent learning nothing. The
 * commit is kept for the machinery — it is what the diff is taken against and what decides whether
 * the chunk is in your history — and it stays out of the agent's line.
 *
 * **Staleness is a property of the whole CHUNK, not of one citation.** Chunks are built around
 * interconnected things; if one cited file has moved, the claim the chunk makes about how those
 * things fit together is in doubt, not merely the part touching that file. The label still names
 * which file moved, because that is where the agent should look.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blobSha, type Chunk } from './store.js';

export type Freshness = 'fresh' | 'stale' | 'divergent' | 'missing';

export interface Staleness {
  state: Freshness;
  /** The one line an agent reads. Branch-led, short, no sha. */
  label: string;
  /** Cited files whose bytes have moved since the chunk was written. */
  changed: string[];
  /** True when the change is only in the working tree — very often the agent's own edit. */
  uncommitted: boolean;
}

const git = (repoPath: string, args: string[]): string => {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, maxBuffer: 2 * 1024 * 1024,
    }).trim();
  } catch { return ''; }
};

const day = (iso: string): string => (iso || '').slice(0, 10);

/** `+12 −3` for one file since a commit, or '' when it cannot be computed. */
function deltaSince(repoPath: string, commit: string, file: string): string {
  if (!commit) return '';
  // Against the WORKING TREE, not HEAD: an uncommitted edit is the most common staleness in a live
  // session, and diffing commit..HEAD would miss exactly that.
  const out = git(repoPath, ['diff', '--numstat', commit, '--', file]);
  const row = out.split('\n').find(Boolean);
  if (!row) return '';
  const [added, deleted] = row.split('\t');
  if (added === '-' || deleted === '-') return 'binary';
  return `+${added} −${deleted}`;
}

/** True when the file differs from HEAD in the working tree (staged or not). */
function hasUncommittedChange(repoPath: string, file: string): boolean {
  return git(repoPath, ['status', '--porcelain', '--', file]).trim().length > 0;
}

/** Is the chunk's commit part of the history you are standing on? */
function isAncestor(repoPath: string, commit: string): boolean | null {
  if (!commit) return null;
  try {
    execFileSync('git', ['-C', repoPath, 'merge-base', '--is-ancestor', commit, 'HEAD'],
      { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch { return false; }
}

/**
 * Assess one chunk against the repo as it is right now.
 *
 * Cheap enough to run per injected chunk: one hash per cited file, and at most three short git calls
 * when something has actually moved.
 */
export function assessChunk(repoPath: string, chunk: Chunk): Staleness {
  const where = chunk.branch ? ` on ${chunk.branch}` : ' (branch unknown — chunk predates provenance)';
  const when = `answered ${day(chunk.createdAt)}${where}`;

  const changed: string[] = [];
  let missing = false;
  for (const c of chunk.citations) {
    let body: Buffer;
    try { body = readFileSync(join(repoPath, c.path)); } catch { missing = true; changed.push(c.path); continue; }
    if (blobSha(body) !== c.sha && !changed.includes(c.path)) changed.push(c.path);
  }

  if (missing) {
    return {
      state: 'missing', changed, uncommitted: false,
      label: `[corpus · STALE] ${when} · ${changed.join(', ')} no longer exists · line refs as of then`,
    };
  }

  if (changed.length === 0) {
    // Fresh bytes, but the chunk may still come from a line of development you are not on.
    if (chunk.commit && isAncestor(repoPath, chunk.commit) === false) {
      return {
        state: 'divergent', changed: [], uncommitted: false,
        label: `[corpus · DIVERGENT] ${when}, which is not in your current history`,
      };
    }
    return { state: 'fresh', changed: [], uncommitted: false, label: `[corpus] ${when} — cited files unchanged` };
  }

  const uncommitted = changed.some((f) => hasUncommittedChange(repoPath, f));
  const deltas = changed
    .map((f) => { const d = deltaSince(repoPath, chunk.commit ?? '', f); return d ? `${f} ${d}` : f; })
    .join(', ');
  const divergent = chunk.commit ? isAncestor(repoPath, chunk.commit) === false : false;

  const parts = [`[corpus · ${divergent ? 'DIVERGENT' : 'STALE'}] ${when}`, deltas];
  if (uncommitted) parts.push('uncommitted changes in your working tree');
  if (divergent) parts.push('not in your current history');
  parts.push('line refs as of then');

  return { state: divergent ? 'divergent' : 'stale', changed, uncommitted, label: parts.join(' · ') };
}
