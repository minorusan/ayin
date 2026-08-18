import type { Tool } from '../base.js';
import { toolPrompts } from '../runtime.js';
import { configureSentry } from '../connectors/sentry/auth.js';
import { sentryStatus } from '../connectors/sentry/loop.js';

/**
 * Fills ayin's Sentry credential file from whatever the operator pasted.
 *
 * Called with no text it REPORTS instead of configuring — including the case that catches people out: a
 * token stored with no organization slug, which is a 403 on every query until it is added.
 */
export const tool: Tool = {
  name: 'sentry_auth',
  description:
    'Set up or refresh the Sentry credential from pasted text (auth token, organization slug, optional '
    + 'project — any order). Call with no arguments to report what is configured and whether it works.',
  parameters: [
    { name: 'text', type: 'string', description: 'Pasted token / org slug / project; omit to report status', required: false },
  ],
  // SLASH-ONLY, and here it is about the ARGUMENT, not the cost.
  //
  // This tool's parameter is a credential (`secret: true` below). A tool the model can call is a tool
  // the model can be talked into calling, and its catalogue entry sits in the prompt every turn
  // teaching it that a place to put tokens exists. The operator types this one; the agent has no
  // business anywhere near it.
  slashOnly: true,
  slash: {
    command: 'sentry-auth',
    param: 'text',
    usage: '/sentry-auth <paste token + org slug> — store a Sentry credential (verified before saving); bare /sentry-auth reports status',
    secret: true,
  },
  async execute(params) {
    const text = (params.text ?? '').trim();
    if (!text) return sentryStatus();
    return configureSentry(text, (id, vars) => toolPrompts('sentry').get(id, vars));
  },
};
