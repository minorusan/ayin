import type { Tool } from '../base.js';
import { buildUnifiedDiff } from '../lib.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gateWrite } from '../../entangle/index.js';
import { readBackAfter, requireRead } from '../readGuard.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROMPTS_FILE = join(homedir(), '.ayin-cli', 'prompts.json');

export const tool: Tool = {
    name: 'write_file',
    icon: '✎',
    description: 'Write content to a file. Creates parent directories if needed. Use for creating new files or completely rewriting existing ones.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute file path', required: true },
      { name: 'content', type: 'string', description: 'Complete file content to write', required: true },
    ],
    async execute(params) {
      if (!params.path || params.content === undefined) return 'Error: path and content required';
      if (params.path === PROMPTS_FILE) {
        try {
          JSON.parse(params.content);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `Error: refusing to write invalid JSON to ${PROMPTS_FILE}: ${message}`;
        }
      }
      // ENTANGLED: check the surface this write would declare BEFORE it lands. A violation stops the
      // turn rather than being denied-and-retried — a denial invites the workaround (rename it, move it,
      // inline it into a 200-line method), which is the exact behaviour the gate exists to prevent.
      const stop = gateWrite(params.path, params.content);
      if (stop) return stop;
      /**
       * READ BEFORE OVERWRITE. Creating a file needs no read — there is nothing to have read — but
       * replacing one does, and `whole: true` demands the WHOLE file was seen, because that is what is
       * being replaced. This is the enforcement of the warning the banner below only prints after the
       * fact: a file regenerated from a partial read silently loses whatever was never returned.
       */
      const guard = requireRead(params.path, 'write_file', { whole: true });
      if (guard) return guard;
      const existed = existsSync(params.path);
      const before = existed ? readFileSync(params.path, 'utf-8') : '';
      mkdirSync(dirname(params.path), { recursive: true });
      writeFileSync(params.path, params.content, 'utf-8');
      // READ BACK AFTER: the diff is built from in-memory strings and cannot see a write that did not
      // land as asked. Reported on both paths — a create that produced nothing is the failure mode that
      // matters most, since there is no previous content to notice missing.
      const back = readBackAfter(params.path, params.content);
      if (!back.ok) return `Error: write_file wrote ${params.path} but the ${back.note}`;
      const diff = buildUnifiedDiff(params.path, before, params.content);
      if (!existed) return `Created ${params.path} (${params.content.split('\n').length} lines, ${back.note}).\n${diff}`;
      // An overwrite is visible in the diff — but a full-rewrite diff of a large file is precisely the
      // result that overflows the window, so the fact that content was REPLACED (and how much of it
      // disappeared) is stated up front where no clip can reach it. Regenerating a file from memory and
      // silently dropping half of it is the failure write_file is warned about in its own description.
      const oldLines = before.split('\n').length;
      const newLines = params.content.split('\n').length;
      const shrank = oldLines >= 20 && newLines < oldLines * 0.6;
      const banner = shrank
        ? `OVERWROTE ${params.path}: ${oldLines} lines → ${newLines}. That is ${oldLines - newLines} lines GONE — ` +
          `if you regenerated this file from memory rather than editing it, restore the missing part or use str_replace instead.`
        : `Overwrote ${params.path} (${oldLines} lines → ${newLines}).`;
      return `${banner} ${back.note}\n${diff}`;
    },
  };
