/**
 * git branch lookup for the status bar. Reads `.git/HEAD` directly (no child process) and
 * caches briefly — the status bar redraws on every 80ms animation tick, so a bare read per
 * redraw would hammer the fs for no reason.
 *
 * Handles the repo living in a parent of `cwd`, and a `.git` *file* (submodule / worktree,
 * `gitdir: <path>`). Detached HEAD → short sha. Not a repo → null (segment hidden).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TTL_MS = 2_000;
let cache: { cwd: string; branch: string | null; at: number } | null = null;

export function gitBranch(cwd: string): string | null {
  const now = Date.now();
  if (cache && cache.cwd === cwd && now - cache.at < TTL_MS) return cache.branch;
  const branch = readBranch(cwd);
  cache = { cwd, branch, at: now };
  return branch;
}

function readBranch(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const dotgit = join(dir, '.git');
    if (existsSync(dotgit)) {
      try {
        let gitDir = dotgit;
        if (statSync(dotgit).isFile()) {
          // submodule / linked worktree: ".git" is a file holding "gitdir: <path>"
          const m = /gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, 'utf-8'));
          if (!m) return null;
          gitDir = m[1].startsWith('/') ? m[1] : join(dir, m[1]);
        }
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf-8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1] : head.slice(0, 7); // detached HEAD → short sha
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached fs root
    dir = parent;
  }
}
