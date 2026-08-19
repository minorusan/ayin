/**
 * The RESOURCE provider — a backend that puts an arbitrated LLM RESOURCE in front of the model.
 *
 * This is the private/self-hosted shape: one card, one model in VRAM, many consumers, so nobody
 * touches the runtime directly and everything acquires through an authority layer first. ONE DOOR.
 * ayin never probes the model runtime's port and never runs nvidia-smi itself — every fact and every
 * action below goes through the resource bridge:
 *
 *     POST {endpoint}/resource/llm  {op, params}   → {ok, data}
 *     GET  {endpoint}/resource/llm/events          → SSE
 *
 *     ops:  status · models · gpu · setModel · authority.current
 *           authority.enqueue · authority.detach
 *
 * THIS FILE IS THE ONLY PLACE IN AYIN THAT MAY CALL `resourceOp('llm', …)`. If you need a new fact
 * from the resource layer, add a capability to the port and implement it here — a consumer that
 * reaches around this file re-couples the public agent to one operator's private backend, which is
 * the exact bug the port exists to remove.
 *
 * Everything in here was MOVED, not rewritten: the acquisition dance, its keepalive semantics, the
 * `models`-op backoff, the SSE reconnect. In particular the keepalive's re-grant handling (a backend
 * restart wipes the in-memory authority stack, so the next keepalive returns a NEW grant instead of
 * a refresh; the token rotates) belongs to the port's `acquire()`, which ayin itself no longer calls
 * and is preserved verbatim.
 */

import { llmBaseUrl, llmChat as transportChat, type NativeToolCall } from '../../connection.js';
import { log } from '../../log.js';
import type {
  AcquireOptions, AcquireResult, AuthorityInfo, LlmEvent, LlmProvider, LlmTelemetry, ModelCatalog,
  ProviderStatus,
  GenerateOptions, GenerateResult, LlmMessage, TokenUsage,
} from '../provider.js';
import { httpGenerate, httpStatus } from './direct.js';
import { providerConfig } from './runtime.js';

/** The one door: POST {endpoint}/resource/<name> {op, params}. Never throws; null on any failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resourceOp(resource: string, op: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any | null> {
  try {
    const res = await fetch(`${llmBaseUrl()}/resource/${resource}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? body.data : null;
  } catch {
    return null;
  }
}

/**
 * Does the configured endpoint actually expose the llm resource surface?
 *
 * Used by provider selection, so it must distinguish "answered, no such surface" from "did not
 * answer at all" — a backend that is merely slow to boot must not condemn the whole session to the
 * degraded provider. `present:false, conclusive:true` means we got an HTTP answer that was not a
 * resource (404 / not-ok body); anything else is inconclusive and the caller may re-probe later.
 */
