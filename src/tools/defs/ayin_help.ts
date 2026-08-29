import type { Tool } from '../base.js';
import { plainPage, topicPage } from '../../help-page.js';
import { HELP } from '../../help.js';

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
 *
 * AND A QUESTION IS THE ONE PEOPLE ACTUALLY ASK. `topic` requires already knowing the name of the thing
 * — which is exactly what someone asking "can you talk to Jira?" or "how do I get a code review?" does
 * not have. `question` searches the same catalogue SEMANTICALLY: every command, flag, key and TOOL is
 * scored against the words asked, and the matches come back with what each one does.
 *
 * IT ANSWERS "NO" OUT LOUD. A capability search that returns nothing is the most useful answer this
 * tool has — "ayin cannot do that" is a fact the operator needs and the model will otherwise invent
 * around. So an empty result is a sentence saying so, never an empty string.
 *
 * NO MODEL CALL. The scoring is term overlap over ~90 short entries; the agent that called this is
 * already the one composing the answer, and a second generation to rank sixty lines would cost a
 * round to say what a `filter` says.
 */
export const tool: Tool = {
  name: 'ayin_help',
  description:
    'ANSWER ANY QUESTION ABOUT WHAT AYIN CAN OR CANNOT DO. Pass `question` in the operator\'s own words — '
    + '"can you talk to jira", "how do I review a diff", "can it run tests" — and it searches every slash '
    + 'command, launch flag, key binding AND tool, or says plainly that nothing matches. Your own tool list '
    + 'is only half of what this session can do: the commands the OPERATOR can type are the other half, and '
    + 'they are only in here. Call this before answering any "can you…" or "how do I…" question about ayin '
    + 'itself, instead of answering from the tools you happen to see. `topic` returns one command\'s full '
    + 'page; no arguments returns the whole list.',
  parameters: [
    { name: 'topic', type: 'string', description: 'One command, flag or key — "/diff", "/qa", "indulge", "Ctrl+O". Omit for the whole list.', required: false },
    { name: 'question', type: 'string', description: 'Ask in plain words what ayin can do — "can you talk to jira", "how do I review a diff", "can it run tests". Searches every command, flag, key and tool.', required: false },
  ],
  async execute(params) {
    const question = String(params.question ?? '').trim();
    if (question) {
      // IMPORTED LAZILY, AND THAT IS LOAD-BEARING. A top-level `import … from '../../tools.js'` is a
      // CYCLE: `tools.ts` discovers this file, so at discovery time it is only half initialised and the
      // binding is undefined — the def throws, discovery records it as failed, and `ayin_help` silently
      // stops existing. Measured: the tool vanished from the catalogue entirely and the model answered
      // "I cannot call ayin_help as it is not a tool available to me". Here the import happens on the
      // turn that asks, long after everything is built.
      const { modelTools } = await import('../../tools.js');
      return answerCapability(question, modelTools().map((t) => ({ name: t.name, description: t.description })));
    }
    const topic = String(params.topic ?? '').trim();
    return topic ? topicPage(topic) : plainPage();
  },
};

/** Words too common to tell two capabilities apart. Scoring on them ranks the catalogue at random. */
const STOP = new Set([
  'can', 'you', 'ayin', 'the', 'a', 'an', 'is', 'it', 'do', 'does', 'how', 'what', 'i', 'to', 'my',
  'me', 'and', 'or', 'of', 'in', 'on', 'for', 'with', 'this', 'that', 'be', 'able', 'have', 'has',
  'use', 'used', 'using', 'there', 'any', 'some', 'get', 'make', 'tell', 'ask', 'please', 'about',
]);

function terms(text: string): string[] {
  return [...new Set(
    text.toLowerCase().split(/[^a-z0-9_+-]+/).filter((w) => w.length > 1 && !STOP.has(w)),
  )];
}

/** One capability, from wherever it came. */
interface Capability { label: string; kind: string; text: string }

function catalogue(tools: Array<{ name: string; description: string }>): Capability[] {
  const out: Capability[] = HELP.map((h) => ({
    label: h.name,
    kind: h.kind === 'cli' ? 'shell' : h.kind,
    text: `${h.name} ${h.short} ${h.tip ?? ''}`,
  }));
  // TOOLS COUNT AS CAPABILITIES. "Can you search the web" is answered by `web_search` existing, and
  // nothing in HELP mentions it — the tool catalogue is the other half of what ayin can do.
  for (const t of tools) out.push({ label: t.name, kind: 'tool', text: `${t.name} ${t.description}` });
  return out;
}

/**
 * Score by how much of the QUESTION each capability accounts for, with a whole-word bonus.
 *
 * Substring matching is what makes "test" find `testrun` and "review" find both `/qa` and the code
 * review flow; the whole-word bonus is what keeps `/diff` above a page that merely contains "different".
 */
export function answerCapability(question: string, tools: Array<{ name: string; description: string }> = []): string {
  const want = terms(question);
  if (want.length === 0) return `Ask about a capability — "can you talk to jira", "how do I review a diff".\n\n${plainPage()}`;

  const scored = catalogue(tools).map((c) => {
    const hay = c.text.toLowerCase();
    let score = 0;
    for (const w of want) {
      if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay)) score += 3;
      else if (hay.includes(w)) score += 1;
    }
    return { c, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.c.label.localeCompare(b.c.label));

  if (scored.length === 0) {
    // The most useful answer this tool has. Say it plainly rather than returning nothing and letting
    // the model fill the silence.
    return `NOTHING IN AYIN MATCHES "${question}".\n\n`
      + 'Searched every slash command, launch flag, key binding and tool. If the operator asked whether '
      + 'ayin can do this, the honest answer is that it cannot — say so rather than suggesting a command '
      + 'that does not exist. `ayin_help` with no arguments lists everything, if you want to be sure.';
  }

  const top = scored.slice(0, 12);
  const lines = top.map(({ c }) => `- [${c.kind}] ${c.label} — ${c.text.slice(c.label.length).trim().slice(0, 200)}`);
  return `Capabilities matching "${question}" (${scored.length} found, best ${top.length} shown):\n\n`
    + `${lines.join('\n')}\n\n`
    + 'Call ayin_help with `topic` set to any of these names for its full page. Anything NOT in this '
    + 'list is not something ayin does — do not invent one.';
}
