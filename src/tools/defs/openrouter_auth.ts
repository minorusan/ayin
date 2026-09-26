import OpenAI from 'openai';
import type { Tool } from '../base.js';
import { toolLog, toolReport } from '../runtime.js';
import { readVendorKey, readVendorModel, vendorEnvFile, writeVendorCredentials } from '../credentials/compat.js';
import { vendor } from '../../llm/vendors.js';

/**
 * `/openrouter <key>` — store the OpenRouter key, after proving it works.
 *
 * The third of these and the shape is now settled: verify before saving, never switch providers as a
 * side effect, name the next command. What differs here is what verification can usefully REPORT.
 *
 * OpenRouter's listing carries a price and a parameter list per model, so the check can answer the
 * question somebody actually has — *which of these can I use for nothing, and will they take tools?*
 * — rather than just "the key is live". A key that authenticates against 458 models it cannot drive
 * is not much of an answer.
 */

const OR = vendor('openrouter')!;

/** OpenRouter issues `sk-or-v1-…`; the looser `sk-…` still matches it, and matches nothing else here. */
const KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/;

/** A model id in the same paste, e.g. `/openrouter sk-or-… qwen/qwen3.8-27b:free`. */
const MODEL_RE = /\b[a-z0-9-]+\/[A-Za-z0-9._:-]+\b/;

interface Probe { free: number; tools: number; total: number; best: string[] }

async function verify(key: string): Promise<{ ok: true; probe: Probe } | { ok: false; reason: string }> {
  try {
    const client = new OpenAI({ apiKey: key, baseURL: OR.baseURL, timeout: 20_000, maxRetries: 1 });
    const page = await client.models.list();
    const raw = page.data as unknown as Array<Record<string, unknown>>;
    const usable = OR.pickModels ? OR.pickModels(raw) : [];
    const free = usable.filter((m) => m.parameterSize === 'FREE');
    return {
      ok: true,
      probe: {
        total: raw.length,
        tools: usable.length,
        free: free.length,
        best: free.slice(0, 5).map((m) => `${m.id}${m.ctx ? ` (${Math.round(m.ctx / 1024)}k)` : ''}`),
      },
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) return { ok: false, reason: 'that key was rejected (401). Check for a stray character.' };
    return { ok: false, reason: `cannot reach ${OR.baseURL}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * WHAT THE ACCOUNT MAY ACTUALLY DO — the lesson from DeepSeek, where a key authenticated against an
 * empty account and every completion then returned 402.
 *
 * OpenRouter publishes `/key`, free to call, and it reports the rate limit this key is ON. That is
 * the number that decides whether ayin can run a session: 50 requests a day is one or two, 1,000 is
 * twenty-five to fifty. Best-effort — a silent endpoint must not stop the key being saved.
 */
async function limits(key: string): Promise<string> {
  try {
    const res = await fetch(`${OR.baseURL}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return '';
    const body = await res.json() as { data?: Record<string, unknown> };
    const d = body.data ?? {};
    const limit = d.limit === null ? 'unlimited' : String(d.limit ?? '?');
    const usage = String(d.usage ?? '?');
    const free = d.is_free_tier === true;
    const rl = d.rate_limit as Record<string, unknown> | undefined;
    const rate = rl ? `${String(rl.requests ?? '?')} per ${String(rl.interval ?? '?')}` : '';
    return `Account: ${free ? 'FREE tier' : 'paid tier'} · credit limit ${limit} · used ${usage}`
      + (rate ? ` · rate ${rate}` : '')
      + (free
        ? `\nOn the free tier :free models are capped at 50 requests/day (20/min). An ayin session is `
          + `roughly 20-40 requests, so that is one or two sessions. Buying 10 credits once — a `
          + `lifetime threshold, not a subscription — raises it to 1,000/day.`
        : '');
  } catch {
    return '';
  }
}

function summary(): string {
  const key = readVendorKey(OR.id, OR.envKey);
  if (!key) return `${OR.label}: no key configured.`;
  const model = readVendorModel(OR.id, OR.envModel) || `${OR.defaultModel} (provider default)`;
  return `${OR.label}: key configured (…${key.slice(-4)}), model ${model}.`;
}

function setupMessage(): string {
  return `No ${OR.label} key configured.\n`
    + `  1. Sign up at https://openrouter.ai — no card required.\n`
    + `  2. Create a key at ${OR.signup}.\n`
    + `  3. Run /openrouter <key> here, or export ${OR.envKey}.\n`
    + `ayin stores it in ${vendorEnvFile(OR.id)} (0600). Then /model ${OR.id} to switch, `
    + `and /model on its own to pick from the free models.`;
}

export const tool: Tool = {
  name: 'openrouter_auth',
  icon: '🔑',
  description: '',
  parameters: [
    { name: 'text', type: 'string', description: 'The key (sk-or-…), optionally with a model id; omit to report status', required: false },
  ],
  // SLASH-ONLY: the parameter is a credential, and a tool the model can call is a tool it can be
  // talked into calling. The operator types this one.
  slashOnly: true,
  slash: {
    command: 'openrouter',
    param: 'text',
    usage: '/openrouter <sk-or-…> — store your OpenRouter key (verified, then saved); bare /openrouter reports status. Switch with /model openrouter',
    secret: true,
  },
  async execute(params) {
    const text = (params.text ?? '').trim();
    if (!text) {
      return readVendorKey(OR.id, OR.envKey)
        ? `${summary()}\nSwitch to it with /model ${OR.id}, then /model to pick a model.`
        : setupMessage();
    }

    const key = KEY_RE.exec(text)?.[0];
    if (!key) {
      return `No ${OR.label} key in that text — one looks like \`sk-or-v1-…\`. Paste the key itself.\n\n${setupMessage()}`;
    }
    const model = MODEL_RE.exec(text.replace(key, ''))?.[0] ?? readVendorModel(OR.id, OR.envModel);

    toolReport(`openrouter: verifying the key against ${OR.baseURL}`);
    const check = await verify(key);
    if (!check.ok) {
      toolLog().warn('openrouter_auth_rejected', { reason: check.reason });
      return `openrouter: ${check.reason}\nNothing was saved.`;
    }

    const account = await limits(key);
    const path = writeVendorCredentials(OR.id, OR.label, OR.envKey, OR.envModel, { key, model });
    toolLog().info('openrouter_auth_saved', {
      model: model || '(provider default)', file: path,
      free: String(check.probe.free), tools: String(check.probe.tools),
    });

    return `openrouter: key authenticated ✓\n`
      + (account ? `${account}\n` : '')
      + `${check.probe.total} model(s) listed · ${check.probe.tools} accept tools · ${check.probe.free} of those cost nothing.\n`
      + (check.probe.best.length ? `Free and tool-capable, widest context first:\n  ${check.probe.best.join('\n  ')}\n` : '')
      + `${summary()}\n`
      + `Saved to ${path} (0600).\n`
      + `Switch with /model ${OR.id}, then /model on its own to pick — free models are listed first.`;
  },
};
