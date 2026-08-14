import type { Tool } from '../base.js';
import { askSentry } from '../connectors/sentry/loop.js';

/**
 * A CONNECTOR: `execute` runs its own agentic loop against the Sentry API, so the outer agent asks in
 * plain words and gets an answer — never a Sentry search query it had to compose.
 *
 * Scoped to unresolved issues in the operator's organization over a recent window (see client.ts), which
 * is both the question worth asking and a payload a local model can hold.
 */
export const tool: Tool = {
  name: 'sentry',
  description:
    'Answer a question about errors in production from Sentry: which issues are unresolved, how often they '
    + 'fire, how many users they affect, and what the stacktrace of one says. Ask in plain language. '
    + 'Scoped to unresolved issues from the last 14 days.',
  parameters: [
    { name: 'question', type: 'string', description: 'The question, in plain language', required: true },
  ],
  slash: {
    command: 'sentry',
    param: 'question',
    usage: '/sentry <question> — production errors in plain words ("what breaks most for users?", "why is the checkout crashing?")',
  },
  async execute(params) {
    if (!params.question) return 'Error: question required';
    return askSentry(params.question);
  },
};
