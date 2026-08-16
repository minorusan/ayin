/**
 * The OPENAI provider — the one ayin can run on with nothing but a key.
 *
 * Everything else about ayin assumes a model you host: the whole point of the port is that the agent
 * does not care what serves it. This provider is the exception that makes the repo testable — a clone
 * with no GPU, no runtime and no model download works as soon as `/openai sk-…` succeeds, which is why
 * it is the default when nothing else is configured (`select.ts`).
 *
 * ON THE OFFICIAL SDK (`openai`, a runtime dependency), not hand-rolled HTTP. One client means one
 * definition of the base URL, the auth header, retry policy and error shape. There WAS a second,
 * hand-rolled path — an "emergency fallback" in `connection.ts` that fired when no local endpoint
 * answered — and being a second definition is exactly how it rotted: it pinned `gpt-4.1`, honoured only
 * the FIRST tool call in a reply, and sidestepped the gate forbidding a stale model default by living
 * in another file. It is gone, and a gate now forbids any hand-rolled request to the API.
 *
 * THREE THINGS THAT MAKE IT DIFFERENT FROM THE LOCAL PROVIDERS
 *
 * 1. It costs money per token, so it is never ESCALATED to. It may be the default when nothing is
 *    configured, and it may be chosen with `/model openai` — but a configured endpoint that is merely
 *    unreachable falls back to `direct`, never here. A slow local service must not become a bill.
 *
 * 2. `tools: 'native'` — the API takes function schemas and returns structured `tool_calls`, so the
 *    model never has to be taught ayin's text format, and ayin's prompt drops its tool catalogue
 *    entirely. Tool-call arguments come back as a JSON STRING here (unlike Ollama, which returns an
 *    object), which is the one shape difference worth knowing when reading `renderToolCalls`.
 *
 * 3. The key arrives through the provider runtime (`providerCredential`), so this file does not know
 *    where credentials live — the same seam that keeps `config` and `log` out of here.
 *
 * WHAT IT DOES NOT IMPLEMENT: acquire / authority / telemetry / events. There is no GPU to arbitrate
 * and no queue to narrate — those segments vanish, which is honest.
 */

import OpenAI from 'openai';
import type {
  GenerateOptions, GenerateResult, LlmMessage, LlmProvider, ModelCatalog, ModelEntry, ProviderStatus,
} from '../provider.js';
import { providerLog, providerCredential } from './runtime.js';

const GENERATE_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Retries, by the SDK. Two, because ayin's own callers already retry the AGENT round: a transient 429
 * retried at both layers multiplies into a wait the operator reads as a hang.
 */
const MAX_RETRIES = 2;

/**
 * The client, rebuilt when the key changes.
 *
 * `/openai` can store a new key mid-session, so a client captured once would keep authenticating with
 * the old one until restart — a "the key I just set does nothing" bug with no visible cause. Keyed on
 * the key itself rather than invalidated by a callback: there is then no state to forget to update.
 */
let cached: { key: string; client: OpenAI } | null = null;

function client(key: string): OpenAI {
  if (cached?.key === key) return cached.client;
  cached = { key, client: new OpenAI({ apiKey: key, timeout: GENERATE_TIMEOUT_MS, maxRetries: MAX_RETRIES }) };
  return cached.client;
}

/**
 * Embeddings, through the SAME client as generation.
 *
 * Here rather than in `indulge/embed.ts` because this module is the ONE place that holds the key,
 * constructs the client, and renders SDK errors safely — a hand-rolled `fetch` to api.openai.com
 * elsewhere re-implements all three, and the gate rejects one on sight for exactly that reason.
 *
 * ORDER IS THE CONTRACT. The API returns `data[]` carrying an `index`; it is sorted by it here
 * rather than trusted, because a vector attached to the wrong chunk is undetectable afterwards —
 * every distance in the corpus would be subtly wrong, nothing would error, and retrieval would
 * quietly return the wrong neighbours forever.
 */
export async function openAiEmbed(texts: string[], embedModel: string): Promise<number[][]> {
  if (!texts.length) return [];
  const key = openAiKey();
  if (!key) throw new Error(openAiSetupHint());
  try {
    const res = await client(key).embeddings.create({ model: embedModel, input: texts });
    const rows = res.data.slice().sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length) {
      throw new Error(`OpenAI returned ${rows.length} vector(s) for ${texts.length} input(s)`);
    }
    return rows.map((r) => {
      if (!Array.isArray(r.embedding) || !r.embedding.length) throw new Error('OpenAI returned an empty vector');
      return r.embedding as number[];
    });
  } catch (err) {
    throw new Error(describe(err));
  }
}

/**
 * An SDK error, made safe to show. `APIError` carries the status and the API's own message, which is
 * what an operator needs ("insufficient_quota", "model not found") — but it is rendered here rather
 * than thrown raw so nothing in it can carry the request headers, and therefore the key.
 */
