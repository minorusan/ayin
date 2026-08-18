/**
 * Connection — the HTTP edge. ONE configured endpoint, no discovery.
 *
 * Every LLM call goes to `POST <endpoint>/api/generate`; the endpoint comes from the `AYIN_MODEL_URL`
 * env var, else `/set llm-url`, else loopback. There is no service mesh, no registry, nothing to look
 * up: if the endpoint is wrong the call fails loudly instead of silently probing alternatives.
 */

import { fetch as undiciFetch, Agent } from 'undici';
// gemma4 with thinking on long prompts can take 10+ min; lift undici's 300s default
// headersTimeout/bodyTimeout. /api/generate buffers the whole response and sends nothing —
// no headers, no bytes — until generation is done, so a long call sits as an idle connection
// the entire time; past 300s undici's own client-side default kills it with a
// HeadersTimeoutError, surfaced here as a bare "fetch failed".
//
// A prior version of this fix called `setGlobalDispatcher()` and used the bare global
// `fetch()` — verified (2026-07-27, isolated local repro) to do NOTHING: Node's built-in
// global `fetch` runs on its OWN internally bundled undici instance, a separate module
// singleton from whatever `undici` is installed in node_modules. `setGlobalDispatcher` from
// the npm package configures that package's singleton, which Node's global fetch never
// consults — every call silently kept undici's stock 300s default the whole time. Passing an
// `Agent` from the npm package as `{ dispatcher }` to the GLOBAL fetch fails outright (an
// immediate "invalid onError method" from the version/instance mismatch) rather than being
// ignored. The only combination that actually works: fetch AND Agent from the *same* undici
// import, with the agent passed explicitly per call — that guarantees one instance, no
// singleton to miss. TCP keepalive is layered on top in case a NAT/router along the way ever
// separately reaps a long-idle connection; it isn't what fixes the 300s failure itself.
const llmAgent = new Agent({
  headersTimeout: 30 * 60 * 1000,
  bodyTimeout: 30 * 60 * 1000,
  connect: { keepAlive: true, keepAliveInitialDelay: 15_000 },
});

/**
 * The id of the generation currently in flight, so the wait narrator can locate it in the backend's
 * GPU queue and report a real position. Module-level because the narrator watches from the side —
 * threading it through every call site would touch the whole agent loop for a status string.
 */
let inFlightRequestId = '';
function setInFlightRequestId(id: string): void { inFlightRequestId = id; }
export function currentRequestId(): string { return inFlightRequestId; }

import { takePendingImages } from './image.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log as fileLog } from './log.js';
import { getConfigString } from './prompts.js';

/**
 * Resolve the LLM endpoint's base URL — the ONE place, so no two call sites can disagree.
 *
 * Priority order:
 *   1. `AYIN_MODEL_URL` env (set by a dispatcher, or by your shell)
 *   2. persisted per-machine config `llmUrl` in ~/.ayin-cli/prompts.json (`/set llm-url …`)
 *   3. http://localhost:9100 — ONLY correct when the endpoint runs on THIS machine.
 *
 * The env var and the config key are the whole story: one name each, no aliases. An install that
 * still exports an older spelling resolves to the localhost default, which fails loudly against a
 * remote endpoint rather than quietly serving the wrong one.
 */
export function llmBaseUrl(): string {
  if (process.env.AYIN_MODEL_URL) return process.env.AYIN_MODEL_URL;
  const configured = getConfigString('llmUrl');
  if (configured) return configured;
  return 'http://localhost:9100';
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
 * Passes thinking=true when --thinking flag is active. Retries once on transient errors.
 * No endpoint means an error naming the fix — never a silent hosted-model call.
 */
/**
 * A tool schema on the wire, and a call coming back.
 *
 * Declared structurally here rather than imported from `llm/provider.ts`: connection.ts is the
 * TRANSPORT and sits below the provider abstraction — importing upward would make a cycle out of a
 * shape that is three fields wide.
 */
export interface NativeToolSchema {
  name: string;
  description: string;
  parameters: Array<{ name: string; type: string; description: string; required?: boolean }>;
}
export interface NativeToolCall {
  name?: string;
  arguments?: Record<string, unknown>;
}

export async function llmChat(
  messages: Array<{ role: string; content: string }>,
  opts: {
    temperature?: number;
    thinking?: boolean;
    /** Schemas to declare to the RUNTIME. Sent only when a provider asks; endpoints that predate the
     *  field ignore it, which is why this is safe to send at all. */
    tools?: NativeToolSchema[];
    /** Called with the endpoint's own parsed calls, when it returned any. */
    onToolCalls?: (calls: NativeToolCall[]) => void;
  } = {},
): Promise<string> {
  const { THINKING_MODE } = await import('./ui.js');
  const llmUrl = await getLlmUrl();

  if (!llmUrl) {
    // NO SILENT ESCALATION TO OPENAI. This used to notice a stored key and quietly bill the operator
    // for a call they thought was local — with a hardcoded two-generation-old model, and only the first
    // tool call of the reply honoured. Dropped deliberately (operator's call, 2026-08-14): a provider
    // that costs money is CHOSEN, via `/model openai`, never fallen into because a local service was
    // down. `llm/providers/openai.ts` is the one OpenAI path, and it is entered on purpose.
    throw new Error(
      `No reachable LLM endpoint at ${llmBaseUrl()}. Point ayin at yours: ` +
      `set env AYIN_MODEL_URL=http://<host>:9100 or run \`/set llm-url http://<host>:9100\`. ` +
      `Or switch to the hosted model with \`/model openai\` (needs a key: \`/openai sk-…\`).`,
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
      if (opts.thinking ?? THINKING_MODE) body.thinking = true;
      if (images.length) body.images = images;
      if (opts.tools?.length) body.tools = opts.tools;

      const reqStart = Date.now();
      const reqBytes = JSON.stringify(body).length;
      fileLog('INFO', 'llm_fetch_start', { url: `${llmUrl}/api/generate`, attempt: String(attempt), reqBytes: String(reqBytes), images: String(images.length) });

      const res = await undiciFetch(`${llmUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        dispatcher: llmAgent,
      });
      fileLog('INFO', 'llm_fetch_headers', { status: String(res.status), elapsedMs: String(Date.now() - reqStart) });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`endpoint ${res.status}: ${errBody}`);
      }

      const bodyText = await res.text();
      fileLog('INFO', 'llm_body_received', { bodyBytes: String(bodyText.length), elapsedMs: String(Date.now() - reqStart) });

      let data: { content?: string; reasoning?: string; toolCalls?: NativeToolCall[] };
      try {
        data = JSON.parse(bodyText) as { content?: string; reasoning?: string; toolCalls?: NativeToolCall[] };
      } catch {
        const preview = bodyText.substring(0, 500);
        fileLog('ERROR', 'llm_body_parse_failed', { preview, bodyBytes: String(bodyText.length) });
        throw new Error(`endpoint body parse failed (${bodyText.length}B): ${preview}`);
      }
      // Structured calls, when the endpoint parsed them for us. Handed to the caller rather than
      // returned, so this function's contract (messages → text) is unchanged for every existing
      // caller — only the provider that ASKED for tools looks at them.
      if (data.toolCalls?.length) opts.onToolCalls?.(data.toolCalls);
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
        throw new Error('gave up after 20 min — the request was still waiting for the shared GPU, not stuck.');
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
