/**
 * The OPENAI provider — a hosted model for the tasks a local one struggles with.
 *
 * Everything about ayin assumes a model you host: the whole point of the port is that the agent does
 * not care what serves it. This provider is the deliberate exception, reached by `/openai` when a task
 * is worth money — a gnarly multi-file change, an unfamiliar framework, a bug that has already eaten an
 * hour locally.
 *
 * TWO THINGS THAT MAKE IT DIFFERENT FROM THE LOCAL PROVIDERS
 *
 * 1. It costs money per token, so it is never selected automatically. Not by probe, not by fallback,
 *    not because the local endpoint was briefly unreachable. A provider that can bill you is a provider
 *    you must ASK for. (`connection.ts` still has an emergency OpenAI fallback from before this file;
 *    that one is a different thing and is not this provider.)
 *
 * 2. `tools: 'native'` — the API takes function schemas and returns structured `tool_calls`, so the
 *    model never has to be taught ayin's text format, and ayin's prompt drops its tool catalogue
 *    entirely. Tool-call arguments come back as a JSON STRING here (unlike Ollama, which returns an
 *    object), which is the one shape difference worth knowing when reading `renderToolCalls`.
 *
 * WHAT IT DOES NOT IMPLEMENT: acquire / authority / telemetry / events. There is no GPU to arbitrate
 * and no queue to narrate — those segments vanish, which is honest.
 */

import type {
  GenerateOptions, GenerateResult, LlmMessage, LlmProvider, ModelCatalog, ModelEntry, ProviderStatus,
} from '../provider.js';
import { providerLog, providerConfig } from './runtime.js';

const API = 'https://api.openai.com/v1';
const GENERATE_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;

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

/** The model this session pays for, resolving config the first time anyone asks. */
function model(): string {
  if (!currentModel) currentModel = providerConfig('openAiModel') || DEFAULT_MODEL;
  return currentModel;
}

/** Env first so a shell export beats stored state; `/openai key …` writes the config copy. */
export function openAiKey(): string {
  return (process.env.OPENAI_API_KEY || providerConfig('openAiKey') || '').trim();
}

export function openAiModel(): string {
  return model();
}

interface OpenAiToolCall {
  function?: { name?: string; arguments?: string };
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }>;
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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

function toOpenAiTools(tools: GenerateOptions['tools']): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
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
        throw new Error('no OpenAI key — set one with `/openai key sk-…` or OPENAI_API_KEY, then try again.');
      }
      const body: Record<string, unknown> = {
        model: model(),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      };
      const tools = toOpenAiTools(opts?.tools);
      if (tools) body.tools = tools;

      const res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as OpenAiChatResponse;
      if (!res.ok || data.error) {
        // The message is shown to the operator, so it must not contain the key.
        throw new Error(`openai ${res.status}: ${(data.error?.message ?? 'request failed').slice(0, 300)}`);
      }
      const msg = data.choices?.[0]?.message;
      const text = msg?.content ?? '';
      const rendered = renderToolCalls(msg?.tool_calls);
      if (data.usage) {
        providerLog().info('openai_usage', {
          model: model(),
          in: String(data.usage.prompt_tokens ?? 0),
          out: String(data.usage.completion_tokens ?? 0),
        });
      }
      return { content: rendered ? (text ? `${text}\n${rendered}` : rendered) : text };
    },

    /** Never throws. No key is a normal state, not an error: the provider is simply unavailable. */
    async status(): Promise<ProviderStatus> {
      const key = openAiKey();
      if (!key) return { ok: false, model: null };
      try {
        const res = await fetch(`${API}/models`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return res.ok ? { ok: true, model: model() } : { ok: false, model: null };
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
        const res = await fetch(`${API}/models`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
        const models: ModelEntry[] = (data.data ?? [])
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
