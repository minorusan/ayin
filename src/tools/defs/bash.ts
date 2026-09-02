import type { Tool } from '../base.js';
import { execAsync, resolveAgainstCwd, suggestSimilarPaths } from '../lib.js';
import { existsSync } from 'node:fs';

const CWD = process.cwd();

export const tool: Tool = {
    name: 'bash',
    icon: '💻',
    description: 'Execute a shell command and return its output. Use for: running scripts, builds, installs, git, docker, checking system state. For LISTING a directory use list_dir, for searching use grep/find_files, for reading use read_file — they are bounded and cheaper. Pass cwd instead of `cd X && …`. Commands are killed after 120s by default — raise timeout_seconds for a build, and put anything open-ended (a server, a watcher) in the background yourself.',
    parameters: [
      { name: 'command', type: 'string', description: 'The shell command to execute', required: true },
      { name: 'timeout_seconds', type: 'number', description: 'Kill the command after N seconds (default 120, max 900)', required: false },
      { name: 'cwd', type: 'string', description: 'Run in this directory instead of the session root — use this rather than prefixing `cd X && …`', required: false },
    ],
    async execute(params, ctx) {
      if (!params.command) return 'Error: command required';
      // The command itself is the narration: a card reading `bash 40s — npm run build` is a tool
      // working, where `bash 40s` alone is a tool that might have hung. See `runs.ts`.
      ctx?.onStatus(params.command.replace(/\s+/g, ' ').slice(0, 80));
      // A model-settable budget with a ceiling: 120s kills a Unity compile or a cold npm install, and no
      // budget at all hangs the turn forever on the first foreground server.
      const secs = Number(params.timeout_seconds);
      const timeoutMs = Number.isFinite(secs) && secs > 0 ? Math.min(secs, 900) * 1000 : undefined;
      /**
       * A DIRECTORY PARAMETER, because every call is a fresh shell.
       *
       * `cd X && …` was the single most common shape in the transcripts — 126 of one project's 826 shell
       * calls, and 1129 of another agent's 2569 — and a bare `cd X` is worse than useless: the shell exits,
       * nothing persists, and the model spends a whole round learning nothing. Measured, not assumed.
       *
       * A missing directory is REFUSED rather than silently falling back to the session root: running a
       * build in the wrong tree looks like success and is the harder failure to notice.
       */
      const dir = String(params.cwd ?? '').trim();
      if (dir) {
        const resolved = resolveAgainstCwd(dir);
        if (!existsSync(resolved)) return `Error: cwd not found: ${dir}.${suggestSimilarPaths(dir)}`;
        return execAsync(params.command, { cwd: resolved, timeoutMs, signal: ctx?.signal });
      }
      return execAsync(params.command, { cwd: CWD, timeoutMs, signal: ctx?.signal });
    },
  };
