/**
 * indulge/rerank.ts — the fourth retrieval stage: score the query and the chunk TOGETHER.
 *
 * `names → domains → cosine` all share one blind spot. The embedding model is a BI-ENCODER: it turns
 * a chunk into 768 numbers before it has ever seen the question, so one vector has to serve every
 * question anyone will ever ask. Measured on this corpus, that flattens the ranking exactly where it
 * matters — "how many times is Calculate invoked during a flush" put the formula for a bonus first
 * (0.614), "when does Calculate throw" second (0.588) and "what does Calculate return" third (0.578).
 * Three different questions, three near-identical scores, because the vectors could not know which
 * one was asked.
 *
 * A CROSS-ENCODER reads the query and one chunk as a single input and attends across both, so it can
 * see that a question asking for a COUNT is not answered by a FORMULA. It costs one forward pass per
 * (query, chunk) pair, which is why it cannot rank a corpus — it ranks the shortlist the cheap stages
 * produced. Recall is theirs; precision is this one's.
 *
 * MEASURED, on 8 covered and 6 nonsense queries against 943 chunks:
 *
 *   - it moved the right chunk from cosine rank #25 to #1 (an assembly question whose answer was
 *     buried below two dozen topically-similar chunks) and scored it +4.29;
 *   - every nonsense query — kubernetes, credit cards, unladen swallows — came back between −2.4 and
 *     −9.4, where cosine had given them 0.49–0.61 against a relevant band starting at 0.625. **The
 *     0.017 margin that made a cosine floor unsafe becomes a margin of whole units here**, which is
 *     what finally lets retrieval say "nothing here answers that" instead of returning its best
 *     guess with citations attached;
 *   - and the queries it scored lowest among the covered set were the ones already known to have no
 *     covering chunk. It agreeing with that, loudly, is the point rather than a miss.
 *
 * MODEL SIZE IS NOT OPTIONAL HERE. `jina-reranker-v1-tiny-en` (33M) and `-turbo-en` (37M) both ranked
 * a near-miss above the exact answer on a four-document sanity check and produced ranges of 0.03
 * units on the real corpus — coarse topicality, no discrimination. `bge-reranker-v2-m3` (568M, Q4)
 * ordered the same four correctly with margins of 4+. A reranker too small to discriminate is worse
 * than none, because it reorders confidently.
 *
 * OFF UNLESS CONFIGURED. This needs a process the operator runs, and ayin brings no model — same
 * bargain as the embedding endpoint. No `rerankUrl`, no reranking, and the cosine ranking stands.
 */

import { getConfigString } from '../prompts.js';
import { log } from '../log.js';

/**
 * How many candidates go to the reranker.
 *
 * The whole point is that the cheap stages only have to get the answer into this window, and a
 * measured miss showed the window has to be wide: the correct chunk for an assembly question sat at
 * cosine #25. Against that, latency is linear — on 6 cores, 8 threads: N=8 1.2s, N=12 1.7s, N=20
 * 2.2s, N=30 3.5s. Sixteen is the compromise, and it is the operator's to move.
 */
const DEFAULT_CANDIDATES = 16;

/**
 * Below this, a chunk is not an answer.
 *
 * A sigmoid of the model's logit, so it reads as 0–1 like every hosted rerank API.
 *
 * MEASURED on 943 chunks: nonsense queries topped out at 0.08 (kubernetes, credit cards, unladen
 * swallows: 0.00–0.08), while a covered question sat at 0.115 — so the usable window is narrow, and
 * 0.10 is the middle of it. Compare what it replaces: cosine's relevant band began at 0.625 and its
 * irrelevant band reached 0.608, a margin of 0.017 that made a floor unsafe to set at all.
 *
 * **Calibrated on thirteen queries against one corpus.** That is enough to beat having no floor and
 * not enough to be a constant nobody may touch — hence `rerankFloor`. Raise it to refuse more, lower
 * it to answer more, and the refusal line prints the score it saw so the choice can be made on data.
 */
const DEFAULT_FLOOR = 0.10;

/** Chars of one chunk sent per pair. Longer costs latency linearly and adds little — answers are terse. */
const MAX_DOC_CHARS = 600;
/** Retrieval is an OPTIONAL improvement to a turn and must never hold one open. */
const TIMEOUT_MS = Number(process.env.AYIN_RERANK_TIMEOUT_MS || 6_000);

export const rerankUrl = (): string =>
  process.env.AYIN_RERANK_URL || getConfigString('rerankUrl') || '';

export const rerankCandidates = (): number =>
  Number(process.env.AYIN_RERANK_CANDIDATES || getConfigString('rerankCandidates')) || DEFAULT_CANDIDATES;

export const rerankFloor = (): number => {
  const raw = Number(process.env.AYIN_RERANK_FLOOR || getConfigString('rerankFloor'));
  return Number.isFinite(raw) && raw !== 0 ? raw : DEFAULT_FLOOR;
};

/** Configured at all? Nothing here runs otherwise, and the cosine ranking is untouched. */
export const rerankEnabled = (): boolean => rerankUrl().length > 0;

export interface RerankHit {
  /** Index into the array that was passed in. */
  index: number;
  /** 0–1. A sigmoid of the model's logit, so a floor reads the same as on a hosted API. */
  score: number;
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Score `docs` against `query`, best first. Returns [] when reranking is off or unavailable.
 *
 * FAILS OPEN, and that is deliberate: a reranker that is down must cost precision, never the answer.
 * The caller keeps its cosine order when this returns nothing, which is the ranking it would have
 * had anyway.
 */
export async function rerank(query: string, docs: string[]): Promise<RerankHit[]> {
  const url = rerankUrl();
  if (!url || docs.length === 0) return [];
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/v1/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, documents: docs.map((d) => d.slice(0, MAX_DOC_CHARS)) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`rerank HTTP ${res.status}`);
    const body = await res.json() as { results?: Array<{ index?: number; relevance_score?: number }> };
    if (!Array.isArray(body.results)) throw new Error('rerank returned no results array');
    return body.results
      .filter((r): r is { index: number; relevance_score: number } =>
        typeof r.index === 'number' && typeof r.relevance_score === 'number'
        // An index the server invented cannot be allowed to select a chunk nobody sent it.
        && r.index >= 0 && r.index < docs.length)
      .map((r) => ({ index: r.index, score: sigmoid(r.relevance_score) }))
      .sort((a, b) => b.score - a.score);
  } catch (e) {
    // SAY WHY. The vector pass hid its own failures for four rounds of debugging, and a silent
    // fallback here reads as a bad corpus rather than an endpoint that is down or slow.
    const msg = e instanceof Error ? e.message : String(e);
    log('WARN', 'corpus_rerank_failed', { error: msg, docs: docs.length });
    return [];
  }
}