function describe(err: unknown): string {
  if (err instanceof OpenAI.APIError) {
    const detail = (err.message || 'request failed').slice(0, 300);
    return err.status === 401
      ? `openai 401: the key was rejected — it is wrong, revoked, or from another account. Re-set it with /openai.`
      : `openai ${err.status ?? '?'}: ${detail}`;
  }
  return `openai: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Default model, and it is a JUDGEMENT not a constant: this file will rot the moment the lineup moves.
 *
 * As of 2026-08: the flagships are GPT-5.6 (Sol $5/$30, Terra $2/$12, Luna $0.20/$1.20) and GPT-5.5
 * ($5/$30, 1M context); GPT-5.4 ($2.50/$15) is the general-work tier with Mini/Nano/Pro variants, and
 * GPT-5.3 Codex is the coding-specialised one. `gpt-5.5` is the default because this provider exists
 * for the hard cases — paying for the cheap tier on a task the local model already failed is the worst
 * of both. Override per session with `/openai <model>` or `AYIN_OPENAI_MODEL`.
 *
 * Check the lineup before trusting this comment. A stale model default is how a coding agent ends up
 * calling a two-generation-old model at full price.
 */
const DEFAULT_MODEL = 'gpt-5.5';

// Env ONLY at module scope — see the same note in `ollama.ts`. `model()` resolves config on first use.
let currentModel = process.env.AYIN_OPENAI_MODEL || '';

/** The model this session pays for, resolving stored state the first time anyone asks. */
function model(): string {
  if (!currentModel) currentModel = providerCredential('openai').model || DEFAULT_MODEL;
  return currentModel;
}

/** The key, from wherever core keeps it. This file does not know, and must not. */
export function openAiKey(): string {
  return providerCredential('openai').key.trim();
}

/** What to tell the operator when there is no key — core owns the wording, since core owns the store. */
export function openAiSetupHint(): string {
  return providerCredential('openai').setupHint;
}

export function openAiModel(): string {
  return model();
}

/**
 * Read structurally rather than as the SDK's tool-call union: newer API versions add call kinds
 * (custom tools, and whatever comes next) and a narrow type would make an unknown kind a COMPILE
 * error in a file that should simply skip it. Only `function` calls mean anything to ayin.
 */
interface OpenAiToolCall {
  function?: { name?: string; arguments?: string };
}

/**
 * Structured calls → ayin's canonical text form, so the loop and parser never learn who parsed them.
 * `arguments` is a JSON STRING here; a model occasionally emits invalid JSON in it, and that must not
 * take the turn down — a malformed call is reported as text the model can see and correct.
 */
function renderToolCalls(calls: OpenAiToolCall[] | undefined): string {
  if (!calls?.length) return '';
  return calls
    .map((c) => {
      const name = c.function?.name ?? 'unknown';
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function?.arguments || '{}') as Record<string, unknown>;
      } catch {
        return `<function=${name}>\n<parameter=_malformed>\n${c.function?.arguments ?? ''}\n</parameter>\n</function>`;
      }
      const params = Object.entries(args)
        .map(([k, v]) => `<parameter=${k}>\n${typeof v === 'string' ? v : JSON.stringify(v)}\n</parameter>`)
        .join('\n');
      return `<function=${name}>\n${params}\n</function>`;
    })
    .join('\n');
}

function toOpenAiTools(tools: GenerateOptions['tools']): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          t.parameters.map((p) => [
            p.name,
            { type: p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string', description: p.description },
          ]),
        ),
        required: t.parameters.filter((p) => p.required).map((p) => p.name),
      },
    },
  }));
}

export function createOpenAiProvider(): LlmProvider {
  return {
    name: 'openai',
    // The API declares the tools, so ayin's prompt must not also carry a catalogue and a format.
    tools: 'native',

    async generate(messages: LlmMessage[], opts?: GenerateOptions): Promise<GenerateResult> {
      const key = openAiKey();
      if (!key) {
        // The full setup instructions, not a hint: this throw is what a fresh clone hits on its very
        // first prompt, and it is the one error where the reader has no context to fall back on.
        throw new Error(openAiSetupHint());
      }
      const tools = toOpenAiTools(opts?.tools);
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await client(key).chat.completions.create({
          model: model(),
          messages: messages.map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: m.content,
          })),
          ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(tools ? { tools } : {}),
        });
      } catch (err) {
        throw new Error(describe(err));
      }

      const msg = completion.choices?.[0]?.message;
      const text = msg?.content ?? '';
      const rendered = renderToolCalls(msg?.tool_calls as OpenAiToolCall[] | undefined);
      if (completion.usage) {
        providerLog().info('openai_usage', {
          model: model(),
          in: String(completion.usage.prompt_tokens ?? 0),
          out: String(completion.usage.completion_tokens ?? 0),
        });
      }
      return { content: rendered ? (text ? `${text}\n${rendered}` : rendered) : text };
    },

    /** Never throws. No key is a normal state, not an error: the provider is simply unavailable. */
    async status(): Promise<ProviderStatus> {
      const key = openAiKey();
      if (!key) return { ok: false, model: null };
      try {
        // A status poll must never wait the generate timeout, so the probe overrides it per request.
        await client(key).models.list({ timeout: PROBE_TIMEOUT_MS, maxRetries: 0 });
        return { ok: true, model: model() };
      } catch {
        return { ok: false, model: null };
      }
    },

    /**
     * The chat-capable models on this account. `sizeBytes` is 0 — a hosted model has no size, and the
     * picker treats 0 as "unknown, always show" rather than filtering it out as a tiny sidecar.
     */
    async models(): Promise<ModelCatalog | null> {
      const key = openAiKey();
      if (!key) return null;
      try {
        const list = await client(key).models.list({ timeout: PROBE_TIMEOUT_MS, maxRetries: 0 });
        const models: ModelEntry[] = list.data
          .map((m) => String(m.id ?? ''))
          .filter((id) => /^(gpt|o\d)/i.test(id) && !/audio|realtime|image|tts|whisper|embed|moderation/i.test(id))
          .sort()
          .map((id) => ({ name: id, parameterSize: 'hosted', quantization: '', sizeBytes: 0, active: id === model() }));
        return { activeModel: model(), loadedModel: model(), sharedModel: '', coderModel: '', models };
      } catch {
        return null;
      }
    },

    /** Switch which hosted model this session pays for. Accepts any id the account can list. */
    async setModel(model: string): Promise<boolean> {
      const wanted = model.trim();
      if (!wanted) return false;
      currentModel = wanted;
      providerLog().info('openai_set_model', { model: wanted });
      return true;
    },
  };
}
