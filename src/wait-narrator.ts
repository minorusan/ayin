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
import { fetchCatalog, fetchGpu, type GpuInfo, type ModelCatalog, type QueueInfo } from './llm-status.js';

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

  if (q?.running) {
    const secs = Math.round(q.runningForMs / 1000);
    bits.push(q.depth > 0
      ? `⏳ GPU: ${q.running} ${secs}s · ${q.depth} waiting`
      : `▸ GPU: ${q.running} ${secs}s`);
  } else if (q && q.depth === 0 && !bits.length && gpu && gpu.util > 50) {
    bits.push(`▸ generating${cat ? ` on ${cat.loadedModel}` : ''}`);
  }

  if (!bits.length) return what;

  // The honest "why", once the wait is long enough that you deserve it.
  const why = waitedMs > WHY_AFTER_MS && q && q.depth > 0 ? ' — ayin queues last (low priority)' : '';
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
      setAgentState('thinking', compose(what, cat, tel.queue, tel.gpu, Date.now() - started));
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
