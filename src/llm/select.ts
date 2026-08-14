/**
 * Which provider serves this machine.
 *
 * Resolution order, and it NEVER throws — a failure to decide always lands on the provider that
 * needs nothing:
 *
 *   1. EXPLICIT   env `AYIN_LLM_PROVIDER=ollama|direct|resource|openai`, else config `llmProvider`
 *                 (`/set llm-provider resource`). An operator who says which one gets which one,
 *                 with no probe and no startup latency.
 *   2. PROBE      ask the configured endpoint whether it exposes the llm resource surface.
 *   3. OPENAI     nothing configured anywhere — the fresh-clone case. Needs a key, nothing else, and
 *                 says how to set one. Never inferred when an endpoint IS configured but merely
 *                 unreachable: that is a booting backend, and it must not become a bill.
 *   4. DIRECT     an endpoint is configured but exposes no resource surface — a plain model endpoint.
 *
 * THE INCONCLUSIVE PROBE. "The backend said 404" and "the backend did not answer" are different
 * facts and must not be treated alike: ayin is often launched while its backend is still coming up
 * (a reboot, a redeploy), and condemning the whole session to the degraded provider because of a
 * three-second window would lose `/lock` and the model picker for hours. So an inconclusive probe
 * picks `direct` PROVISIONALLY and re-probes, at most every 30s, the next time anyone asks for the
 * provider — the status poll asks every 5s, so recovery is automatic and needs no restart.
 * The upgrade is one-way (direct → resource) and never the reverse: a held authority must not have
 * the ground moved under it.
 */

import { log } from '../log.js';
import { getConfigString } from '../prompts.js';
import type { LlmProvider } from './provider.js';
import { createDirectProvider } from './providers/direct.js';
import { createResourceProvider, probeResourceSurface } from './providers/resource.js';
import { createOllamaProvider } from './providers/ollama.js';
import { createOpenAiProvider } from './providers/openai.js';
import { ensureProviderRuntime } from '../tool-wiring.js';

// Every provider is constructed here, so this is where their runtime must exist. Idempotent, and
// deliberately not left to whoever imports us first — the same order-dependence that bit the tools.
ensureProviderRuntime();

const REPROBE_EVERY_MS = 30_000;

let current: LlmProvider | null = null;
/** True while `current` is `direct` only because the probe could not reach the endpoint. */
let provisional = false;
let lastProbeAt = 0;
let inFlight: Promise<LlmProvider> | null = null;

function configured(): 'direct' | 'resource' | 'ollama' | 'openai' | null {
  const raw = (process.env.AYIN_LLM_PROVIDER || getConfigString('llmProvider') || '').trim().toLowerCase();
  if (raw === 'direct') return 'direct';
  if (raw === 'resource') return 'resource';
  // Explicit only. Never chosen by probe in preference to a resource layer that exists: on a shared
  // GPU two writers is the race the authority prevents. A box with no backend gets it by asking.
  if (raw === 'ollama') return 'ollama';
  // Billed per token, so never inferred — but an operator who has decided may persist it.
  if (raw === 'openai') return 'openai';
  return null; // '', 'auto', or a typo → auto-detect rather than fail
}

/** Whether the operator has pointed ayin at an endpoint at all. Absent = a clone nobody configured. */
function endpointConfigured(): boolean {
  return Boolean((process.env.AYIN_MODEL_URL ?? '').trim() || getConfigString('llmUrl'));
}

async function resolve(): Promise<LlmProvider> {
  const forced = configured();
  if (forced) {
    provisional = false;
    const p = forced === 'resource' ? createResourceProvider()
      : forced === 'ollama' ? createOllamaProvider()
        : forced === 'openai' ? createOpenAiProvider()
          : createDirectProvider();
    log('INFO', 'llm_provider_selected', { provider: p.name, via: 'config' });
    return p;
  }

  const probe = await probeResourceSurface().catch(() => ({ present: false, conclusive: false }));
  if (probe.present) {
    provisional = false;
    log('INFO', 'llm_provider_selected', { provider: 'resource', via: 'probe' });
    return createResourceProvider();
  }

  /**
   * NOTHING CONFIGURED AT ALL → OpenAI. This is the fresh-clone case, and it is the difference between
   * a repo someone can try and a repo that needs a GPU first: `direct` against the localhost default
   * fails on every prompt with a connection error, which reads as "ayin is broken", while OpenAI needs
   * only a key and says exactly how to set one.
   *
   * Deliberately NOT reached when an endpoint IS configured but unreachable — that is a backend still
   * booting, and quietly moving a session onto a billed provider because a local service was slow is a
   * charge the operator never agreed to. That case keeps the provisional `direct` behaviour below.
   */
  if (!endpointConfigured()) {
    provisional = false;
    log('INFO', 'llm_provider_selected', { provider: 'openai', via: 'no-endpoint-configured' });
    return createOpenAiProvider();
  }

  provisional = !probe.conclusive;
  log('INFO', 'llm_provider_selected', { provider: 'direct', via: probe.conclusive ? 'probe' : 'probe-unreachable' });
  return createDirectProvider();
}

/**
 * The provider for this process. Cheap after the first call; safe to call from a 2s poll.
 * Concurrent callers share one resolution.
 */
/**
 * A provider chosen at RUNTIME by the operator (`/openai`), overriding config and probe alike.
 *
 * Separate from `configured()` on purpose: that reads persisted settings, this is "for this session,
 * right now". Set back to null and the normal resolution takes over again, which is what makes the
 * switch reversible mid-task.
 */
let override: LlmProvider | null = null;
let overrideName = '';

export function setProviderOverride(name: 'openai' | null): string {
  if (name === null) {
    override = null;
    overrideName = '';
    return '';
  }
  override = createOpenAiProvider();
  overrideName = name;
  return name;
}

export function providerOverrideName(): string { return overrideName; }

export async function llmProvider(): Promise<LlmProvider> {
  if (override) return override;
  if (!current) return inFlight ?? (inFlight = start());
  // A re-probe runs in the BACKGROUND. Callers that already have a working provider must never wait
  // three seconds on a network probe just to read the status bar.
  if (provisional && !inFlight && Date.now() - lastProbeAt > REPROBE_EVERY_MS) inFlight = start();
  return current;
}

function start(): Promise<LlmProvider> {
  lastProbeAt = Date.now(); // claimed synchronously, so concurrent callers cannot storm the probe
  return resolve()
    .then((p) => {
      // Never downgrade: once an authority-bearing provider is in use, a transient network blip must
      // not swap it out from under a live hold.
      if (!(current?.name === 'resource' && p.name === 'direct')) current = p;
      return current as LlmProvider;
    })
    .catch(() => {
      // resolve() is already defensive; this is the belt to its braces. Selection never throws.
      current = current ?? createDirectProvider();
      provisional = true;
      return current;
    })
    .finally(() => { inFlight = null; });
}

/** Resolve the provider once at boot, so the first UI paint already knows what exists. */
export async function initLlmProvider(): Promise<LlmProvider> {
  return llmProvider();
}

/** The active provider's name, or '' before the first resolution. For logs and messages only. */
export function llmProviderName(): string {
  return current?.name ?? '';
}
