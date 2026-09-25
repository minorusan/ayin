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

import { log } from '../log.js';
import { isCorpusInjection } from '../modes.js';
import { chunksByIds, embedQuery, hasUsableVectors, loadVectors, vectorSearch, liveVectors, QUERY_TIMEOUT_MS } from './embed.js';
import { buildLexicon, canGate, lookupNames, type NameHit } from './lexicon.js';
import { rerank, rerankCandidates, rerankEnabled, rerankFloor } from './rerank.js';
import { assessChunk } from './staleness.js';
import { citeLabel, openStore, type Chunk } from './store.js';

/** Two is a nudge; five is a briefing nobody asked for. */
const MAX_CHUNKS = 2;
/** Below this many lines, a read is a targeted peek — one chunk, or the note dwarfs the code. */
const NARROW_READ_LINES = 60;
/** An answer longer than this is clipped — the citation is there for the full story. */
const MAX_ANSWER_CHARS = 700;

/** A chunk's domains, whichever schema wrote it. Old corpora carry a single `domain`. */
export function domainsOf(chunk: Chunk): string[] {
  if (Array.isArray(chunk.domains) && chunk.domains.length) return chunk.domains;
  return chunk.domain ? [chunk.domain] : [];
}

/** How many of a chunk's cited lines fall inside the range actually being read. */
function overlapWith(chunk: Chunk, file: string, range?: LineRange): number {
  if (!range) return 0;
  let best = 0;
  for (const c of chunk.citations) {
    if (c.path !== file) continue;
    const lo = Math.max(c.startLine, range.startLine);
    const hi = Math.min(c.endLine, range.endLine);
    if (hi >= lo) best = Math.max(best, hi - lo + 1);
  }
  return best;
}

export interface LineRange { startLine: number; endLine: number }

/**
 * Chunks about this file, best first.
 *
 * Ordered by OVERLAP with the lines actually on screen, not by age. Ranking by recency was
 * measured wrong: reading lines 115-118 of a file surfaced a chunk about lines 277-287 first,
 * while the chunk citing 115-136 — the exact code being read — came second. The most recent
 * answer about a file is not the one about the part you are looking at.
 */
export function chunksForFile(repoPath: string, file: string, range?: LineRange): Chunk[] {
  // Same rule as corpusSearch: an audited-out chunk is not shown when a file is read either.
  const store = openStore(repoPath);
  if (!store.exists()) return [];
  const hits = store.chunks().filter((c) => c.qa?.verdict !== 'reject').filter((c) =>
    c.entity?.file === file || c.files.includes(file) || c.citations.some((x) => x.path === file));
  return hits.sort((a, b) => {
    const ov = overlapWith(b, file, range) - overlapWith(a, file, range);
    if (ov !== 0) return ov;
    return (b.createdAt || '').localeCompare(a.createdAt || '');   // tie-break: newer answer wins
  });
}

/**
 * The block appended to a `read_file` result, or null when there is nothing worth saying.
 *
 * Fresh chunks are preferred over stale ones — but a stale chunk is still offered when nothing
 * fresher exists, because "this was true on dev last week" is worth more than silence, provided it
 * says so.
 */
/**
 * WHAT INDULGE ALREADY ANSWERED ABOUT THE FILES A SEARCH FOUND.
 *
 * `corpusBlockFor` hangs off `read_file`, and measured over a full night the agent barely reads files:
 * One run made 900 rounds with 863 `bash` calls against 37 `read_file`. The knowledge we spent a
 * day building was invisible for 95% of everything it looked at, and it grepped past its own answers
 * for six hours.
 *
 * Takes the RANKED FILE LIST rather than the raw output, because the tool already knows which files it
 * matched and in what order — re-parsing its own text was how the first attempt missed single-file
 * searches entirely (`grep(pattern, path=x.py)` prints bare `43: def …` lines with no path prefix,
 * since there is no ambiguity to resolve).
 *
 * DELIBERATELY THINNER THAN A READ. A read is "show me this file" and earns several answers; a search
 * scans many, and full blocks for five files would put kilobytes behind every query.
 */
const SEARCH_NOTE_FILES = 5;

