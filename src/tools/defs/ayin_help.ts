import type { Tool } from '../base.js';
import { plainPage, topicPage } from '../../help-page.js';

/**
 * `ayin_help` — the agent reads its OWN help, the same bytes `ayin --help` prints.
 *
 * WHY A TOOL AND NOT PROMPT TEXT. Everything the operator can type — `!cmd`, `/diff`, `/qa`,
 * `ayin indulge`, `/git-hardreset` — is a capability of the system the agent is working inside, and the
 * agent had no way to learn any of it. Asked "how do I review this?" it invented an answer, or told the
 * operator to run something that does not exist. The catalogue is ~6 KB: as prompt text it would be
 * loaded on every turn to serve the rare turn that needs it, which is the exact shape §3a forbids. As a
 * tool it is fetched on the turn that asks.
 *
 * NO SIDE EFFECTS AND NO PROCESS. It calls the same functions `ayin --help` does, in-process, rather
 * than shelling out to `ayin --help` — which would spawn a second ayin, pay a whole node boot, and (with
 * no TTY on the far end) hand back whatever that process decided about paging and colour. The plain form
 * is the default here for the same reason it is the default there: escape codes are noise to a reader
 * that is not an eye.
 *
 * A TOPIC IS THE CHEAP CASE. `topic` returns one command in full (~1 KB) instead of the whole list, and
 * an unknown topic answers with the near-matches rather than nothing.
 */
export const tool: Tool = {
  name: 'ayin_help',
  description:
    'Read ayin\'s own help — every slash command, launch flag, key binding and shell trick available in this '
    + 'session, exactly as `ayin --help` prints it. Pass topic (e.g. "/diff", "indulge") for one command in '
    + 'full. Use it before telling the operator how to do something, instead of guessing a command exists.',
  parameters: [
    { name: 'topic', type: 'string', description: 'One command, flag or key — "/diff", "/qa", "indulge", "Ctrl+O". Omit for the whole list.', required: false },
  ],
  async execute(params) {
    const topic = String(params.topic ?? '').trim();
    return topic ? topicPage(topic) : plainPage();
  },
};
