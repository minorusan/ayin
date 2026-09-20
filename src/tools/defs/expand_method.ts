/**
 * ONE METHOD BODY, from a file too big to hold — the other half of `skeletonOf`.
 *
 * The skeleton names every method and the lines it occupies but shows no code, so it has to be
 * followed by something that shows code. That something cannot be `read_file offset=1876`: computing
 * an offset from a range is the byte-paging the skeleton exists to end, and it puts the model back to
 * choosing window sizes by hand.
 *
 * REGISTERING THE READ IS NOT A DETAIL. `readGuard` refuses an edit to lines this process has not
 * returned, and it is right to — a replacement written over unseen text is how content silently
 * disappears. A skeleton returns line NUMBERS and no lines, so without the `recordRead` below the
 * sequence is: read the file, expand the method, edit it, refused — with the refusal advising
 * `read_file around=1876`, which is the loop we just removed, restored by the tool meant to replace it.
 */
import type { Tool } from '../base.js';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { readCap, resolveAgainstCwd, suggestSimilarPaths } from '../lib.js';
import { toolLog, toolStructure } from '../runtime.js';
import { locate } from '../skeleton.js';
import { recordRead } from '../readGuard.js';

/** Calls listed under a body. The body itself is right there, so this is an index, not the content. */
const CALLS_SHOWN = 12;

/**
 * Lines of a body returned whole before it is windowed like any other long read.
 *
 * A method is usually the right unit; sometimes it is a monster. `Axes.hist` is 536 lines, and
 * returning all of it produced a reply large enough that the model began PAGING THROUGH THE ARTIFACT
 * FILE OF ITS OWN EXPANSION — `read_file t6-expand_method.txt offset=180` — which is the byte-hunting
 * this tool exists to end, one level of indirection deeper. Measured on a live run.
 *
 * So a body past this is opened at its head with its span stated, and the model is told how to reach
 * the rest by line. Nothing is hidden; it is simply not all delivered at once.
 */
const BODY_LINES_MAX = 160;

/**
 * 160 WAS PULLED FROM NOWHERE AND IT HID THE ANSWER.
 *
 * A measured case: a 537-line method, and the one-line fix inside it 323 lines down. Capped at 160
 * the reply showed only the first third — the right method, the wrong half — and the model spent nine reads and
 * four `sed` calls hunting for the rest of a body it had just asked for by name. The cap meant to stop
 * it paging through an artefact made it page through the file instead.
 *
 * The honest bound is the one a `read_file` would have obeyed: `readCap()`, which is derived from the
 * served model's context (1,250 lines at 40k). A 537-line method fits inside that with room to spare,
 * so a method that fits the window is returned whole and only a genuine monster is windowed.
 */
async function bodyBudget(): Promise<number> {
  return Math.max(BODY_LINES_MAX, await readCap());
}

