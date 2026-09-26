import OpenAI from 'openai';
import type { Tool } from '../base.js';
import { toolLog, toolReport } from '../runtime.js';
import { readVendorKey, readVendorModel, vendorEnvFile, writeVendorCredentials } from '../credentials/compat.js';
import { vendor } from '../../llm/vendors.js';

/**
 * `/deepseek <key>` — store the DeepSeek key, after proving it works.
 *
 * The sibling of `/openai`, and deliberately its twin rather than something cleverer: same regex for
 * the key, same verify-before-save, same refusal to switch providers as a side effect. DeepSeek issues
 * keys with OpenAI's `sk-` prefix and speaks the same protocol, so the one thing that differs is where
 * the request goes.
 *
 * VERIFIED BEFORE SAVING. A stored-but-wrong key fails later, mid-task, as a 401 nobody attributes to
 * the moment it was typed.
 *
 * IT DOES NOT SWITCH AYIN TO DEEPSEEK. Storing a credential and choosing which brain answers are two
 * decisions; merging them is how an operator ends up billed for saving a key. `/model deepseek` is the
 * switch.
 */

const DS = vendor('deepseek')!;

/** DeepSeek issues `sk-…` keys, same shape as OpenAI's — so the same regex finds one in any paste. */
const KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/;

/** A model name in the same paste, e.g. `/deepseek sk-… deepseek-v4-pro`. */
const MODEL_RE = /\bdeepseek[A-Za-z0-9.-]*\b/i;

/**
 * `models.list()` — the cheapest call that proves a key is live, and it is free.
 *
 * Through the official SDK with DeepSeek's base URL, same as the provider: one HTTP client, one
 * definition of the endpoint and the auth header.
 */
async function verify(key: string): Promise<{ ok: true; models: string[] } | { ok: false; reason: string }> {
  try {
    const client = new OpenAI({ apiKey: key, baseURL: DS.baseURL, timeout: 15_000, maxRetries: 1 });
    const page = await client.models.list();
    return { ok: true, models: page.data.map((m) => m.id).slice(0, 12) };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) return { ok: false, reason: 'that key was rejected (401). Check for a stray character.' };
    return { ok: false, reason: `cannot reach ${DS.baseURL}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function summary(): string {
  const key = readVendorKey(DS.id, DS.envKey);
  if (!key) return `${DS.label}: no key configured.`;
  const model = readVendorModel(DS.id, DS.envModel) || `${DS.defaultModel} (provider default)`;
  return `${DS.label}: key configured (…${key.slice(-4)}), model ${model}.`;
}

function setupMessage(): string {
  return `No ${DS.label} key configured.\n`
    + `  1. Sign up at https://platform.deepseek.com — no card required.\n`
    + `  2. Create a key at ${DS.signup}.\n`
    + `  3. Run /deepseek <key> here, or export ${DS.envKey}.\n`
    + `ayin stores it in ${vendorEnvFile(DS.id)} (0600). Then switch with /model ${DS.id}.`;
}

export const tool: Tool = {
  name: 'deepseek_auth',
  icon: '🔑',
  description: '',
  parameters: [
    { name: 'text', type: 'string', description: 'The key (sk-…), optionally with a model name; omit to report status', required: false },
  ],
  // SLASH-ONLY, and here it is about the ARGUMENT, not the cost. This tool's parameter is a
  // credential. A tool the model can call is a tool the model can be talked into calling, and its
  // catalogue entry would sit in the prompt every turn teaching it that a place to put tokens exists.
  slashOnly: true,
  slash: {
    command: 'deepseek',
    param: 'text',
    usage: '/deepseek <sk-…> — store your DeepSeek key (verified, then saved); bare /deepseek reports status. Switch with /model deepseek',
    secret: true,
  },
  async execute(params) {
    const text = (params.text ?? '').trim();
    if (!text) {
      return readVendorKey(DS.id, DS.envKey)
        ? `${summary()}\nSwitch to it with /model ${DS.id}.`
        : setupMessage();
    }

    const key = KEY_RE.exec(text)?.[0];
    if (!key) {
      return `No ${DS.label} key in that text — one looks like \`sk-…\`. Paste the key itself.\n\n${setupMessage()}`;
    }
    const model = MODEL_RE.exec(text.replace(key, ''))?.[0] ?? readVendorModel(DS.id, DS.envModel);

    toolReport(`deepseek: verifying the key against ${DS.baseURL}`);
    const check = await verify(key);
    if (!check.ok) {
      toolLog().warn('deepseek_auth_rejected', { reason: check.reason });
      return `deepseek: ${check.reason}\nNothing was saved.`;
    }

    const path = writeVendorCredentials(DS.id, DS.label, DS.envKey, DS.envModel, { key, model });
    toolLog().info('deepseek_auth_saved', { model: model || '(provider default)', file: path });
    // Precise about what was proven, the same caveat `/openai` learned: `models.list` authenticates
    // the key and costs nothing, but it succeeds on an account with no balance. Claiming more than was
    // tested sends the operator hunting through ayin for a billing problem.
    return `deepseek: key authenticated ✓ (a free call — it does not prove the account has credit)\n`
      + `${summary()}\n`
      + (check.models.length ? `Models it offers: ${check.models.join(', ')}\n` : '')
      + `Saved to ${path} (0600).\n`
      + `Switch to it with /model ${DS.id}${model ? '' : ` — it will use ${DS.defaultModel} unless you pass a model name here`}.`;
  },
};
