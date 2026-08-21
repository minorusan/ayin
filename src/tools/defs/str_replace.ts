import type { Tool } from '../base.js';
import { buildUnifiedDiff, diagnoseMiss, resolveAgainstCwd, suggestSimilarPaths } from '../lib.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gateWrite } from '../../entangle/index.js';
import { readBackAfter, requireRead } from '../readGuard.js';

export const tool: Tool = {
    name: 'str_replace',
    description:
      'Make a SURGICAL edit to an existing file: replace ONE exact, unique block of text with new text. ' +
      'PREFER THIS over write_file for editing existing files — it changes only the targeted lines and cannot ' +
      'drop or truncate the rest of the file. `old_str` must match the current file EXACTLY (including whitespace ' +
      'and indentation) and occur EXACTLY ONCE — include a few surrounding lines to make it unique. To insert code, ' +
      'set `new_str` to the matched block plus your addition. Returns a unified diff.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute file path', required: true },
      { name: 'old_str', type: 'string', description: 'Exact existing text to replace (must be unique in the file)', required: true },
      { name: 'new_str', type: 'string', description: 'Replacement text', required: true },
    ],
    async execute(params) {
      if (!params.path || params.old_str === undefined || params.new_str === undefined) {
        return 'Error: path, old_str and new_str required';
      }
      const resolved = resolveAgainstCwd(params.path);
      if (!existsSync(resolved)) return `Error: file not found: ${params.path}.${suggestSimilarPaths(params.path)}`;
      if (params.old_str === params.new_str) return 'Error: old_str and new_str are identical — nothing to change.';
      const before = readFileSync(resolved, 'utf-8');
      const count = before.split(params.old_str).length - 1;
      if (count === 0) return `Error: old_str not found in ${params.path}.${diagnoseMiss(before, params.old_str)}`;
      if (count > 1) return `Error: old_str occurs ${count} times in ${params.path} — include more surrounding lines to make it unique.`;
      /**
       * READ BEFORE EDIT, checked at the LINE the match was found on — not merely "was this file read".
       * A capped read returns at most READ_MAX_LINES, so an unread region of a long file is the normal
       * case, and an edit landing there is precisely the edit-from-memory this refuses. The match index
       * is already known here, which makes the line number free.
       */
      const matchLine = before.slice(0, before.indexOf(params.old_str)).split('\n').length;
      const guard = requireRead(resolved, 'str_replace', {
        atLine: matchLine,
        toLine: matchLine + params.old_str.split('\n').length - 1,
      });
      if (guard) return guard;
      const after = before.replace(params.old_str, params.new_str);
      // Same gate as write_file, on the resulting file rather than the fragment: a surgical edit that
      // adds an undesigned type is the same violation, and checking the fragment alone would miss it.
      const editStop = gateWrite(resolved, after);
      if (editStop) return editStop;
      writeFileSync(resolved, after, 'utf-8');
      // READ BACK AFTER. The diff below is computed from what we MEANT to write; without this line it
      // would report a successful edit even if the write was short, mangled or lost — the one thing a
      // diff built from in-memory strings can never notice.
      const back = readBackAfter(resolved, after);
      if (!back.ok) return `Error: str_replace wrote ${params.path} but the ${back.note}`;
      return `${buildUnifiedDiff(params.path, before, after)}\n(${back.note})`;
    },
  };