export async function probeResourceSurface(timeoutMs = 3_000): Promise<{ present: boolean; conclusive: boolean }> {
  try {
    const res = await fetch(`${llmBaseUrl()}/resource/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'status', params: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { present: false, conclusive: true }; // it answered: there is no resource here
    const body = await res.json().catch(() => null) as { ok?: boolean } | null;
    if (body && body.ok) return { present: true, conclusive: true };
    return { present: false, conclusive: true };
  } catch {
    return { present: false, conclusive: false }; // unreachable / timed out — we simply don't know
  }
}

// ── authority ────────────────────────────────────────────────────────

/**
 * Take the backend llm resource as the `ayin` authority (ownership.gained → the backend applies its
 * per-holder model policy; release/detach → reverts).
 */
async function acquire(reason: string, opts: AcquireOptions = {}): Promise<AcquireResult> {
  const grant = await resourceOp('llm', 'authority.enqueue', {
    holder: 'ayin',
    reason,
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.force ? { force: true } : {}),
  }, 5_000);
  if (grant && grant.granted) {
    // Slide the grant for long runs. A SHORT ttl with a fast keepalive is what makes a grant
    // self-releasing: stop responding and the grant lapses on its own.
    const every = opts.keepaliveMs ?? 10 * 60 * 1000;
    const keepalive = setInterval(() => {
      void resourceOp('llm', 'authority.enqueue', {
        holder: 'ayin',
        ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
      }, 5_000).then((r) => {
        if (!r?.granted || !r.token) return;
        // `refresh` = we still held it. Anything else is a NEW grant: rotate the token (the old one
        // is dead) and let the holder re-assert whatever the grant used to guarantee.
        if (r.via !== 'refresh' || r.token !== hold.token) {
          hold.token = String(r.token);
          opts.onRegrant?.(hold.token, String(r.via ?? 'unknown'));
        }
      });
    }, every);
    keepalive.unref();
    let released = false;
    const hold = {
      token: String(grant.token),
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(keepalive);
        const r = await resourceOp('llm', 'authority.detach', { token: hold.token }, 5_000);
        if (r?.released) return;
        // Our token was replaced (a restart, or a preempt) and the keepalive hadn't noticed yet, so
        // that detach freed nothing and the grant would sit there until its TTL. We ARE the `ayin`
        // holder, so re-acquire to learn the live token and hand it back properly. Bounded: only when
        // `ayin` still holds it, and only once.
        const who = await resourceOp('llm', 'authority.current', {}, 5_000);
        if (who?.holder !== 'ayin') return; // someone else owns it now — not ours to release
        const fresh = await resourceOp('llm', 'authority.enqueue', { holder: 'ayin' }, 5_000);
        if (fresh?.granted && fresh.token) await resourceOp('llm', 'authority.detach', { token: fresh.token }, 5_000);
      },
    };
    return hold;
  }
  if (grant && grant.busy) return 'busy';
  return 'no-resource-layer';
}

/** The current authority holder, or null (free / unreachable). Never throws. */
async function authority(): Promise<AuthorityInfo | null> {
  return (await resourceOp('llm', 'authority.current', {}, 4_000)) as AuthorityInfo | null;
}

// ── the catalog ──────────────────────────────────────────────────────

/** The wire shape of the `models`/`status` ops. `sharedModel` is the backend's name for the role
 *  the port calls `sharedModel`; the mapping happens here so no consumer learns the backend's word. */
interface WireCatalog {
  activeModel?: string;
  loadedModel?: string;
  sharedModel?: string;
  coderModel?: string;
  models?: ModelCatalog['models'];
  /** The window the ACTIVE preset grants — the resource layer is authoritative about this. */
  ctxSize?: number;
}

/**
 * Status through the RESOURCE op rather than the plain `/api/status`.
 *
 * One request, strictly more information: the generic endpoint answers `{ok, model}` and nothing
 * else, while the resource layer also reports `ctxSize` — the window the active preset actually
 * grants. That number existed all along and ayin never asked for it, so the session meter fell back
 * to a hardcoded 65536 while the operator ran a 16k preset.
 *
 * Falls back to the plain contract when the op is unavailable: this doubles as the liveness probe,
 * and a backend that predates the op must not read as "down".
 */
/**
 * The model the gateway last reported as resident. Recorded here rather than imported from the
 * manager, which imports providers — and read per generate, because a preset applied mid-session
 * swaps the model under a running agent.
 */
let lastKnownModel = '';

async function resourceStatus(): Promise<ProviderStatus> {
  const s = await resourceOp('llm', 'status', {}, 4_000).catch(() => null) as WireCatalog | null;
  if (s?.activeModel) {
    lastKnownModel = s.activeModel;
    const ctx = Number(s.ctxSize);
    return {
      ok: true,
      model: s.activeModel,
      ...(Number.isFinite(ctx) && ctx > 0 ? { contextTokens: ctx } : {}),
    };
  }
  return httpStatus();
}

/** Used only when the backend predates the `models` read op — a `status` read still tells us the
 *  two role models, so the picker degrades to "the models this backend has roles for". */
async function catalogFromStatus(): Promise<ModelCatalog | null> {
  const s = await resourceOp('llm', 'status', {}, 4_000) as WireCatalog | null;
  if (!s || !s.activeModel) return null;
  const shared = s.sharedModel;
  const names = [shared, s.coderModel, s.activeModel].filter((n): n is string => !!n);
  const uniq = [...new Set(names)];
  return {
    activeModel: s.activeModel,
    loadedModel: s.loadedModel ?? s.activeModel,
    sharedModel: shared ?? s.activeModel,
    coderModel: s.coderModel ?? s.activeModel,
    models: uniq.map((name) => ({ name, parameterSize: '', quantization: '', sizeBytes: 0, active: name === s.activeModel })),
  };
}

// A backend without the `models` op would otherwise cost TWO requests on every 5s tick, forever.
// After a miss we stop asking for 5 minutes — long enough that a deploy is picked up on its own,
// short enough that nobody has to restart ayin to see the richer catalog.
const MODELS_OP_RETRY_MS = 5 * 60 * 1000;
let modelsOpMissingUntil = 0;

/** The model catalog, or null when the backend is unreachable. Never throws.
 *  `force` skips the "op is missing" backoff — the picker always asks for the real thing, so a
 *  backend deployed a minute ago doesn't show a stale, degraded list. */
async function models(opts: { force?: boolean } = {}): Promise<ModelCatalog | null> {
  if (opts.force || Date.now() >= modelsOpMissingUntil) {
    const r = await resourceOp('llm', 'models', {}, 5_000) as WireCatalog | null;
    if (r && Array.isArray(r.models) && r.models.length > 0 && r.activeModel) {
      modelsOpMissingUntil = 0;
      return {
        activeModel: r.activeModel,
        loadedModel: r.loadedModel ?? r.activeModel,
        sharedModel: r.sharedModel ?? '',
        coderModel: r.coderModel ?? '',
        models: r.models,
      };
    }
    modelsOpMissingUntil = Date.now() + MODELS_OP_RETRY_MS;
  }
  return catalogFromStatus(); // older backend (no `models` op) → roles only
}

/** Switch the served model. Guarded by the resource layer: the authority token is required. */
async function setModel(model: string, token?: string): Promise<boolean> {
  const res = await resourceOp('llm', 'setModel', { model, ...(token ? { authority: token } : {}) }, 10_000);
  return !!res;
}

/** Current GPU telemetry + scheduler state. Never throws. */
async function telemetry(): Promise<LlmTelemetry> {
  const r = await resourceOp('llm', 'gpu', {}, 4_000) as LlmTelemetry | null;
  return { gpu: r?.gpu ?? null, queue: r?.queue ?? null };
}

// ── the live event stream ────────────────────────────────────────────

/**
 * Follow the resource's SSE stream, reconnecting with backoff forever (the TUI may outlive backend
 * restarts). A broken stream emits nothing — the consumer is told by the stop/`null` path, so the
 * status bar can never show a stale phase over a dead stream.
 */
function events(onEvent: (e: LlmEvent) => void): () => void {
  let stopped = false;
  let backoffMs = 2_000;

  const connectLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const res = await fetch(`${llmBaseUrl()}/resource/llm/events`, {
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        log('INFO', 'llm_events_subscribed', {});
        backoffMs = 2_000;

        let buf = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (stopped) return;
          buf += Buffer.from(chunk).toString('utf-8');
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
            if (!dataLine) continue; // heartbeat/comment
            try {
              const e = JSON.parse(dataLine.slice(6));
              onEvent({ type: String(e.type), payload: (e.payload ?? {}) as Record<string, unknown> });
            } catch { /* torn frame */ }
          }
        }
        throw new Error('stream ended');
      } catch (err) {
        if (stopped) return;
        onEvent({ type: 'stream.lost', payload: {} }); // never show a stale phase over a dead stream
        log('WARN', 'llm_events_reconnect', { error: err instanceof Error ? err.message : String(err), backoffMs: String(backoffMs) });
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  };

  void connectLoop();
  return () => { stopped = true; onEvent({ type: 'stream.lost', payload: {} }); };
}

/**
 * Does this install declare tools to the RUNTIME instead of in the prompt?
 *
 * OFF BY DEFAULT, and that is deliberate. Prompt-declared tools work today for every model whose
 * Ollama parser leaves the markup alone (`qwen3-coder`, `glimmer`), and flipping the whole install to
 * native tools is a behaviour change to a working system, not a bug fix.
 *
 * It exists because some parsers do NOT leave it alone. `qwen3.5` — which serves qwen3.8 — has no
 * `len(tools) == 0` guard, so with no tools declared it still consumes the opening `<function=NAME>`
 * tag, emits no call, and returns orphaned `<parameter=…>` blocks with the tool name already gone.
 * Nothing downstream can recover a name that was deleted upstream. Declaring the schemas makes
 * Ollama's parser do the job properly and hand back structured calls.
 *
 * `/set resource-native-tools true`, or AYIN_RESOURCE_NATIVE_TOOLS=1.
 */
function nativeToolsEnabled(): boolean {
  if (process.env.AYIN_RESOURCE_NATIVE_TOOLS === '1') return true;
  return (providerConfig('resourceNativeTools') ?? '').trim().toLowerCase() === 'true';
}


/**
 * Generate through the gateway, declaring tool schemas when this install asks for it.
 *
 * The returned calls are rendered BACK into the canonical text form before they leave here, exactly
 * as `providers/openai.ts` does: everything downstream — the dialect parser, the agent loop, the tool
 * guard — reads text, and giving one provider a second structured path would be a second agent loop
 * in all but name.
 */
async function resourceGenerate(messages: LlmMessage[], opts?: GenerateOptions): Promise<GenerateResult> {
  if (!opts?.tools?.length) return httpGenerate(messages, opts);
  let calls: NativeToolCall[] = [];
  let usage: TokenUsage | undefined;
  const content = await transportChat(messages, {
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    tools: opts.tools,
    onToolCalls: (c) => { calls = c; },
    onUsage: (u) => { usage = u; },
  });
  const rendered = renderNativeCalls(calls);
  const text = rendered ? (content ? `${content}\n${rendered}` : rendered) : content;
  return usage ? { content: text, usage } : { content: text };
}

/** `{name, arguments}` → the XML text every dialect parser already reads. */
function renderNativeCalls(calls: Array<{ name?: string; arguments?: Record<string, unknown> }> | undefined): string {
  if (!calls?.length) return '';
  return calls.map((c) => {
    const params = Object.entries(c.arguments ?? {})
      .map(([k, v]) => `<parameter=${k}>\n${typeof v === 'string' ? v : JSON.stringify(v)}\n</parameter>`)
      .join('\n');
    return `<function=${c.name ?? 'unknown'}>\n${params}\n</function>`;
  }).join('\n');
}

export function createResourceProvider(): LlmProvider {
  const native = nativeToolsEnabled();
  return {
    name: 'resource',
    // Generation and liveness are the same tiny HTTP contract — the resource layer arbitrates who
    // may generate and on which model, it does not replace the endpoint.
    // ALWAYS the resource generator. It falls back to `httpGenerate` itself when the caller passes no
    // tools, so this is identical in prompt mode — and it removes the dead end where `toolMode()`
    // upgraded to native for a model that needs it while `generate` physically could not send schemas.
    generate: resourceGenerate,
    ...(native ? { tools: 'native' as const } : {}),
    status: resourceStatus,
    models,
    setModel,
    acquire,
    authority,
    telemetry,
    events,
  };
}
