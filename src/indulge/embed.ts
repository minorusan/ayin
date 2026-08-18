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
import { llmBaseUrl } from '../connection.js';
import { domainsOf } from './inject.js';
import type { Chunk, IndulgeStore } from './store.js';

const DEFAULT_MODEL = 'nomic-embed-text';

/** Same endpoint the ollama provider uses — one place to point at a model server, not two. */
/**
 * Where embeddings are asked for — the SAME endpoint everything else uses, not the model port.
 *
 * This used to fall back to `127.0.0.1:11434`, reaching around whatever serves the model to poke
 * Ollama's own port directly. On a machine that talks to a remote endpoint there is nothing on that
 * port, so `--embed` failed with `fetch failed` while generation had been working all night — and
 * the failure was the design working, not a misconfiguration to fix by pointing it somewhere.
 *
 * For a plain Ollama install this changes nothing: the configured endpoint IS Ollama, and Ollama
 * serves `/api/embeddings`. For a gateway it means embeddings queue and get attributed like every
 * other call instead of jumping the queue. `AYIN_EMBED_URL` stays as the escape hatch for a separate
 * embedding server.
 */
function embedUrl(): string {
  const url = process.env.AYIN_EMBED_URL || llmBaseUrl();
  return url.replace(/\/+$/, '');
}

export function embedModel(): string {
  return process.env.AYIN_EMBED_MODEL || getConfigString('embedModel') || DEFAULT_MODEL;
}

/**
 * Which service embeds. Inferred from the MODEL NAME, overridable.
 *
 * Inferred rather than configured separately because the two cannot disagree usefully: asking
 * OpenAI for `nomic-embed-text` is an error, and asking a local endpoint for `text-embedding-3-small`
 * is a different one. One setting that can be wrong beats two that can contradict.
 */
export function embedProvider(): 'openai' | 'endpoint' {
  const explicit = (process.env.AYIN_EMBED_PROVIDER || getConfigString('embedProvider') || '').toLowerCase();
  if (explicit === 'openai' || explicit === 'endpoint') return explicit;
  return /^text-embedding-/.test(embedModel()) ? 'openai' : 'endpoint';
}

/**
 * How many texts go in one request.
 *
 * This is the entire speed story, and it is a property of the API rather than of the model. OpenAI's
 * `input` takes an ARRAY, so 847 chunks are nine requests instead of 847 round trips — and the local
 * path is one-at-a-time on CPU, which is what made `--embed` feel hung. A local endpoint gets 1
 * because `/api/embeddings` takes a single prompt; raising it there would silently embed only the
 * first of each batch.
 */
export function embedBatchSize(): number {
  return embedProvider() === 'openai' ? 96 : 1;
}

/**
 * One request, N texts, N vectors back — in the SAME ORDER.
 *
 * Order is the contract. OpenAI returns `data[]` carrying an `index`, and it is sorted by it here
 * rather than trusted: a vector attached to the wrong chunk is undetectable afterwards. Every
 * distance in the corpus would be subtly wrong, nothing would error, and retrieval would just
 * quietly return the wrong neighbours forever.
 */
export async function embedBatch(texts: string[], model = embedModel()): Promise<number[][]> {
  if (!texts.length) return [];
  if (embedProvider() !== 'openai') {
    const out: number[][] = [];
    for (const t of texts) out.push(await embedText(t, model));
    return out;
  }
  // Through the OpenAI PROVIDER, not a hand-rolled fetch. That module owns the key, the client and
  // the safe rendering of SDK errors; duplicating the call here would re-implement all three, and a
  // build gate rejects a second api.openai.com caller on sight for exactly that reason.
  const { openAiEmbed } = await import('../llm/providers/openai.js');
  return openAiEmbed(texts, model);
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

  // BATCHED. Was one request per chunk, which on a local CPU model meant 847 sequential round trips
  // and a command that looked hung for minutes. Batch size is a property of the API, not the model:
  // OpenAI takes an array (nine requests instead of 847), a single-prompt endpoint takes one.
  const todo = chunks.filter((c) => !done.has(c.chunkId));
  report.skipped = chunks.length - todo.length;
  const size = opts.embed ? 1 : embedBatchSize();   // an injected embedder is per-text by contract
  let processed = 0;

  for (let i = 0; i < todo.length; i += size) {
    if (shouldStop?.()) { report.stopped = true; onStatus?.('stop requested — the rest stay unembedded'); break; }
    const batch = todo.slice(i, i + size);
    onProgress?.(processed, todo.length, batch[0].entity?.file || batch[0].files[0] || batch[0].chunkId);

    try {
      // Question AND answer: the question is what a query echoes, the answer is what makes two
      // differently-worded questions about the same thing land near each other.
      const texts = batch.map((c) => `${c.question}\n\n${c.answer}`);
      const vectors = opts.embed
        ? [await opts.embed(texts[0])]
        : await embedBatch(texts, model);

      // Positional pairing, so a short reply cannot silently attach vectors to the wrong chunks.
      if (vectors.length !== batch.length) throw new Error(`got ${vectors.length} vector(s) for ${batch.length} chunk(s)`);
      for (let k = 0; k < batch.length; k++) {
        const rec: VectorRecord = {
          chunkId: batch[k].chunkId, domains: domainsOf(batch[k]), model,
          dim: vectors[k].length, vector: vectors[k],
        };
        appendFileSync(vectorsPath(store), JSON.stringify(rec) + '\n');
        report.embedded++;
      }
    } catch (err) {
      report.failed += batch.length;
      onStatus?.(`failed on ${batch.length} chunk(s) at ${batch[0].chunkId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      // A dead endpoint fails everything; stop rather than logging hundreds of identical lines.
      if (report.failed >= 3 * size && report.embedded === 0) {
        onStatus?.('embedding endpoint is not answering — stopping');
        break;
      }
    }
    processed += batch.length;
    onProgress?.(processed, todo.length, batch[batch.length - 1].entity?.file ?? '');
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
  return liveVectors(store).some((v) => v.model === model);
}

/**
 * Vectors whose CHUNK still exists.
 *
 * A corpus rebuilt in place keeps its old `vectors.jsonl` rows, and those rows still carry the right
 * embedding model — so every check passes and they rank normally. Measured on a rebuilt corpus: 1,410
 * vectors from the previous build sat beside 1,033 live ones, took all three top slots by cosine, and
 * were then dropped as unresolvable — leaving semantic search with nothing and the caller silently
 * reading a keyword result. The vector was fine; the thing it pointed at was gone.
 */
export function liveVectors(store: IndulgeStore): VectorRecord[] {
  const live = new Set(store.chunks().map((c) => c.chunkId));
  return loadVectors(store).filter((v) => live.has(v.chunkId));
}

/** Chunks in id order matching a set of hits, for rendering. */
export function chunksByIds(chunks: Chunk[], ids: string[]): Chunk[] {
  const byId = new Map(chunks.map((c) => [c.chunkId, c]));
  return ids.map((id) => byId.get(id)).filter((c): c is Chunk => Boolean(c));
}
