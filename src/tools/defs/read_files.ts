/**
 * read_files — several files in ONE call, under one budget, split proportionally.
 *
 * WHY IT IS NOT A LOOP OVER `read_file`. Orientation reads come in sets: the module, the type it
 * imports, the test that pins it. One per call is one LLM round per file, and by the fourth round the
 * first file has been compressed out of the window it was read into. This returns the set together,
 * which is also the only way the budget can be shared — and a shared budget is the whole point.
 *
 * PROPORTIONAL, NOT FIRST-COME. A fixed per-file cap spends the same on a 12-line barrel file as on
 * the 900-line service the question is actually about; a first-come budget returns file one whole and
 * file four as a stub, which depends on argument order rather than on anything real. So each file gets
 * a share of the total in proportion to its length, floored so no file is reduced to a title, and any
 * share a small file does not need is handed back and re-split among the ones that were clipped —
 * files under their share cost nothing, which is the common case for a set of small modules.
 *
 * THE CAP IS THE CONTEXT, through the one door every reader uses (`lib.ts#readCap`). A self-hosted
 * model runs at 16k by default (`AYIN_OLLAMA_CTX`) and a 2,000-line reply is the turn's whole window;
 * `gpt-5.6-luna` was measured accepting ~1.1M tokens, where the same caution is a round wasted asking
 * for the rest of a file it could have been handed. Asked per call, never cached — the answer changes
 * with `/model`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — each of these is `read_file`'s job, and duplicating it here would
 * be a second copy to drift:
 *   · no image attachment. An image goes to the NEXT llm call, so a bulk read would attach ten of them
 *     to one request and blow it up; images are reported and skipped.
 *   · no corpus injection. One block per file is the payload again, on a call whose entire purpose is
 *     to fit several files inside one budget.
 *   · no sliding window, no `around`. A set read is orientation; a window is a follow-up, and the
 *     follow-up tool already exists.
 *
 * THE READ GUARD IS ARMED PER FILE, with the range ACTUALLY RETURNED. A clipped file must not license
 * an edit in the part that never came back — the same rule `read_file` states, and the reason this
 * tool records each span itself rather than recording "all of it".
 */

import type { Tool } from '../base.js';
import { readCap, resolveAgainstCwd, suggestSimilarPaths } from '../lib.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { isImagePath } from '../../image.js';
import { recordRead } from '../readGuard.js';
import { snapEnd } from '../readWindow.js';

/** How many files one call may name. Past this it is a directory listing, not a read. */
const MAX_FILES = 12;

/** No file is worth returning as a title and three lines. Below this, show it whole or not at all. */
const MIN_SHARE = 40;

interface Candidate {
  given: string;
  resolved: string;
  lines: string[];
  total: number;
  bytes: number;
  share: number;
}

/**
 * Split `total` lines across the candidates in proportion to their length.
 *
 * A FLOOR FIRST, THEN PROPORTIONAL TOP-UPS. Every file gets `MIN_SHARE` (or its whole length, if
 * shorter) so nothing comes back as a title and three lines; what remains is then handed out in
 * proportion to what each file still NEEDS, not to its total size. Repeating that is what gives the
 * budget back: a file that fills up leaves the pool, and the next round re-splits the remainder among
 * the files still short — so a set of small modules costs only what they are, and the long file the
 * question is actually about absorbs the rest.
 *
 * IN PROPORTION TO REMAINING NEED, and shares ACCUMULATE. The first version re-split against total
 * size and ASSIGNED the result, so the second round replaced a 333-line share with a 40-line floor and
 * left 240 of 400 budgeted lines unspent — the biggest file in the set came back smaller than the
 * smallest. Measured, on the four files this repo happened to have open.
 *
 * TOO MANY FILES FOR THE FLOOR is its own case: with a budget under `files × MIN_SHARE` an equal split
 * is the only honest answer, because there is nothing left to be proportional with.
 */
function allocate(files: Candidate[], total: number): void {
  for (const f of files) f.share = 0;
  const live = files.filter((f) => f.total > 0);
  if (!live.length) return;

  if (total < live.length * MIN_SHARE) {
    const each = Math.max(1, Math.floor(total / live.length));
    for (const f of live) f.share = Math.min(f.total, each);
    return;
  }

  let pool = total;
  for (const f of live) {
    const floor = Math.min(f.total, MIN_SHARE);
    f.share = floor;
    pool -= floor;
  }

  let open = live.filter((f) => f.share < f.total);
  while (pool > 0 && open.length) {
    const need = open.reduce((n, f) => n + (f.total - f.share), 0);
    if (need <= 0) break;
    let spent = 0;
    for (const f of open) {
      if (pool - spent <= 0) break;
      const want = f.total - f.share;
      const give = Math.min(want, pool - spent, Math.max(1, Math.floor((want / need) * pool)));
      f.share += give;
      spent += give;
    }
    if (spent <= 0) break;
    pool -= spent;
    open = open.filter((f) => f.share < f.total);
  }
}