export function corpusNotesForFiles(repoPath: string, files: string[]): string {
  if (!isCorpusInjection() || files.length === 0) return '';
  const out: string[] = [];
  for (const file of files.slice(0, SEARCH_NOTE_FILES)) {
    const all = chunksForFile(repoPath, file);
    if (all.length === 0) continue;
    const usable = all
      .map((c) => ({ chunk: c, state: assessChunk(repoPath, c) }))
      .filter((a) => a.state.state !== 'missing');
    if (usable.length === 0) continue;
    const { chunk } = usable[0];
    const answer = chunk.answer.length > MAX_ANSWER_CHARS
      ? `${chunk.answer.slice(0, MAX_ANSWER_CHARS)}…`
      : chunk.answer;
    out.push('');
    out.push(`${file} — ${usable.length} answered question(s) already`);
    out.push(`Q. ${chunk.question}`);
    out.push(answer);
  }
  if (out.length === 0) return '';
  log('INFO', 'corpus_notes_on_search', { files: String(out.length / 4) });
  return ['', '--- indulge already answered questions about these files ---']
    .concat(out)
    .concat(['', 'Ask corpus_search for more. Notes from an earlier pass, not the code.'])
    .join('\n');
}

export function corpusBlockFor(repoPath: string, file: string, range?: LineRange): string | null {
  if (!isCorpusInjection()) return null;
  const all = chunksForFile(repoPath, file, range);
  if (all.length === 0) return null;

  const assessed = all.map((c) => ({ chunk: c, state: assessChunk(repoPath, c) }));
  // A chunk whose cited file is gone entirely tells the agent nothing it cannot see for itself.
  const usable = assessed.filter((a) => a.state.state !== 'missing');
  if (usable.length === 0) return null;

  // Freshness breaks ties only — it must not drag an unrelated fresh chunk above the one that
  // cites the lines on screen. Overlap already ordered them; keep that order among equals.
  const rank = { fresh: 0, stale: 1, divergent: 2, missing: 3 };
  usable.sort((a, b) => {
    const ov = overlapWith(b.chunk, file, range) - overlapWith(a.chunk, file, range);
    if (ov !== 0) return ov;
    return rank[a.state.state] - rank[b.state.state];
  });

  // A four-line peek should not come back with 2.7 KB of notes attached.
  const budget = range && (range.endLine - range.startLine + 1) <= NARROW_READ_LINES ? 1 : MAX_CHUNKS;

  const lines: string[] = ['', `--- what indulge already knows about ${file} (${usable.length} answered) ---`];
  for (const { chunk, state } of usable.slice(0, budget)) {
    const answer = chunk.answer.length > MAX_ANSWER_CHARS
      ? `${chunk.answer.slice(0, MAX_ANSWER_CHARS)}…`
      : chunk.answer;
    lines.push('');
    lines.push(state.label);
    lines.push(`Q. ${chunk.question}`);
    lines.push(answer);
    lines.push(`cited: ${chunk.citations.map((c) => `${citeLabel(c)}`).join(' · ')}`);
  }
  if (usable.length > budget) {
    lines.push('');
    lines.push(`(${usable.length - budget} more answered question(s) about this file — ask corpus_search for them.)`);
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
/**
 * WHAT THIS CORPUS ACTUALLY COVERS — the half a miss was never reporting.
 *
 * A corpus is built by pointing `indulge` at named DOMAINS, and it holds those and nothing else.
 * Nothing in a miss said so, so "nothing answers this" read as a fact about the subject rather than
 * about what was indexed — and a model acted on it exactly that way, asking a game repository's
 * corpus *"what tools does ayin have for unity projects"* and taking the empty answer as evidence.
 * Two different mistakes at once: the corpus is about the repo, never about ayin, and its silence
 * only ever means "not baked", never "not so".
 *
 * Counted from the chunks rather than from the run manifest: a domain that was asked for and yielded
 * nothing is not coverage, and re-runs accumulate manifests that no longer describe what is stored.
 */
function coverageNote(chunks: Array<{ domains?: string[]; domain?: string }>): string {
  const counts = new Map<string, number>();
  for (const c of chunks) {
    for (const d of (c.domains?.length ? c.domains : [c.domain ?? ''])) {
      if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  if (!counts.size) return '';
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = top.slice(0, 10).map(([d, n]) => `${d} (${n})`).join(' · ');
  return `\nThis corpus was built for THIS REPOSITORY, over these domains and nothing else`
    + `${top.length > 10 ? ` (${top.length} in all, commonest first)` : ''}:\n  ${shown}\n`
    + `A question outside them is unanswered here because it was never indexed — that is not evidence `
    + `about the answer. Ask ayin_help about ayin's own tools; this holds only what indulge read in `
    + `this repository.`;
}

export async function corpusSearch(repoPath: string, query: string, limit = 3): Promise<string> {
  const store = openStore(repoPath);
  if (!store.exists()) {
    return 'No corpus for this repo yet — nothing has been indexed, which says nothing about the '
      + 'subject you asked about. This tool only ever answers from what a previous `ayin indulge` run '
      + 'read IN THIS REPOSITORY; it is not documentation about ayin or its tools (ask ayin_help for '
      + 'that).\nBuild one with: ayin indulge --domains "<what you are working on>"';
  }
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_.]+/u).filter((t) => t.length > 2);
  if (terms.length === 0) return 'Query too short to search on.';

  // ── cheap pass first: does the query NAME something? ──
  // An exact symbol or file match is not "probably relevant" — it is the thing that was asked
  // about, and it costs no model. Chunks carrying a matched name become the candidate set;
  // everything else is out of the race rather than merely out-ranked.
  // Rejected chunks never reach a prompt. The audit's whole purpose is that a chunk it condemned
  // stops being retrieved — leaving them in and merely marking them would mean the corpus still
  // hands the agent something already judged not worth reading.
  const all = store.chunks().filter((c) => c.qa?.verdict !== 'reject');
  const named = lookupNames(buildLexicon(all), query);

  // Only a STRONG name match may restrict the field. Measured: "how does it figure out where the
  // speech bubble points" fuzzy-matched the symbol `pathPoints` on the word "points", which then
  // gated the candidate set — so the chunk that actually answers it (the tail apex) was never
  // considered. An exact name is evidence; a fuzzy hit on an English word is a coincidence.
  const STRONG = 0.9;
  // …and a name that is a single common word may BOOST but never GATE, however exact the match.
  // `canGate` carries the reasoning and the four words that retired the denylist that used to live
  // here. Restriction is now decided by the SHAPE of the name rather than by a list of the English
  // words someone has been bitten by so far.
  const gating = named.filter((n) => n.score >= STRONG && canGate(n.handle));
  const strongIds = new Set(gating.flatMap((n) => [...n.handle.chunkIds]));
  const namedIds = new Set(named.flatMap((n) => [...n.handle.chunkIds]));   // weak hits still BOOST
  const pool = strongIds.size ? all.filter((c) => strongIds.has(c.chunkId)) : all;

  // ── vector pass, when the corpus has vectors from the model configured right now ──
  // Names narrowed the field; domains narrow it again; cosine only ranks what survived. If the
  // endpoint is down or nothing is embedded, fall through to lexical rather than failing the tool.
  let vectorNote: string | undefined;
  if (hasUsableVectors(store)) {
    try {
      const qv = await embedQuery(query);
      // A WIDER NET WHEN A RERANKER WILL NARROW IT. The cheap stages only have to get the answer
      // into the shortlist; measured, the right chunk for an assembly question sat at cosine #25, so
      // asking cosine for `limit` and stopping there is what buried it.
      const wide = rerankEnabled() ? Math.max(limit, rerankCandidates()) : limit;
      // AND NO DOMAIN GATE WHEN A RERANKER IS RANKING. Domain top-K is a RECALL filter, and putting
      // one in front of a precision filter is backwards. Measured: "what happens when a bundle
      // download fails" has its answer at cosine #1 (0.773), which reranks to 0.49 — and the gate
      // dropped it, because it picked `game mode bundles` and `reward handlers` as the top two
      // domains while that chunk sits in `changed on this branch`. The stage below then correctly
      // reported that nothing good was there, about a shortlist the best chunk never entered.
      //
      // Coarse-to-fine still holds; what changed is which stage decides. Cosine used to be final, so
      // scoping before it was both cheaper and more accurate. Now cosine only has to get the answer
      // into the window, and every filter above it can only lose.
      const hits = vectorSearch(liveVectors(store), qv, {
        limit: wide,
        within: strongIds.size ? strongIds : undefined,
        ...(rerankEnabled() ? { topDomains: Number.MAX_SAFE_INTEGER } : {}),
      });
      if (hits.length) {
        const ordered = chunksByIds(all, hits.map((h) => h.chunkId));
        if (!rerankEnabled()) {
          return render(repoPath, store, ordered.slice(0, limit), query, named, 'semantic');
        }
        const scored = await rerank(query, ordered.map((c) => `${c.question}\n\n${c.answer}`));
        // Fails open: no reranker, no reordering, and cosine's order stands.
        if (!scored.length) {
          return render(repoPath, store, ordered.slice(0, limit), query, named, 'semantic');
        }
        const floor = rerankFloor();
        const kept = scored.filter((h) => h.score >= floor).slice(0, limit);
        // NOTHING CLEARED THE FLOOR IS AN ANSWER. Cosine cannot say this — its relevant and
        // irrelevant bands are 0.017 apart — and returning the best of a bad shortlist is how a
        // corpus launders a guess into a citation. Saying so is the whole reason this stage exists.
        if (!kept.length) {
          /**
           * AND NAME WHAT IT DOES HOLD NEARBY. A refusal that reports only a number leaves the caller
           * guessing whether a different phrasing would land — reported verbatim: *"honest but leaves
           * me guessing whether a slightly different phrasing would have hit. A hint of what the
           * corpus covers would help me phrase the query."* So the closest few are listed as
           * QUESTIONS, never as answers: they did not clear the floor, and printing their answers
           * here would be the laundering this branch exists to prevent.
           */
          /**
           * A CANDIDATE THAT SCORED ZERO IS NOT A NEAR MISS. Listing the three "closest" questions
           * helps when the query nearly landed; on a query the corpus has no purchase on at all they
           * are arbitrary, and reported as such — *"so far off they add nothing"*. Under this the
           * coverage note is the honest answer on its own: not what is nearby, but what is here.
           */
          const near = scored.slice(0, 3).filter((h) => h.score > 0)
            .map((h) => `    ${h.score.toFixed(2)}  ${ordered[h.index].question}`)
            .join('\n');
          return `Nothing in the corpus answers "${query}".`
            + ` ${scored.length} candidate(s) were considered and the closest scored`
            + ` ${scored[0].score.toFixed(2)} against a floor of ${floor}.`
            + ` The corpus holds ${store.totals().chunks} answered question(s) for this repo.\n`
            + (near
              ? `The nearest it has — none of them an answer to yours, and their answers are NOT shown `
                + `for that reason. Rephrase toward one of these if it is what you meant:\n${near}\n`
              : 'Nothing scored above zero, so there is no near miss to rephrase toward.\n')
            + coverageNote(all);
        }
        return render(repoPath, store, kept.map((h) => ordered[h.index]), query, named, 'semantic');
      }
    } catch (e) {
      // SAY WHY, ON SCREEN. This catch hid a real failure for four rounds of debugging: the search
      // printed `[keyword]` with no hint that the semantic pass had been attempted and failed, so a
      // wrong answer read as a bad corpus. Lexical is still a fine fallback — a silent one is not.
      // A timeout is the case the operator most needs named: it means the embedding endpoint is slow
      // or busy, which is a fact about the machine, not about this corpus.
      const msg = e instanceof Error ? e.message : String(e);
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      log('WARN', 'corpus_vector_pass_failed', { error: msg, timedOut });
      vectorNote = timedOut
        ? `semantic pass gave up after ${Math.round(QUERY_TIMEOUT_MS / 1000)}s (embedding endpoint slow or busy)`
        : `semantic pass failed: ${msg}`;
    }
  }

  const scored = pool.map((c) => {
    const q = c.question.toLowerCase();
    const body = c.answer.toLowerCase();
    const paths = [c.entity?.file ?? '', ...c.files].join(' ').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (q.includes(t)) score += 3;        // it is a question — matching the question matters most
      if (paths.includes(t)) score += 2;    // a path is a precise handle
      if (body.includes(t)) score += 1;
    }
    // A named hit outranks any amount of word overlap: it is a different KIND of evidence.
    if (namedIds.has(c.chunkId)) score += 10;
    return { chunk: c, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);

  if (scored.length === 0) {
    return `Nothing in the corpus matches "${query}". It holds ${store.totals().chunks} answered `
      + `question(s) for this repo.\n${coverageNote(all)}`;
  }

  return render(repoPath, store, scored.map((s2) => s2.chunk), query, named, 'keyword', vectorNote);
}

/** One rendering for both passes — the agent should not be able to tell which found the chunk. */
function render(
  repoPath: string, store: ReturnType<typeof openStore>, chunks: Chunk[],
  query: string, named: NameHit[], how: 'semantic' | 'keyword', why?: string,
): string {
  // Only names that actually decided the result are named. Reporting a weak fuzzy hit as "matched
  // on: pathPoints" when the answer came from semantics tells the agent something untrue about why
  // it is looking at this chunk.
  const matchedNames = named.filter((n) => n.score >= 0.9).slice(0, 3).map((n) => n.handle.raw).join(', ');
  const out: string[] = [
    `${chunks.length} of ${store.totals().chunks} chunk(s) match "${query}" [${how}]`
    + (why ? ` — ${why}` : '') + (matchedNames ? ` (matched on: ${matchedNames})` : '') + ':',
  ];
  /**
   * A CHUNK ABOUT A DELETED FILE GOES LAST AND SAYS SO FIRST.
   *
   * The injection path above already refuses these outright — `state !== 'missing'`, twice — because
   * an answer describing code that no longer exists is not evidence. The TOOL never applied the same
   * judgement, so a search could open with a confident answer citing a file that has been gone for
   * weeks. Reported verbatim: *"The first hit cited ScoreEdit.cs which no longer exists."*
   *
   * Not filtered, because this tool is driven by someone who asked, and silently dropping the only
   * hit makes "why does it find nothing" unanswerable. Demoted and marked instead: it cannot lead,
   * and the reason arrives before the answer rather than inside a label that reads like the other
   * four staleness labels.
   */
  const assessed = chunks.map((chunk) => ({ chunk, state: assessChunk(repoPath, chunk) }));
  const gone = assessed.filter((a) => a.state.state === 'missing');
  for (const { chunk, state } of [...assessed.filter((a) => a.state.state !== 'missing'), ...gone]) {
    out.push('');
    if (state.state === 'missing') {
      out.push(`!! THE CODE THIS DESCRIBES IS GONE — ${state.gone.join(', ')} `
        + 'no longer exist(s) in this checkout. Read it as history, never as a description of the '
        + 'current code, and do not cite it.');
    }
    out.push(state.label);
    out.push(`Q. ${chunk.question}`);
    out.push(chunk.answer.length > MAX_ANSWER_CHARS ? `${chunk.answer.slice(0, MAX_ANSWER_CHARS)}\u2026` : chunk.answer);
    out.push(`cited: ${chunk.citations.map((c) => `${citeLabel(c)}`).join(' \u00b7 ')}`);
  }
  out.push('');
  out.push(gone.length
    ? `Notes from an earlier pass, not the code — and ${gone.length} of them describe files that are gone. Verify anything you act on.`
    : 'Notes from an earlier pass, not the code. Verify anything you act on.');
  return out.join('\n');
}


// ── the prompt-level sites: what the operator asked for with /embed ──────────────
//
// Retrieval on a USER PROMPT is opt-in, because a prompt is a much worse retrieval key than a file
// path: a large share of turns are `continue`, `yes`, `now the other one`, and embedding those
// returns noise with a confident score. The operator knows their intent; a cosine value guesses at
// it. The FIRST prompt of a session is the exception — it states the task, which is the one moment
// the query is reliably worth embedding.
//
// Lifetime is the TURN, not the session. The block is set before the loop and cleared after, so it
// survives every round of that turn (where the plan forms) without pinning itself into the prefix
// of every later turn, where the task has usually moved on.

let pending: string | null = null;

/** Hold a retrieved block for the turn about to run. */
export function setPendingCorpus(block: string | null): void { pending = block; }

/** Read it without consuming — the same turn spans many rounds. */
export function pendingCorpus(): string | null { return pending; }

export function clearPendingCorpus(): void { pending = null; }

/**
 * Retrieve for a user prompt, or return null when there is nothing useful to add.
 *
 * Short and anaphoric prompts are skipped outright: "continue" and "yes" carry no query, and a
 * retrieval keyed on them is noise dressed as evidence.
 */
/**
 * ASK THE MODEL WHAT TO SEARCH FOR, THEN SEARCH. Measured over 20 real runs against the
 * files the real fix touches:
 *
 *                     raw issue text     model-written query
 *     recall@2            2/20  10%           7/20  35%
 *     recall@5            2/20  10%           9/20  45%
 *     recall@10           4/20  20%          11/20  55%
 *     recall@20           6/20  30%          11/20  55%
 *
 * Both curves flatten at K=20, so this was never a ranking-depth problem — the right file was not in
 * the candidate set at all. A corpus speaks in identifiers; a bug report speaks in behaviour ("inverting
 * a log axis doesn't work", "nominal scale should draw like categorical"), and the embedding of that
 * prose lands nowhere near the implementation. The raw-text hits were exactly the issues that happened
 * to quote an identifier already — `url_for`, `content-length`, a literal `\sphinxcode{` — and nothing
 * else. One short generation turns the question into the language the corpus is written in.
 *
 * One run is the case worth remembering: four failed runs, 115 rounds of grepping for
 * `sql/compiler.py` — which was IN the corpus, unreachable from the issue text, and comes back at K=5
 * once the model names `queryset union order_by SQLCompiler`.
 *
 * Fail-soft by design: if the call errors or returns nothing usable, fall back to the prompt itself,
 * which is exactly the old behaviour and still worth 10%.
 */
const QUERY_PROMPT = 'A bug report or task description is below. Name ONLY the functions, methods, '
  + 'classes and module paths most likely involved. Output a single space-separated list of bare '
  + 'identifiers. No prose, no explanation, no markdown.\n\n---\n';

/** Enough to carry the repro snippet, which is where the identifiers usually are. */
const QUERY_SOURCE_CHARS = 1800;
/** K=10 is where recall plateaus; past it the curve is flat and the tokens are wasted. */
const PROMPT_INJECT_LIMIT = 8;

async function identifierQuery(prompt: string): Promise<string> {
  try {
    // IMPORTED LAZILY, ON PURPOSE. A top-level import of '../llm/manager.js' pulls its module
    // initialisation into every consumer of inject.ts, and `budget.ts` sizes its char budget from that
    // module's `activeContextTokens()` — check:indulge went from green to three failures about window
    // budgeting the moment the import was added, with no behavioural change to retrieval at all.
    const { llmCall } = await import('../llm/manager.js');
    const said = (await llmCall(QUERY_PROMPT + prompt.slice(0, QUERY_SOURCE_CHARS))).trim();
    // A model that answers in prose has not given us identifiers; the raw prompt is no worse.
    const flat = said.replace(/\s+/g, ' ').slice(0, 300);
    if (!flat || flat.split(' ').length > 40) return prompt;
    log('INFO', 'corpus_query_rewritten', { query: flat.slice(0, 120) });
    return flat;
  } catch (err) {
    log('WARN', 'corpus_query_rewrite_failed', { error: err instanceof Error ? err.message : String(err) });
    return prompt;
  }
}

export async function corpusForPrompt(repoPath: string, prompt: string): Promise<string | null> {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;
  const store = openStore(repoPath);
  if (!store.exists() || store.totals().chunks === 0) return null;
  const found = await corpusSearch(repoPath, await identifierQuery(prompt), PROMPT_INJECT_LIMIT);
  if (/^No corpus|^Nothing in the corpus|^Query too short/.test(found)) return null;
  return found;
}
