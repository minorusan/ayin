/**
 * Connection — standalone (vendored into Maradel).
 *
 * The egregor build talked to the Keli gateway via Merkavah/Sofer. This vendored
 * copy is decoupled: the LLM call goes straight to a keli-shaped endpoint
 * (the Maradel backend's POST /api/generate, backed by gemma) selected via the
 * KELI_URL env var. No Merkavah, no Sofer, no Netzach discovery.
 */

import { setGlobalDispatcher, Agent } from 'undici';
// gemma4 with thinking on long prompts can take 10+ min; lift Node's 300s default.
setGlobalDispatcher(new Agent({ headersTimeout: 30 * 60 * 1000, bodyTimeout: 30 * 60 * 1000 }));

import { takePendingImages } from './image.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log as fileLog } from './log.js';
import { getConfigString } from './prompts.js';

/**
 * Resolve the Maradel backend (gemma) base URL, in priority order:
 *   1. KELI_URL env (set by code_agent, or by the user's shell)
 *   2. persisted per-machine config `keliUrl` in ~/.ayin-cli/prompts.json (`/set keli-url …`)
 *   3. http://localhost:9100 — ONLY correct when the backend runs on THIS machine.
 *
 * The backend + gemma live on the NUC; on a Mac/Pi/Windows box localhost is wrong, so set the
 * LAN address once (e.g. `/set keli-url http://192.168.0.229:9100`) and it sticks across runs.
 * Both the LLM call and the docs_search tool use this resolver, so they never diverge.
 */
export function keliBaseUrl(): string {
  return process.env.KELI_URL || getConfigString('keliUrl') || 'http://localhost:9100';
}

// ── Config ──────────────────────────────────────────────────────────

const LOG_DIR = join(homedir(), '.ayin-cli', 'logs');

// ── State ───────────────────────────────────────────────────────────

let connected = false;
let activeLlmController: AbortController | null = null;

type ConnectionListener = (state: 'connected' | 'disconnected') => void;
let _onStateChange: ConnectionListener = () => {};

export function onConnectionChange(fn: ConnectionListener): void {
  _onStateChange = fn;
}

export function isConnected(): boolean {
  return connected;
}

export function cancelActiveThinking(): boolean {
  if (!activeLlmController) return false;
  activeLlmController.abort();
  activeLlmController = null;
  return true;
}

// ── Init (no Merkavah/Sofer — just mark ready) ──────────────────────

export async function connect(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  connected = true;
  _onStateChange('connected');
}

export async function disconnect(): Promise<void> {
  connected = false;
}

// ── LLM call ────────────────────────────────────────────────────────

/**
 * Send structured messages to the keli-shaped endpoint (Maradel backend /api/generate → gemma).
 * Falls back to OpenAI (via openAiKey in prompts.json) when no endpoint is available.
 * Passes thinking=true when --thinking flag is active. Retries once on transient errors.
 */
