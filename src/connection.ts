/**
 * Connection — the HTTP edge. ONE configured endpoint, no discovery.
 *
 * Every LLM call goes to `POST <endpoint>/api/generate`; the endpoint comes from the `AYIN_LLM_URL`
 * env var, else `/set llm-url`, else loopback. There is no service mesh, no registry, nothing to look
 * up: if the endpoint is wrong the call fails loudly instead of silently probing alternatives.
 */

import { setGlobalDispatcher, Agent } from 'undici';
// gemma4 with thinking on long prompts can take 10+ min; lift Node's 300s default.
setGlobalDispatcher(new Agent({ headersTimeout: 30 * 60 * 1000, bodyTimeout: 30 * 60 * 1000 }));

/**
 * The id of the generation currently in flight, so the wait narrator can locate it in the backend's
 * GPU queue and report a real position. Module-level because the narrator watches from the side —
 * threading it through every call site would touch the whole agent loop for a status string.
 */
let inFlightRequestId = '';
function setInFlightRequestId(id: string): void { inFlightRequestId = id; }
export function currentRequestId(): string { return inFlightRequestId; }

/**
 * The authority token of a LOCKED session (`/lock`), or '' when unlocked.
 *
 * Sent with every generation so the backend can put this session at the FRONT of the shared GPU
 * queue: `/api/generate` is LOW priority by default (background agent work must yield to a human),
 * and the token is what proves we are entitled to more. Asking for priority without the token is
 * ignored — otherwise any client could promote itself past user chat.
 *
 * Set from model-picker.ts on lock/unlock; kept module-level to avoid an import cycle
 * (model-picker → resource-client → connection).
 */
let lockAuthority = '';
export function setRequestAuthority(token: string): void { lockAuthority = token; }
export function currentRequestAuthority(): string { return lockAuthority; }

import { takePendingImages } from './image.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log as fileLog } from './log.js';
import { getConfigString, setConfigValue } from './prompts.js';

/**
 * Resolve the LLM endpoint's base URL — the ONE place, so no two call sites can disagree.
 *
 * Priority order:
 *   1. `AYIN_LLM_URL` env (set by a dispatcher, or by your shell)
 *   2. `KELI_URL` env — **DEPRECATED**, still honoured (see below)
 *   3. persisted per-machine config `llmUrl` in ~/.ayin-cli/prompts.json (`/set llm-url …`)
 *   4. persisted `keliUrl` — **DEPRECATED**, still honoured
 *   5. http://localhost:9100 — ONLY correct when the endpoint runs on THIS machine.
 *
 * RENAMED in 1.0.220. The old names were `KELI_URL` / `keliUrl` / `/set keli-url`, after a private
 * service on the author's network — a fact about one machine baked into a public repo, and meaningless
 * to anyone else reading it. The new names say what the value is.
 *
 * Both old spellings keep working, deliberately and indefinitely-until-noticed: an env var lives in
 * people's shells, systemd units, launchd plists and CI files that this repo cannot reach, so breaking
 * it would strand a working install with a confusing "no reachable endpoint" error. Using an old name
 * logs `deprecated_endpoint_name` once per process so the transition is visible without being noisy.
 */
let _deprecationLogged = false;

function noteDeprecated(which: string, replacement: string): void {
  if (_deprecationLogged) return;
  _deprecationLogged = true;
  fileLog('WARN', 'deprecated_endpoint_name', { used: which, use: replacement });
}

export function llmBaseUrl(): string {
  if (process.env.AYIN_LLM_URL) return process.env.AYIN_LLM_URL;
  if (process.env.KELI_URL) {
    noteDeprecated('KELI_URL', 'AYIN_LLM_URL');
    return process.env.KELI_URL;
  }
  const configured = getConfigString('llmUrl');
  if (configured) return configured;
  const legacy = getConfigString('keliUrl');
  if (legacy) {
    noteDeprecated('config keliUrl', '/set llm-url');
    migrateLegacyConfigKey(legacy);
    return legacy;
  }
  return 'http://localhost:9100';
}

/**
 * Copy a pre-1.0.220 `keliUrl` forward to `llmUrl`, once per process, the first time we actually read
 * it. A config file is OURS to keep current — leaving the old key as the only source means every future
 * run takes the deprecated path forever, and the operator never learns the setting was renamed.
 * Idempotent (the next run finds `llmUrl` and never reaches here) and best-effort: a failed write just
 * means we migrate again next time, never that the endpoint stops resolving.
 */
