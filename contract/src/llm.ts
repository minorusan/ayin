/**
 * The model-provider PORT — the seam between ayin and whatever serves its model.
 *
 * REQUIRED   generate()  messages → text. Without it there is no agent.
 *            status()    is it alive, and which model is answering (this drives dialect selection).
 *
 * OPTIONAL   models() · setModel() · acquire() · authority() · telemetry() · events()
 *
 * THE RULE FOR CONSUMERS: an absent capability renders as NOTHING — not an error, not a spinner that
 * never resolves. Someone running a bare local model server must see a working agent, not a UI full of
 * red about a resource layer they have never heard of.
 */

/**
 * Ayin LLM manager — types.
 *
 * A ModelDialect captures everything model-FAMILY-specific about driving a
 * text-tool-calling LLM through ayin's agent loop:
 *   - how the model is TOLD to emit tool calls (system-prompt instructions),
 *   - how tool calls are PARSED out of its raw output,
 *   - how an assistant tool-call turn is RE-RENDERED when replayed into history,
 *   - how a tool RESULT is framed back to the model.
 *
 * Everything else — the agent loop, the tools, the transport — is model-agnostic.
 * Add a model family by implementing this interface and registering it in
 * `manager.ts`. See docs/ARCHITECTURE.md "LLM manager & dialects".
 */

export interface LlmMessage {
  role: string;
  content: string;
}

// ── generation ───────────────────────────────────────────────────────

/**
 * Tool schemas, for a provider that can hand them to the runtime.
 *
 * Optional on purpose: over the tiny HTTP contract there is nowhere to put them, so the caller omits
 * them and the model's calls arrive as text to be parsed. A provider talking to a runtime directly
 * (`providers/ollama.ts`) passes them along, the runtime parses the model's native tool-call syntax
 * itself, and the provider renders the result back into the canonical text form. Same loop, same
 * parser, no format for the model to invent.
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Array<{ name: string; type: string; description: string; required?: boolean }>;
}

export interface GenerateOptions {
  /** Sampling temperature; the transport's default applies when omitted. */
  temperature?: number;
  /** Ask the model to think out loud first (the transport strips the block from `content`). */
  thinking?: boolean;
  /** Tools the model may call, for a provider that can declare them to the runtime. See ToolSchema. */
  tools?: ToolSchema[];
}

export interface GenerateResult {
  content: string;
  /** The thinking block, when the endpoint returns it separately. Usually absent. */
  reasoning?: string;
}

/** Liveness + identity. `model` is what is answering right now, or null when unknown. */
export interface ProviderStatus {
  ok: boolean;
  model: string | null;
}

// ── optional: the model catalog ──────────────────────────────────────

export interface ModelEntry {
  name: string;
  parameterSize: string;
  quantization: string;
  sizeBytes: number;
  active: boolean;
  /** The context window THIS model will actually get, when the provider knows it — a 24GB card
   *  cannot give every model the same window, so one global number would be a lie. */
  ctx?: number;
}

export interface ModelCatalog {
  activeModel: string;
  /** Resident right now — differs from activeModel only mid-swap. Equal to it when the provider
   *  cannot tell the difference (nothing is ever "swapping" then, which is the honest answer). */
  loadedModel: string;
  /** The provider's default/shared model, if it has the concept. Switching TO it may mean RELEASING
   *  an authority rather than setting a model. '' when there is no such role. */
  sharedModel: string;
  /** The provider's coding model role, if it has one. '' when there is no such role. */
  coderModel: string;
  models: ModelEntry[];
}

// ── optional: shared-GPU telemetry ───────────────────────────────────

export interface GpuInfo {
  tempC: number;
  usedMiB: number;
  totalMiB: number;
  util: number;
  at: number;
}

/**
 * A single-slot scheduler in front of the model: what holds the slot and who waits behind it.
 * Knowing this is the difference between "ayin is slow" and "ayin is 4th in line".
 */
export interface QueueInfo {
  /** Label of the call holding the slot right now. */
  running: string | null;
  runningForMs: number;
  /** Correlation tag of the running job (`ayin:<id>` for our own calls), '' if untagged. */
  runningTag?: string;
  depth: number;
  /** IN THE ORDER THEY WILL RUN — an entry's index is its real place in line. */
  waiting: Array<{ label: string; priority: string; waitingMs: number; tag?: string }>;
}

