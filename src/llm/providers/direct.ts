/**
 * The DIRECT provider — ayin's public default, and the whole of the public story.
 *
 * It speaks only the tiny HTTP contract ayin has always spoken (see docs/ARCHITECTURE.md → "LLM
 * connection", and `examples/ollama-adapter.mjs`, which implements it on top of a plain Ollama):
 *
 *     POST {endpoint}/api/generate   { messages, temperature?, thinking?, images? } → { content }
 *     GET  {endpoint}/api/status                                                    → { ok, model }
 *
 * That is two endpoints, and they map exactly onto the two REQUIRED methods of the port. Everything
 * else — authorities, model swapping, GPU telemetry, an event stream — is simply not offered, so
 * every consumer hides the corresponding UI. No queue line, no `/lock`, no GPU readout, no error.
 *
 * The one extra it does offer is `models()`, because it is FREE over this contract: `/api/status`
 * already names the model that is answering, so the catalog is that one model. It costs nothing,
 * it keeps the status bar honest ("⬡ qwen3-coder:30b"), and it cannot mislead — with no `setModel`
 * the picker refuses to pretend the model can be changed from here.
 *
 * NEVER add a direct model-runtime call (an Ollama port, an nvidia-smi shell-out) to this file. The
 * provider talks to the CONFIGURED endpoint; bridging that endpoint to a runtime is the adapter's
 * job, and keeping it that way is what makes the one-door discipline hold for private installs too.
 */

import { llmBaseUrl, llmChat as transportChat } from '../../connection.js';
import type {
  GenerateOptions, GenerateResult, LlmMessage, LlmProvider, ModelCatalog, ProviderStatus,
} from '../provider.js';

/**
 * Generation, for every provider: straight through the shared transport, which owns the retry, the
 * 20-minute ceiling, the pending-image attach and the OpenAI fallback. A provider that reimplemented
 * any of that would be a second, subtly different LLM path — exactly the drift this port removes.
 */
export async function httpGenerate(messages: LlmMessage[], opts?: GenerateOptions): Promise<GenerateResult> {
  const content = await transportChat(messages, opts ?? {});
  return { content };
}

/** `GET /api/status`, for every provider. Never throws — an unreachable endpoint is `{ok:false}`. */
export async function httpStatus(): Promise<ProviderStatus> {
  try {
    const res = await fetch(`${llmBaseUrl()}/api/status`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return { ok: false, model: null };
    const data = await res.json() as { model?: string };
    const model = String(data.model ?? '');
    return { ok: true, model: model || null };
  } catch {
    return { ok: false, model: null };
  }
}

/**
 * A catalog of one, derived from the required status read. Cached, because the status poll and the
 * wait narrator both ask for it on a short interval and the answer changes about never.
 */
const CATALOG_TTL_MS = 30_000;
let cached: { at: number; catalog: ModelCatalog | null } | null = null;

async function models(opts: { force?: boolean } = {}): Promise<ModelCatalog | null> {
  if (!opts.force && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog;
  const s = await httpStatus();
  const catalog: ModelCatalog | null = s.ok && s.model
    ? {
      activeModel: s.model,
      loadedModel: s.model, // nothing can be mid-swap over this contract — never claim otherwise
      sharedModel: '',
      coderModel: '',
      models: [{ name: s.model, parameterSize: '', quantization: '', sizeBytes: 0, active: true }],
    }
    : null;
  cached = { at: Date.now(), catalog };
  return catalog;
}

export function createDirectProvider(): LlmProvider {
  return {
    name: 'direct',
    generate: httpGenerate,
    status: httpStatus,
    models,
    // No setModel / acquire / authority / telemetry / events — deliberately. See the header.
  };
}
