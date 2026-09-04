/**
 * indulge/qa.ts — auditing a corpus that already exists.
 *
 * Every chunk was verified at WRITE time: its citations resolve, the lines are in range, the blob
 * sha matched. That proves the answer points at real code. It does not prove the answer is worth
 * reading, and a corpus is retrieved from for months.
 *
 * Two passes, and the split is the whole design:
 *
 *   DETERMINISTIC first, and free. A question that is a JSON blob, an answer that restates its
 *   question, an entry with no citations — these are decidable without a model, and spending a
 *   model call to decide them is spending the audit's budget on the easy half. Measured on a real
 *   corpus: 2% of stored questions were raw JSON replies, every one of which this catches for
 *   nothing.
 *
 *   THE MODEL second, on what survives, in BATCHES of question+answer only. No source: the audit
 *   asks whether an answer is worth keeping, not whether it is true — truth was settled by the
 *   citation gate. Sending the file again would multiply the cost of the audit by the size of the
 *   code for a judgement that does not need it.
 *
 * Verdicts are written onto the chunk and are REVERSIBLE. Nothing is deleted here: `--fix` decides
 * what to do about a reject, and an audit that destroys evidence cannot be re-run with better
 * criteria.
 */

import { ensureToolRuntime } from '../tool-wiring.js';
import { toolLlm, toolPrompts, type ToolPrompts } from '../tools/runtime.js';

// Wired here rather than trusting that whoever imported this module already did it — `ayin indulge
// --qa` is its own entry point and loads no agent loop.
ensureToolRuntime();
import type { Chunk, IndulgeStore } from './store.js';

const indulgePrompts = (): ToolPrompts => toolPrompts('indulge');

/** Chunks per model call. Small enough that one bad reply costs little, large enough to amortise. */
const BATCH = 12;
/**
 * A non-answer, and LENGTH IS NOT HOW YOU TELL.
 *
 * This was a flat floor: under 40 characters said nothing, whatever it said. Measured right after the
 * answer prompts started asking for the fact and nothing else, that floor rejected 133 of 1,075
 * chunks — 12% of the corpus filtered out of retrieval — and every one sampled was a correct cited
 * fact: "The counter stays at 1", "It returns string.Empty", "PlayPerfect.GameModes.Rewards",
 * "The Y-coordinate value is 140f". The answer prompt says in as many words that a short answer is a
 * good answer; this rule was calling that a defect.
 *
 * The first repair kept the floor and acquitted anything holding a "concrete token" by regex. It
 * still condemned `IRuntimeGameModesLogger`, `Core` and `_gameStartCoroutine`, because a regex for
 * "looks like an identifier" is the same list-of-exceptions in another costume — and the identifiers
 * a repo will invent tomorrow are not enumerable today.
 *
 * So the rule pass now decides only what is DECIDABLE. A non-answer is one that does not commit, and
 * that is a closed set of shapes: `yes`, `no`, `it depends`, `unclear`. Whether a short but committed
 * answer is worth keeping is a judgement, and the audit already has a pass for judgement — the model
 * one, on question and answer alone. Spending the free pass on it meant guessing, and guessing here
 * deletes evidence.
 *
 * `true` and `false` are deliberately NOT here: "what is the default value of X" is answered by one
 * of them, and correctly.
 */
const NON_ANSWER = /^(yes|no|maybe|n\/?a|none|nothing|nothing known|unknown|unclear|it depends|not applicable|not specified)\.?$/i;

export function saysNothing(answer: string): boolean {
  const a = answer.trim();
  return !a || NON_ANSWER.test(a);
}

export interface QaVerdict {
  chunkId: string;
  verdict: 'ok' | 'reject';
  why?: string;
  /** Which pass decided — a deterministic reject costs nothing and should be visible as such. */
  by: 'rule' | 'model';
}

export interface QaReport {
  judged: number;
  rejected: number;
  byRule: number;
  byModel: number;
  calls: number;
  skipped: number;      // already carried a verdict
  stopped: boolean;
  reasons: Array<{ why: string; count: number }>;
}

/**
 * The free half. Returns a reason when the chunk is decidably bad, null when a model must look.
 *
 * Every rule here is one that was actually seen in a corpus, not one that seemed plausible.
 */
export function ruleReject(chunk: Chunk): string | null {
  const q = (chunk.question ?? '').trim();
  const a = (chunk.answer ?? '').trim();

  // The batch parser's old fallback filed whole JSON replies as questions. 2% of a real corpus.
  if (q.startsWith('{') || q.startsWith('[')) return 'question is a JSON blob';
  if (!q) return 'no question';
  if (q.length > 320) return 'question is an essay';
  if (!a) return 'no answer';
  if (saysNothing(a)) return 'answer says nothing';
  // A chunk with no citation cannot exist by design; one that does is corruption, not an opinion.
  if (!chunk.citations?.length) return 'no citations';
  if (a.toLowerCase() === q.toLowerCase()) return 'answer restates the question';
  return null;
}

function entriesBlock(chunks: Chunk[]): string {
  return chunks.map((c) => [
    `id: ${c.chunkId}`,
    `Q: ${c.question.replace(/\s+/g, ' ').slice(0, 400)}`,
    `A: ${c.answer.replace(/\s+/g, ' ').slice(0, 900)}`,
  ].join('\n')).join('\n\n');
}

