/**
 * Taking the LLM authority — the port-side façade over `LlmProvider.acquire`.
 *
 * ONE DOOR: ayin does not touch a model runtime, it asks the provider for an authority and works
 * inside the grant. A provider that has no authority layer (the public `direct` one) answers
 * 'no-resource-layer', which every caller already treats as "proceed best-effort on whatever model
 * is being served" — so a public clone runs the watcher and headless mode unchanged, just without
 * the model booking it never had.
 */

import type { AcquireOptions, AcquireResult } from './provider.js';
import { llmProvider } from './select.js';

export type { AcquireOptions } from './provider.js';

/**
 * The result of asking for the authority. The union is unchanged from the pre-port `resource-client`
 * so every caller's narrowing (`=== 'busy'`, `typeof hold === 'object'`) still means what it meant.
 */
export type LlmHold = AcquireResult;

/** Take the authority for `reason`. Never throws. */
export async function acquireLlm(reason: string, opts: AcquireOptions = {}): Promise<LlmHold> {
  const p = await llmProvider();
  if (!p.acquire) return 'no-resource-layer'; // this provider has no authority layer — nothing to take
  try {
    return await p.acquire(reason, opts);
  } catch {
    return 'no-resource-layer';
  }
}

/** Whether `/lock` and model booking mean anything on this installation. */
export async function authoritySupported(): Promise<boolean> {
  return typeof (await llmProvider()).acquire === 'function';
}
