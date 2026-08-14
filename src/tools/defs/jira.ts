import type { Tool } from '../base.js';
import { askJira } from '../connectors/jira/loop.js';

/**
 * A CONNECTOR, not a query tool: `execute` runs its own agentic loop against the Jira API, so the outer
 * agent asks a question in plain words and gets an answer, never a JQL string it had to compose.
 *
 * Scoped to the token owner's CURRENT SPRINT by the queries themselves (see client.ts) — which is both
 * the useful scope for a working day and the reason its payload fits a local model's context.
 */
export const tool: Tool = {
  name: 'jira',
  description:
    'Answer a question about the current Jira sprint for the authenticated user: which tickets are assigned, '
    + 'their status and priority, and what a ticket says or who commented on it. Ask in plain language, not JQL. '
    + 'Scoped to your own tickets in the open sprint.',
  parameters: [
    { name: 'question', type: 'string', description: 'The question, in plain language', required: true },
  ],
  slash: {
    command: 'jira',
    param: 'question',
    usage: '/jira <question> — your current sprint, in plain words ("what is still open on me?", "any replies on the login bug?")',
  },
  async execute(params) {
    if (!params.question) return 'Error: question required';
    return askJira(params.question);
  },
};
