/**
 * serve-page.ts — `ayin diff` and `ayin sprint` from a plain shell, as LIVE pages.
 *
 * WHY THESE COMMANDS CHANGED. Both pages used to need a TUI behind them, because a comment on a line
 * and a question about a ticket were messages into that session's chat. `ayin diff` from a shell
 * therefore wrote a static snapshot with the comment box absent, and `ayin sprint` did not exist at all
 * — the board has no static form, since its cards fetch their own detail.
 *
 * A comment is answered by its OWN headless run now (diff/runner.ts, sprint/runner.ts). Nothing about
 * either page needs a chat any more: it needs a SERVER. So these commands start one, open the page, and
 * stay up — which is the whole of what a TUI was contributing.
 *
 * IT PARKS, and that is the interface. A command that serves a page and exits serves nothing; the
 * process holding the socket IS the feature, so it says so on stdout and waits for Ctrl+C. The one case
 * that still exits immediately is the good one: a session already serving this tree, whose page is the
 * same page — opening a second server for the same repo would publish a second record and split the
 * comment store's readers across two ports for no gain.
 */

import { initLlmProvider } from './llm/select.js';
import { findSessionServer, serverPort, startPromptServer } from './prompt-server.js';
import { openExternal } from './open-external.js';
import { log } from './log.js';

export interface ServedPage {
  url: string;
  opened: boolean;
  /** True when this process is the one holding the socket, and therefore must not exit. */
  own: boolean;
}

/** The session already serving `cwd` — this process, or another ayin on this box. */
export function existingServer(cwd: string, route: string): string | null {
  if (serverPort() && cwd === process.cwd()) return `http://127.0.0.1:${serverPort()}${route}`;
  const other = findSessionServer(cwd);
  return other ? `http://127.0.0.1:${other.port}${route}` : null;
}

/**
 * Serve `route` for `cwd` until the operator stops it, or hand back a URL an existing session already
 * serves. Rejects when the socket could not be bound — a command that cannot serve must not park.
 *
 * `open` is the operator's choice, not a guess: over ssh there is no browser to open, and printing the
 * URL is the whole answer there.
 */
export async function servePage(cwd: string, route: string, open: boolean): Promise<ServedPage> {
  const existing = existingServer(cwd, route);
  if (existing) {
    return { url: existing, opened: open ? openExternal(existing) : false, own: false };
  }

  // WHICH PROVIDER, before the first request. The buttons on these pages that spend a model call —
  // Draft, rephrase, the `.cs` staging pass — run in THIS process, and an unresolved provider makes
  // them fail with a confusing error rather than a missing endpoint. Never throws.
  await initLlmProvider();

  const port = await new Promise<number>((resolve, reject) => {
    startPromptServer(cwd, (r) => {
      if ('error' in r) reject(new Error(r.error));
      else resolve(r.port);
    });
  });

  const url = `http://127.0.0.1:${port}${route}`;
  log('INFO', 'serve_page_cli', { route, port: String(port), cwd });
  return { url, opened: open ? openExternal(url) : false, own: true };
}

/**
 * Hold the process open until Ctrl+C, then leave.
 *
 * The server already keeps the event loop alive, so this exists for the SIGINT half: without it the
 * default handler kills the process mid-write and the operator gets a stack-shaped goodbye instead of a
 * line saying the page is gone. Resolves rather than exits, so the caller owns the exit code.
 */
export function parkUntilInterrupted(what: string): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.stdout.write(`\n${what} stopped — the page is no longer served.\n`);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