/**
 * Parse the audit reply into rejected ids.
 *
 * Pairs are scanned positionally for the same reasons the question parser does it: duplicate keys
 * are valid JSON and silently drop everything but the last, and a truncated reply must yield what it
 * completed rather than nothing. An unparseable reply rejects NOTHING — failing open is correct for
 * an audit, because failing closed would delete a batch of good chunks on a bad reply.
 */
export function parseQaReply(reply: string, known: Set<string>): Array<{ id: string; why: string }> {
  const out: Array<{ id: string; why: string }> = [];
  const seen = new Set<string>();
  const pair = /"id"\s*:\s*"([^"]+)"\s*(?:,\s*"why"\s*:\s*"([^"]*)")?/g;
  let m: RegExpExecArray | null;
  while ((m = pair.exec(reply))) {
    const id = m[1].trim();
    // Only ids that were actually in the batch. A model that invents one must not be able to
    // condemn a chunk nobody showed it.
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, why: (m[2] ?? 'rejected by audit').trim().slice(0, 60) });
  }
  return out;
}

export interface QaOptions {
  store: IndulgeStore;
  /** Re-judge chunks that already carry a verdict. */
  again?: boolean;
  /** Rule pass only — no model, no network, instant. */
  rulesOnly?: boolean;
  limit?: number;
  onStatus?: (note: string) => void;
  onProgress?: (done: number, total: number, current: string) => void;
  shouldStop?: () => boolean;
  /** Injected by the gate so the audit can be tested without a model. */
  ask?: (prompt: string) => Promise<string>;
}

export async function runQa(opts: QaOptions): Promise<QaReport> {
  const { store, onStatus, onProgress, shouldStop } = opts;
  const report: QaReport = {
    judged: 0, rejected: 0, byRule: 0, byModel: 0, calls: 0, skipped: 0, stopped: false, reasons: [],
  };
  const reasons = new Map<string, number>();
  const note = (why: string): void => { reasons.set(why, (reasons.get(why) ?? 0) + 1); };

  const all = store.chunks();
  const todo = all.filter((c) => (opts.again ? true : !c.qa));
  report.skipped = all.length - todo.length;
  const queue = opts.limit ? todo.slice(0, opts.limit) : todo;
  onStatus?.(`${queue.length} chunk(s) to audit${report.skipped ? `, ${report.skipped} already judged` : ''}`);

  // ── the free pass ──────────────────────────────────────────────────────────────
  const survivors: Chunk[] = [];
  for (const c of queue) {
    const why = ruleReject(c);
    if (why) {
      store.setChunkQa(c.chunkId, { verdict: 'reject', why, by: 'rule' });
      report.rejected++; report.byRule++; report.judged++;
      note(why);
    } else {
      survivors.push(c);
    }
  }
  if (report.byRule) onStatus?.(`${report.byRule} rejected by rule — no model spent on them`);

  if (opts.rulesOnly) {
    report.reasons = [...reasons.entries()].map(([why, count]) => ({ why, count })).sort((a, b) => b.count - a.count);
    return report;
  }

  // ── the model pass, on what survived ───────────────────────────────────────────
  for (let i = 0; i < survivors.length; i += BATCH) {
    if (shouldStop?.()) { report.stopped = true; onStatus?.('stop requested — the rest keep their verdicts'); break; }
    const batch = survivors.slice(i, i + BATCH);
    onProgress?.(i, survivors.length, batch[0]?.entity?.file ?? '');

    let reply: string;
    try {
      const prompt = indulgePrompts().get('qaBatch', { ENTRIES: entriesBlock(batch) });
      reply = opts.ask ? await opts.ask(prompt) : await toolLlm().ask([{ role: 'user', content: prompt }]);
    } catch (err) {
      // A model that is down must not mark a batch either way. They stay unjudged and the next run
      // picks them up — an audit is resumable for the same reason the build is.
      onStatus?.(`audit failed on a batch: ${String(err).slice(0, 120)}`);
      continue;
    }
    report.calls++;

    const known = new Set(batch.map((c) => c.chunkId));
    const rejects = new Map(parseQaReply(reply, known).map((r) => [r.id, r.why]));
    for (const c of batch) {
      const why = rejects.get(c.chunkId);
      store.setChunkQa(c.chunkId, why ? { verdict: 'reject', why, by: 'model' } : { verdict: 'ok', by: 'model' });
      report.judged++;
      if (why) { report.rejected++; report.byModel++; note(why); }
    }
  }

  report.reasons = [...reasons.entries()].map(([why, count]) => ({ why, count })).sort((a, b) => b.count - a.count);
  return report;
}

export function formatQaReport(r: QaReport): string {
  const lines = [
    `${r.judged} chunk(s) audited · ${r.rejected} rejected (${r.byRule} by rule, ${r.byModel} by model)`
    + `${r.calls ? ` · ${r.calls} model call(s)` : ''}`
    + `${r.skipped ? ` · ${r.skipped} already judged` : ''}`,
  ];
  for (const { why, count } of r.reasons.slice(0, 8)) lines.push(`  ${String(count).padStart(4)}  ${why}`);
  if (r.rejected) lines.push('', 'Nothing was deleted. `ayin indulge --fix` re-answers them and re-embeds what changes.');
  return lines.join('\n');
}
