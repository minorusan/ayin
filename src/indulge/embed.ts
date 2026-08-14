/**
 * indulge/embed.ts — the expensive pass, and the smallest model in the building.
 *
 * An embedding model is not a chat model. `nomic-embed-text` is ~270 MB against gemma's 15+ GB: it
 * generates nothing, streams nothing, and returns one fixed-length array per input. It runs happily
 * on CPU in milliseconds, so it does not compete for the card and does not evict anything — which is
 * why this stage does not take an authority the way generation does.
 *
 * Two rules that make vectors safe to keep:
 *
 *   1. **A vector is only comparable to vectors from the SAME model.** Not "worse results" —
 *      meaningless ones. Two models put meaning in different places, so cosine between a nomic
 *      vector and an OpenAI vector is noise. Mismatched dimensions crash, which is lucky; matching
 *      dimensions produce confident garbage silently. So every record carries the model NAME, and a
 *      query embedded by a different model refuses to run rather than returning nonsense.
 *   2. **Vectors are derived data. Chunks are the asset.** `chunks/` is portable and model-agnostic;
 *      `vectors.jsonl` is neither. Copy a corpus to another machine and re-embed there — minutes on
 *      a CPU — rather than shipping numbers that machine's model cannot read.
 *
 * Retrieval is coarse-to-fine and this is the LAST stage, not the first: names (`lexicon.ts`) narrow
 * the field, domains narrow it again, and cosine only ever ranks what survives.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigString } from '../prompts.js';
import { domainsOf } from './inject.js';
import type { Chunk, IndulgeStore } from './store.js';

const DEFAULT_MODEL = 'nomic-embed-text';

/** Same endpoint the ollama provider uses — one place to point at a model server, not two. */
function embedUrl(): string {
  const url = process.env.AYIN_EMBED_URL || process.env.AYIN_OLLAMA_URL || getConfigString('ollamaUrl');
  return (url || 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

export function embedModel(): string {
  return process.env.AYIN_EMBED_MODEL || getConfigString('embedModel') || DEFAULT_MODEL;
}

export interface VectorRecord {
  chunkId: string;
  domains: string[];
  model: string;
  dim: number;
  vector: number[];
}

/** One text → one array of floats. The whole API surface of an embedding model. */
export async function embedText(text: string, model = embedModel()): Promise<number[]> {
  const res = await fetch(`${embedUrl()}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status} — is "${model}" pulled? (ollama pull ${model})`);
  const body = await res.json() as { embedding?: number[] };
  if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
    throw new Error(`embeddings returned no vector for model "${model}"`);
  }
  return body.embedding;
}

const vectorsPath = (store: IndulgeStore): string => join(store.dir, 'vectors.jsonl');

export function loadVectors(store: IndulgeStore): VectorRecord[] {
  const path = vectorsPath(store);
  if (!existsSync(path)) return [];
  const out: VectorRecord[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as VectorRecord;
      if (v.chunkId && Array.isArray(v.vector)) out.push(v);
    } catch { /* torn line — same as every other JSONL here */ }
  }
  // Last write wins, so a re-embed supersedes rather than duplicating.
  const byId = new Map(out.map((v) => [v.chunkId, v]));
  return [...byId.values()];
}

export interface EmbedReport {
  model: string;
  embedded: number;
  skipped: number;
  failed: number;
  stopped: boolean;
  /** Vectors on disk from a DIFFERENT model — they cannot be mixed with these. */
  foreign: number;
}

/**
 * Embed every chunk that has no vector for the current model.
 *
 * Append-per-record and resumable, like every other stage: a kill costs the one in flight. Chunks
 * embedded under a different model are counted, never silently reused.
 */
