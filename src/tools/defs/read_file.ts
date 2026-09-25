import type { Tool } from '../base.js';
import { readCap, resolveAgainstCwd, suggestSimilarPaths } from '../lib.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { addPendingImage, isImagePath, preprocessImage } from '../../image.js';
import { corpusBlockFor, chunksForFile } from '../../indulge/inject.js';
import { log } from '../../log.js';
import { attributeFile } from '../../indulge/attribution.js';
import { coverage, recordRead, takeEditNotes } from '../readGuard.js';
import { skeletonOf } from '../skeleton.js';
import { AROUND_DEFAULT, centeredWindow, clampSpan, describeSpans, slideWindow, snapEnd, snapStart, spanLines, unreadRanges } from '../readWindow.js';

/** How much of a first big-file read is spent on the END of the file rather than its top. */
const OUTLINE_TAIL_LINES = 40;

/**
 * Reads of ONE too-big file before its structure is offered instead of another window.
 *
 * THE FEATURE WAS UNREACHABLE. The structure view triggered only on a PARAM-FREE read, on the
 * principle that a model which knows where it is going should not be handed a map. Measured on a real
 * run: of five reads of a 2,486-line file, EVERY ONE carried an explicit offset. The model never opens
 * a file — it greps for a definition, gets a line number, reads a window around it, does not find
 * enough, and greps again with a slightly different pattern. 28 greps, 5 windowed reads, no edit. The
 * map that answers its question in one call sat behind a door it never knocked on.
 *
 * Two is deliberate paging. Three windows into the same large file is hunting, and hunting is the
 * thing structure replaces.
 */
const HUNT_READS = 3;

/**
 * Windowed reads per file this session, for `HUNT_READS`.
 *
 * Counted here rather than derived from `coverage()` spans: adjacent windows MERGE into one span, so
 * three reads of the same neighbourhood look like one region and the signal disappears exactly where
 * it matters most. The count is what the sentence means — how many times has this been asked for.
 * Cleared when `coverage()` reports the file changed, which is the same staleness rule the spans obey.
 */
const windowedReads = new Map<string, number>();

/** A diff longer than this stops being a summary and becomes the re-send it replaces. */
const EDIT_NOTE_MAX_CHARS = 1_200;

/**
 * The structure of a file, as a reply — or null when no language claims it or it declares nothing.
 *
 * One function because two callers now need it: the first read of a too-big file, and the read that
 * shows the model has started hunting. `why` names which, so the log can tell them apart and the
 * model is told why it got a map instead of the lines it asked for.
 */
function structureReply(
  resolved: string, shown: string, text: string, budget: number, total: number, why: string,
): string | null {
  const skel = skeletonOf(resolved, text, budget);
  if (!skel) return null;
  log('INFO', 'read_file_skeleton', {
    path: shown, tier: skel.tier, types: String(skel.types), members: String(skel.members),
    lines: String(total), why,
  });
  const partial = skel.tier === 'full' ? '' : ` (${skel.tier} form — the full one did not fit)`;
  const lead = why === 'asked for'
    ? `${shown} — ${total} lines. Structure only, no bodies${partial}. \`expand_method\` returns one body:`
    : why === 'first read'
    ? `${shown} — ${total} lines, too big for one window. Structure only, no bodies${partial}:`
    : `${shown} — ${total} lines. You have read ${why} of this file without finding what you are after, `
      + `so here is its structure instead of another window${partial}:`;
  return `${lead}\n\n${skel.text}\n\n`
    + `For a body: expand_method(path=${shown}, method=Class.method). It returns the code and counts as `
    + `having read those lines, so an edit to them is allowed.\n`
    + `read_file with offset= or around= still returns text, if you want the file itself.`;
}

