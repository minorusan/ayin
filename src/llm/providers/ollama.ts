/**
 * The OLLAMA provider — ayin talking to a local model runtime directly, with no adapter and no backend
 * in between. This is the shape a stranger who clones ayin actually has: Ollama on loopback, a coder
 * model pulled, nothing else running.
 *
 * WHY THIS EXISTS, AND WHAT IT BUYS
 *
 * The tiny text contract (`providers/direct.ts`) carries messages and returns text, and nothing else.
 * That is what makes ayin model-agnostic, and it has one real cost: the request cannot declare the
 * available TOOLS, so the runtime never parses the model's native tool-call syntax. Qwen3-Coder is
 * trained to wrap calls in `<tool_call>…</tool_call>`; over the text contract that wrapper is a
 * generation boundary — measured three times, the model emitted it and generation ended there, leaving
 * a run with zero tool calls. So over that contract ayin must teach a slightly-off, un-wrapped format
 * and parse it out of prose itself.
 *
 * Talking to Ollama directly removes the constraint: `POST /api/chat` accepts a `tools` array, so the
 * runtime parses tool calls itself and returns them as structured `message.tool_calls`. The model emits
 * the syntax it was trained on, nothing is suppressed, and nothing has to be recovered from prose. That
 * is the whole reason to prefer this provider when it is available.
 *
 * The structured calls are rendered back into ayin's canonical text form on the way out, so the agent
 * loop and `parser.ts` are untouched — a provider is a transport, not a new protocol for the loop.
 *
 * ONE DOOR, STILL
 *
 * On an installation that HAS a model-serving backend with an authority layer, that backend remains the
 * door: this provider is chosen only when configured explicitly (`AYIN_LLM_PROVIDER=ollama`) or when
 * probing finds no such backend. It must never be selected in preference to a resource layer that
 * exists, because two writers on one GPU is the race the authority prevents. What it deliberately does
 * NOT implement is the give-away: no `acquire`, no `authority`, no `telemetry`, no `events` — so on a
 * single-user box those UI segments simply do not appear, which is honest, and on a shared box the
 * absence is the reason to configure the resource provider instead.
 *
 * WHAT IT DOES NOT DO
 *
 * No model *swapping* policy, no VRAM arithmetic, no queueing: `setModel` changes which model this
 * process asks for, and Ollama loads it on demand. A single-user runtime needs no arbitration, and
 * inventing some here would be a second, subtly different scheduler.
 */

import type {
  GenerateOptions, GenerateResult, LlmMessage, LlmProvider, ModelCatalog, ModelEntry, ProviderStatus,
} from '../provider.js';
import { providerLog, providerConfig, providerPendingImages, providerLlmState } from './runtime.js';

/** Loopback default: a neutral built-in that reveals nothing about any particular machine. */
const DEFAULT_URL = 'http://127.0.0.1:11434';

/** Generation ceiling. A long agent turn on a big context legitimately takes minutes. */
const GENERATE_TIMEOUT_MS = 20 * 60_000;
const PROBE_TIMEOUT_MS = 2_500;

/**
 * Sampling defaults for the family this provider is tuned for, from the Qwen3.6 model card's
 * NON-thinking table: temperature 0.7, top_p 0.8, top_k 20.
 *
 * The card also lists presence_penalty 1.5 for that mode. It is deliberately NOT here: applied to an
 * agent it suppresses tool-call syntax, which is almost entirely repeated tag vocabulary
 * (`<function=`, `<parameter=`). Measured — a run answered "let me start by checking…" and emitted no
 * call at all. The card's number is for prose; this is not prose.
 *
 * Thinking is off for the same measured reason the card explains: Qwen3.6 thinks by default and wants
 * ~128K of context to do it well. A 27B at Q4 with 128K of KV does not fit on a 24GB card, so a small
 * `num_ctx` with thinking on is the worst of both. Set `AYIN_OLLAMA_THINK=1` on a machine that can
 * afford the context.
 */
const QWEN_DEFAULTS = { temperature: 0.7, topP: 0.8, topK: 20 };

function baseUrl(): string {
  return (process.env.AYIN_OLLAMA_URL || providerConfig('ollamaUrl') || DEFAULT_URL).replace(/\/+$/, '');
}

