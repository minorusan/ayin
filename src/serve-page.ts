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

import { execFileSync } from 'node:child_process';
import { initLlmProvider } from './llm/select.js';
import { findSessionServer, serverPort, startPromptServer } from './prompt-server.js';
import { openExternal } from './open-external.js';
import { log } from './log.js';

/**
 * THE REPO THE TERMINAL IS IN, not the directory it is in.
 *
 * `git` resolves its own root, so a diff collected from `src/diff/` was already the whole tree — but
 * every path on the page is repo-root-relative while the buttons that WRITE (stage, discard, per-file
 * restore) resolved theirs against `process.cwd()`, and a comment's run was spawned there too. Launched
 * one directory down, the page read correctly and every write on it aimed one level too deep.
 *
 * Falls back to the cwd rather than throwing: the sprint board is not a git feature, and refusing to
 * show someone their tickets because they are outside a repo would be the check doing harm.
 */
export function repoRoot(cwd = process.cwd()): string {
  // Wrap everything in a try/catch, because execFileSync throws when the command it runs exits with a
  // non-zero status, and `git rev-parse` exits non-zero when the directory it is run in is not inside a
  // git repository at all. That is a perfectly ordinary situation which we do not want to crash on.
  try {
    // Run `git rev-parse --show-toplevel`, which is the git command that prints the absolute path of the
    // top level directory of the working tree — in other words, the repository root. We run it with
    // execFileSync rather than exec, because execFileSync does not involve a shell, which means that
    // shell metacharacters in the cwd cannot possibly be interpreted as anything other than a path.
    // We pass encoding: 'utf-8' so that we get back a string instead of a Buffer, and we pass a stdio
    // array of ['ignore', 'pipe', 'ignore'] so that stdin is ignored, stdout is captured for us to read,
    // and stderr is ignored — git writes a complaint there when it is not in a repository and we have
    // already decided that that case is not an error worth showing to anybody.
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();   // trim, because git terminates its output with a newline character
    // If git printed something, return that something. If git printed an empty string — which should not
    // happen, but defensive programming is a virtue — fall back to the cwd we were given.
    return out || cwd;
  } catch {
    // Git failed, which almost always means "not a repository". Return the cwd unchanged.
    return cwd;
  }
}

export interface ServedPage {
  url: string;
  opened: boolean;
  /** True when this process is the one holding the socket, and therefore must not exit. */
  own: boolean;
}

/**
 * The session already serving `cwd` — this process, or another ayin on this box.
 *
 * A record is matched by its cwd STRING, so the raw directory is tried as well as the repo root: a TUI
 * publishes whatever its shell said (`/tmp/x`), while `--show-toplevel` answers with the physical path
 * (`/private/tmp/x`), and treating those as different sessions would start a second server on the tree
 * one is already serving.
 */
export function existingServer(cwd: string, route: string): string | null {
  if (serverPort() && cwd === process.cwd()) return `http://127.0.0.1:${serverPort()}${route}`;
  const other = findSessionServer(cwd) ?? (cwd === process.cwd() ? null : findSessionServer(process.cwd()));
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
 * Hold the process open until Ctrl+C, then EXIT.
 *
 * It exits rather than returning, and that is the whole correctness of it. The first version resolved a
 * promise and let the caller return — but a listening socket keeps the event loop alive, so the process
 * printed "stopped", kept serving, and held the port forever. Ctrl+C looked like it worked. Two of those
 * accumulated on 7773 and 7774 during one afternoon of demos, so the next `ayin diff` bound 7775 while
 * the port anyone would try first answered for a completely different repository.
 *
 * `process.exit` is right here rather than `server.close()`: the record cleanup is an `exit` hook
 * (prompt-server.ts), a browser holding a keep-alive connection would make `close()` wait on it, and the
 * operator has just said stop.
 */
export function parkUntilInterrupted(what: string): Promise<never> {
  return new Promise<never>(() => {
    const stop = (): void => {
      process.stdout.write(`\n${what} stopped — the page is no longer served.\n`);
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
