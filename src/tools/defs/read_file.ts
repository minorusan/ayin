import type { Tool } from '../base.js';
import { READ_MAX_LINES, resolveAgainstCwd, suggestSimilarPaths } from '../lib.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { addPendingImage, isImagePath, preprocessImage } from '../../image.js';
import { corpusBlockFor, chunksForFile } from '../../indulge/inject.js';
import { log } from '../../log.js';
import { attributeFile } from '../../indulge/attribution.js';
import { coverage, recordRead } from '../readGuard.js';
import { AROUND_DEFAULT, centeredWindow, clampSpan, describeSpans, slideWindow, snapEnd, spanLines, unreadRanges } from '../readWindow.js';

export const tool: Tool = {
    name: 'read_file',
    icon: '▤',
    description: 'Read a file and return its contents with line numbers. For a large file: `around=<line>` centres the window on a line (paste a grep hit straight in), and calling it again with no offset SLIDES to the next part you have not read yet rather than repeating the top. Use offset/limit to pick a window by hand. For image files (png/jpg/jpeg/webp/gif/avif/tiff/bmp) the image is downscaled and attached to the next LLM call for vision processing instead of returning bytes.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute file path', required: true },
      { name: 'offset', type: 'number', description: 'First line to show, 1-based — paste a grep line number straight in (text only)', required: false },
      { name: 'limit', type: 'number', description: 'Max lines to return (text only; capped per call, the reply says how to continue)', required: false },
      { name: 'tail', type: 'number', description: 'Return the LAST n lines instead — what a log is read for; no need to learn the length first', required: false },
      { name: 'around', type: 'number', description: 'Centre a focused window on this line, with context on BOTH sides — paste a grep hit here rather than computing an offset. Widen it with limit=', required: false },
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
      const lines = raw.toString('utf-8').split('\n');
      // `offset` is the LINE NUMBER to start at, matching grep's output and the numbers printed below.
      // It used to be 0-based while the display was 1-based, so feeding a grep hit straight back read
      // from the line after it. 0 and 1 both mean "the top" so older callers still behave.
      const total = lines.length;
      const rawOff = parseInt(params.offset || '0', 10);
      const askedOffset = Number.isFinite(rawOff) && rawOff > 0 ? rawOff : 0;
      // A read with no limit used to return the WHOLE file, which the window then cut at 16 KB with no
      // notice — the model believing it had read a 5000-line file it had seen a fifth of.
      const askedLimit = parseInt(params.limit || '0', 10);
      const size = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(askedLimit, READ_MAX_LINES) : READ_MAX_LINES;
      /**
       * `tail` — the LAST n lines, which is what a log is ever read for.
       *
       * 65 of one project's 826 shell calls were `tail`/`head`/`cat` on a file this tool could already
       * return, and the ones that genuinely needed a shell were all "what did the run just print". Without
       * this the model has to read the file to learn its length, then read again from a computed offset:
       * two calls and a subtraction to answer "show me the end".
       */
      const askedTail = parseInt(params.tail || '0', 10);
      const tailN = Number.isFinite(askedTail) && askedTail > 0 ? Math.min(askedTail, READ_MAX_LINES) : 0;
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
      let slidPast: string | null = null;
      let span: [number, number];
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
          span = clampSpan([1, snapEnd(lines, 1, size, total)], total);
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
      const numbered = slice.map((l, i) => `${off2 + i + 1}\t${l}`).join('\n');
      const lastShown = span[1];
      // The COUNTS, always. 19 shell `wc -l` calls existed only because a read never said how big the
      // file was unless it happened to truncate; now every reply carries it, so "is this file big?" is
      // never its own call.
      const bytes = raw.length >= 1024 ? `, ${(raw.length / 1024).toFixed(1)} KB` : `, ${raw.length} B`;
      const slidNote = slidPast ? ` — slid past what you already read (${slidPast})` : '';
      const header = `(lines ${span[0]}-${lastShown} of ${total}${bytes}${slidNote})\n`;
      /**
       * WHAT IS STILL UNSEEN, as line ranges, every time the file is not fully read.
       *
       * "N more lines" only ever described the tail of the file, so after one slide it was wrong: a model
       * that had read 1-800 and then 801-1000 of a 2000-line file was told "1000 more lines" with no way
       * to know 1-800 was already behind it. The complement is the honest answer, and it is the number the
       * next call needs.
       */
      const covered = [...(seen?.spans ?? []), span] as [number, number][];
      const unread = unreadRanges(covered, total);
      const capNote = askedLimit && askedLimit > READ_MAX_LINES ? `; limit is capped at ${READ_MAX_LINES} lines/call` : '';
      const footer = unread.length
        ? `\n(unread: ${describeSpans(unread)} — ${spanLines(unread)} of ${total} lines. Read again with no `
          + `offset to slide there, or around=<line> to centre on one${capNote})`
        : `\n(all ${total} lines of this file have now been read${capNote})`;
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
      return `${attribution}${header}${numbered}${footer}${corpus}`;
    },
  };