export const tool: Tool = {
    name: 'read_file',
    icon: '📄',
    description: 'Read a file and return its contents with line numbers. For a large file: `around=<line>` centres the window on a line (paste a grep hit straight in), and calling it again with no offset SLIDES to the next part you have not read yet rather than repeating the top. Use offset/limit to pick a window by hand. For image files (png/jpg/jpeg/webp/gif/avif/tiff/bmp) the image is downscaled and attached to the next LLM call for vision processing instead of returning bytes.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute file path', required: true },
      { name: 'offset', type: 'number', description: 'First line to show, 1-based — paste a grep line number straight in (text only)', required: false },
      { name: 'limit', type: 'number', description: 'Max lines to return (text only; capped per call, the reply says how to continue)', required: false },
      { name: 'tail', type: 'number', description: 'Return the LAST n lines instead — what a log is read for; no need to learn the length first', required: false },
      { name: 'around', type: 'number', description: 'Centre a focused window on this line, with context on BOTH sides — paste a grep hit here rather than computing an offset. Widen it with limit=', required: false },
      { name: 'structure', type: 'string', description: 'true returns the file\'s SHAPE instead of its lines: every type, every member, each with its exact line range, no bodies. Ask for it when you want the API surface — the fields, the methods, the lifecycle hooks — rather than the code. Then `expand_method` for one body.', required: false },
    ],
    async execute(params) {
      if (!params.path) return 'Error: path required';
      const resolved = resolveAgainstCwd(params.path);
      if (!existsSync(resolved)) {
        return `Error: file not found: ${params.path}.${suggestSimilarPaths(params.path)}`;
      }
      const ext = extname(resolved).toLowerCase();
      if (ext === '.pdf') {
        return `Error: no vision encoder here reads PDF. Rasterize to PNG first, e.g.:\n  pdftoppm -r 200 -png "${resolved}" /tmp/page\n  read_file /tmp/page-1.png`;
      }
      /**
       * A .controller IS A STATE MACHINE, and there was a tool that said so while doing nothing.
       *
       * Reading one returned 1,900 lines of YAML with a note on top saying `animator_inspect` reads
       * this structurally — advice, delivered alongside the very thing it advises against, after the
       * window had already been spent. Reported verbatim: the banner arrived *with* the raw dump
       * rather than instead of it. A pointer the harness can follow itself is not a pointer.
       *
       * ONLY ON A PARAM-FREE READ. `offset=`, `around=`, `tail=`, `limit=` and `structure=` all say
       * the caller wants bytes at a position, which is exactly the case the map cannot serve — and it
       * is the escape hatch `animator_inspect` itself names when its parse comes back empty.
       *
       * AND ONLY ON THE FIRST ONE. A windowed read ends with "read again with no offset to slide to
       * the next part" — follow that on a routed file and the slide hands back the map instead, which
       * is the loop this is supposed to end rather than a new one. Once the YAML has been opened it
       * stays open.
       */
      if (ext === '.controller'
        && !params.offset && !params.around && !params.tail && !params.limit
        && String(params.structure ?? '').toLowerCase() !== 'true'
        && !coverage(resolved)) {
        // Lazy, for the same reason as the vision check below: a module-scope edge between defs
        // half-initializes whichever side the loader reaches first.
        const { tool: animator } = await import('./animator_inspect.js');
        return `${params.path} — returned as its state machine rather than as YAML. This is `
          + `animator_inspect(path=${params.path}); read_file ${params.path} offset=1 returns the raw file.\n\n`
          + `${await animator.execute({ path: resolved })}`;
      }
      if (isImagePath(resolved)) {
        /**
         * ASK BEFORE ATTACHING. An image handed to a model with no vision encoder does not come back
         * as a worse answer — Ollama refuses the whole request with HTTP 400 "Multimodal data provided,
         * but model does not support multimodal requests", so the NEXT call the agent makes dies, and
         * the operator reads a transport error instead of "this model cannot see".
         *
         * Verified against the runtime, not inferred: glm-4.7-flash returns exactly that 400.
         *
         * Lazy import — `llm/select` reaches the tool registry back through the provider runtime, and a
         * module-scope edge here half-initializes whichever side loads first.
         */
        try {
          const { llmProvider } = await import('../../llm/select.js');
          const provider = await llmProvider();
          const sees = provider.vision ? await provider.vision() : null;
          if (sees === false) {
            const status = await provider.status();
            return `Error: ${basename(resolved)} is an image and the served model`
              + ` (${status.model ?? 'unknown'}) has no vision capability — attaching it would fail the`
              + ` next call with "model does not support multimodal requests", not degrade it.\n`
              + `Switch to a model that can see first (\`/model <name>\`), then read the image again.`;
          }
          // `null` means the provider does not publish capabilities. Attach and let it refuse: a
          // provider that cannot answer the question must not have vision disabled on its behalf.
        } catch (e) {
          // The CHECK failing is not the read failing. Say so and carry on to the attach.
          log('WARN', 'vision_check_failed', { error: e instanceof Error ? e.message : String(e) });
        }
        try {
          const img = await preprocessImage(resolved);
          addPendingImage(img.base64);
          const kb = (img.outBytes / 1024).toFixed(1);
          return `[attached image: ${basename(resolved)}, ${img.origDims}→${img.outDims}, ${kb}KB ${img.format}]`;
        } catch (e) {
          return `Error: failed to read image ${params.path}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const raw = readFileSync(resolved);
      // utf-8 decoding a binary produced pages of mojibake in the window. Say what it is instead.
      if (raw.includes(0)) {
        return `Error: ${params.path} is a binary file (${(raw.length / 1024).toFixed(1)} KB). Use bash (file, strings, xxd) if you need to inspect it.`;
      }
      const text = raw.toString('utf-8');
      const lines = text.split('\n');
      // `offset` is the LINE NUMBER to start at, matching grep's output and the numbers printed below.
      // It used to be 0-based while the display was 1-based, so feeding a grep hit straight back read
      // from the line after it. 0 and 1 both mean "the top" so older callers still behave.
      const total = lines.length;
      const rawOff = parseInt(params.offset || '0', 10);
      const askedOffset = Number.isFinite(rawOff) && rawOff > 0 ? rawOff : 0;
      // A read with no limit used to return the WHOLE file, which the window then cut at 16 KB with no
      // notice — the model believing it had read a 5000-line file it had seen a fifth of.
      const askedLimit = parseInt(params.limit || '0', 10);
      // THE CAP IS THE CONTEXT, asked per call — see `lib.ts#readCap`. A fixed 800 protected a 16k
      // window and, on a hosted million-token one, turned every real file into three calls.
      const maxLines = await readCap();
      const size = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(askedLimit, maxLines) : maxLines;

      /**
       * THE SHAPE, ON REQUEST — not only when the file is too big to send.
       *
       * `structureReply` already existed and was reachable two ways, both of them the harness's
       * decision: the first read of a file that does not fit, and the read that shows the model has
       * started hunting. A file that DOES fit could not be asked for as structure at all, so "what
       * are this MonoBehaviour's serialized fields and public methods" had no cheaper answer than
       * reading the whole class. Reported verbatim: *"there's no 'show me the class skeleton' view."*
       * There was; it just could not be asked for.
       *
       * Falls through to the ordinary window when no language claims the file or it declares nothing,
       * for the same reason the automatic path does: an empty skeleton is a worse answer than lines.
       */
      if (String(params.structure ?? '').toLowerCase() === 'true') {
        const asked = structureReply(resolved, params.path, text, maxLines, total, 'asked for');
        if (asked) return asked;
      }
      /**
       * `tail` — the LAST n lines, which is what a log is ever read for.
       *
       * 65 of one project's 826 shell calls were `tail`/`head`/`cat` on a file this tool could already
       * return, and the ones that genuinely needed a shell were all "what did the run just print". Without
       * this the model has to read the file to learn its length, then read again from a computed offset:
       * two calls and a subtraction to answer "show me the end".
       */
      const askedTail = parseInt(params.tail || '0', 10);
      const tailN = Number.isFinite(askedTail) && askedTail > 0 ? Math.min(askedTail, maxLines) : 0;
      const rawAround = parseInt(params.around || '0', 10);
      const askedAround = Number.isFinite(rawAround) && rawAround > 0 ? rawAround : 0;

      /**
       * WHICH WINDOW. Four ways in, in priority order — and the fourth is the one that matters.
       *
       *  `tail`     the end, verbatim.
       *  `around`   centred on a line, context on BOTH sides. A grep hit pastes straight in; starting
       *             *at* the hit (what `offset` does) throws away everything leading to it.
       *  `offset`   a window chosen by hand.
       *  nothing    the next part NOT YET READ. A second param-free read used to return the same
       *             top-of-file slice — a whole round spent re-reading imports. It now slides, and says
       *             so, which is also what makes the read-before-edit guard tractable: the model can
       *             reach line 4012 of a 5000-line file by asking again, not by doing subtraction.
       *
       * A window that is not the tail is snapped to a structural break so it does not end mid-function;
       * see `../window.ts` for why that is language-agnostic on purpose.
       */
      const seen = askedAround || askedOffset || tailN ? null : coverage(resolved);
      /**
       * WHAT THIS FILE HAS ALREADY GIVEN UP, regardless of how it was asked for.
       *
       * `seen` above is deliberately null when an offset was passed — that branch is about SLIDING, and
       * a hand-picked window must not slide. But "how many times has this file been opened" is a
       * different question, and the answer decides whether the model is paging deliberately or hunting.
       * See the structure branch below.
       */
      const already = coverage(resolved);
      /**
       * THE MODEL IS HUNTING, NOT PAGING — hand it the map it never asked for.
       *
       * A windowed read says "I know where I am going". Three of them into the same large file says
       * the opposite, and nothing in the first design noticed: the structure view waited for a
       * param-free read that a grep-then-offset model never makes. See `HUNT_READS`.
       *
       * The count resets with the coverage it shadows — a file that changed underneath is a new file
       * for this purpose, and the model deserves fresh windows into it.
       */
      if (!already) windowedReads.delete(resolved);
      if (askedOffset || askedAround) {
        const n = (windowedReads.get(resolved) ?? 0) + 1;
        windowedReads.set(resolved, n);
        /**
         * EXACTLY ONCE, and `===` is the whole reason.
         *
         * Written as `>=` this became a trap door: every read past the third returned the map, so a
         * model asking for a window got structure, asked again, got the same structure, and could
         * never reach the file again. Measured on a live run — six structure replies against two
         * `expand_method` calls, the model followed the map twice and then spent four reads being
         * handed a 305-line document it already held. The intervention became the loop it was built
         * to break.
         *
         * `read_file` is in `REPEATABLE_READS`, so the echo guard never refuses it and could not have
         * caught this. Showing a map once is an intervention; showing it every time is a wall.
         */
        if (n === HUNT_READS && total > await readCap()) {
          const skel = structureReply(resolved, params.path, text, await readCap(), total, `${n} windows`);
          if (skel) return skel;
        }
        if (n > HUNT_READS && total > await readCap()) {
          log('INFO', 'read_file_structure_already_shown', { path: params.path, reads: String(n) });
        }
      }
      let slidPast: string | null = null;
      let span: [number, number];
      /**
       * THE FIRST LOOK AT A BIG FILE SHOULD BE A MAP, NOT ITS IMPORTS.
       *
       * A param-free read returned the top of the file, which for anything large is licence headers
       * and imports -- readWindow.ts says so itself. The model learns nothing about the shape of the
       * file, and its END (exports, the registry, the main entry) was never seen at all without
       * deliberate paging. So the FIRST param-free read of a file too big to fit returns BOTH ends and
       * says how much sits between them. Subsequent reads slide exactly as before: this changes the
       * opening move only, not the paths the model steers itself down afterwards.
       */
      let outlineTail: [number, number] | null = null;
      if (tailN > 0) {
        span = clampSpan([total - tailN + 1, total], total);
      } else if (askedAround > 0) {
        // A FOCUSED window by default. `around` is for looking at one thing; sizing it at the full cap
        // returned 800 lines to show one constant, and the model followed it with a narrower read.
        const centred = centeredWindow(askedAround, askedLimit > 0 ? size : AROUND_DEFAULT, total);
        span = clampSpan([centred[0], snapEnd(lines, centred[0], centred[1], total)], total);
      } else if (askedOffset > 0) {
        span = clampSpan([askedOffset, snapEnd(lines, askedOffset, askedOffset + size - 1, total)], total);
      } else {
        const slid = seen && seen.lines === total ? slideWindow(lines, seen.spans, size, total) : null;
        if (slid) {
          span = slid;
          slidPast = describeSpans(seen!.spans);
        } else {
          /**
           * STRUCTURE BEATS THE FIRST PAGE, when the file does not fit and nothing has been read yet.
           *
           * Returning the head plus the tail tells the model where the file starts and stops and
           * nothing about what is in it, so the only move left is guessing an offset. Measured on
           * A real run: 27 reads of `axis.py`, three neighbourhoods circled for 42 minutes, no
           * edit. The skeleton answers the question those 27 reads were asking — 305 lines standing in
           * for 2,486, every method with its exact range — and `expand_method` returns a body without
           * a byte offset ever being computed.
           *
           * Falls through to the byte window when no language claims the file or it declares nothing:
           * an empty skeleton is a worse answer than a real first page.
           */
          if (!seen?.spans.length && total > size) {
            const skel = structureReply(resolved, params.path, text, size, total, 'first read');
            if (skel) return skel;
          }
          // Nothing read yet AND the file does not fit: spend part of the budget on the tail.
          const wantOutline = !seen?.spans.length && total > size;
          const headLines = wantOutline ? Math.max(1, size - OUTLINE_TAIL_LINES) : size;
          span = clampSpan([1, snapEnd(lines, 1, headLines, total)], total);
          if (wantOutline) {
            const start = Math.max(span[1] + 1, total - OUTLINE_TAIL_LINES + 1);
            if (start <= total) outlineTail = clampSpan([snapStart(lines, start), total], total);
          }
        }
      }

      if (askedOffset > total) {
        return `Error: offset ${askedOffset} is past the end of ${params.path} (${total} lines).`;
      }
      const off2 = span[0] - 1;
      const slice = lines.slice(span[0] - 1, span[1]);
      if (!slice.length) {
        return `Error: offset ${askedOffset || 1} is past the end of ${params.path} (${total} lines).`;
      }
      const number = (from: number, to: number): string =>
        lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n');
      const gap = outlineTail ? outlineTail[0] - span[1] - 1 : 0;
      const numbered = outlineTail
        ? `${number(span[0], span[1])}\n\u2026 [${gap} lines between here and the end are not shown -- read `
          + `again with no offset to slide into them, or around=<line> to centre on one]\n`
          + `${number(outlineTail[0], outlineTail[1])}`
        : slice.map((l, i) => `${off2 + i + 1}\t${l}`).join('\n');
      const lastShown = span[1];
      // The COUNTS, always. 19 shell `wc -l` calls existed only because a read never said how big the
      // file was unless it happened to truncate; now every reply carries it, so "is this file big?" is
      // never its own call.
      const bytes = raw.length >= 1024 ? `, ${(raw.length / 1024).toFixed(1)} KB` : `, ${raw.length} B`;
      const slidNote = slidPast ? ` — slid past what you already read (${slidPast})` : '';
      const shown = outlineTail
        ? `lines ${span[0]}-${lastShown} and ${outlineTail[0]}-${outlineTail[1]}`
        : `lines ${span[0]}-${lastShown}`;
      const header = `(${shown} of ${total}${bytes}${slidNote})\n`;
      /**
       * WHAT IS STILL UNSEEN, as line ranges, every time the file is not fully read.
       *
       * "N more lines" only ever described the tail of the file, so after one slide it was wrong: a model
       * that had read 1-800 and then 801-1000 of a 2000-line file was told "1000 more lines" with no way
       * to know 1-800 was already behind it. The complement is the honest answer, and it is the number the
       * next call needs.
       */
      const covered = [...(seen?.spans ?? []), span, ...(outlineTail ? [outlineTail] : [])] as [number, number][];
      const unread = unreadRanges(covered, total);
      const capNote = askedLimit && askedLimit > maxLines ? `; limit is capped at ${maxLines} lines/call by the served model's context` : '';
      /**
       * A TOOL THE MODEL DOES NOT KNOW APPLIES IS A TOOL THAT DOES NOT EXIST.
       *
       * The structure view and `expand_method` were reachable and useful and never once used, because
       * nothing in a windowed read said they were an option. One line, only on files too big to hold,
       * where it is the difference between paging blind and asking for the map.
       */
      const mapNote = total > maxLines && skeletonOf(resolved, text, maxLines)
        ? `\nStructure: read this file with NO offset for every class and method with its line range, `
          + `then expand_method(path, Class.method) for one body.`
        : '';
      const footer = unread.length
        ? `\n(unread: ${describeSpans(unread)} — ${spanLines(unread)} of ${total} lines. Read again with no `
          + `offset to slide there, or around=<line> to centre on one${capNote})${mapNote}`
        : `\n(all ${total} lines of this file have now been read${capNote})${mapNote}`;
      // What the corpus already knows about THIS file. An exact path lookup, not a similarity
      // search, so it cannot surface a plausible-but-unrelated chunk. Never fatal: a corpus that
      // fails to load must not break the read that was actually asked for.
      // Chunks are keyed by REPO-RELATIVE path; this tool takes an absolute one, so the lookup has
      // to be translated or it silently never matches.
      let corpus = '';
      let attribution = '';
      try {
        const rel = relative(process.cwd(), resolved).split(sep).join('/');
        if (rel && !rel.startsWith('..')) {
          corpus = corpusBlockFor(process.cwd(), rel, { startLine: span[0], endLine: lastShown }) ?? '';
          // WHAT this file is, stated where the mistake happens. Plus the corpus count — a flat int
          // the operator reads to decide whether this file deserves another indulge run. Shown even
          // when zero: silence and "not covered" must not look the same.
          attribution = attributeFile({
            tool: 'read_file', repoPath: process.cwd(), file: rel,
            source: lines.join('\n'), chunks: chunksForFile(process.cwd(), rel),
          });
        }
      } catch { /* attribution never breaks the read it annotates */ }
      // The read-before-edit guard is armed with the range ACTUALLY RETURNED, not the whole file: a
      // capped read of a 5000-line file must not license an edit at line 4012 in the part that never
      // came back. See `../readGuard.ts`.
      recordRead(resolved, [span[0], lastShown], total);
      if (outlineTail) recordRead(resolved, outlineTail, total);
      /**
       * HOW YOUR EDIT LANDED, answered before the file itself.
       *
       * Capped, and the cap is the point: an uncapped diff of a large rewrite is the same wall of bytes
       * this exists to avoid re-sending, and it would push the window toward the compression that
       * starts the re-read spiral. A clipped diff still answers "did it land where I meant"; the file
       * below answers everything else.
       */
      const notes = takeEditNotes(resolved);
      const changed = notes.length
        ? `(this file was edited since you last read it — what changed:)\n`
          + notes.map((n) => (n.length > EDIT_NOTE_MAX_CHARS
            ? `${n.slice(0, EDIT_NOTE_MAX_CHARS)}\n… [diff clipped — the file below is the current truth]`
            : n)).join('\n')
          + '\n\n'
        : '';
      return `${attribution}${changed}${header}${numbered}${footer}${corpus}`;
    },
  };
