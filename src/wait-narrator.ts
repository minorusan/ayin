/**
 * Why you are waiting — said out loud, while you wait.
 *
 * Every LLM call ayin makes goes through here (wired in `llm/manager.ts`), so the thinking line
 * stops saying a cheerful "Thinking··" for two minutes and instead reports the actual state of the
 * shared GPU, refreshed every 2s:
 *
 *   ▍ ⠹ thinking · ⇆ loading qwen3.6:27b (gemma4:26b still resident)          1m04s
 *   ▍ ⠹ thinking · ⏳ GPU: chatOnce 47s · 5 waiting — ayin queues last        2m11s
 *   ▍ ⠹ thinking · ▸ generating on qwen3.6:27b                                 38s
 *
 * The three things that actually cost the time, in the order you meet them:
 *   1. A MODEL SWAP. Launching ayin books the coder model, which evicts the shared one — ~17 GB
 *      out, ~16 GB in. Until it lands, the model in the status bar is a TARGET, not what's serving.
 *   2. THE QUEUE. One slot serializes every model call on the backend (chat, habits, embeddings,
 *      swaps, TTS), and ayin's calls are LOW priority — a habit that arrives later still runs
 *      first. That's why "GPU: chatOnce 47s · 5 waiting" can persist for minutes.
 *   3. GENERATION itself: 80-170s for a real prompt on a 27B at 64k context.
 *
 * Facts only, never attribution: the queue line reports what holds the card, not a guess about
 * whose job it is — we cannot know that from here, and a confident wrong answer is worse than a
 * plain one. Costs two cached read ops per 2s (the backend caches gpu 2s / models 60s), and it is
 * skipped entirely in headless mode, where nobody is watching a spinner.
 */

import { HEADLESS, setAgentState } from './ui.js';
import { fetchCatalog, fetchGpu, findOwnPlace, type GpuInfo, type ModelCatalog, type QueueInfo } from './llm-status.js';
import { currentRequestId } from './connection.js';
import { activityText } from './activity.js';

const POLL_MS = 2_000;
/** Only blame the priority band once the wait is clearly not just "the model is thinking". */
const WHY_AFTER_MS = 20_000;

function compose(what: string, cat: ModelCatalog | null, q: QueueInfo | null, gpu: GpuInfo | null, waitedMs: number): string {
  const bits: string[] = [];

  // A swap in flight is the single most misleading state: the status bar names the target model,
  // so without this you are told "qwen" while gemma is still the thing in VRAM.
  if (cat && cat.loadedModel !== cat.activeModel) {
    bits.push(`⇆ loading ${cat.activeModel} (${cat.loadedModel} still resident)`);
  }

  // OUR OWN PLACE IN LINE — the number that actually answers "why am I still waiting?". Matched by
  // the correlation id sent with this request, so it is our request, not a guess about the queue.
  const mine = findOwnPlace(q, currentRequestId());
  if (mine?.running) {
    bits.push(`▸ generating${cat ? ` on ${cat.loadedModel}` : ''}`);
  } else if (mine) {
    const behind = mine.aheadOfUs.length ? ` behind ${mine.aheadOfUs.slice(0, 2).join(', ')}${mine.aheadOfUs.length > 2 ? '…' : ''}` : '';
    bits.push(`⏳ queued #${mine.position}/${mine.of}${behind}`);
  } else if (q?.running) {
    // No tag match (older backend, or our call hasn't reached the queue yet) — report the facts.
    const secs = Math.round(q.runningForMs / 1000);
    bits.push(q.depth > 0
      ? `⏳ GPU: ${q.running} ${secs}s · ${q.depth} waiting`
      : `▸ GPU: ${q.running} ${secs}s`);
  } else if (q && q.depth === 0 && !bits.length && gpu && gpu.util > 50) {
    bits.push(`▸ generating${cat ? ` on ${cat.loadedModel}` : ''}`);
  }

  if (!bits.length) return what;

  // The honest "why", once the wait is long enough that you deserve it. Being overtaken is the
  // ayin-specific pathology: /api/generate is LOW priority, so a later habit call runs first.
  const overtaken = mine && !mine.running && mine.aheadOfUs.length > 0;
  const why = waitedMs > WHY_AFTER_MS && (overtaken || (q && q.depth > 0)) ? ' — ayin queues last (low priority)' : '';
  return `${what} · ${bits.join(' · ')}${why}`;
}

/**
 * Run `fn` while narrating the wait. The agent state stays `thinking` throughout on purpose — the
 * indicator restarts its elapsed clock on a state CHANGE, and the one number you want during a
 * two-minute wait is how long you have actually been waiting.
 */
export async function narrateWait<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (HEADLESS) return fn();

  const started = Date.now();
  let done = false;

  const tick = async (): Promise<void> => {
    if (done) return;
    try {
      const [cat, tel] = await Promise.all([fetchCatalog(), fetchGpu()]);
      if (done) return; // the call finished while we were asking — don't paint a stale reason
      // A named phase (a QA pass, plan-mode research) LEADS the line instead of being overwritten by
      // it: `QA 1/3 · reviewing 4 artifacts · ▸ generating on qwen3.6:27b`. Without this, the two
      // slowest things ayin does are indistinguishable from an ordinary turn.
      setAgentState('thinking', compose(activityText() ?? what, cat, tel.queue, tel.gpu, Date.now() - started));
    } catch { /* the reason is a nicety; never let it break the turn */ }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, POLL_MS);
  timer.unref?.();

  try {
    return await fn();
  } finally {
    done = true;
    clearInterval(timer);
  }
}
