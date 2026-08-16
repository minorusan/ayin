/**
 * indulge/budget.ts — how much source a prompt may carry, derived from the model that will read it.
 *
 * This was two constants: 50,000 characters of sources per answer and 12,000 per question frame.
 * Both were wrong in both directions at once, which is what a constant does when the provider is a
 * setting.
 *
 * AGAINST A 16k LOCAL MODEL, 50,000 characters is roughly 14k tokens BEFORE the instructions and
 * with nothing left for the reply. The runtime does not error on that — it truncates, silently, from
 * whichever end it likes, so the model answers about sources it was never shown and the citation
 * gate then rejects it for claims it could not prove. Measured: answers took ~45s each against a
 * 16k-context model, prompt-processing-bound, on prompts that partly did not fit.
 *
 * AGAINST OPENAI it is the opposite waste: a 128k window filled to 11%, so a question whose answer
 * lives two files away gets neither file.
 *
 * So the budget follows the model. Chars rather than tokens because every producer here is
 * concatenating source text and a tokenizer call per candidate file would cost more than the slack
 * this approximation leaves.
 */

import { getConfigString } from '../prompts.js';
import { activeContextTokens } from '../llm/manager.js';

/**
 * Characters per token, for code.
 *
 * Deliberately pessimistic: 3.0 rather than the ~3.8 English averages, because source is dense in
 * punctuation and identifiers that split into several tokens each. Guessing high here means
 * overflowing the window, which fails silently — guessing low only wastes a little room.
 */
const CHARS_PER_TOKEN = 3.0;

/**
 * Share of the window the sources may occupy.
 *
 * The rest is the instructions, the question, and — the part that is easy to forget — the model's own
 * reply, which comes out of the same window on a local runtime.
 */
const SOURCE_SHARE = 0.55;

/** What OpenAI models here can actually hold. Conservative: the smallest of the ones worth using. */
const OPENAI_CONTEXT_TOKENS = 128_000;
/** Local default, matching providers/ollama.ts. Overridden by AYIN_OLLAMA_CTX / config. */
const LOCAL_DEFAULT_TOKENS = 16_384;

/** True when generation is going to OpenAI rather than a self-hosted endpoint. */
export function generatingOnOpenAi(): boolean {
  const p = (process.env.AYIN_LLM_PROVIDER || getConfigString('llmProvider') || '').toLowerCase();
  return p === 'openai';
}

/**
 * The context window, in tokens, of whatever will read the next prompt.
 *
 * PREFERS WHAT THE PROVIDER REPORTS. `AYIN_OLLAMA_CTX` / `ollamaCtx` describe the *ollama* provider's
 * own request, and on a resource-layer backend they describe nothing at all — the window there is set
 * by the active preset, which the operator changes without touching any ayin config. Reading only the
 * local setting meant this returned 16384 while the preset granted 40000: every budget derived from
 * it was sized for a window less than half the real one, and the operator had no way to tell.
 */
export function contextTokens(): number {
  if (generatingOnOpenAi()) return OPENAI_CONTEXT_TOKENS;
  const reported = activeContextTokens();
  if (reported > 0) return reported;
  const raw = process.env.AYIN_OLLAMA_CTX || getConfigString('ollamaCtx');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : LOCAL_DEFAULT_TOKENS;
}

/**
 * Characters of SOURCE a prompt may carry.
 *
 * Capped at 300k regardless of window: past that the limit stops being the model and starts being
 * the reader — a prompt nobody can audit, and a retrieval step that has stopped retrieving and
 * started dumping the repo.
 */
export function sourceBudgetChars(): number {
  return Math.min(300_000, Math.floor(contextTokens() * CHARS_PER_TOKEN * SOURCE_SHARE));
}

/**
 * Characters of ONE file a question-generation prompt may carry.
 *
 * Smaller than the answer budget on purpose: generation shows a single file and asks what is worth
 * asking about it, so a file too large to fit is a file whose questions should come from its shape
 * rather than its every line.
 */
export function singleFileBudgetChars(): number {
  return Math.max(4_000, Math.floor(sourceBudgetChars() * 0.45));
}

/**
 * How many questions about ONE file go in a single answer call.
 *
 * This is where the night goes. Answering was one call per question, each re-sending the whole
 * source: on a real run, 847 answers at 17–45s each. The sources are identical for every question
 * about the same file, so sending them once and asking ten questions costs one prompt instead of ten
 * — the model is doing the work either way, it was simply being spoon-fed one bite at a time.
 *
 * Scaled by window, because the limit is the REPLY: every answer in a batch comes out of the same
 * output budget, and a batch large enough to truncate the last answers is worse than no batching at
 * all. Roughly one question per 1.5k tokens of window above the sources, floored at 1 so a small
 * local model keeps exactly today's behaviour.
 */
export function answerBatchSize(): number {
  const spare = contextTokens() * (1 - SOURCE_SHARE);
  return Math.max(1, Math.min(24, Math.floor(spare / 1500)));
}

/**
 * How many CATEGORIES ride in one question-generation call.
 *
 * Generation is one call per (file, category), and on a real run that was 1,053 calls against ~35
 * for all the answering combined — 30× everything else. The source is identical across categories
 * for a given file, so on a window with room they go together and the file is sent once.
 *
 * Kept at 1 on a small window deliberately. Each category carries its own FOCUS prompt, and stacking
 * several framings beside the source in a 16k context is how you get questions that belong to no
 * category in particular. The merge is a big-window optimisation, not a better idea.
 */
export function categoryBatchSize(): number {
  return contextTokens() >= 60_000 ? 4 : 1;
}
