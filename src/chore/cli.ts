/**
 * chore/cli.ts — `ayin chore`, and the page `/chore` opens.
 *
 * The page is written OUTSIDE the repository (`~/.ayin-cli/chore/`), like every other artifact ayin
 * produces: a report about the working tree is not a change to it, and one written into the tree would
 * land in the next diff, the next commit, and eventually someone's review.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runChore, DEFAULT_COMMITS, type ChoreReport } from './index.js';
import { renderChorePage, renderChoreText } from './render.js';
import { openExternal } from '../open-external.js';
import { log } from '../log.js';

const CHORE_DIR = join(homedir(), '.ayin-cli', 'chore');

/** One file per repo, overwritten: the interesting report is the current one. */
export function writeChorePage(report: ChoreReport): string {
  mkdirSync(CHORE_DIR, { recursive: true });
  const stem = (report.repo.split(/[\\/]/).filter(Boolean).pop() ?? 'repo').replace(/[^A-Za-z0-9_-]/g, '_');
  const path = join(CHORE_DIR, `chore-${stem}.html`);
  writeFileSync(path, renderChorePage(report), 'utf-8');
  log('INFO', 'chore_page_written', { path, findings: String(report.findings.length) });
  return path;
}

export interface ChoreRun { report: ChoreReport; text: string; page?: string; opened?: boolean }

/** The one entry point every surface goes through, so text and page can never describe different scans. */
export function chore(opts: { repo: string; commits?: number; all?: boolean; html?: boolean; open?: boolean }): ChoreRun {
  const report = runChore({ repo: opts.repo, commits: opts.commits, includeUsed: opts.all === true });
  const text = renderChoreText(report);
  if (!opts.html) return { report, text };
  const page = writeChorePage(report);
  const opened = opts.open === false ? false : openExternal(page);
  return { report, text, page, opened };
}

const USAGE = `chore — members added in recent commits that nothing uses

  ayin chore                     the last ${DEFAULT_COMMITS} commits, as text
  ayin chore --commits 25        look further back
  ayin chore --all               include the ones that ARE used, and the reflection-invoked
  ayin chore --html              also write the page and open it
  ayin chore --html --no-open    write the page, print its path

Each item is a method, property or field added in that range whose declaration is still in HEAD, with
the commit that introduced it. Added-then-removed is history and is dropped. Code and assets are both
searched — a Unity field is named from a prefab, not from C#.
`;

export function runChoreCli(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE); return 0; }
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : undefined;
  };

  const commits = Number(value('commits') ?? DEFAULT_COMMITS);
  const run = chore({
    repo: process.cwd(),
    commits: Number.isFinite(commits) ? commits : DEFAULT_COMMITS,
    all: flag('all'),
    html: flag('html'),
    open: !flag('no-open'),
  });

  process.stdout.write(`${run.text}\n`);
  if (run.page) {
    process.stdout.write(`\npage: ${run.page}${run.opened ? ' (opened)' : ''}\n`);
  }
  // Findings are not a failure — this is a report, and a non-zero exit would break any pipeline that
  // runs it routinely. The count is on stdout for anything that wants to decide for itself.
  return 0;
}
