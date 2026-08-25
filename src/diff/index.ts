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
 * `--static` writes the page to disk and opens it as `file://` — self-contained, no port, works on a
 * machine with no network. The comment affordance is absent there rather than present and broken, and
 * the page says which of the two it is. Every served page leaves one of these behind as well, because a
 * served page dies with its process.
 *
 * WITHOUT A SESSION, `ayin diff` now SERVES the page itself and parks (see serve-page.ts). A comment is
 * answered by its own headless run, so a shell needs nothing from a TUI except the socket.
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
import { existingServer } from '../serve-page.js';

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

export function buildAndOpen(repo: string, against = 'HEAD'): DiffResult {
  // ONE definition of "who is serving this tree", shared with `ayin diff` and `ayin sprint` — two copies
  // of a port lookup is two places for a stale daemon record to be trusted differently.
  const url = existingServer(repo, `/diff?rev=${encodeURIComponent(against)}`);
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
    + (r.served
      ? '\nhover a line to comment — each comment gets its own headless run, and answers under your line'
      : '\nstatic snapshot — nothing is serving it, so the comment boxes are off');
}

const USAGE = `ayin diff [<rev>] — serve the working tree as a reviewable page and open it.

  <rev>       compare against this instead of HEAD (e.g. \`ayin diff main\`)
  --no-open   serve and print the URL, open no browser (ssh)
  --static    write a self-contained snapshot to ~/.ayin-cli/diffs, print the path, exit
  --help

It SERVES the page and stays up until Ctrl+C: hover a line to comment, and the comment
gets its own headless run that makes the change and answers under your line. An ayin
session already serving this repo is used instead of a second server.

Staged, unstaged and untracked changes are all included. Extension filters start at
.cs .asset .ts .js .py — everything else is one click away, and the hidden count is
always on screen.
`;

/**
 * `ayin diff` — a live page from a plain shell.
 *
 * IT USED TO WRITE A FILE. That was right while a comment needed a chat to land in: with no session
 * there was nothing to answer one, so the page was a snapshot with the comment box absent. A comment
 * spawns its own run now (diff/runner.ts), so the only thing missing from a shell was the socket — and
 * this command holds it. `--static` keeps the old behaviour by name, because a snapshot that survives
 * the session is still worth having and one flag is cheaper than remembering the pipeline.
 */
export async function runDiffCli(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const rev = argv.find((a) => !a.startsWith('-')) ?? 'HEAD';
  const open = !argv.includes('--no-open');

  if (argv.includes('--static')) {
    try {
      const r = buildDiffPage(process.cwd(), rev);
      r.opened = open ? openExternal(r.path) : false;
      process.stdout.write(`${summarise(r)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`ayin diff: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  try {
    // COLLECTED FIRST, deliberately. A clean tree or a bad rev must fail here, before a socket is bound
    // and a browser is opened onto a page that says nothing — and the summary is the only thing that can
    // tell the operator how big the change is.
    const set = collectDiff(process.cwd(), rev);
    // The snapshot is still written, exactly as the TUI path does: a served page dies with this process,
    // and a review worth having is one that can still be read tomorrow.
    writeStaticPage(set);
    const { servePage, parkUntilInterrupted } = await import('../serve-page.js');
    const page = await servePage(process.cwd(), `/diff?rev=${encodeURIComponent(rev)}`, open);
    process.stdout.write(`${summarise({
      path: page.url, served: true,
      files: set.files.length,
      additions: set.files.reduce((n, f) => n + f.additions, 0),
      deletions: set.files.reduce((n, f) => n + f.deletions, 0),
      hiddenByDefault: set.files.filter((f) => !DEFAULT_EXTENSIONS.includes(f.ext)).length,
      opened: page.opened,
    })}\n`);
    if (!page.own) {
      process.stdout.write('an ayin session is already serving this repo — using its page\n');
      return 0;
    }
    process.stdout.write('serving · Ctrl+C to stop\n');
    await parkUntilInterrupted('ayin diff');
    return 0;
  } catch (err) {
    process.stderr.write(`ayin diff: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
