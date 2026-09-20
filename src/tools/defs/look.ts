import { isAbsolute, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { Tool } from '../base.js';
import { isImagePath, preprocessImage, addPendingImage } from '../../image.js';

/**
 * EYES. The agent renders something and then actually looks at it.
 *
 * Measured across 20 real runs: bugs whose symptom is computational got an edit 12/13 times;
 * bugs whose symptom is a rendered artefact — a plot, a PDF, a UML diagram — got one 1/6, and the
 * misses were spread evenly across plotting and documentation tooling. One of them had the correct
 * root cause and the correct one-line fix
 * written out, and refused to apply it: "Unconfirmed: I did not run the LaTeX build to verify the exact
 * rendered output."
 *
 * It was right to refuse. It had no way to check. The model is multimodal and `connection.ts` already
 * ships `body.images` from a pending queue — nothing in an agent turn ever put anything in that queue.
 * This does.
 *
 * The image is not returned as text; it is queued for the NEXT model call, which is how the runtime's
 * image channel works. So the reply here is a receipt, and the picture arrives with the next round.
 */
const MAX_BYTES = 12 * 1024 * 1024;

export const tool: Tool = {
  name: 'look',
  icon: '👁',
  description:
    'Look at an image file — a rendered plot, a screenshot, a page converted to PNG. The image is shown to you on your NEXT turn, and you judge it yourself. '
    + 'Use it to verify work whose result is visual: render the figure or convert the PDF page to PNG first, then look at it. '
    + 'PNG/JPEG/WebP/GIF only — convert a PDF page with something like `pdftoppm -png -r 100 -f 1 -l 1 in.pdf out`.',
  parameters: [
    { name: 'path', type: 'string', description: 'Path to an image file to look at', required: true },
  ],
  async execute(params) {
    const raw = (params.path ?? '').trim();
    if (!raw) return 'Error: path required';
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
    if (!existsSync(abs)) return `Error: no such file: ${raw}. Render it first, then look at it.`;
    if (!statSync(abs).isFile()) return `Error: not a file: ${raw}`;
    // A PDF or SVG named here is the commonest miss — say what to do about it rather than just refusing.
    if (!isImagePath(abs)) {
      return `Error: ${raw} is not a raster image. Convert it first — a PDF page with `
        + `\`pdftoppm -png -r 100 -f 1 -l 1 ${raw} /tmp/page\`, an SVG with a renderer — then look at the PNG.`;
    }
    const bytes = statSync(abs).size;
    if (bytes > MAX_BYTES) return `Error: ${raw} is ${(bytes / 1048576).toFixed(1)} MB, over the ${MAX_BYTES / 1048576} MB limit. Render it smaller.`;
    try {
      const img = await preprocessImage(abs);
      addPendingImage(img.base64);
      return `Queued ${raw} (${img.origDims} → ${img.outDims}, ${img.format}, ${(img.outBytes / 1024).toFixed(0)} KB). `
        + `You will SEE it on your next turn — say what you expected, then judge whether that is what it shows.`;
    } catch (err) {
      return `Error: could not read ${raw} as an image — ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
