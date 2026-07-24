/**
 * LLM phase subscriber — follows the backend llm resource's live event stream
 * (GET {keliUrl}/resource/llm/events, SSE) and reduces it to one human phase for
 * the status bar: swapping → preprocessing → responding → postprocessing → (idle).
 *
 * Reconnects with backoff forever (the TUI may outlive backend restarts); a broken
 * stream simply blanks the phase — the status bar never shows a stale one.
 */

import { keliBaseUrl } from './connection.js';
import { log } from './log.js';

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
    default: return undefined;
  }
}

/** Subscribe; returns a stop function. */
export function subscribeLlmPhase(onPhase: PhaseListener): () => void {
  let stopped = false;
  let backoffMs = 2_000;

  const connectLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const res = await fetch(`${keliBaseUrl()}/resource/llm/events`, {
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        log('INFO', 'llm_events_subscribed', {});
        backoffMs = 2_000;

        let buf = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (stopped) return;
          buf += Buffer.from(chunk).toString('utf-8');
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
            if (!dataLine) continue; // heartbeat/comment
            try {
              const e = JSON.parse(dataLine.slice(6));
              const p = reducePhase(String(e.type), e.payload ?? {});
              if (p !== undefined) onPhase(p);
            } catch { /* torn frame */ }
          }
        }
        throw new Error('stream ended');
      } catch (err) {
        if (stopped) return;
        onPhase({ phase: null }); // never show a stale phase over a dead stream
        log('WARN', 'llm_events_reconnect', { error: err instanceof Error ? err.message : String(err), backoffMs: String(backoffMs) });
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  };

  void connectLoop();
  return () => { stopped = true; onPhase({ phase: null }); };
}
