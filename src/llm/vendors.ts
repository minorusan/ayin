/**
 * llm/vendors.ts — the OpenAI-COMPATIBLE endpoints ayin can be pointed at.
 *
 * DeepSeek, Alibaba's Model Studio, Moonshot's Kimi, Groq and OpenRouter all speak the OpenAI Chat
 * Completions protocol: same request shape, same `tool_calls` reply, same SDK. So supporting them is
 * not four more providers — it is `providers/openai.ts` with a base URL, which is the one thing that
 * file hardcoded by omission (`new OpenAI({ apiKey })` with no `baseURL` can only ever reach OpenAI).
 *
 * WHAT A VENDOR IS ALLOWED TO DIFFER IN, and nothing else: where it lives, what it calls its key, and
 * which model to use when the operator has not said. A vendor needing more than that is not
 * OpenAI-compatible and does not belong in this table — it belongs in a provider of its own, the way
 * `ollama` and `direct` do.
 *
 * INSIDE `llm/`, one level above `providers/`, because a gate forbids a vendor provider importing
 * anything outside `llm/` — `../vendors.js` is inside, `../../vendors.js` is not. The credential TOOL
 * reads it too, from `tools/defs/`, which is the one direction that seam permits: a table of hostnames
 * and key names is not the LLM layer the runtime exists to hold at arm's length, and duplicating a
 * base URL between the caller and the thing that verifies the key is how the two drift apart.
 *
 * "COMPATIBLE" IS ABOUT THE REQUEST SHAPE, NOT ABOUT FEATURES. Every vendor here is documented as
 * accepting `tools`, and ayin leans on native tool calls entirely — so `probeTools` in the provider
 * asks once, rather than assuming. One documented divergence is already known: Alibaba's Model Studio
 * refuses `tools` together with `stream: true`. It costs ayin nothing because ayin does not stream,
 * and it is recorded here so the next person does not rediscover it at runtime.
 */

/** One row the model picker can show. `parameterSize` and `ctx` are what it renders beside the name. */
export interface CatalogRow {
  id: string;
  /** Rendered first in the picker's note. For a hosted model, the useful fact is the PRICE. */
  parameterSize?: string;
  ctx?: number;
}

export interface CompatVendor {
  /** What `/model <id>` and `AYIN_LLM_PROVIDER` call it. */
  readonly id: string;
  /** For messages to the operator. */
  readonly label: string;
  /**
   * The OpenAI-compatible endpoint. `undefined` means OpenAI's own, which the SDK reaches by default —
   * an explicit `https://api.openai.com/v1` would work and would also be a second place to keep it
   * right.
   */
  readonly baseURL?: string;
  /** Used when the operator has not pinned one. */
  readonly defaultModel: string;
  /** The environment variable, and the key inside this vendor's credentials file. */
  readonly envKey: string;
  /** The environment variable naming a model, for a container that wants to pin one without a file. */
  readonly envModel: string;
  /** Where the operator gets a key. Printed when there is none — a refusal that names the next step. */
  readonly signup: string;
  /**
   * TRUE when the base URL is not a constant but a property of the ACCOUNT.
   *
   * Alibaba's Model Studio embeds a workspace id in the host, so there is no value this table could
   * hold. The operator supplies the whole URL, and the field exists so the setup message can say that
   * rather than printing a template with a placeholder nobody can resolve.
   */
  readonly baseUrlIsPerAccount?: boolean;
  /**
   * WHICH MODELS TO OFFER, AND WHAT TO SAY ABOUT THEM.
   *
   * Not cosmetic. `/models` means something different at every endpoint: OpenAI lists embeddings and
   * whisper beside the chat models, OpenRouter lists 458 from every vendor alive, DeepSeek lists two.
   * A single filter cannot serve all three — the OpenAI one was `/^(gpt|o\d)/`, which is exactly
   * right for OpenAI and returns NOTHING for `deepseek-flash`.
   *
   * The vendor also knows what is worth PRINTING. OpenRouter publishes a price and a context length
   * per model, so its rows can say `free · 977k ctx` and sort the free ones to the top, which is the
   * whole difference between a list you scroll and a list you choose from.
   *
   * Absent means "offer everything the endpoint lists, sorted by name".
   */
  readonly pickModels?: (raw: ReadonlyArray<Record<string, unknown>>) => CatalogRow[];
}

/** `0` / `'0'` / `'0.0000001'` → a number, for pricing fields that arrive as strings. */
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? ''));
  return Number.isFinite(n) ? n : NaN;
};

