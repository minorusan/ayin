import type { Tool } from '../base.js';
import { exploreExecute } from '../explore.js';

export const tool: Tool = {
    name: 'explore',
    description: 'Find and read code in the codebase. Spawns a sub-agent that iteratively runs read-only commands (ls, cat, grep, git show/log/blame, find) to locate files and extract content. Use this when you need to find an unknown file, read a method body, find where a field is assigned, list callers, or run git log. Returns extracted code/data as text. NOTE: explore only FINDS and READS — it does not reason or explain. Ask it factual questions like "find X" or "show Y", not "why does X happen".',
    parameters: [
      { name: 'question', type: 'string', description: 'A factual question asking explore to FIND or READ something. Good: "Find ClassName.cs and show MethodName body", "Find where _field is set to null", "Run git log on path/file.cs". Bad: "Why does X happen", "What triggers the error".', required: true },
      { name: 'context', type: 'string', description: 'Optional extra context — file paths, class names, error messages, stack frames', required: false },
    ],
    async execute(params) {
      return exploreExecute(params);
    },
  };