let _migrated = false;
function migrateLegacyConfigKey(value: string): void {
  if (_migrated) return;
  _migrated = true;
  try {
    setConfigValue('llmUrl', value);
    fileLog('INFO', 'migrated_config_key', { from: 'keliUrl', to: 'llmUrl' });
  } catch {
    /* stays on the legacy key; retried next process */
  }
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

// ── Init (nothing to negotiate — just mark ready) ──────────────────────

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
 * Send structured messages to the configured endpoint (`POST /api/generate`).
 * Falls back to OpenAI (via openAiKey in prompts.json) when no endpoint is available.
 * Passes thinking=true when --thinking flag is active. Retries once on transient errors.
 */
export async function llmChat(
  messages: Array<{ role: string; content: string }>,
  opts: { temperature?: number; thinking?: boolean } = {},
): Promise<string> {
  const { THINKING_MODE } = await import('./ui.js');
  const llmUrl = await getLlmUrl();

  if (!llmUrl) {
    const openAiKey = getConfigString('openAiKey');
    if (openAiKey) {
      fileLog('INFO', 'endpoint_unavailable_openai_fallback', {});
      return llmChatOpenAI(messages, openAiKey);
    }
    throw new Error(
      `No reachable LLM endpoint at ${llmBaseUrl()}. Point ayin at yours: ` +
      `set env AYIN_LLM_URL=http://<host>:9100 or run \`/set llm-url http://<host>:9100\`.`,
    );
  }

  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 15_000;
  let lastErr: unknown;

  const images = takePendingImages();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    activeLlmController = controller;
    // 20 min, not 10. The old ceiling fired while the request was still QUEUED — not stuck — and
    // undici surfaces an abort as `TypeError: fetch failed`, so a plain wait was reported as a
    // network error. The backend's own undici allows 30 min; this stays under it so a real hang is
    // still bounded.
    const timeout = setTimeout(() => controller.abort(), 20 * 60_000);

    try {
      // A correlation id per attempt, so the wait narrator can find THIS request in the backend's
      // GPU queue and report an actual position ("queued #4/6") instead of just the total depth.
      // Backends that don't know the field ignore it.
      const requestId = `${randomUUID().slice(0, 8)}`;
      setInFlightRequestId(requestId);

      const body: Record<string, unknown> = { messages, temperature: opts.temperature ?? 0.7, requestId };
      // Locked session → ask for the front of the queue, and prove we may have it.
      if (lockAuthority) { body.authority = lockAuthority; body.priority = 'high'; }
      if (opts.thinking ?? THINKING_MODE) body.thinking = true;
      if (images.length) body.images = images;

      const reqStart = Date.now();
      const reqBytes = JSON.stringify(body).length;
      fileLog('INFO', 'llm_fetch_start', { url: `${llmUrl}/api/generate`, attempt: String(attempt), reqBytes: String(reqBytes), images: String(images.length) });

      const res = await fetch(`${llmUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      fileLog('INFO', 'llm_fetch_headers', { status: String(res.status), elapsedMs: String(Date.now() - reqStart) });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`endpoint ${res.status}: ${errBody}`);
      }

      const bodyText = await res.text();
      fileLog('INFO', 'llm_body_received', { bodyBytes: String(bodyText.length), elapsedMs: String(Date.now() - reqStart) });

      let data: { content?: string; reasoning?: string };
      try {
        data = JSON.parse(bodyText) as { content?: string; reasoning?: string };
      } catch {
        const preview = bodyText.substring(0, 500);
        fileLog('ERROR', 'llm_body_parse_failed', { preview, bodyBytes: String(bodyText.length) });
        throw new Error(`endpoint body parse failed (${bodyText.length}B): ${preview}`);
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
        msg.includes('endpoint 502') ||
        msg.includes('endpoint 503') ||
        msg.includes('endpoint 504');

      const aborted = controller.signal.aborted && !transient;
      if (controller.signal.aborted && transient) {
        // Our abort, dressed up as a network failure by undici. Say which it was.
        throw new Error('gave up after 20 min — the request was still waiting for the shared GPU, not stuck. /lock puts this session in the priority band.');
      }
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

// ── Endpoint reachability (resolved by llmBaseUrl(); probed once per process) ─────

let _llmUrl: string | null = null;

async function getLlmUrl(): Promise<string | null> {
  if (_llmUrl) return _llmUrl;

  const override = llmBaseUrl();
  try {
    const check = await fetch(`${override}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (check.ok) {
      _llmUrl = override;
      fileLog('INFO', 'llm_url_resolved', { url: override });
      return override;
    }
  } catch { /* no endpoint */ }
  return null;
}

// ── Removed surface, kept as a loud stub ─────────────────────────────────────
// Sessions are local files (see session-store.ts); there is no remote session sync in ayin. This
// throws rather than returning a plausible empty result, so any caller still reaching for it fails
// visibly instead of appearing to sync.

export async function sendRequest<TReq = unknown, TRes = unknown>(
  _request: unknown,
): Promise<TRes> {
  throw new Error('sendRequest: remote session sync is not part of ayin — sessions are local files');
}
