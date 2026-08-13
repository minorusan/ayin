import type { Tool } from '../base.js';
import { execAsync } from '../lib.js';

const CWD = process.cwd();

export const tool: Tool = {
    name: 'bash',
    description: 'Execute a shell command and return its output. Use for: running scripts, installing packages, git commands, listing files, checking system state. Commands are killed after 120s by default — raise timeout_seconds for a build, and put anything open-ended (a server, a watcher) in the background yourself.',
    parameters: [
      { name: 'command', type: 'string', description: 'The shell command to execute', required: true },
      { name: 'timeout_seconds', type: 'number', description: 'Kill the command after N seconds (default 120, max 900)', required: false },
    ],
    async execute(params) {
      if (!params.command) return 'Error: command required';
      // A model-settable budget with a ceiling: 120s kills a Unity compile or a cold npm install, and no
      // budget at all hangs the turn forever on the first foreground server.
      const secs = Number(params.timeout_seconds);
      const timeoutMs = Number.isFinite(secs) && secs > 0 ? Math.min(secs, 900) * 1000 : undefined;
      return execAsync(params.command, { cwd: CWD, timeoutMs });
    },
  };
