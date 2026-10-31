import type { Tool } from '../base.js';
import { getSessionArtifacts, readArtifact } from '../../artifacts.js';
import { tokenCount } from '../../tokenizer.js';
import { activeContextTokens } from '../../llm/manager.js';

const BUDGET_SHARE = 0.4;
const CONTEXT_FALLBACK = 16384;

export const tool: Tool = {
  name: 'full_view',
  icon: '▦',
  description: 'Return results from the call list whole, by id, with the task restated. Use when the list holds what the task needs and you are ready to decide or edit. Holds about 40% of your context window; a result that does not fit is named with its size so you can narrow it and ask again.',
  parameters: [
    { name: 'ids', type: 'string', description: 'Result ids from the call list, space or comma separated, e.g. "t3 t7"', required: true },
  ],
  async execute(params) {
    const raw = params.ids ?? '';
    const ids = [...new Set((raw.match(/\bt?\d{1,4}\b/g) ?? []).map((x) => (x.startsWith('t') ? x : `t${x}`)))];
    if (!ids.length) return 'Error: ids required, e.g. t3 t7';
    const all = getSessionArtifacts();
    const budget = Math.floor((activeContextTokens() || CONTEXT_FALLBACK) * BUDGET_SHARE);
    let spent = 0;
    const shown: string[] = [];
    const missing: string[] = [];
    const over: string[] = [];
    for (const id of ids) {
      const a = all.find((x) => x.id === id);
      if (!a) { missing.push(id); continue; }
      const text = readArtifact(a);
      const n = tokenCount(text);
      if (spent + n > budget) { over.push(`${id}  ${a.tool}(${a.params})  ${n} tokens`); continue; }
      spent += n;
      shown.push(`### ${id} — ${a.tool}(${a.params})  [${n} tokens]\n${text}`);
    }
    const notes: string[] = [];
    if (missing.length) notes.push(`Unknown ids: ${missing.join(', ')}.`);
    if (over.length) {
      notes.push(`Did not fit — the full view holds ${budget} tokens and ${spent} are used:\n${over.join('\n')}\n`
        + 'Narrow these (read_file offset/limit or around=, structure=true then expand_method, a tighter grep) and ask again.');
    }
    const out = [...shown, ...notes].join('\n\n');
    return out || 'Error: nothing to show';
  },
};
