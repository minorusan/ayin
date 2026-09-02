import OpenAI from 'openai';
import type { Tool } from '../base.js';
import { toolLog, toolReport } from '../runtime.js';
import {
  OPENAI_ENV_FILE, noKeyMessage, openAiSummary, readOpenAiKey, readOpenAiModel, writeOpenAiCredentials,
} from '../credentials/openai.js';

/**
 * `/openai <key>` — store the OpenAI key, after proving it works.
 *
 * No LLM extraction here, unlike `/jira-auth`: an OpenAI key has a strict, unambiguous prefix, so a
 * regex finds it in any paste and a model round would add cost and a way to be wrong.
 *
 * VERIFIED BEFORE SAVING, for the same reason as Jira: a stored-but-wrong key fails later, in the middle
 * of a task, as a 401 that nobody attributes to the moment it was typed.
 *
 * This tool does NOT switch ayin to OpenAI. Setting a credential and choosing which brain answers are
 * two decisions, and merging them is how an operator ends up billed for storing a key. `/model openai`
 * is the switch.
 */

const KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/;

/** A model name in the same paste, e.g. `/openai sk-… gpt-5.1`. */
const MODEL_RE = /\b(?:gpt|o\d|chatgpt)[A-Za-z0-9.-]*\b/i;

/**
 * `models.list()` — the cheapest call that proves a key is live, and it is free.
 *
 * Through the official SDK, same as the provider: one HTTP client, one place that knows the base URL
 * and the auth header. A hand-rolled `fetch` here would be a second definition of "how ayin talks to
 * OpenAI", and the two would drift the first time either changed.
 *
 * `maxRetries: 0` on purpose — the operator is watching, and a wrong key is not a transient failure.
 */
async function verify(key: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await new OpenAI({ apiKey: key, timeout: 20_000, maxRetries: 0 }).models.list();
    return { ok: true };
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) {
      return { ok: false, reason: 'OpenAI rejected that key (HTTP 401) — it is wrong, revoked, or from a different account.' };
    }
    if (err instanceof OpenAI.RateLimitError) {
      return { ok: false, reason: 'OpenAI returned 429 — the key is real but rate-limited or out of quota. Check billing.' };
    }
    if (err instanceof OpenAI.APIError) {
      return { ok: false, reason: `OpenAI returned HTTP ${err.status ?? '?'}: ${(err.message || '').slice(0, 200)}` };
    }
    return { ok: false, reason: `cannot reach api.openai.com: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const tool: Tool = {
  name: 'openai_auth',
  icon: '🔑',
  description:
    'Store the OpenAI API key (verified against OpenAI before saving), optionally with a model name. '
    + 'Call with no arguments to report whether a key is configured. Does not switch ayin to OpenAI — /model openai does that.',
  parameters: [
    { name: 'text', type: 'string', description: 'The key (sk-…), optionally with a model name; omit to report status', required: false },
  ],
  // SLASH-ONLY, and here it is about the ARGUMENT, not the cost.
  //
  // This tool's parameter is a credential (`secret: true` below). A tool the model can call is a tool
  // the model can be talked into calling, and its catalogue entry sits in the prompt every turn
  // teaching it that a place to put tokens exists. The operator types this one; the agent has no
  // business anywhere near it.
  slashOnly: true,
  slash: {
    command: 'openai',
    param: 'text',
    usage: '/openai <sk-…> — store your OpenAI key (verified, then saved); bare /openai reports status. Switch with /model openai',
    secret: true,
  },
  async execute(params) {
    const text = (params.text ?? '').trim();
    if (!text) {
      return readOpenAiKey()
        ? `${openAiSummary()}\nSwitch to it with /model openai.`
        : noKeyMessage();
    }

    const key = KEY_RE.exec(text)?.[0];
    if (!key) {
      return 'No OpenAI key in that text — one looks like `sk-…`. Paste the key itself.\n\n' + noKeyMessage();
    }
    const model = MODEL_RE.exec(text.replace(key, ''))?.[0] ?? readOpenAiModel();

    toolReport('openai: verifying the key against api.openai.com');
    const check = await verify(key);
    if (!check.ok) {
      toolLog().warn('openai_auth_rejected', { reason: check.reason });
      return `openai: ${check.reason}\nNothing was saved.`;
    }

    const path = writeOpenAiCredentials({ key, model });
    toolLog().info('openai_auth_saved', { model: model || '(provider default)', file: OPENAI_ENV_FILE });
    // Deliberately precise about what was proven. `models.list` authenticates the key and costs nothing,
    // but it succeeds on an account with a zero balance — measured: a freshly-issued key verified here
    // and then every completion returned 429 "You have no credits remaining". Claiming more than was
    // tested would send the operator hunting through ayin for a billing problem.
    return `openai: key authenticated ✓ (a free call — it does not prove the account has credit)\n`
      + `${openAiSummary()}\nSaved to ${path} (0600).\n`
      + `Switch to it with /model openai${model ? '' : ' — pass a model name here to pin one'}.`;
  },
};
