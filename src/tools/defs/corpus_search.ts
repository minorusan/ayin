import type { Tool } from '../base.js';
import { corpusSearch } from '../../indulge/inject.js';

/**
 * The PULL half of retrieval. `read_file` pushes what is known about a file; this is how the agent
 * asks for anything else — which is the difference between a corpus that costs attention on every
 * turn and one that costs it only when consulted.
 *
 * Lexical for now: it matches the question text, the file path and the answer body. Real semantic
 * search is Phase 2 (embeddings); pretending to have it now would return confident nonsense for
 * anything not sharing words with the query, which is worse than an honest keyword match.
 */
export const tool: Tool = {
  name: 'corpus_search',
  icon: '📚',
  description:
    'Search what a previous `ayin indulge` run already answered about THIS repo — questions, answers and the code they cite. '
    + 'Use it before investigating something from scratch: the answer may already exist, with citations. '
    + 'Keyword match over question text, file paths and answers (not semantic). Returns nothing if no corpus has been built.',
  parameters: [
    { name: 'query', type: 'string', description: 'Words to look for — a file path, a symbol name, or what you want to know', required: true },
    { name: 'limit', type: 'number', description: 'Max results (default 3, max 8)', required: false },
  ],
  async execute(params) {
    if (!params.query?.trim()) return 'Error: query required';
    const asked = parseInt(params.limit || '3', 10);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 8) : 3;
    return await corpusSearch(process.cwd(), params.query, limit);
  },
};
