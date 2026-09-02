import type { Tool } from '../base.js';
import { askSlack } from '../connectors/slack/loop.js';

/**
 * A CONNECTOR: `execute` runs its own agentic loop against Slack's Web API, so the outer agent asks
 * in plain words and gets an answer — never a search query or a channel id it had to look up first.
 *
 * READ-ONLY, on a user token: every public channel, private channel and DM the operator can see.
 * Nothing they could not already read themselves. See `connectors/slack/client.ts` for the allowlist.
 */
export const tool: Tool = {
  name: 'slack',
  icon: '💬',
  description:
    'Answer a question about the operator\'s Slack: search every channel and DM they can see, read a '
    + "channel's history or a thread, list their channels, or look up a person. Ask in plain language. "
    + 'Read-only — it cannot post.',
  parameters: [
    { name: 'question', type: 'string', description: 'The question, in plain language', required: true },
  ],
  // SLASH-ONLY: the operator may run it, the agent may not.
  //
  // A connector's `run` is an inner agentic loop against a REST API, so one call costs several round
  // trips mid-turn for something the operator can fetch in one command before asking anything. The
  // result still reaches the model — a slash invocation is recorded into the conversation window.
  slashOnly: true,
  slash: {
    command: 'slack',
    param: 'question',
    usage: '/slack <question> — search and read your Slack in plain words ("what has anyone said about the outage?", "what happened in that thread?")',
  },
  async execute(params) {
    if (!params.question) return 'Error: question required';
    return askSlack(params.question);
  },
};
