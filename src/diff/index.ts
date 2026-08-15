/**
 * diff/index.ts — `/diff` and `ayin diff`.
 *
 * Renders the working tree to a self-contained HTML page and opens it. The page is written to disk
 * rather than served, because a review page has no reason to open a port and a `file://` URL works
 * on a machine with no network — which is the machine this is most likely to run on.
 *
 * Pages are pruned on the way IN, like launch scripts: an exit handler does not run when the process
 * is killed, and these files contain the operator's uncommitted source.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectDiff } from './collect.js';
import { DEFAULT_EXTENSIONS, renderDiffPage } from './render.js';
import { openExternal } from '../open-external.js';

const DIFF_DIR = join(homedir(), '.ayin-cli', 'diffs');
const PAGE_TTL_MS = 24 * 60 * 60 * 1000;

function prune(): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(DIFF_DIR)) {
      const p = join(DIFF_DIR, name);
      try { if (now - statSync(p).mtimeMs > PAGE_TTL_MS) rmSync(p, { force: true }); }
      catch { /* already gone */ }
    }
  } catch { /* not created yet */ }
}

export interface DiffResult {
  path: string;
  files: number;
  additions: number;
  deletions: number;
  hiddenByDefault: number;   // files the default filters start with collapsed away
  opened: boolean;
}

/**
 * Build the page. `against` is any rev — `HEAD` for the working tree, `main` to review a branch.
 *
 * Returns the summary rather than printing it: the TUI and the CLI want to say it differently, and a
 * function that writes to stdout cannot be used by the one with a blessed screen attached.
 */
export function buildDiffPage(repo: string, against = 'HEAD'): DiffResult {
  const set = collectDiff(repo, against);
  const html = renderDiffPage(set);
  mkdirSync(DIFF_DIR, { recursive: true });
  prune();
  const stamp = set.generatedAt.replace(/[-:]/g, '').replace(/\..+/, '');
  const path = join(DIFF_DIR, `diff-${stamp}.html`);
  writeFileSync(path, html, 'utf-8');

  return {
    path,
    files: set.files.length,
    additions: set.files.reduce((n, f) => n + f.additions, 0),
    deletions: set.files.reduce((n, f) => n + f.deletions, 0),
    hiddenByDefault: set.files.filter((f) => !DEFAULT_EXTENSIONS.includes(f.ext)).length,
    opened: false,
  };
}

export function buildAndOpen(repo: string, against = 'HEAD'): DiffResult {
  const r = buildDiffPage(repo, against);
  r.opened = openExternal(r.path);
  return r;
}

/** One line for the operator, wherever it is printed. */
export function summarise(r: DiffResult): string {
  if (r.files === 0) return 'Working tree is clean — nothing to diff.';
  return `${r.files} file(s) · +${r.additions} −${r.deletions}`
    + (r.hiddenByDefault ? ` · ${r.hiddenByDefault} hidden by the default filters (chips at the top show them)` : '')
    + `\n${r.path}`;
}

const USAGE = `ayin diff [<rev>] — render the working tree as a reviewable HTML page and open it.

  <rev>       compare against this instead of HEAD (e.g. \`ayin diff main\`)
  --no-open   write the page, print the path, open nothing
  --help

Staged, unstaged and untracked changes are all included. Extension filters start at
.cs .asset .ts .js .py — everything else is one click away, and the hidden count is
always on screen.
`;

export async function runDiffCli(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const rev = argv.find((a) => !a.startsWith('-')) ?? 'HEAD';
  try {
    const r = argv.includes('--no-open') ? buildDiffPage(process.cwd(), rev) : buildAndOpen(process.cwd(), rev);
    process.stdout.write(`${summarise(r)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`ayin diff: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
