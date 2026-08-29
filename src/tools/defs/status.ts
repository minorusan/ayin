import type { Tool } from '../base.js';
import { statusExecute } from '../status.js';

export const tool: Tool = {
    name: 'status',
    icon: '◔',
    description: 'Check the status of background tool tasks. Shows all tasks that went background (took >20s), their current status (running/completed/failed), how long they have been running, and a preview of their result once done. Call this to check on long-running tools like explore or web_search.',
    parameters: [],
    async execute(params) {
      return statusExecute(params);
    },
  };
