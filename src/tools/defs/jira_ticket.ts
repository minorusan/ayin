import type { Tool } from '../base.js';
import { issueDetail } from '../connectors/jira/client.js';
import { fmtDetail } from '../connectors/jira/format.js';
import { readCredentials } from '../connectors/jira/credentials.js';

/** What Jira itself accepts as a key: a project prefix, a dash, a number. */
const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * `jira_ticket` — one ticket, by key, in ONE request. Deterministic: no model, no rounds, no board.
 *
 * WHY THIS EXISTS BESIDE THE `jira` CONNECTOR. That one is `slashOnly` on purpose — its `execute` is an
 * inner agentic loop, so an agent calling it pays several LLM round trips mid-turn. The consequence went
 * unnoticed until a headless run needed a ticket: the agent could not read one AT ALL. It has a tool for
 * a file, a grep and a shell, and for the ticket that says what to change it had nothing — so it worked
 * from the operator's paraphrase, or ran `curl` with a token it had to find first.
 *
 * Reading a ticket by key needs no reasoning. The key is already in the task ("PERF-13492 says the
 * booster should use the config value"), and this is the request that answers it: description, comments,
 * status, type, priority. No sprint filter — a coding agent's tickets are usually closed, someone else's,
 * or from an older release, and every one of those is a ticket about the code in front of it.
 *
 * A BARE NUMBER IS REFUSED, and told why. `13492` names no project, and guessing a prefix fetches a
 * DIFFERENT ticket that exists — a wrong answer that reads exactly like a right one. The operator's own
 * `/jira` can resolve a bare number, because it holds the board to disambiguate against; this cannot,
 * and inventing the prefix is the one failure worth crashing over.
 */
export const tool: Tool = {
  name: 'jira_ticket',
  icon: '◰',
  description:
    'Read one Jira ticket by key (e.g. PROJ-1234): title, status, type, priority, full description and all '
    + 'comments. One request, any ticket the token can see — open or closed, any sprint, any assignee. Use it '
    + 'whenever a task names a ticket key instead of working from a paraphrase of it.',
  parameters: [
    { name: 'key', type: 'string', description: 'Ticket key including the project prefix, e.g. PROJ-1234', required: true },
  ],
  async execute(params) {
    const key = String(params.key ?? '').trim().toUpperCase();
    if (!key) return 'Error: key required, e.g. PROJ-1234';
    if (!KEY.test(key)) {
      return /^\d+$/.test(key)
        ? `Error: ${key} is a number, not a ticket key — include the project prefix (PROJ-${key}). `
          + 'The same number exists in every project, so there is nothing to guess from.'
        : `Error: ${key} is not a ticket key. Expected PROJ-1234.`;
    }
    if (!readCredentials()) return 'Error: Jira is not configured — the operator runs /jira-auth once, then this works.';
    try {
      return fmtDetail(await issueDetail(key));
    } catch (err) {
      return `jira: could not read ${key} — ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
