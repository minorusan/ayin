import type { Tool } from '../base.js';
import { toolPrompts } from '../runtime.js';
import { configureJira } from '../connectors/jira/auth.js';
import { jiraStatus } from '../connectors/jira/loop.js';

/**
 * Fills ayin's Jira credential file from whatever the operator pasted.
 *
 * Prompts come through `toolPrompts('jira')` — the same namespace the connector's loop uses, resolved on
 * call rather than at module scope, so the module imports cleanly before core wires the runtime.
 *
 * Called with no text it REPORTS instead of configuring: `/jira-auth` alone is the natural way to ask "am
 * I still authenticated, and when does this token die?", which is the question that precedes re-authing.
 */
export const tool: Tool = {
  name: 'jira_auth',
  icon: '🔑',
  description:
    'Set up or refresh the Jira credential from pasted text (token, site, email, expiry — any order). '
    + 'Call with no arguments to report who is authenticated and when the token expires.',
  parameters: [
    { name: 'text', type: 'string', description: 'Pasted credential text; omit to report current status', required: false },
  ],
  // SLASH-ONLY, and here it is about the ARGUMENT, not the cost.
  //
  // This tool's parameter is a credential (`secret: true` below). A tool the model can call is a tool
  // the model can be talked into calling, and its catalogue entry sits in the prompt every turn
  // teaching it that a place to put tokens exists. The operator types this one; the agent has no
  // business anywhere near it.
  slashOnly: true,
  slash: {
    command: 'jira-auth',
    param: 'text',
    usage: '/jira-auth <paste token + site + expiry> — store a Jira credential (verified before saving); bare /jira-auth reports status',
    secret: true,
  },
  async execute(params) {
    const text = (params.text ?? '').trim();
    if (!text) return jiraStatus();
    return configureJira(text, (id, vars) => toolPrompts('jira').get(id, vars));
  },
};
