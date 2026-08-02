/**
 * LLM status feed — what model is serving us, what else we could switch to, and what the shared
 * GPU is doing. Every fact here comes from the LLM PROVIDER (src/llm/provider.ts), never from a
 * backend call made here: this module is a consumer of the port, not a client of anybody's backend.
 *
 * WHAT IS OPTIONAL. Only `status()` is guaranteed. A provider may or may not offer a catalog, GPU
 * telemetry or an authority, and this module's whole job is to make "not offered" indistinguishable
 * from "quiet": every accessor returns null, the status poll reports nulls, and the status bar hides
 * the segments it has nothing to say about. No errors, no spinners, no empty popups.
 *
 * The poll is self-healing: every failure just leaves the last good value in place (or clears it),
 * and the next tick tries again — a backend restart or a network blip costs one stale interval,
 * never a dead status bar and never a thrown error into the TUI.
 */

import { llmBaseUrl } from './connection.js';
import { llmProvider } from './llm/select.js';
import type { AuthorityInfo, GpuInfo, ModelCatalog, ModelEntry, QueueInfo } from './llm/provider.js';

export type { AuthorityInfo, GpuInfo, ModelCatalog, ModelEntry, QueueInfo };
/** Historical alias — the catalog's rows used to be called ModelEntry here. */
export type { ModelEntry as CatalogEntry };

/** Role words that mean "whatever model the provider has in that role", so `/model coder` keeps
 *  working when the concrete tag changes. Providers without roles simply never match these. */
const SHARED_WORDS = new Set(['gemma', 'chat', 'shared', 'release', 'default']);
const CODER_WORDS = new Set(['coder', 'qwen', 'code']);

/** The model catalog, or null when the provider has none / is unreachable. Never throws. */
export async function fetchCatalog(opts: { force?: boolean } = {}): Promise<ModelCatalog | null> {
  const p = await llmProvider();
  if (!p.models) return null; // no catalog capability → the picker and the model segment stay quiet
  try {
    return await p.models(opts);
  } catch {
    return null;
  }
}

/**
 * Where OUR in-flight request sits in the provider's queue, matched by the correlation id ayin sent
 * with it. `position` is 1-based among the waiters; `running` means it has the slot and is generating.
 * null when we have nothing in flight, or the provider has no queue at all.
 */
export function findOwnPlace(q: QueueInfo | null, requestId: string): { running: boolean; position: number; of: number; aheadOfUs: string[] } | null {
  if (!q || !requestId) return null;
  const mine = `ayin:${requestId}`;
  if (q.runningTag === mine) return { running: true, position: 0, of: q.depth, aheadOfUs: [] };
  const idx = q.waiting.findIndex((w) => w.tag === mine);
  if (idx < 0) return null;
  return {
    running: false,
    position: idx + 1,
    of: q.waiting.length,
    aheadOfUs: q.waiting.slice(0, idx).map((w) => w.label),
  };
}

/** The current authority holder, or null (free / unreachable / no authority layer). Never throws. */
export async function fetchAuthority(): Promise<AuthorityInfo | null> {
  const p = await llmProvider();
  if (!p.authority) return null;
  try {
    return await p.authority();
  } catch {
    return null;
  }
}

/** GPU telemetry + scheduler state; both null when the provider does not report them. Never throws. */
export async function fetchGpu(): Promise<{ gpu: GpuInfo | null; queue: QueueInfo | null }> {
  const p = await llmProvider();
  if (!p.telemetry) return { gpu: null, queue: null };
  try {
    const t = await p.telemetry();
    return { gpu: t.gpu ?? null, queue: t.queue ?? null };
  } catch {
    return { gpu: null, queue: null };
  }
}

/** True when the provider reports a GPU/queue at all — consumers use it to skip work that could
 *  only ever produce nothing (see wait-narrator.ts). */
export async function telemetrySupported(): Promise<boolean> {
  return typeof (await llmProvider()).telemetry === 'function';
}

/** Resolve what the user typed (`qwen`, `gemma`, or a full `qwen3-coder:30b`) to a catalog model.
 *  Returns null when nothing matches. */
export function resolveModelName(input: string, catalog: ModelCatalog): string | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;
  const names = catalog.models.map((m) => m.name);
  const exact = names.find((n) => n.toLowerCase() === t);
  if (exact) return exact;

  if (SHARED_WORDS.has(t) && catalog.sharedModel) return catalog.sharedModel;
  if (CODER_WORDS.has(t) && catalog.coderModel) return catalog.coderModel;

  // Otherwise a prefix/substring of an installed tag — longest match wins, so `qwen3` beats `qwen`.
  const substr = names.filter((n) => n.toLowerCase().includes(t)).sort((a, b) => b.length - a.length);
  return substr[0] ?? null;
}

/**
 * Start the status poll. Fires `onUpdate` after every tick, and keeps running across backend
 * restarts. Capabilities the provider lacks arrive as nulls, tick after tick, and the status bar
 * hides those segments — which is exactly right: they are not broken, they do not exist here.
 * The interval is unref'd, so it never holds the process open. Returns a stop function.
 */
export function startLlmStatusPoll(
  onUpdate: (u: { catalog: ModelCatalog | null; gpu: GpuInfo | null; queue: QueueInfo | null; authority: AuthorityInfo | null }) => void,
  everyMs = 5_000,
): () => void {
  let stopped = false;
  let running = false; // a slow/hanging backend must never stack polls on top of each other

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const [catalog, g, authority] = await Promise.all([fetchCatalog(), fetchGpu(), fetchAuthority()]);
      if (!stopped) onUpdate({ catalog, gpu: g.gpu, queue: g.queue, authority });
    } catch {
      if (!stopped) onUpdate({ catalog: null, gpu: null, queue: null, authority: null }); // never show stale truth
    } finally {
      running = false;
    }
  };

  void tick(); // don't make the user wait a whole interval for the first paint
  const timer = setInterval(() => { void tick(); }, everyMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

/** Where the provider points — surfaced in the picker so a wrong endpoint is obvious. */
export function statusSource(): string {
  return llmBaseUrl();
}
