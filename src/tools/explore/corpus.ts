/**
 * explore/corpus.ts — what the corpus already knows about this question, appended to a localization.
 *
 * WHY HERE. `explore` answers "where is it" from bytes on disk, and that is deliberately all it answers.
 * But the agent's next move after a localization is almost always to read those files and work out what
 * they DO — which is exactly the question a corpus has already answered, overnight, with citations. Making
 * it fetch that separately costs a whole round, and the model has to think to do it; most of the time it
 * did not.
 *
 * SEMANTIC ONLY. This is a vector pass and nothing else: no keyword fallback, no lexical scoring. A
 * localization already IS the keyword answer — appending a second keyword match over the same terms adds
 * tokens and no information. With no vectors from the currently configured embedding model, this block is
 * absent, which is the honest state: "not embedded yet" is not "nothing known".
 *
 * `functionality` ONLY, and that is a decision about what helps HERE. The five shipped categories answer
 * different questions, and the other four are the wrong ones at this moment: `git` is history, `dependencies`
 * and `connections` restate the reference graph the localization just walked, `gotchas` is a warning without
 * a change to warn about. A `ticket` chunk (`indulge --jira`) is deliberately out too — the requirement is
 * what the code should do, not what it does, and this block sits under a list of file spans.
 *
 * IT IS LABELLED, because `format.ts` guarantees that every character it emits is a file byte, a counted
 * number or a closed-set label — and a corpus answer is none of those: it is model prose from another run.
 * So it goes BELOW that output, under a header naming what it is and when it was written, with its own
 * citations. The guarantee still holds over the part that makes it, and the reader can tell the two apart.
 */

import { existsSync } from 'node:fs';
import { openStore } from '../../indulge/store.js';
import { citeLabel } from '../../indulge/store.js';
import { embedQuery, hasUsableVectors, liveVectors, vectorSearch, QUERY_TIMEOUT_MS } from '../../indulge/embed.js';
import { toolLog } from '../runtime.js';

/** The one category worth reading beside a set of file spans. */
export const EXPLORE_CATEGORY = 'functionality';

/** Chunks appended. Two: this rides under an answer that already spent the reader's attention. */
const LIMIT = 2;

/**
 * A floor on similarity, which `corpus_search` deliberately does NOT have — and the difference is who
 * asked. There, the agent typed a query and top-K beats a threshold: "nothing matched" is a worse answer
 * than a weak match it can judge for itself. Here nobody asked; the block is injected into every explore
 * result, so a weak match is not a hint, it is a distractor — measurably the thing that degrades the rest
 * of the prompt. Below this, silence is the better answer.
 */
const MIN_SCORE = 0.55;

/** An answer is evidence, not an essay — a corpus chunk can be 6000 characters. */
const MAX_ANSWER_CHARS = 700;

const clip = (s: string): string => {
  const t = s.replace(/\s+\n/g, '\n').trim();
  return t.length <= MAX_ANSWER_CHARS ? t : `${t.slice(0, MAX_ANSWER_CHARS)}… [clipped]`;
};

/**
 * The block, or null when there is nothing to add.
 *
 * Never throws: a failed embedding call must not turn a good localization into an error. It IS reported,
 * on screen and in the log — a silent fallback here cost four rounds of debugging once already, because a
 * wrong answer read as a bad corpus rather than as a pass that never ran.
 */
export async function exploreCorpusBlock(repoPath: string, question: string): Promise<string | null> {
  if (!question.trim() || !existsSync(repoPath)) return null;
  let store;
  try { store = openStore(repoPath); } catch { return null; }
  if (!store.exists()) return null;

  const eligible = store.chunks().filter((c) => c.category === EXPLORE_CATEGORY && c.qa?.verdict !== 'reject');
  if (!eligible.length) return null;
  if (!hasUsableVectors(store)) return null;

  const within = new Set(eligible.map((c) => c.chunkId));
  let hits;
  try {
    const qv = await embedQuery(question);
    hits = vectorSearch(liveVectors(store), qv, { limit: LIMIT, within }).filter((h) => h.score >= MIN_SCORE);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    toolLog().warn('explore_corpus_pass_failed', { error: msg, timedOut: String(timedOut) });
    return `corpus: the semantic pass did not run — ${timedOut
      ? `no answer from the embedding endpoint within ${Math.round(QUERY_TIMEOUT_MS / 1000)}s (slow or busy)`
      : msg}. Nothing above is affected; corpus_search would fall back to keywords.`;
  }
  if (!hits.length) return null;

  const byId = new Map(eligible.map((c) => [c.chunkId, c]));
  const out: string[] = [
    '',
    `corpus · ${EXPLORE_CATEGORY} · ${hits.length} of ${eligible.length} answered question(s), by meaning`,
    'Written by an earlier indulge run, not by this tool — every claim below carries its citation.',
    '',
  ];
  for (const h of hits) {
    const c = byId.get(h.chunkId);
    if (!c) continue;
    out.push(`  Q: ${c.question}`);
    for (const line of clip(c.answer).split('\n')) out.push(`     ${line}`);
    out.push(`     cited: ${c.citations.map(citeLabel).join(' · ')}`
      + `  ·  ${c.model}, ${c.createdAt.slice(0, 10)}  ·  match ${h.score.toFixed(2)}`);
    out.push('');
  }
  out.push('Use corpus_search for more, or read the cited lines to check any of it.');
  return out.join('\n');
}
