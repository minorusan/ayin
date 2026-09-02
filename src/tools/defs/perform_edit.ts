import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BaseTool } from '../base.js';
import { resolveAgainstCwd, suggestSimilarPaths } from '../lib.js';
import { toolLlm, toolLog } from '../runtime.js';

/**
 * `perform_edit` — say what you want changed; a model reads the file and places it.
 *
 * WHY THIS EXISTS BESIDE `str_replace`. `str_replace` is exact and unforgiving: the caller must already
 * know the file's precise bytes, so an agent using it reads the file, holds it in context, composes an
 * anchor, and burns a round when the anchor is off by a space. That is the right primitive for an agent
 * that is INSIDE the file's context and the wrong one for an arbitrator that is not — and an
 * arbitrator holding twenty files' exact contents is an arbitrator with no room left to arbitrate.
 *
 * So the division of labour is: the caller states the CHANGE, this tool works out the PLACE. One model
 * call, given the whole file and the instruction, returning the whole file.
 *
 * NO TOOLS INSIDE IT. It is one call, not a loop — `toolLlm().ask` declares no tools, so the model
 * cannot wander off reading other files. The only thing it can do is return this file, edited.
 *
 * AND THE RESULT IS DETERMINISTIC, WHICH IS THE WHOLE POINT. A model saying "I made the change" is not
 * evidence; a diff is. The file is snapshotted before, compared after, and what comes back to the caller
 * is the actual line-level change — or "NO CHANGE", which is a fact the caller has to act on rather than
 * a claim it has to trust. This is the failure mode ayin has measured repeatedly: a model reporting work
 * it did not do reads exactly like a model reporting work it did.
 */
class PerformEdit extends BaseTool {
  readonly name = 'perform_edit';
  readonly icon = '✐';
  readonly description =
    'Make a change to ONE file by describing it. Pass `file` and `edit` — the edit in plain words, with '
    + 'the code to add or the behaviour to change. A model reads the file and places the change; you do '
    + 'not need the file\'s exact current text and you do not need to have read it. Returns the REAL diff '
    + 'of what changed on disk, or NO CHANGE when the edit could not be applied. Use this instead of '
    + 'reading a file and composing an exact replacement yourself.';

  readonly parameters = [
    { name: 'file', type: 'string', description: 'Path to the file to change. It must already exist.', required: true },
    {
      name: 'edit',
      type: 'string',
      description: 'What to change, in plain words — include the code to insert or the exact behaviour wanted. Say enough that someone who has not read this conversation could make the change.',
      required: true,
    },
  ];

  /** `prompts/perform-edit/` beside the build — resolved from this module, so no import leaves `tools/`. */
  readonly promptsSourceDir = fileURLToPath(new URL('../../../prompts/perform-edit', import.meta.url));

  async execute(params: Record<string, string>): Promise<string> {
    const file = String(params.file ?? '').trim();
    const edit = String(params.edit ?? '').trim();
    if (!file) return 'Error: file required';
    if (!edit) return 'Error: edit required — describe the change';

    const path = resolveAgainstCwd(file);
    if (!existsSync(path)) return `Error: file not found: ${file}.${suggestSimilarPaths(file)}`;

    let before: string;
    try { before = readFileSync(path, 'utf8'); } catch (err) {
      return `Error: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`;
    }

    const answer = await toolLlm().ask([{
      role: 'user',
      content: this.prompt('apply', { PATH: file, CONTENT: before, EDIT: edit }),
    }]);

    // A FENCE IS THE ONE THING IT RELIABLY ADDS. Stripping it is not "cleaning up the model's output"
    // — an unstripped ``` written to disk is a syntax error in every language ayin edits.
    const after = stripFence(answer);
    if (!after.trim()) return `NO CHANGE to ${file} — the model returned nothing. The file is untouched.`;

    if (after === before) {
      return `NO CHANGE to ${file}. The edit was not applied: it is either already present, or it names `
        + 'something this file does not contain. Read the file if you need to see why, or restate the edit.';
    }

    try { writeFileSync(path, after); } catch (err) {
      return `Error: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`;
    }
    toolLog().info('perform_edit_applied', { file, beforeBytes: String(before.length), afterBytes: String(after.length) });
    return `Edit was made to ${file} with changes:\n\n${lineDiff(before, after)}`;
  }
}

/** ```lang … ``` around the whole answer, and nothing else. A fence INSIDE the file is left alone. */
export function stripFence(text: string): string {
  const t = text.replace(/^﻿/, '');
  const m = /^\s*```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  return m ? m[1] : t;
}

/**
 * The change, as lines. Deliberately tiny — this is EVIDENCE for the caller, not a patch to apply, so
 * it needs to be readable and honest rather than minimal. Long runs are summarised by their count so a
 * whole-file rewrite does not return the whole file a second time.
 */
export function lineDiff(before: string, after: string, maxLines = 60): string {
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim the common head and tail; what is left is the changed region.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const out: string[] = [`@@ line ${head + 1} @@  -${removed.length} +${added.length}`];
  const show = (lines: string[], sign: string): void => {
    if (lines.length <= maxLines) { out.push(...lines.map((l) => `${sign} ${l}`)); return; }
    out.push(...lines.slice(0, maxLines).map((l) => `${sign} ${l}`));
    out.push(`${sign} … ${lines.length - maxLines} more line(s)`);
  };
  show(removed, '-');
  show(added, '+');
  return out.join('\n');
}

export const tool = new PerformEdit();
