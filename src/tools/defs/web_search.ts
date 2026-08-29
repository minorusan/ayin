import type { Tool } from '../base.js';
import { webSearch } from '../web-search.js';

export const tool: Tool = {
    name: 'web_search',
    icon: '◎',
    description: 'Search the web for documentation, APIs, tutorials, error messages, or any information not available locally. Returns readable content extracted from the top result pages, with sources (SearXNG → DuckDuckGo).',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
    ],
    async execute(params) {
      if (!params.query) return 'Error: query required';
      return webSearch(params.query);
    },
  };