export const tool: Tool = {
  name: 'read_files',
  icon: '📚',
  description:
    'Read SEVERAL files in one call, with line numbers. Use it when a question spans a set — a module, '
    + 'the type it imports, the test that pins it — instead of one read_file per file. The whole reply '
    + 'shares ONE line budget, split between the files in proportion to their length, so a long file gets '
    + 'more of it than a short one and a file that fits whole costs only what it needs. Every clip says '
    + 'which lines were withheld; read_file that one file to see the rest. Images and binaries are '
    + 'reported and skipped, never attached.',
  parameters: [
    { name: 'paths', type: 'string', description: `Absolute file paths, comma- or newline-separated. At most ${MAX_FILES}.`, required: true },
    { name: 'limit', type: 'number', description: 'Total lines for the whole reply, across all files. Defaults to the context the served model has.', required: false },
  ],

  async execute(params) {
    if (!params.paths) return 'Error: paths required — comma-separated absolute file paths';
    const given = params.paths.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
    if (!given.length) return 'Error: paths required — comma-separated absolute file paths';
    if (given.length > MAX_FILES) {
      return `Error: ${given.length} paths — read_files takes at most ${MAX_FILES}. `
        + `Past that it is a directory listing, not a read: use list_dir or grep to narrow first.`;
    }

    // The same cap one `read_file` gets — shared across the set rather than granted per file, which is
    // the whole reason to call this instead of reading them one at a time.
    const capLines = await readCap();
    const askedLimit = parseInt(params.limit || '0', 10);
    const total = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(askedLimit, capLines) : capLines;

    const ok: Candidate[] = [];
    const skipped: string[] = [];

    for (const g of given) {
      const resolved = resolveAgainstCwd(g);
      if (!existsSync(resolved)) { skipped.push(`${g} — not found.${suggestSimilarPaths(g)}`); continue; }
      try {
        if (statSync(resolved).isDirectory()) { skipped.push(`${g} — is a directory; use list_dir`); continue; }
      } catch { skipped.push(`${g} — unreadable`); continue; }
      const ext = extname(resolved).toLowerCase();
      if (ext === '.pdf') { skipped.push(`${basename(resolved)} — PDF; rasterize to PNG and use read_file`); continue; }
      // An image attaches to the NEXT llm call. A bulk read must never do that ten times over.
      if (isImagePath(resolved)) { skipped.push(`${basename(resolved)} — image; read_file it alone to attach it`); continue; }
      let raw: Buffer;
      try { raw = readFileSync(resolved); } catch (e) {
        skipped.push(`${g} — ${e instanceof Error ? e.message : String(e)}`); continue;
      }
      if (raw.includes(0)) {
        skipped.push(`${basename(resolved)} — binary (${(raw.length / 1024).toFixed(1)} KB); use bash (file, strings, xxd)`);
        continue;
      }
      const lines = raw.toString('utf-8').split('\n');
      ok.push({ given: g, resolved, lines, total: lines.length, bytes: raw.length, share: 0 });
    }

    if (!ok.length) {
      return `Error: nothing readable.\n${skipped.map((s) => `  ${s}`).join('\n')}`;
    }

    allocate(ok, total);

    const blocks: string[] = [];
    let spent = 0;
    /**
     * THE BUDGET IS SPENT AS IT GOES, not assumed to match the allocation.
     *
     * `snapEnd` moves a window up to `BOUNDARY_SLACK` lines EITHER WAY to avoid ending mid-construct,
     * so a file can come back a little over its share — deliberately, and `read_file` does the same.
     * Left unaccounted that turns into a header reading "318 of 300", which is a contradiction the
     * reader has to resolve. So an overshoot is charged to what remains and a later file gets less;
     * a file whose remaining share has been spent is reported rather than returned empty.
     */
    let remaining = total;
    for (const f of ok) {
      const share = Math.min(f.share, remaining);
      if (share <= 0) {
        skipped.push(`${basename(f.resolved)} — budget spent by the files above; read_file this path`);
        continue;
      }
      // Snapped to a structural break so a clipped file does not end mid-function — the same reason
      // `read_file` snaps, and the same helper, so the two cannot disagree about where a break is.
      const end = share >= f.total ? f.total : snapEnd(f.lines, 1, Math.max(1, share), f.total);
      const shown = f.lines.slice(0, end);
      const bytes = f.bytes >= 1024 ? `${(f.bytes / 1024).toFixed(1)} KB` : `${f.bytes} B`;
      const head = end >= f.total
        ? `── ${f.resolved} (all ${f.total} lines, ${bytes})`
        : `── ${f.resolved} (lines 1-${end} of ${f.total}, ${bytes} — ${f.total - end} unread; read_file this path for the rest)`;
      blocks.push(`${head}\n${shown.map((l, i) => `${i + 1}\t${l}`).join('\n')}`);
      spent += end;
      remaining -= end;
      // Armed with what actually came back, never with the whole file. See the header.
      recordRead(f.resolved, [1, end], f.total);
    }

    const header = `${blocks.length} file(s), ${spent} lines (budget ${total})`;
    const skipNote = skipped.length ? `\n\nskipped:\n${skipped.map((s) => `  ${s}`).join('\n')}` : '';
    return `${header}\n\n${blocks.join('\n\n')}${skipNote}`;
  },
};