/** The model this process asks for. Mutable via `setModel`; `''` until resolved from the runtime. */
// Env ONLY at module scope. `providerConfig` here would run before core wires the provider runtime —
// a module-scope service read is the same trap as caching a prompt bundle at import time, and it turns
// a wiring order problem into a module that cannot be loaded at all. Config is consulted in
// `resolveModel`, on first use.
let currentModel = process.env.AYIN_OLLAMA_MODEL || '';

/**
 * 16K, and bigger is a trap.
 *
 * MEASURED: across agent runs of 12, 24 and 33 tool calls, no prompt exceeded ~8K tokens — the backend
 * warns when prompt + reply reserve reaches the window and never once did at 16K. That is not luck; the
 * loop bounds its own prompt on purpose: a 12-message window, each tool result clipped to 16K chars,
 * reads capped at 800 lines, greps at 50 matches, old tool responses compressed on the way out.
 *
 * What a bigger window costs, both real:
 *  - VRAM that is no longer holding LAYERS. On a 24GB card a 27B at Q4 fits all 65 layers with a 16K
 *    KV cache and nothing to spare; when 10 layers spilled to CPU the same work ran ~7x slower. Context
 *    you do not use is bought with the thing that makes it fast.
 *  - Prefill on every round, and attention spread thinner over material the answer does not need —
 *    mid-context content is measurably the least well attended.
 *
 * Ollama's own default (2-4K depending on build) is the opposite failure: an agent turn does not fit and
 * gets silently truncated. 16K sits above the measured ceiling with room, and the knob is here for a
 * machine with VRAM to spare: `AYIN_OLLAMA_CTX`.
 */
const DEFAULT_CTX = 16_384;

function numCtx(): number {
  const raw = process.env.AYIN_OLLAMA_CTX || providerConfig('ollamaCtx');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CTX;
}

function wantsThinking(): boolean {
  return process.env.AYIN_OLLAMA_THINK === '1';
}

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> };
}

interface OllamaChatResponse {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  error?: string;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    details?: { parameter_size?: string; quantization_level?: string };
  }>;
}

/**
 * Structured tool calls → ayin's canonical text form, so the loop and parser never learn that a
 * runtime parsed them. `arguments` values arrive typed (Ollama coerces against the schema); the text
 * form is untyped, so objects are JSON-encoded and everything else stringified.
 */
function renderToolCalls(calls: OllamaToolCall[] | undefined): string {
  if (!calls?.length) return '';
  return calls
    .map((c) => {
      const args = c.function?.arguments ?? {};
      const params = Object.entries(args)
        .map(([k, v]) => `<parameter=${k}>\n${typeof v === 'string' ? v : JSON.stringify(v)}\n</parameter>`)
        .join('\n');
      return `<function=${c.function?.name ?? 'unknown'}>\n${params}\n</function>`;
    })
    .join('\n');
}

/**
 * Ollama's tool schema shape. Built from whatever the caller passes in `GenerateOptions.tools`; when it
 * passes nothing the request simply omits `tools` and the model's calls arrive as text, exactly as over
 * the HTTP contract. Declaring tools is an upgrade, never a requirement.
 */
function toOllamaTools(tools: GenerateOptions['tools']): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          t.parameters.map((p) => [p.name, { type: p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string', description: p.description }]),
        ),
        required: t.parameters.filter((p) => p.required).map((p) => p.name),
      },
    },
  }));
}

