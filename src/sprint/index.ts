/**
 * sprint/index.ts — `/sprint` and `ayin sprint`.
 *
 * The board has no `file://` form, and never will: the cards fetch their own detail, the comment box
 * writes to Jira, and asking ayin about a ticket needs a route. A page with three dead affordances is
 * worse than a sentence saying why there is no page.
 *
 * WHICH IS WHY `ayin sprint` SERVES ITS OWN. The board used to be reachable only from a TUI, because
 * that was the only thing that ran a server — and asking a question needed that session's chat. Neither
 * is true now: a question spawns its own headless run (sprint/runner.ts), so the shell command starts a
 * server, opens the board and parks. See serve-page.ts.
 */

import { openExternal } from '../open-external.js';
import { existingServer } from '../serve-page.js';

export interface SprintResult {
  url: string | null;
  opened: boolean;
  /** Why there is no URL. Present exactly when `url` is null. */
  reason?: string;
}

export function openSprintBoard(cwd = process.cwd()): SprintResult {
  const url = existingServer(cwd, '/sprint');
  if (!url) {
    return {
      url: null,
      opened: false,
      reason: 'no session is listening, and the board is not a static page — its cards fetch their own '
        + 'detail and its comment box posts to Jira. Start ayin in this directory and run /sprint there.',
    };
  }
  return { url, opened: openExternal(url) };
}

/** One line for the operator. The board is fetched by the ROUTE, so this cannot report ticket counts. */
export function summariseSprint(r: SprintResult): string {
  if (!r.url) return `/sprint: ${r.reason}`;
  return `${r.url}\n`
    + 'click a ticket for its description and comments · + posts a comment to Jira as you'
    + (r.opened ? '' : '\n(could not open a browser — the URL above is the board)');
}

const USAGE = `ayin sprint — serve your Jira sprint as a board and open it.

  --no-open   serve and print the URL, open no browser (ssh)
  --help

It stays up until Ctrl+C. Click a ticket for its description and comments; + posts a
comment to Jira as you; "ask ayin" starts a headless run on this repo that searches
the code and answers in the ticket's thread. An ayin session already serving this
directory is used instead of a second server.

Needs a Jira credential — run \`ayin\` and \`/jira-auth\` once if the board is empty.
`;

/**
 * `ayin sprint` — the board without a TUI.
 *
 * The board is FETCHED BY THE ROUTE, so this cannot report ticket counts before serving and does not
 * pretend to: an unreachable Jira renders as the page saying why, which is where the operator is
 * looking. That is deliberate — see sprint/server.ts, which answers a failed collect with HTML rather
 * than a 502 nobody reads.
 */
export async function runSprintCli(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    const { servePage, parkUntilInterrupted } = await import('../serve-page.js');
    const page = await servePage(process.cwd(), '/sprint', !argv.includes('--no-open'));
    process.stdout.write(`${page.url}\n`);
    process.stdout.write('click a ticket for its description and comments · + posts a comment to Jira as you\n');
    if (!page.opened) process.stdout.write('(no browser was opened — the URL above is the board)\n');
    if (!page.own) {
      process.stdout.write('an ayin session is already serving this directory — using its board\n');
      return 0;
    }
    process.stdout.write('serving · Ctrl+C to stop\n');
    await parkUntilInterrupted('ayin sprint');
    return 0;
  } catch (err) {
    process.stderr.write(`ayin sprint: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
