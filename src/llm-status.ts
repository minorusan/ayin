/**
 * LLM status feed — what model is serving us, what else we could switch to, and what the shared
 * GPU is doing. Everything here comes from the backend llm resource's READ ops (open, no authority):
 *
 *     POST {keliUrl}/resource/llm  {op:'models'} → {activeModel, loadedModel, maradelModel, coderModel, models[]}
 *     POST {keliUrl}/resource/llm  {op:'gpu'}    → {gpu:{tempC,usedMiB,totalMiB,util,at}|null}
 *
 * Ollama is loopback-only on the model host, so this resource bridge is the ONLY door to the
 * catalog — ayin never probes :11434 and never runs nvidia-smi itself (it may not even be on the
 * same machine as the card).
 *
 * The poll is self-healing: every failure just leaves the last good value in place (or clears it),
 * and the next tick tries again — a backend restart or a network blip costs one stale interval,
 * never a dead status bar and never a thrown error into the TUI.
 *
 * TECH DEBT — see docs/TechDebt.md "model picker & GPU status". The role aliases below and the
 * fallback catalog are ayin-side knowledge that belongs to the backend; and this poll exists only
 * because the llm resource has no model/gpu EVENTS to ride on the SSE stream we already hold open.
 */

import { keliBaseUrl } from './connection.js';
import { resourceOp } from './resource-client.js';

export interface GpuInfo {
  tempC: number;
  usedMiB: number;
  totalMiB: number;
  util: number;
  at: number;
}

export interface ModelEntry {
  name: string;
  parameterSize: string;
  quantization: string;
  sizeBytes: number;
  active: boolean;
}

export interface ModelCatalog {
  activeModel: string;
  /** Resident in VRAM right now — differs from activeModel only mid-swap. */
  loadedModel: string;
  /** The shared/default model. Switching TO it means RELEASING our authority, not setting a model. */
  maradelModel: string;
  coderModel: string;
  models: ModelEntry[];
}

/** Role words that mean "whatever model the backend has in that role", so `/model gemma` and
 *  `/model coder` keep working when the concrete tag changes. TECH DEBT: the backend owns roles. */
const SHARED_WORDS = new Set(['gemma', 'chat', 'shared', 'release', 'default']);
const CODER_WORDS = new Set(['coder', 'qwen', 'code']);

/** Used only when the backend predates the `models` read op — a `status` read still tells us the
 *  two role models, so the picker degrades to "the models this backend has roles for". */
async function catalogFromStatus(): Promise<ModelCatalog | null> {
  const s = await resourceOp('llm', 'status', {}, 4_000) as
    | { activeModel?: string; loadedModel?: string; maradelModel?: string; coderModel?: string }
    | null;
  if (!s || !s.activeModel) return null;
  const names = [s.maradelModel, s.coderModel, s.activeModel].filter((n): n is string => !!n);
  const uniq = [...new Set(names)];
  return {
    activeModel: s.activeModel,
    loadedModel: s.loadedModel ?? s.activeModel,
    maradelModel: s.maradelModel ?? s.activeModel,
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
export async function fetchCatalog(opts: { force?: boolean } = {}): Promise<ModelCatalog | null> {
  if (opts.force || Date.now() >= modelsOpMissingUntil) {
    const r = await resourceOp('llm', 'models', {}, 5_000) as ModelCatalog | null;
    if (r && Array.isArray(r.models) && r.models.length > 0) {
      modelsOpMissingUntil = 0;
      return r;
    }
    modelsOpMissingUntil = Date.now() + MODELS_OP_RETRY_MS;
  }
  return catalogFromStatus(); // older backend (no `models` op) → roles only
}

/** Current GPU telemetry, or null (no card visible / backend unreachable). Never throws. */
export async function fetchGpu(): Promise<GpuInfo | null> {
  const r = await resourceOp('llm', 'gpu', {}, 4_000) as { gpu?: GpuInfo | null } | null;
  return r?.gpu ?? null;
}

/** Resolve what the user typed (`qwen`, `gemma`, or a full `qwen3-coder:30b`) to a catalog model.
 *  Returns null when nothing matches. */
export function resolveModelName(input: string, catalog: ModelCatalog): string | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;
  const names = catalog.models.map((m) => m.name);
  const exact = names.find((n) => n.toLowerCase() === t);
  if (exact) return exact;

  if (SHARED_WORDS.has(t)) return catalog.maradelModel;
  if (CODER_WORDS.has(t) && catalog.coderModel) return catalog.coderModel;

  // Otherwise a prefix/substring of an installed tag — longest match wins, so `qwen3` beats `qwen`.
  const substr = names.filter((n) => n.toLowerCase().includes(t)).sort((a, b) => b.length - a.length);
  return substr[0] ?? null;
}

/**
 * Start the status poll. Fires `onUpdate` after every tick that produced something (model and/or
 * GPU), and keeps running across backend restarts. The interval is unref'd, so it never holds the
 * process open. Returns a stop function.
 */
export function startLlmStatusPoll(
  onUpdate: (u: { catalog: ModelCatalog | null; gpu: GpuInfo | null }) => void,
  everyMs = 5_000,
): () => void {
  let stopped = false;
  let running = false; // a slow/hanging backend must never stack polls on top of each other

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const [catalog, gpu] = await Promise.all([fetchCatalog(), fetchGpu()]);
      if (!stopped) onUpdate({ catalog, gpu });
    } catch {
      if (!stopped) onUpdate({ catalog: null, gpu: null }); // never show stale truth
    } finally {
      running = false;
    }
  };

  void tick(); // don't make the user wait a whole interval for the first paint
  const timer = setInterval(() => { void tick(); }, everyMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

/** Where the poll points — surfaced in the picker so a wrong keli-url is obvious. */
export function statusSource(): string {
  return keliBaseUrl();
}