/** Resolve a model to ask for when none was configured: the one that is loaded, else the first pulled. */
async function resolveModel(): Promise<string> {
  if (currentModel) return currentModel;
  currentModel = providerConfig('ollamaModel') || '';
  if (currentModel) return currentModel;
  try {
    const ps = await fetch(`${baseUrl()}/api/ps`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (ps.ok) {
      const data = (await ps.json()) as OllamaTagsResponse;
      const loaded = data.models?.[0]?.name;
      if (loaded) {
        currentModel = loaded;
        providerLog().info('ollama_model_resolved', { model: loaded, via: 'loaded' });
        return currentModel;
      }
    }
  } catch { /* fall through to the pulled list */ }
  try {
    const tags = await fetch(`${baseUrl()}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (tags.ok) {
      const data = (await tags.json()) as OllamaTagsResponse;
      const first = data.models?.[0]?.name;
      if (first) {
        currentModel = first;
        providerLog().info('ollama_model_resolved', { model: first, via: 'first-pulled' });
      }
    }
  } catch { /* leave empty — generate() will report it clearly */ }
  return currentModel;
}

export function createOllamaProvider(): LlmProvider {
  return {
    name: 'ollama',
    // The runtime declares the tools and returns parsed calls — so the loop leaves its own tool block
    // and format instructions out of the prompt. One declaration, one format.
    tools: 'native',

    async generate(messages: LlmMessage[], opts?: GenerateOptions): Promise<GenerateResult> {
      const model = await resolveModel();
      if (!model) {
        throw new Error(
          `no model to use: ${baseUrl()} reports none pulled. Pull one (e.g. \`ollama pull qwen3-coder:30b\`) ` +
            `or set AYIN_OLLAMA_MODEL.`,
        );
      }

      // Images are attached to the LAST message, which is where the user's turn is — the same place the
      // HTTP transport puts them.
      const images = providerPendingImages();
      const body: Record<string, unknown> = {
        model,
        messages: messages.map((m, i) =>
          images.length && i === messages.length - 1 ? { ...m, images } : m,
        ),
        stream: false,
        think: opts?.thinking ?? wantsThinking(),
        options: {
          temperature: opts?.temperature ?? QWEN_DEFAULTS.temperature,
          top_p: QWEN_DEFAULTS.topP,
          top_k: QWEN_DEFAULTS.topK,
          num_ctx: numCtx(),
        },
      };
      const tools = toOllamaTools(opts?.tools);
      if (tools) body.tools = tools;

      // Mirrored, like the gateway path: a model call in flight is the single most useful fact about
      // a run that appears stuck, and it must be readable from outside the process.
      const started = Date.now();
      providerLlmState('issued', { url: `${baseUrl()}/api/chat` });
      const res = await fetch(`${baseUrl()}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      }).catch((e: unknown) => {
        providerLlmState('failed', { error: e instanceof Error ? e.message : String(e), elapsedMs: Date.now() - started });
        throw e;
      });
      providerLlmState('returned', { elapsedMs: Date.now() - started });
      if (!res.ok) {
        throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as OllamaChatResponse;
      if (data.error) throw new Error(`ollama: ${data.error}`);

      const text = data.message?.content ?? '';
      const rendered = renderToolCalls(data.message?.tool_calls);
      if (rendered) {
        providerLog().info('ollama_native_tool_calls', { count: String(data.message?.tool_calls?.length ?? 0) });
      }
      return {
        content: rendered ? (text ? `${text}\n${rendered}` : rendered) : text,
        ...(data.message?.thinking ? { reasoning: data.message.thinking } : {}),
      };
    },

    /** Liveness + which model answers. Never throws: an unreachable runtime is `{ok:false}`. */
    async status(): Promise<ProviderStatus> {
      try {
        const res = await fetch(`${baseUrl()}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return { ok: false, model: null };
        const model = await resolveModel();
        // `num_ctx` is what THIS provider puts on every request (see the generate call), so it is not
        // an estimate here — it is the window, and the meter may state it as fact.
        return { ok: true, model: model || null, contextTokens: numCtx() };
      } catch {
        return { ok: false, model: null };
      }
    },

    /** Everything pulled locally. `ctx` is omitted: Ollama does not report the window it will grant. */
    async models(): Promise<ModelCatalog | null> {
      try {
        const res = await fetch(`${baseUrl()}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return null;
        const data = (await res.json()) as OllamaTagsResponse;
        const active = await resolveModel();
        const models: ModelEntry[] = (data.models ?? []).map((m) => ({
          name: String(m.name ?? ''),
          parameterSize: m.details?.parameter_size ?? '',
          quantization: m.details?.quantization_level ?? '',
          sizeBytes: Number(m.size ?? 0),
          active: m.name === active,
        }));
        return { activeModel: active, loadedModel: active, sharedModel: '', coderModel: '', models };
      } catch {
        return null;
      }
    },

    /**
     * Switch which model this process asks for. No authority token, no swap wait: on a single-user
     * runtime the next request simply names a different model and Ollama loads it. Refuses a name it
     * cannot see, because silently keeping the old model would look like success.
     */
    async setModel(model: string): Promise<boolean> {
      const wanted = model.trim();
      if (!wanted) return false;
      const catalog = await this.models?.();
      if (catalog && catalog.models.length && !catalog.models.some((m) => m.name === wanted)) {
        providerLog().warn('ollama_set_model_unknown', { model: wanted });
        return false;
      }
      currentModel = wanted;
      providerLog().info('ollama_set_model', { model: wanted });
      return true;
    },
  };
}
