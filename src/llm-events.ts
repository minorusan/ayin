/**
 * LLM phase subscriber — reduces the provider's live event stream to ONE human phase for the status
 * bar: swapping → preprocessing → responding → postprocessing → (idle).
 *
 * The stream itself belongs to the provider (`LlmProvider.events`, optional, transport + reconnect
 * live there). This module owns only the reduction, because a phase is a UI fact, not a wire fact.
 *
 * A provider with no event stream is not an error and not a blank spinner — the subscription is a
 * no-op, the phase stays null, and the status bar has no phase segment at all.
 */

import { llmProvider } from './llm/select.js';
import { llmCallInFlight } from './connection.js';

export interface LlmPhase {
  phase: 'swapping' | 'preprocessing' | 'responding' | 'postprocessing' | 'done' | 'warning' | null;
  detail?: string; // e.g. the model being swapped in
  ttlMs?: number;  // transient blip (✓ done / ⚠ warning) — auto-clears in the status bar
}

type PhaseListener = (p: LlmPhase) => void;

function shortModel(model: unknown): string {
  return String(model ?? '').replace(/:.*$/, ''); // qwen3-coder:30b → qwen3-coder
}

/** event → phase reduction. Returns undefined when the event doesn't change the phase. */
export function reducePhase(type: string, payload: Record<string, unknown>): LlmPhase | undefined {
  switch (type) {
    case 'model.swap.start': return { phase: 'swapping', detail: shortModel(payload.to) };
    case 'model.swap.finish': return { phase: 'done', detail: `${shortModel(payload.to)} ready`, ttlMs: 2000 };
    case 'request.preprocess': return { phase: 'preprocessing', detail: shortModel(payload.model) };
    case 'request.start': return { phase: 'preprocessing', detail: shortModel(payload.model) };
    case 'request.responding': return { phase: 'responding', detail: shortModel(payload.model) };
    case 'request.postprocess': return { phase: 'postprocessing', detail: shortModel(payload.model) };
    case 'request.finish': {
      const ms = Number(payload.ms ?? 0);
      return { phase: 'done', detail: ms > 0 ? `${(ms / 1000).toFixed(1)}s` : undefined, ttlMs: 1500 };
    }
    case 'oom.warning': return { phase: 'warning', detail: 'context overflow risk', ttlMs: 4000 };
    // The provider says the stream died (or was stopped). Blank the phase rather than leave a stale
    // one lit over a connection that no longer exists.
    case 'stream.lost': return { phase: null };
    default: return undefined;
  }
}

/** Subscribe; returns a stop function. Safe to call on any provider. */
export function subscribeLlmPhase(onPhase: PhaseListener): () => void {
  let stopped = false;
  let stopStream: (() => void) | null = null;

  void llmProvider().then((p) => {
    if (stopped) return;
    if (!p.events) return; // no stream on this provider — the segment simply never appears
    stopStream = p.events((e) => {
      const phase = reducePhase(e.type, e.payload);
      if (phase === undefined) return;
      // ONLY OUR OWN WORK. The gateway broadcasts every caller's events — habits, other sessions,
      // anything else on the shared card — and this reduced ALL of them into this session's status
      // bar. So a finished turn kept showing `generating … 5m49s`, counting somebody else's job,
      // and an operator watching a spinner reasonably concluded their agent had hung. It had not:
      // the turn had ended nineteen seconds in. Cost: an afternoon, chasing a stall that never was.
      //
      // `stream.lost` (phase null) still passes — a dead stream must never leave a phase lit.
      if (phase.phase !== null && !llmCallInFlight()) return;
      onPhase(phase);
    });
  });

  return () => {
    stopped = true;
    stopStream?.();
    stopStream = null;
    onPhase({ phase: null });
  };
}
