import type { Tool } from '../base.js';
import { READ_MAX_LINES, resolveAgainstCwd, suggestSimilarPaths } from '../lib.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { addPendingImage, isImagePath, preprocessImage } from '../../image.js';

export const tool: Tool = {
    name: 'read_file',
    description: 'Read a file and return its contents with line numbers. Use offset/limit for large files. For image files (png/jpg/jpeg/webp/gif/avif/tiff/bmp) the image is downscaled and attached to the next LLM call for vision processing instead of returning bytes.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute file path', required: true },
      { name: 'offset', type: 'number', description: 'First line to show, 1-based — paste a grep line number straight in (text only)', required: false },
      { name: 'limit', type: 'number', description: 'Max lines to return (text only; capped per call, the reply says how to continue)', required: false },
    ],
    async execute(params) {
      if (!params.path) return 'Error: path required';
      const resolved = resolveAgainstCwd(params.path);
      if (!existsSync(resolved)) {
        return `Error: file not found: ${params.path}.${suggestSimilarPaths(params.path)}`;
      }
      const ext = extname(resolved).toLowerCase();
      if (ext === '.pdf') {
        return `Error: PDFs are not natively supported by gemma vision. Rasterize to PNG first, e.g.:\n  pdftoppm -r 200 -png "${resolved}" /tmp/page\n  read_file /tmp/page-1.png`;
      }
      if (isImagePath(resolved)) {
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
      const rawOff = parseInt(params.offset || '1', 10);
      const startLine = Number.isFinite(rawOff) ? Math.max(1, rawOff) : 1;
      const off = startLine - 1;
      // A read with no limit used to return the WHOLE file, which the window then cut at 16 KB with no
      // notice — the model believing it had read a 5000-line file it had seen a fifth of.
      const askedLimit = parseInt(params.limit || '0', 10);
      const lim = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(askedLimit, READ_MAX_LINES) : READ_MAX_LINES;
      const slice = lines.slice(off, off + lim);
      if (!slice.length) {
        return `Error: offset ${startLine} is past the end of ${params.path} (${lines.length} lines).`;
      }
      const numbered = slice.map((l, i) => `${off + i + 1}\t${l}`).join('\n');
      const lastShown = off + slice.length;
      const more = lastShown < lines.length;
      const header = more || off > 0 ? `(lines ${off + 1}-${lastShown} of ${lines.length})\n` : '';
      const footer = more
        ? `\n(${lines.length - lastShown} more lines — continue with offset=${lastShown + 1}${askedLimit && askedLimit > READ_MAX_LINES ? `; limit is capped at ${READ_MAX_LINES} lines per call` : ''})`
        : '';
      return `${header}${numbered}${footer}`;
    },
  };