export const tool: Tool = {
  name: 'expand_method',
  icon: '▤',
  description: 'Return ONE method body from a file, by name, with the lines it occupies and what it touches. Use after a read of a large file returned its structure instead of its text: the structure names each method and its line range, this returns the code. Takes Class.method when several classes declare the same name (a bare name that matches more than one is refused, listing them). Counts as having read those lines, so an edit to them is allowed.',
  parameters: [
    { name: 'path', type: 'string', description: 'File the method is declared in', required: true },
    { name: 'method', type: 'string', description: 'Class.method, e.g. "XAxis.set_view_interval" — or a bare method name when it is unique in the file', required: true },
  ],
  async execute(params) {
    const { path, method } = params;
    if (!path?.trim() || !method?.trim()) return 'Error: path and method required';
    const abs = resolveAgainstCwd(path);
    if (!existsSync(abs)) return `Error: path not found: ${path}.${suggestSimilarPaths(path)}`;
    if (!toolStructure().handles(abs)) {
      return `Error: no structural parser for ${path} — read it with read_file instead.`;
    }

    const source = readFileSync(abs, 'utf-8');
    const rows = source.split('\n');
    const hits = locate(source, abs, method);

    if (!hits.length) {
      const near = locate(source, abs, method.includes('.') ? method.slice(method.lastIndexOf('.') + 1) : method);
      return near.length
        ? `Error: ${method} is not declared in ${path}. Declared as: ${near.map((h) => `${h.type.name}.${h.member.name}`).join(', ')}.`
        : `Error: ${method} is not declared in ${path}. Read the file to see its structure.`;
    }
    /**
     * AMBIGUITY IS REFUSED, NEVER RESOLVED BY ORDER.
     *
     * `axis.py` declares `get_view_interval` on four classes with four different bodies. Returning the
     * first would hand over `Tick`'s when the model meant `XAxis`'s, and the body it gets back looks
     * entirely plausible — a subclass override of the same signature. The edit then lands in the wrong
     * class and the test still fails, with nothing on screen to say why.
     */
    if (hits.length > 1) {
      return `Error: "${method}" is declared ${hits.length} times in ${path} — name the class:\n`
        + hits.map((h) => `  ${h.type.name}.${h.member.name}   lines ${h.member.line ?? "?"}-${h.member.endLine ?? "?"}`).join('\n');
    }

    const { type, member } = hits[0];
    if (member.line === undefined || member.endLine === undefined) {
      return `Error: ${type.name}.${member.name} has no recorded line range in ${path} — read the file instead.`;
    }
    /**
     * THE PARSER AND THE FILE MUST AGREE. If the range no longer starts at the declaration the parser
     * found, something is out of step — a stale cache, an edit between calls, a parser bug — and the
     * honest answer is to say so, not to return whatever lives at those numbers now.
     */
    const head = rows[member.line - 1] ?? '';
    if (member.sig && !head.includes(member.name)) {
      return `Error: ${path} line ${member.line} does not declare ${member.name} — it reads "${head.trim().slice(0, 80)}". `
        + `The file changed since it was parsed; read it again.`;
    }

    // Hoisted past the guard: TypeScript drops the narrowing on a mutable property inside a closure,
    // and `numbered` below maps over the body.
    const from = member.line;
    const to = member.endLine;
    /**
     * A MONSTER METHOD IS STILL A LONG READ. See `BODY_LINES_MAX`.
     *
     * The span RECORDED is what was actually shown, never the whole method — `readGuard` refuses an
     * edit to lines this process did not return, and recording the full range for a truncated reply
     * would licence an edit to text the model never saw. That is the exact lie the guard exists to
     * prevent, and it would have been invisible: the edit would simply land.
     */
    const budget = await bodyBudget();
    const shownTo = Math.min(to, from + budget - 1);
    const clipped = shownTo < to;
    const body = rows.slice(from - 1, shownTo);
    recordRead(abs, [from, shownTo], rows.length);
    toolLog().info('expand_method', {
      path: relative(process.cwd(), abs) || path,
      member: `${type.name}.${member.name}`,
      lines: `${member.line}-${member.endLine}`,
    });

    const facts = toolStructure().facts(abs, rows.slice(from, to));
    const numbered = body.map((l, i) => `${from + i}\t${l}`).join('\n');
    const notes: string[] = [];
    if (facts?.assigns.length) notes.push(`assigns: ${facts.assigns.join(', ')}`);
    if (facts?.calls.length) {
      const rest = facts.calls.length > CALLS_SHOWN ? ` (+${facts.calls.length - CALLS_SHOWN} more)` : '';
      notes.push(`calls: ${facts.calls.slice(0, CALLS_SHOWN).join(', ')}${rest}`);
    }
    const title = clipped
      ? `${type.name}.${member.name} — ${path} lines ${from}-${to} of ${rows.length}, showing ${from}-${shownTo} `
        + `(${to - shownTo} more lines in this method)`
      : `${type.name}.${member.name} — ${path} lines ${from}-${to} of ${rows.length}`;
    const more = clipped
      ? `\n[Showing ${shownTo - from + 1} of ${to - from + 1} lines. For the rest: `
        + `read_file(path=${path}, offset=${shownTo + 1}, limit=${Math.min(budget, to - shownTo)}).]`
      : '';
    return `${title}\n${numbered}\n`
      + (notes.length ? `\n${notes.join('\n')}\n` : '')
      + `\n[Lines ${from}-${shownTo} now count as read — str_replace within them is allowed.]${more}`;
  },
};
