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
}

export const VENDORS: readonly CompatVendor[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-5.6-luna',
    envKey: 'OPENAI_API_KEY',
    envModel: 'OPENAI_MODEL',
    signup: 'https://platform.openai.com/api-keys',
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
  },
];

export function vendor(id: string): CompatVendor | null {
  return VENDORS.find((v) => v.id === id) ?? null;
}

export function isVendorId(id: string): boolean {
  return VENDORS.some((v) => v.id === id);
}

export const VENDOR_IDS: readonly string[] = VENDORS.map((v) => v.id);
