/**
 * Image preprocessing for whatever vision model is serving — gemma, qwen3.x-VL, glimmer.
 *
 * 896 is gemma's ViT native tile: larger inputs get tiled (Pan&Scan), which multiplies token count and
 * VRAM. It is a safe ceiling for the others rather than their optimum — the qwen VL encoders take
 * dynamic resolutions in 28px patches and would accept more detail — but this is a MAX edge, so an
 * image already smaller than it passes through untouched, and the failure mode of the cap is a slightly
 * softer picture rather than a turn that will not fit on the card.
 *
 * WHICH MODEL CAN SEE AT ALL is not decided here. The provider is asked before an image is ever
 * attached (LlmProvider.vision → Ollama's /api/show), because a text-only model does not answer an
 * image badly, it refuses the request with HTTP 400 and takes the turn with it.
 */

import sharp from 'sharp';
import { extname } from 'node:path';

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.tiff', '.tif', '.bmp',
]);

const MAX_EDGE = 896;
const JPEG_QUALITY = 85;
const HARD_BYTE_CAP = 2 * 1024 * 1024;
const FALLBACK_EDGE = 640;
const FALLBACK_QUALITY = 70;

export function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(extname(p).toLowerCase());
}

export interface PreprocessedImage {
  base64: string;
  origDims: string;
  outDims: string;
  outBytes: number;
  format: string;
}

export async function preprocessImage(absPath: string): Promise<PreprocessedImage> {
  const probe = sharp(absPath);
  const meta = await probe.metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;

  // PNG-friendly path: small screenshots stay PNG (lossless for text/UI).
  // Everything else re-encodes to JPEG.
  const keepPng = meta.format === 'png' && origW * origH < 640_000;

  const build = (edge: number, quality: number, asJpeg: boolean) => {
    let p = sharp(absPath).rotate();
    if (origW > edge || origH > edge) {
      p = p.resize(edge, edge, { fit: 'inside', withoutEnlargement: true });
    }
    p = p.removeAlpha().toColorspace('srgb');
    return asJpeg
      ? p.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true })
      : p.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  };

  let buf = await build(MAX_EDGE, JPEG_QUALITY, !keepPng);

  // If still too big (rare — usually a high-entropy 4K screenshot), fall back
  // to smaller edge + lower JPEG quality.
  if (buf.data.length > HARD_BYTE_CAP) {
    buf = await build(FALLBACK_EDGE, FALLBACK_QUALITY, true);
  }

  return {
    base64: buf.data.toString('base64'),
    origDims: `${origW}x${origH}`,
    outDims: `${buf.info.width}x${buf.info.height}`,
    outBytes: buf.data.length,
    format: buf.info.format,
  };
}

// Per-turn pending image queue. read_file pushes; the next llmChat drains
// and attaches to the outgoing request body.
const pendingImages: string[] = [];

export function addPendingImage(b64: string): void {
  pendingImages.push(b64);
}

export function takePendingImages(): string[] {
  if (pendingImages.length === 0) return [];
  const out = pendingImages.slice();
  pendingImages.length = 0;
  return out;
}
