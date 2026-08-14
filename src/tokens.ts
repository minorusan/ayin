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
export async function estimateTokens(
  messages: Array<{ role: string; content: string }>,
): Promise<TokenEstimate> {
  try {
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

  // Fallback: rough estimate, use cached context window if known.
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const cw = knownContextWindow || 65536;
  const est: TokenEstimate = {
    promptTokens: Math.ceil(totalChars / 4),
    contextWindow: cw,
    remaining: cw - Math.ceil(totalChars / 4),
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
