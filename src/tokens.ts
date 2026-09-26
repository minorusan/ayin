/**
 * Token estimation for the session meter.
 *
 * Tries the endpoint's exact tokenizer at `${llmBaseUrl()}/api/estimate` (same host as the LLM,
 * resolved identically — env AYIN_MODEL_URL → /set llm-url → localhost). An endpoint that does not serve
 * /api/estimate degrades gracefully to a char/4 estimate; if it is added later this picks it up for
 * free. Deliberately NO discovery of any other host: probing for a tokenizer somewhere else only
 * ever added 3s timeouts to every refresh.
 */

import { log } from './log.js';
import { llmBaseUrl } from './connection.js';
import { activeContextTokens, charsPerToken } from './llm/manager.js';
import { llmProviderName, providerOverrideName } from './llm/select.js';
import { isVendorId } from './llm/vendors.js';

export interface TokenEstimate {
  promptTokens: number;
  contextWindow: number;
  remaining: number;
}

let lastEstimate: TokenEstimate | null = null;
let knownContextWindow = 0; // cached from a successful backend estimate

export function getLastEstimate(): TokenEstimate | null {
  return lastEstimate;
}

/**
 * Estimate tokens for a set of messages. Prefers the backend's exact tokenizer, falls back to char/4.
 */
/**
 * Is the model answering us the one `llmBaseUrl()` points at?
 *
 * `/api/estimate` is the LOCAL endpoint's tokenizer, and it is only the right tokenizer when the local
 * endpoint is what is serving. Asked unconditionally it did two wrong things at once on a cloud
 * provider: it posted the whole conversation to a LAN address on every footer refresh — a 5-second
 * timeout each time when that host is asleep, in the render path — and if the box DID answer, the
 * reply described a completely different model's tokenizer and context window.
 */
function servedLocally(): boolean {
  const name = providerOverrideName() || llmProviderName();
  return !isVendorId(name);
}

export async function estimateTokens(
  messages: Array<{ role: string; content: string }>,
): Promise<TokenEstimate> {
  try {
    if (!servedLocally()) throw new Error('remote provider — the local tokenizer describes another model');
    const res = await fetch(`${llmBaseUrl()}/api/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as {
        prompt_tokens: number;
        context_window: number;
        remaining: number;
      };
      knownContextWindow = data.context_window || knownContextWindow;
      lastEstimate = {
        promptTokens: data.prompt_tokens,
        contextWindow: data.context_window,
        remaining: data.remaining,
      };
      return lastEstimate;
    }
  } catch (err) {
    log('DEBUG', 'token_estimate_fallback', { error: String(err) });
  }

  // Fallback: rough estimate on the char count — but the WINDOW is never guessed.
  //
  // This used to fall back to a hardcoded 65536, belonging to no model and no setting. Almost nothing serves
  // `/api/estimate`, so that branch was the normal path, and the meter reported 65536 for every
  // session regardless of the preset: an operator on a 16k window watched a bar promising four times
  // the room they had while the runtime truncated the prompt in silence. The meter was not merely
  // uninformative, it was consulted and wrong.
  //
  // The provider knows — the resource layer reports the active preset's `ctxSize`, and the ollama
  // provider sets `num_ctx` itself. `activeContextTokens()` is that number, and 0 means genuinely
  // unknown, which the caller must render as unknown rather than backfill.
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  /**
   * THE LIVE WINDOW WINS OVER THE CACHED ONE. `knownContextWindow` is whatever `/api/estimate` last
   * said, kept forever and never cleared — so once a local box had answered, its window outranked the
   * provider's own for the rest of the process, and switching to a cloud model left the meter
   * describing the machine under the desk. `activeContextTokens()` is re-read from the live provider
   * on every status poll and is 0 only when genuinely unknown, which is exactly when the stale value
   * is worth having as a fallback rather than as an override.
   */
  const cw = activeContextTokens() || knownContextWindow;
  /**
   * AND THE RATIO IS MEASURED, NOT FOUR. `charsPerToken()` is learned from the server's own
   * `prompt_tokens` over the session's real calls, clamped to 2.5–5.5, with a deliberately pessimistic
   * 3 until three samples land. This divided by a hardcoded 4 — a different number from the one the
   * rest of the system uses, and optimistic against every one of them, so the meter read low by
   * roughly a quarter on the one prompt it is ever asked about: the first of a session, before any
   * real usage is known.
   */
  const tokens = Math.ceil(totalChars / charsPerToken());
  const est: TokenEstimate = {
    promptTokens: tokens,
    contextWindow: cw,
    // A prompt over the window is a real state and the meter must not render it as a negative bar.
    remaining: Math.max(0, cw - tokens),
  };
  lastEstimate = est;
  return est;
}

/**
 * Estimate tokens for current session state.
 */
export async function estimateSessionTokens(
  summary: string,
  recentMessages: Array<{ role: string; content: string }>,
): Promise<TokenEstimate> {
  const messages: Array<{ role: string; content: string }> = [];
  // Always include system prompt so we get a valid estimate
  messages.push({ role: 'system', content: summary || 'You are a coding agent.' });
  for (const m of recentMessages) {
    messages.push(m);
  }
  return estimateTokens(messages);
}