export async function embedCorpus(opts: {
  store: IndulgeStore;
  onStatus?: (note: string) => void;
  onProgress?: (done: number, total: number, current: string) => void;
  shouldStop?: () => boolean;
  embed?: (text: string) => Promise<number[]>;
}): Promise<EmbedReport> {
  const { store, onStatus, onProgress, shouldStop } = opts;
  const model = embedModel();
  const embed = opts.embed ?? ((t: string) => embedText(t, model));

  const existing = loadVectors(store);
  const done = new Set(existing.filter((v) => v.model === model).map((v) => v.chunkId));
  const foreign = existing.filter((v) => v.model !== model).length;

  const chunks = store.chunks();
  const report: EmbedReport = { model, embedded: 0, skipped: 0, failed: 0, stopped: false, foreign };
  onStatus?.(`${chunks.length} chunk(s), ${done.size} already embedded with ${model}`
    + (foreign ? ` · ${foreign} from another model (ignored)` : ''));

  let i = 0;
  for (const c of chunks) {
    i++;
    if (shouldStop?.()) { report.stopped = true; onStatus?.('stop requested — the rest stay unembedded'); break; }
    if (done.has(c.chunkId)) { report.skipped++; continue; }
    onProgress?.(i, chunks.length, c.entity?.file || c.files[0] || c.chunkId);
    try {
      // Question AND answer: the question is what a query echoes, the answer is what makes two
      // differently-worded questions about the same thing land near each other.
      const vector = await embed(`${c.question}\n\n${c.answer}`);
      const rec: VectorRecord = { chunkId: c.chunkId, domains: domainsOf(c), model, dim: vector.length, vector };
      appendFileSync(vectorsPath(store), JSON.stringify(rec) + '\n');
      report.embedded++;
    } catch (err) {
      report.failed++;
      onStatus?.(`failed on ${c.chunkId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      // A model that is down fails every chunk; stop rather than logging thousands of lines.
      if (report.failed >= 3 && report.embedded === 0) {
        onStatus?.('embedding endpoint is not answering — stopping');
        break;
      }
    }
  }
  return report;
}

/** "Do these two arrows point the same way?" 1 = same, 0 = unrelated. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
  const mag = Math.sqrt(ma) * Math.sqrt(mb);
  return mag === 0 ? 0 : dot / mag;
}

/**
 * A domain's vector is the MEAN of its chunks'.
 *
 * Not the embedding of its name: a domain is an arbitrary string the operator typed, and `liveops`
 * may describe its contents poorly or not at all. The centroid represents what the domain actually
 * holds, costs no extra call, and moves on its own as chunks are added.
 */
export function domainCentroids(vectors: VectorRecord[]): Map<string, number[]> {
  const groups = new Map<string, number[][]>();
  for (const v of vectors) {
    for (const d of v.domains.length ? v.domains : ['']) {
      const g = groups.get(d);
      if (g) g.push(v.vector); else groups.set(d, [v.vector]);
    }
  }
  const out = new Map<string, number[]>();
  for (const [domain, vs] of groups) {
    const mean = new Array(vs[0].length).fill(0);
    for (const v of vs) for (let i = 0; i < mean.length; i++) mean[i] += v[i] / vs.length;
    out.set(domain, mean);
  }
  return out;
}

export interface VectorHit { chunkId: string; score: number; domain: string }

/**
 * Coarse then fine: pick the domains, then rank chunks inside them.
 *
 * Scoping first is not only cheaper — it is more accurate. A chunk from an unrelated domain that
 * happens to phrase things similarly cannot win if it was never a candidate, which no amount of
 * better scoring achieves.
 */
export function vectorSearch(
  vectors: VectorRecord[], queryVector: number[],
  opts: { topDomains?: number; limit?: number; within?: Set<string> } = {},
): VectorHit[] {
  const topDomains = opts.topDomains ?? 2;
  const limit = opts.limit ?? 3;

  const centroids = [...domainCentroids(vectors).entries()]
    .map(([domain, c]) => ({ domain, score: cosine(queryVector, c) }))
    .sort((a, b) => b.score - a.score)
    // top-K, never a threshold: a badly-phrased query must not retrieve nothing at all.
    .slice(0, topDomains);
  const chosen = new Set(centroids.map((d) => d.domain));

  return vectors
    .filter((v) => (opts.within ? opts.within.has(v.chunkId) : true))
    .filter((v) => (v.domains.length ? v.domains.some((d) => chosen.has(d)) : true))
    .map((v) => ({
      chunkId: v.chunkId,
      score: cosine(queryVector, v.vector),
      domain: v.domains.find((d) => chosen.has(d)) ?? '',
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** True when this corpus has vectors from the model that is configured right now. */
export function hasUsableVectors(store: IndulgeStore): boolean {
  const model = embedModel();
  return loadVectors(store).some((v) => v.model === model);
}

/** Chunks in id order matching a set of hits, for rendering. */
export function chunksByIds(chunks: Chunk[], ids: string[]): Chunk[] {
  const byId = new Map(chunks.map((c) => [c.chunkId, c]));
  return ids.map((id) => byId.get(id)).filter((c): c is Chunk => Boolean(c));
}