export async function llmChat(
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const { THINKING_MODE } = await import('./ui.js');
  const keliUrl = await getKeliUrl();

  if (!keliUrl) {
    const openAiKey = getConfigString('openAiKey');
    if (openAiKey) {
      fileLog('INFO', 'keli_unavailable_openai_fallback', {});
      return llmChatOpenAI(messages, openAiKey);
    }
    throw new Error(
      `No reachable Maradel backend at ${keliBaseUrl()}. On another machine, point ayin at the NUC: ` +
      `set env KELI_URL=http://192.168.0.229:9100 or run \`/set keli-url http://192.168.0.229:9100\`.`,
    );
  }

  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 15_000;
  let lastErr: unknown;

  const images = takePendingImages();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    activeLlmController = controller;
    const timeout = setTimeout(() => controller.abort(), 600_000);

    try {
      const body: Record<string, unknown> = { messages, temperature: 0.7 };
      if (THINKING_MODE) body.thinking = true;
      if (images.length) body.images = images;

      const reqStart = Date.now();
      const reqBytes = JSON.stringify(body).length;
      fileLog('INFO', 'llm_fetch_start', { url: `${keliUrl}/api/generate`, attempt: String(attempt), reqBytes: String(reqBytes), images: String(images.length) });

      const res = await fetch(`${keliUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      fileLog('INFO', 'llm_fetch_headers', { status: String(res.status), elapsedMs: String(Date.now() - reqStart) });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Keli ${res.status}: ${errBody}`);
      }

      const bodyText = await res.text();
      fileLog('INFO', 'llm_body_received', { bodyBytes: String(bodyText.length), elapsedMs: String(Date.now() - reqStart) });

      let data: { content?: string; reasoning?: string };
      try {
        data = JSON.parse(bodyText) as { content?: string; reasoning?: string };
      } catch {
        const preview = bodyText.substring(0, 500);
        fileLog('ERROR', 'llm_body_parse_failed', { preview, bodyBytes: String(bodyText.length) });
        throw new Error(`Keli body parse failed (${bodyText.length}B): ${preview}`);
      }
      let text = data.content || '';
      text = text.replace(/^[\s\S]*<\/think>\s*/g, '').trim();
      fileLog('INFO', 'llm_done', { textBytes: String(text.length), elapsedMs: String(Date.now() - reqStart) });
      return text;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        msg.includes('fetch failed') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('Keli 502') ||
        msg.includes('Keli 503') ||
        msg.includes('Keli 504');

      const aborted = controller.signal.aborted && !transient;
      if (!transient || aborted || attempt >= MAX_ATTEMPTS) throw err;

      fileLog('WARN', 'llm_transient_error_retrying', { attempt: String(attempt), error: msg.substring(0, 200), waitMs: String(RETRY_DELAY_MS) });
      await new Promise<void>(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    } finally {
      clearTimeout(timeout);
      if (activeLlmController === controller) activeLlmController = null;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function llmChatOpenAI(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
): Promise<string> {
  const { getAllTools } = await import('./tools.js');

  const tools = getAllTools().map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          t.parameters.map(p => [p.name, { type: p.type === 'number' ? 'number' : 'string', description: p.description }])
        ),
        required: t.parameters.filter(p => p.required).map(p => p.name),
      },
    },
  }));

  const controller = new AbortController();
  activeLlmController = controller;
  const timeout = setTimeout(() => controller.abort(), 600_000);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4.1', messages, tools, tool_choice: 'auto' }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI ${res.status}: ${body}`);
    }

    type OAIMessage = {
      content: string | null;
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
    };
    const data = await res.json() as { choices: Array<{ message: OAIMessage }> };
    const msg = data.choices[0]?.message;
    const text = msg?.content || '';

    const tc = msg?.tool_calls?.[0];
    if (tc) {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      const paramLines = Object.entries(args)
        .map(([k, v]) => `<parameter=${k}>\n${String(v)}\n</parameter>`)
        .join('\n');
      const xml = `<function=${tc.function.name}>\n${paramLines}\n</function>`;
      return text ? `${text}\n${xml}` : xml;
    }

    return text;
  } finally {
    clearTimeout(timeout);
    if (activeLlmController === controller) activeLlmController = null;
  }
}

/** Simple single-prompt call (for summarizer etc.) */
export async function llmCall(prompt: string): Promise<string> {
  return llmChat([{ role: 'user', content: prompt }]);
}

// ── Keli endpoint discovery (KELI_URL override; default Maradel backend) ─────

let _keliUrl: string | null = null;

async function getKeliUrl(): Promise<string | null> {
  if (_keliUrl) return _keliUrl;

  const override = keliBaseUrl();
  try {
    const check = await fetch(`${override}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (check.ok) {
      _keliUrl = override;
      fileLog('INFO', 'keli_url_resolved', { url: override });
      return override;
    }
  } catch { /* no endpoint */ }
  return null;
}

// ── Stubs for the egregor-only surface (no Merkavah in standalone mode) ──────

export async function sendRequest<TReq = unknown, TRes = unknown>(
  _request: unknown,
): Promise<TRes> {
  throw new Error('sendRequest: remote session sync is disabled in the standalone (Maradel) build');
}