export interface LlmTelemetry {
  gpu: GpuInfo | null;
  queue: QueueInfo | null;
}

// ── optional: the authority (who owns the model) ─────────────────────

/** Who owns the llm resource right now — the authority, not the model. */
export interface AuthorityInfo {
  holder: string;
  expiresAt: number;
  depth: number;
}

/** A granted hold. `token` is MUTABLE: a keepalive that comes back with a new grant rotates it. */
export interface LlmGrant {
  token: string;
  release: () => Promise<void>;
}

/**
 * 'busy' → someone else holds it; the caller decides whether to defer or bail.
 * 'no-resource-layer' → there is no authority to take (provider has no `acquire`, or the backend is
 * unreachable / predates the resource layer). Callers proceed best-effort on the served model.
 */
export type AcquireResult = LlmGrant | 'busy' | 'no-resource-layer';

export interface AcquireOptions {
  ttlMs?: number;
  keepaliveMs?: number;
  force?: boolean;
  /**
   * Called when the keepalive comes back with a NEW grant instead of a refresh — the old one is gone
   * (the backend restarted and its in-memory authority stack went with it, or a higher authority
   * preempted us). Two things are then broken silently: our token is dead, so anything sent with it
   * is ignored; and the backend re-applied its per-holder MODEL policy, so a pinned model has been
   * swapped away. The holder gets the new token and a chance to re-pin.
   */
  onRegrant?: (token: string, via: string) => void;
}

// ── optional: the live event stream ──────────────────────────────────

export interface LlmEvent {
  type: string;
  payload: Record<string, unknown>;
}

// ── the port ─────────────────────────────────────────────────────────

export interface LlmProvider {
  /** Stable id, used in logs and in the "why is this missing" messages. */
  readonly name: string;

  /**
   * WHO DECLARES THE TOOLS.
   *
   * `'prompt'` (the default when absent) — ayin describes every tool and the call format in the system
   * prompt, and parses calls out of the reply. The only option over a text-in/text-out contract.
   *
   * `'native'` — this provider hands the tool schemas to the runtime, which renders them in its own
   * chat template and returns parsed calls. ayin then MUST NOT put its own tool list or format
   * instructions in the prompt: the model would read the same 14 tools twice, in two formats, with two
   * instructions on how to call them. Measured: declaring 2 tools added 331 prompt tokens, so ~2K for a
   * full set — spent entirely on duplication, and one run's judgement visibly degraded.
   *
   * A provider knows which of these it can do; nothing else does. A gemma-backed endpoint with no tool
   * API says `'prompt'`, an Ollama or OpenAI provider says `'native'`, and the loop asks rather than
   * assuming.
   */
  readonly tools?: 'native' | 'prompt';

  /** REQUIRED. Messages → text, through the shared transport. */
  generate(messages: LlmMessage[], opts?: GenerateOptions): Promise<GenerateResult>;

  /** REQUIRED. Liveness + the model id (drives dialect selection). Must never throw. */
  status(): Promise<ProviderStatus>;

  /** What models exist. null = unknown; absent = the concept does not apply here. Never throws. */
  models?(opts?: { force?: boolean }): Promise<ModelCatalog | null>;

  /** Ask for a different served model. `token` is an authority token when the provider needs one.
   *  Resolves false when the provider refused. Never throws. */
  setModel?(model: string, token?: string): Promise<boolean>;

  /** Take an authority over the model/GPU. Never throws. */
  acquire?(reason: string, opts?: AcquireOptions): Promise<AcquireResult>;

  /** Who holds the authority right now, or null (free / unreachable). Never throws. */
  authority?(): Promise<AuthorityInfo | null>;

  /** GPU + scheduler state. Never throws. */
  telemetry?(): Promise<LlmTelemetry>;

  /** Subscribe to the provider's live events; returns a stop function. Must reconnect on its own. */
  events?(onEvent: (e: LlmEvent) => void): () => void;
}

/** Capability names, for `providerHas()` and for talking about them in messages. */
export type LlmCapability = 'models' | 'setModel' | 'acquire' | 'authority' | 'telemetry' | 'events';

/** Does this provider implement an optional capability? The one check every consumer makes. */
export function providerHas(p: LlmProvider | null, cap: LlmCapability): boolean {
  return !!p && typeof p[cap] === 'function';
}
