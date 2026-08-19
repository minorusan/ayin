/**
 * sprint/index.ts — `/sprint`.
 *
 * The board has no `file://` form. Unlike the diff page, nothing here works without a session: the cards
 * fetch their own detail and the comment box writes to Jira, both through routes only a listening session
 * has. A page with two dead affordances is worse than a sentence saying why there is no page.
 */

import { openExternal } from '../open-external.js';
import { findSessionServer, serverPort } from '../prompt-server.js';

export interface SprintResult {
  url: string | null;
  opened: boolean;
  /** Why there is no URL. Present exactly when `url` is null. */
  reason?: string;
}

/** The session serving this tree: this process if it is listening, another ayin on the box if it is. */
function servedUrl(cwd: string): string | null {
  if (serverPort() && cwd === process.cwd()) return `http://127.0.0.1:${serverPort()}/sprint`;
  const other = findSessionServer(cwd);
  return other ? `http://127.0.0.1:${other.port}/sprint` : null;
}

export function openSprintBoard(cwd = process.cwd()): SprintResult {
  const url = servedUrl(cwd);
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
