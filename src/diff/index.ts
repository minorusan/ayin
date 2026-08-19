/**
 * diff/index.ts — `/diff` and `ayin diff`.
 *
 * TWO PAGES, ONE RENDERER.
 *
 * When a session is listening (the normal case — `/diff` in the TUI), the page is SERVED by that
 * session at `/diff` and the browser is pointed at the URL. That is what makes a line commentable: the
 * page can talk back to the agent that owns the tree, and a reload after a fix re-renders from the new
 * working tree instead of needing a fresh file at a fresh path. See diff/server.ts.
 *
 * With no session listening, the page is written to disk and opened as `file://` exactly as before —
 * self-contained, no port, works on a machine with no network. The comment affordance is absent there
 * rather than present and broken, and the page says which of the two it is.
 *
 * Pages are pruned on the way IN, like launch scripts: an exit handler does not run when the process
 * is killed, and these files contain the operator's uncommitted source.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectDiff, type DiffSet } from './collect.js';
import { DEFAULT_EXTENSIONS, renderDiffPage } from './render.js';
import { openExternal } from '../open-external.js';
import { findSessionServer, serverPort } from '../prompt-server.js';

const DIFF_DIR = join(homedir(), '.ayin-cli', 'diffs');
const PAGE_TTL_MS = 24 * 60 * 60 * 1000;

function prune(): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(DIFF_DIR)) {
      // ONLY THE PAGES. This directory is no longer pages alone — comment threads live here too
      // (`comments-<key>.jsonl`), and they are the operator's words plus the agent's answers, kept
      // deliberately across sessions. A blanket sweep by mtime would have deleted a review conversation
      // the day after it happened, silently, as a side effect of running `/diff` again.
      if (!/^diff-.*\.html$/.test(name)) continue;
      const p = join(DIFF_DIR, name);
      try { if (now - statSync(p).mtimeMs > PAGE_TTL_MS) rmSync(p, { force: true }); }
      catch { /* already gone */ }
    }
  } catch { /* not created yet */ }
}

export interface DiffResult {
  /** The URL when a session served it, the file path when it was written to disk. */
  path: string;
  /** True when the page came off a live session — the only page whose lines can be commented on. */
  served: boolean;
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
/** The static snapshot on disk. Separate from the collect so a served page can leave one too. */
function writeStaticPage(set: DiffSet): string {
  mkdirSync(DIFF_DIR, { recursive: true });
  prune();
  const stamp = set.generatedAt.replace(/[-:]/g, '').replace(/\..+/, '');
  const path = join(DIFF_DIR, `diff-${stamp}.html`);
  writeFileSync(path, renderDiffPage(set), 'utf-8');
  return path;
}

export function buildDiffPage(repo: string, against = 'HEAD'): DiffResult {
  const set = collectDiff(repo, against);
  const path = writeStaticPage(set);

  return {
    path,
    served: false,
    files: set.files.length,
    additions: set.files.reduce((n, f) => n + f.additions, 0),
    deletions: set.files.reduce((n, f) => n + f.deletions, 0),
    hiddenByDefault: set.files.filter((f) => !DEFAULT_EXTENSIONS.includes(f.ext)).length,
    opened: false,
  };
}

/**
 * The page URL of a session serving `repo` — this process if it is the one listening, another ayin on
 * the box if it published a record for the same tree. Null when nothing is up, which is the file:// case.
 */
function servedUrl(repo: string, against: string): string | null {
  const rev = `?rev=${encodeURIComponent(against)}`;
  if (serverPort() && repo === process.cwd()) return `http://127.0.0.1:${serverPort()}/diff${rev}`;
  const other = findSessionServer(repo);
  return other ? `http://127.0.0.1:${other.port}/diff${rev}` : null;
}

export function buildAndOpen(repo: string, against = 'HEAD'): DiffResult {
  const url = servedUrl(repo, against);
  if (url) {
    // The counts are collected here as well as by the route. Two git passes for one `/diff` is cheap,
    // and the alternative is a summary line that cannot say how big the change is.
    const set = collectDiff(repo, against);
    // AND THE SNAPSHOT IS STILL WRITTEN. The live page dies with the session; a review worth having is
    // one you can still read tomorrow, so the same collect also leaves the self-contained file behind.
    // It carries no comment client — it is an artifact, not a second client fighting over the same store.
    writeStaticPage(set);
    return {
      path: url,
      served: true,
      files: set.files.length,
      additions: set.files.reduce((n, f) => n + f.additions, 0),
      deletions: set.files.reduce((n, f) => n + f.deletions, 0),
      hiddenByDefault: set.files.filter((f) => !DEFAULT_EXTENSIONS.includes(f.ext)).length,
      opened: openExternal(url),
    };
  }
  const r = buildDiffPage(repo, against);
  r.opened = openExternal(r.path);
  return r;
}

/** One line for the operator, wherever it is printed. */
export function summarise(r: DiffResult): string {
  if (r.files === 0) return 'Working tree is clean — nothing to diff.';
  return `${r.files} file(s) · +${r.additions} −${r.deletions}`
    + (r.hiddenByDefault ? ` · ${r.hiddenByDefault} hidden by the default filters (chips at the top show them)` : '')
    + `\n${r.path}`
    // Whether a line can be commented on is the difference between the two pages, so it is stated
    // rather than left for the operator to discover by hovering and finding nothing.
    + (r.served ? '\nhover a line to comment — replies come back into this chat' : '\nstatic page — no session was listening, so comments are off');
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
