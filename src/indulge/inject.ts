/**
 * indulge/inject.ts — handing the agent what the corpus already knows about a file.
 *
 * The first retrieval site, and deliberately the narrowest one: when the agent reads a file, it gets
 * the answered questions about **that file**. No embedding, no vector search, no relevance threshold
 * to tune — chunks are already keyed by path (`entity.file`, `files[]`, every citation), so this is
 * an exact lookup. A lookup cannot return a plausible-but-unrelated chunk, which is the failure mode
 * every similarity score eventually produces.
 *
 * Three rules, each one load-bearing:
 *
 *   1. **Staleness is stated, never hidden.** Every chunk goes through `assessChunk` and carries its
 *      label. The corpus assists an agent that EDITS CODE, so it goes stale during the very session
 *      it is helping — an unlabelled stale chunk is a confident lie with a citation attached, and
 *      the citation makes it more believable, not less.
 *   2. **A small budget.** Two chunks. Every injected token costs a slice of the attention available
 *      to every other token in the prompt, including the hard constraints; this is a nudge toward
 *      what is already known, not a briefing.
 *   3. **It can be turned off.** Whether retrieval helps is a question to be measured by running the
 *      same task with it off, not settled by intuition. `/corpus off` is that switch.
 *
 * Injected into the tool RESULT rather than the system prompt, which means it also inherits the
 * window's observation masking: after a few messages it compresses to a stub on its own. Timely
 * rather than permanent, and it never churns the KV-cached prefix.
 */

import { isCorpusInjection } from '../modes.js';
import { assessChunk } from './staleness.js';
import { openStore, type Chunk } from './store.js';

/** Two is a nudge; five is a briefing nobody asked for. */
const MAX_CHUNKS = 2;
/** An answer longer than this is clipped — the citation is there for the full story. */
const MAX_ANSWER_CHARS = 700;

/** Chunks that answer something about this exact file, freshest first. */
export function chunksForFile(repoPath: string, file: string): Chunk[] {
  const store = openStore(repoPath);
  if (!store.exists()) return [];
  const hits = store.chunks().filter((c) =>
    c.entity?.file === file || c.files.includes(file) || c.citations.some((x) => x.path === file));
  // Newest first: a later answer about the same file supersedes an earlier one.
  return hits.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * The block appended to a `read_file` result, or null when there is nothing worth saying.
 *
 * Fresh chunks are preferred over stale ones — but a stale chunk is still offered when nothing
 * fresher exists, because "this was true on dev last week" is worth more than silence, provided it
 * says so.
 */
export function corpusBlockFor(repoPath: string, file: string): string | null {
  if (!isCorpusInjection()) return null;
  const all = chunksForFile(repoPath, file);
  if (all.length === 0) return null;

  const assessed = all.map((c) => ({ chunk: c, state: assessChunk(repoPath, c) }));
  // A chunk whose cited file is gone entirely tells the agent nothing it cannot see for itself.
  const usable = assessed.filter((a) => a.state.state !== 'missing');
  if (usable.length === 0) return null;

  const rank = { fresh: 0, stale: 1, divergent: 2, missing: 3 };
  usable.sort((a, b) => rank[a.state.state] - rank[b.state.state]);

  const lines: string[] = ['', `--- what indulge already knows about ${file} (${usable.length} answered) ---`];
  for (const { chunk, state } of usable.slice(0, MAX_CHUNKS)) {
    const answer = chunk.answer.length > MAX_ANSWER_CHARS
      ? `${chunk.answer.slice(0, MAX_ANSWER_CHARS)}…`
      : chunk.answer;
    lines.push('');
    lines.push(state.label);
    lines.push(`Q. ${chunk.question}`);
    lines.push(answer);
    lines.push(`cited: ${chunk.citations.map((c) => `${c.path}:${c.startLine}-${c.endLine}`).join(' · ')}`);
  }
  if (usable.length > MAX_CHUNKS) {
    lines.push('');
    lines.push(`(${usable.length - MAX_CHUNKS} more answered question(s) about this file — ask corpus_search for them.)`);
  }
  lines.push('');
  lines.push('These are notes from an earlier pass, not the code. Verify anything you act on.');
  return lines.join('\n');
}

/**
 * The PULL half: what the corpus has on a free-text query.
 *
 * Lexical, and openly so — question text, file path and answer body, scored by how many query terms
 * hit and weighted toward the question (that is what was actually asked). Phase 2's embeddings will
 * replace the scoring; the shape of the answer will not change.
 *
 * Staleness is labelled here too. A pulled chunk is exactly as dangerous as a pushed one.
 */
export function corpusSearch(repoPath: string, query: string, limit = 3): string {
  const store = openStore(repoPath);
  if (!store.exists()) {
    return 'No corpus for this repo yet. Build one with: ayin indulge --domains "<what you are working on>"';
  }
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_.]+/u).filter((t) => t.length > 2);
  if (terms.length === 0) return 'Query too short to search on.';

  const scored = store.chunks().map((c) => {
    const q = c.question.toLowerCase();
    const body = c.answer.toLowerCase();
    const paths = [c.entity?.file ?? '', ...c.files].join(' ').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (q.includes(t)) score += 3;        // it is a question — matching the question matters most
      if (paths.includes(t)) score += 2;    // a path is a precise handle
      if (body.includes(t)) score += 1;
    }
    return { chunk: c, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);

  if (scored.length === 0) {
    return `Nothing in the corpus matches "${query}". It holds ${store.totals().chunks} answered question(s) for this repo.`;
  }

  const out: string[] = [`${scored.length} of ${store.totals().chunks} chunk(s) match "${query}":`];
  for (const { chunk } of scored) {
    const state = assessChunk(repoPath, chunk);
    out.push('');
    out.push(state.label);
    out.push(`Q. ${chunk.question}`);
    out.push(chunk.answer.length > MAX_ANSWER_CHARS ? `${chunk.answer.slice(0, MAX_ANSWER_CHARS)}\u2026` : chunk.answer);
    out.push(`cited: ${chunk.citations.map((c) => `${c.path}:${c.startLine}-${c.endLine}`).join(' \u00b7 ')}`);
  }
  out.push('');
  out.push('Notes from an earlier pass, not the code. Verify anything you act on.');
  return out.join('\n');
}
