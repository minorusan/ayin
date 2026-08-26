import type { Tool } from '../base.js';
import { configureSlack } from '../connectors/slack/auth.js';
import { slackStatus } from '../connectors/slack/loop.js';

/**
 * Fills ayin's Slack credential file from a pasted User OAuth Token.
 *
 * Called with no text it REPORTS instead of configuring — including the case that catches people
 * out: a bot token, which authenticates fine and then cannot search at all.
 */
export const tool: Tool = {
  name: 'slack_auth',
  description:
    'Set up or refresh the Slack credential from a pasted User OAuth Token (xoxp-…). Call with no '
    + 'arguments to report what is configured and whether it works.',
  parameters: [
    { name: 'text', type: 'string', description: 'Pasted token; omit to report status', required: false },
  ],
  // SLASH-ONLY, and here it is about the ARGUMENT, not the cost — same reasoning as jira_auth /
  // sentry_auth: the parameter is a credential, and a tool the model can call is a tool the model can
  // be talked into calling.
  slashOnly: true,
  slash: {
    command: 'slack-auth',
    param: 'text',
    usage: '/slack-auth <paste your Slack User OAuth Token> — store it (verified before saving); bare /slack-auth reports status',
    secret: true,
  },
  async execute(params) {
    const text = (params.text ?? '').trim();
    if (!text) return slackStatus();
    return configureSlack(text);
  },
};