export const VENDORS: readonly CompatVendor[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-5.6-luna',
    envKey: 'OPENAI_API_KEY',
    envModel: 'OPENAI_MODEL',
    signup: 'https://platform.openai.com/api-keys',
    // The listing carries embeddings, moderation, tts and whisper beside the chat models; none of
    // those can hold a conversation, so none belong in a picker titled "Model".
    pickModels: (raw) => raw
      .map((m) => String(m.id ?? ''))
      .filter((id) => /^(gpt|o\d)/i.test(id) && !/audio|realtime|image|tts|whisper|embed|moderation/i.test(id))
      .sort()
      .map((id) => ({ id })),
  },
  {
    /**
     * DEEPSEEK — the cheapest capable endpoint ayin can reach, by a wide margin.
     *
     * Roughly $0.09 per million input tokens on Flash, against $2–3 for a frontier model, which on
     * ayin's ~30k-token turns is a third of a cent versus ten. New accounts get a one-off grant of
     * about 10M tokens with no card, which is ~300 turns to decide whether you like it.
     *
     * `deepseek-flash` rather than `deepseek-v4-pro` as the default: the agent loop makes many cheap
     * calls rather than a few expensive ones, and a default that quietly costs 25x is the kind of
     * thing nobody notices until the bill.
     */
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    envKey: 'DEEPSEEK_API_KEY',
    envModel: 'DEEPSEEK_MODEL',
    signup: 'https://platform.deepseek.com/api_keys',
    // Two models, both usable. Nothing to filter — and the OpenAI filter above would have rejected
    // both of them for not being called `gpt-…`.
  },
  {
    /**
     * OPENROUTER — one key, 458 models, and the only free tier whose LIMITS FIT AN AGENT.
     *
     * Measured against its public `/models` endpoint: 21 models priced at zero, 18 of which accept
     * `tools`, with contexts up to 1M. Its free ceiling is 20 requests a minute and 50 a day, rising
     * to 1,000 a day once an account has bought ten credits — a one-time threshold, by "all-time
     * credits purchased", not a subscription.
     *
     * THE CAPS ARE ON REQUESTS, NOT TOKENS, and that is why it is here rather than Groq. Groq's free
     * tier is 8,000 tokens per MINUTE against an ayin turn of roughly 30,000 — one turn is four times
     * the whole budget, and its 200,000 per day works out at about six turns. A request cap suits a
     * big-prompt agent; a token cap forbids it.
     */
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    // A free model that takes tools, with the largest context of the free set at the time of writing.
    // Free models come and go on OpenRouter — the picker is the answer to that, not a constant here.
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    envKey: 'OPENROUTER_API_KEY',
    envModel: 'OPENROUTER_MODEL',
    signup: 'https://openrouter.ai/settings/keys',
    pickModels: (raw) => {
      const rows = raw
        .map((m) => {
          const id = String(m.id ?? '');
          const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.map(String) : [];
          const pricing = (m.pricing ?? {}) as Record<string, unknown>;
          const inPrice = num(pricing.prompt);
          const outPrice = num(pricing.completion);
          const free = inPrice === 0 && outPrice === 0;  // exactly zero; -1 means "unknown", not "free"
          return {
            id,
            free,
            tools: params.includes('tools'),
            ctx: Number(m.context_length) || undefined,
            // Per MILLION tokens, which is how every price in this conversation is quoted. The API
            // gives it per token, and a row reading "$0.0000005" tells nobody anything.
            // A NEGATIVE PRICE IS A SENTINEL, NOT A PRICE. `openrouter/auto` routes to whichever model
            // it picks, so its cost is unknown until afterwards and the field carries -1. Multiplied
            // out that rendered as `$-1000000.00 per M`, which is the picker confidently printing
            // nonsense. Caught against the live listing, not imagined.
            parameterSize: free
              ? 'FREE'
              : inPrice < 0 || outPrice < 0
                ? 'price varies'
                : Number.isFinite(inPrice) && Number.isFinite(outPrice)
                  ? `$${(inPrice * 1e6).toFixed(2)}/$${(outPrice * 1e6).toFixed(2)} per M`
                  : '',
          };
        })
        // NO TOOLS, NO PLACE IN THE LIST. ayin drives entirely on native tool calls, so a model that
        // cannot take a `tools` array is not a slower choice here, it is a broken one — and offering
        // it in a picker is offering a session that fails on its first move.
        .filter((r) => r.id && r.tools);
      // Free first, then widest context: the two things somebody scanning this list is deciding on.
      rows.sort((a, b) => Number(b.free) - Number(a.free) || (b.ctx ?? 0) - (a.ctx ?? 0) || a.id.localeCompare(b.id));
      return rows.map(({ id, parameterSize, ctx }) => ({ id, parameterSize, ctx }));
    },
  },
];

export function vendor(id: string): CompatVendor | null {
  return VENDORS.find((v) => v.id === id) ?? null;
}

export function isVendorId(id: string): boolean {
  return VENDORS.some((v) => v.id === id);
}

export const VENDOR_IDS: readonly string[] = VENDORS.map((v) => v.id);
