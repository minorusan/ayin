import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BaseTool } from '../base.js';
import { resolveAgainstCwd, suggestSimilarPaths } from '../lib.js';
import { noteEdit } from '../readGuard.js';
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
  readonly icon = '✏️';
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
    const stripped = stripFence(answer);
    if (!stripped.trim()) return `NO CHANGE to ${file} — the model returned nothing. The file is untouched.`;

    /**
     * THE FILE KEEPS THE TRAILING NEWLINE IT CAME WITH.
     *
     * A model's reply does not end with one, and `stripFence`'s own `\n?```$` eats it when the reply
     * was fenced — so this wrote every edited file one byte short of how it found it. Silent, and
     * permanent: git renders it as `\ No newline at end of file` on a line nobody touched, POSIX says
     * a text file ends with a newline, and an editor that reformats later produces a SECOND spurious
     * diff putting it back.
     *
     * Measured on a real session: an agent asked to revert its own test edit to a Unity prefab did
     * revert the value, and left the file dirty anyway — one stripped newline — then tried
     * `git checkout --` to clean up and was refused by the permission guard. The operator was left
     * with a modified asset nobody had asked to change.
     *
     * Normalised BEFORE the equality check below, so an edit whose only difference was this byte now
     * correctly reports NO CHANGE instead of writing one.
     */
    const after = matchTrailingNewline(before, stripped);

    if (after === before) {
      return `NO CHANGE to ${file}. The edit was not applied: it is either already present, or it names `
        + 'something this file does not contain. Read the file if you need to see why, or restate the edit.';
    }

    // THE MODEL STOPPED EARLY AND WE WERE ABOUT TO WRITE IT.
    //
    // Measured: an 8,164-line source file with one line to change. The model was handed the
    // whole file and asked for the whole file back; it returned 833 lines and this function wrote them.
    // 7331 lines of a core module deleted, a plausible-looking diff, and QA passed it. A file that
    // cannot survive the round trip must not be edited this way at all — `str_replace` exists for it.
    const cut = truncationOf(before, after);
    if (cut) {
      toolLog().warn('perform_edit_truncated', { file, ...cut });
      return `REFUSED to write ${file} — the edit came back TRUNCATED, not edited.\n\n`
        + `The file has ${cut.beforeLines} lines; the model returned ${cut.afterLines}, and the end of the `
        + `file is missing (${cut.removed} lines dropped with nothing replacing them). That is a model that `
        + `ran out of room, not a change you asked for. The file is UNTOUCHED.\n\n`
        + `Use str_replace on this file: it edits a named region and cannot drop the rest.`;
    }

    try { writeFileSync(path, after); } catch (err) {
      return `Error: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`;
    }
    const diff = lineDiff(before, after);
    noteEdit(path, diff);
    toolLog().info('perform_edit_applied', { file, beforeBytes: String(before.length), afterBytes: String(after.length) });
    return `Edit was made to ${file} with changes:\n\n${diff}`;
  }
}

/**
 * Did the model TRUNCATE the file rather than edit it? Null when the change looks like a real edit.
 *
 * THE DISCRIMINATOR IS THE TAIL, not the size. A legitimate deletion — "drop the deprecated block" —
 * removes a region and leaves the rest of the file after it intact, so the common tail is non-empty.
 * A model that ran out of room stops mid-file: everything from some point to the end is simply gone,
 * so the common tail is ZERO and nothing was added in place of what went missing.
 *
 * Both conditions are required, which is what keeps this from blocking honest work: deleting the last
 * function in a file is a zero tail, but it does not also drop two-fifths of the file. The line floor
 * keeps it away from small files, where a rewrite is cheap, obviously correct, and not the failure
 * mode being guarded against.
 */
export function truncationOf(before: string, after: string):
  { beforeLines: string; afterLines: string; removed: string } | null {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length < MIN_LINES_TO_GUARD) return null;

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const removed = a.length - head - tail;
  const added = b.length - head - tail;
  if (tail !== 0) return null;                       // the end of the file survived — a real edit
  if (added >= removed) return null;                 // it replaced what it removed — a real edit
  if (b.length > a.length * MAX_SHRINK) return null; // barely shorter — a real edit

  return { beforeLines: String(a.length), afterLines: String(b.length), removed: String(removed - added) };
}

/** Below this a whole-file rewrite is cheap and reliable; the failure being guarded is a LARGE file. */
const MIN_LINES_TO_GUARD = 200;
/** Keeping under three-fifths of the file while losing its end is not an edit anyone asked for. */
const MAX_SHRINK = 0.6;

/** ```lang … ``` around the whole answer, and nothing else. A fence INSIDE the file is left alone. */
/**
 * Give `after` the same trailing-newline state as `before`.
 *
 * Exported for the gate: this is a round-trip invariant, not a formatting preference, and the whole
 * point is that it holds in both directions — a file that did NOT end with a newline must not gain
 * one either, or the next edit reports a change nobody made.
 */
export function matchTrailingNewline(before: string, after: string): string {
  const had = /\n$/.test(before);
  const has = /\n$/.test(after);
  if (had && !has) return `${after}\n`;
  if (!had && has) return after.replace(/\n+$/, '');
  return after;
}

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
  /**
   * A FEW LINES EITHER SIDE, because a changed line alone does not say WHERE it landed.
   *
   * `@@ line 198 @@ -0 +1` and one `+` line is a true statement that answers the wrong question: the
   * caller wants to know whether the insert went inside the right method, above the right field,
   * after the right brace. Reported verbatim — *"doesn't show surrounding lines. I had to do a
   * follow-up read_file to verify placement"* — and that follow-up read is the exact re-send the
   * edit-note mechanism in `readGuard.ts` exists to avoid. Three lines here are cheaper than a whole
   * file there.
   *
   * Taken from BEFORE, so the context is the file as it was in the caller's head, and marked with a
   * space like a unified diff so it cannot be mistaken for part of the change.
   */
  const CONTEXT = 3;
  const context = (from: number, to: number): string[] =>
    a.slice(Math.max(0, from), Math.max(0, to)).map((l) => `  ${l}`);
  const show = (lines: string[], sign: string): void => {
    if (lines.length <= maxLines) { out.push(...lines.map((l) => `${sign} ${l}`)); return; }
    out.push(...lines.slice(0, maxLines).map((l) => `${sign} ${l}`));
    out.push(`${sign} … ${lines.length - maxLines} more line(s)`);
  };
  out.push(...context(head - CONTEXT, head));
  show(removed, '-');
  show(added, '+');
  out.push(...context(a.length - tail, a.length - tail + CONTEXT));
  return out.join('\n');
}

export const tool = new PerformEdit();
