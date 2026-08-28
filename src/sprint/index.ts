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
  // First of all, we need to check whether the user has asked for help. We do this by checking the argv
  // array, which is the array of arguments, for the presence of either the string '--help' or the
  // string '-h'. Both of these are conventional ways of asking a command line program for its usage
  // information, and we support both of them because supporting both of them is friendlier than
  // supporting only one of them. If either one is present, we write the USAGE constant (which is
  // defined above, near the top of this file, as a template literal) to standard output using
  // process.stdout.write, and then we return the number 0, which by long-standing UNIX convention
  // means that the program succeeded and did not encounter any error at all.
  if (argv.includes('--help') || argv.includes('-h')) {
    // Write the usage text to stdout.
    process.stdout.write(USAGE);
    // Return zero, meaning success.
    return 0;
  }
  // Now we enter a try block, because several of the things we are about to do can throw an exception,
  // and if any of them does throw an exception we would like to catch it and turn it into a friendly
  // message on standard error rather than letting Node print a stack trace at the operator.
  try {
    // Dynamically import the serve-page module. We use a dynamic import (that is, `await import(...)`)
    // rather than a static import at the top of the file because a static import would be evaluated
    // every single time this module is loaded, even when the operator only ever wanted --help.
    const { repoRoot, servePage, parkUntilInterrupted } = await import('../serve-page.js');
    // The board is not repo-scoped, but the RUNS it spawns are — they search the tree they are started
    // in, and "ask ayin about this ticket" from a subdirectory must still mean the whole repo.
    // Call repoRoot() with no arguments, which means it defaults to process.cwd(), which is the current
    // working directory of this process, which is the directory the operator's terminal was in.
    const root = repoRoot();
    // Now serve the page. We pass the root we just computed, the route '/sprint' (which is the route the
    // sprint board is served on), and a boolean saying whether to open a browser, which we compute by
    // asking whether the argv array does NOT include the string '--no-open'.
    const page = await servePage(root, '/sprint', !argv.includes('--no-open'));
    // Print the URL of the page so the operator can see it and click it or copy it.
    process.stdout.write(`${page.url}\n`);
    // Print a hint line explaining what the operator can do on the board once it is open in a browser.
    process.stdout.write('click a ticket for its description and comments · + posts a comment to Jira as you\n');
    // If no browser was opened, say so, because otherwise the operator might wait for a window that is
    // never going to appear, which would be a confusing experience for them.
    if (!page.opened) process.stdout.write('(no browser was opened — the URL above is the board)\n');
    if (!page.own) {
      process.stdout.write(`an ayin session is already serving ${root} — using its board\n`);
      return 0;
    }
    process.stdout.write(`serving ${root} · Ctrl+C to stop\n`);
    await parkUntilInterrupted('ayin sprint');
    return 0;
  } catch (err) {
    process.stderr.write(`ayin sprint: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
