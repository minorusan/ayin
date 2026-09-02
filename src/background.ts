/**
 * background.ts — the SECOND LANE, and why a background task must change providers to be one.
 *
 * THE PROBLEM BACKGROUNDING ACTUALLY HAS HERE. On a self-hosted card the model is one queue, not a
 * lock: two callers do not run in parallel, they take turns. So detaching a long tool from the turn
 * buys the operator their prompt back and nothing else — the moment they type, their round is behind
 * the background task's next generation, and every round after that is too. "Background" that shares
 * one GPU is a UI trick; the work is still sequential and the wait was only moved.
 *
 * A lane is therefore a PROVIDER, not a thread. A backgrounded run's model calls are re-pointed at a
 * hosted endpoint that has its own capacity, and only then is the foreground genuinely free. That is
 * the whole design: the flag lives in the tool gateway (`runs.ts`), and this file is what the flag
 * means.
 *
 * MID-FLIGHT, AND WHAT THAT CAN AND CANNOT REACH. The lane is an AsyncLocalStorage box holding a
 * MUTABLE flag, entered when a run starts. Flipping the flag redirects the NEXT model call made
 * inside that run, so an in-process tool already ten seconds into its work — explore, plan, QA, a
 * connector — moves lanes without being restarted. A `subagent` is a child PROCESS: its provider was
 * fixed by the environment it was spawned with, so backgrounding one detaches it from the turn but
 * cannot move the calls it has left. Arm the lane before it spawns and the child is born in it. The
 * notice says which of the two happened rather than implying the stronger one.
 *
 * THE MODEL GLOBALS ARE NOT SHARED. `manager.ts` caches one model id, one dialect, one tool mode —
 * true of the foreground provider and wrong for a lane pointing somewhere else. A lane carries its
 * own three, so a background call against a native-tool API is not parsed with the dialect of
 * whatever is resident on the card.
 *
 * NEVER INFERRED, ALWAYS BILLED. The lane provider defaults to nothing. Backgrounding with no lane
 * configured still detaches the run — it just stays on the same model, and says so. A key the
 * operator never set must not become a bill because they pressed a key to unblock themselves.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { log } from './log.js';
import { getConfigString } from './prompts.js';
import { providerCredential } from './llm/providers/runtime.js';
import { NativeToolDialect } from './llm/dialects/native.js';
import type { LlmProvider } from './llm/provider.js';
import type { ModelDialect } from './llm/types.js';

/**
 * The box a run carries. MUTABLE on purpose — see the header: flipping `background` is how a run
 * already in flight changes lanes without being torn down and started again.
 */
export interface Lane {
  readonly runId: number;
  readonly tool: string;
  background: boolean;
}

const storage = new AsyncLocalStorage<Lane>();

/** Run `fn` with `lane` attached to it and to everything it awaits. */
export function runInLane<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
  return storage.run(lane, fn);
}

/** The lane of the code calling this, if it is inside a run at all. */
export function currentLane(): Lane | undefined {
  return storage.getStore();
}

/** Whether the caller is executing inside a backgrounded run. */
export function inBackground(): boolean {
  return storage.getStore()?.background === true;
}

// ── which provider the lane points at ────────────────────────────────

/**
 * The lane's provider name, or '' when the operator has not configured one.
 *
 * `/set-background-model`. Deliberately NOT defaulted to openai: see the header — pressing a key to
 * unblock yourself must not silently start spending money.
 */
export function backgroundProviderName(): string {
  return (getConfigString('backgroundProvider') ?? '').trim().toLowerCase();
}

/** The model within that provider, or '' for the provider's own default. */
export function backgroundModelName(): string {
  return (getConfigString('backgroundModel') ?? '').trim();
}

/** Whether a background run would actually move off the foreground model. */
export function laneConfigured(): boolean {
  const p = backgroundProviderName();
  return p !== '' && providerUsable(p, 'backgroundProvider');
}

/**
 * A CONFIGURED PROVIDER WITH NO CREDENTIAL IS NOT A PROVIDER — fall back, never fail.
 *
 * Setting `subagentProvider`/`backgroundProvider` to `openai` is a standing preference, and the key
 * is separate state that can be absent, revoked, or simply not yet pasted on this machine. Honouring
 * the preference anyway means every child is spawned with `AYIN_LLM_PROVIDER=openai` and dies on its
 * first call with a setup hint — the operator set a preference and got a broken agent, and the two
 * facts are a whole debugging session apart.
 *
 * So the preference degrades to "inherit", which is the behaviour that was there before it was set.
 * Said once per key, because a warning on every subagent spawn is noise in the one place the operator
 * is reading tool output.
 *
 * This is the port contract's own rule — "an absent capability renders as NOTHING, not an error" —
 * applied to a credential rather than a method.
 */
const warnedUnusable = new Set<string>();

export function providerUsable(provider: string, settingName: string): boolean {
  if (provider !== 'openai') return true; // only the hosted provider needs a credential
  if (openAiKeyOrEmpty()) return true;
  if (!warnedUnusable.has(settingName)) {
    warnedUnusable.add(settingName);
    log('WARN', 'provider_setting_ignored', {
      setting: settingName, provider, why: 'no openai key is stored — falling back to the agent\'s own provider',
    });
  }
  return false;
}

/**
 * The key, or '' — never throws, whatever state the provider runtime is in.
 *
 * `providerCredential` is the one door to credentials and it is synchronous, but it throws while the
 * runtime is unwired (boot order). Both callers run long after boot, so a throw here means "no
 * credential available to me right now", which is the same answer as "no key" for the one decision
 * being made.
 */
function openAiKeyOrEmpty(): string {
  try {
    return providerCredential('openai').key.trim();
  } catch {
    return '';
  }
}

/**
 * The environment a CHILD process must be spawned with to be born in the lane.
 *
 * Same shape as `subagentModelEnv`, and deliberately separate from it: a subagent model is a standing
 * preference about delegation, a lane is about this one run being got out of the way. An operator may
 * want both, one, or neither.
 */
export function backgroundEnv(): Record<string, string> {
  const provider = backgroundProviderName();
  if (!provider) return {};
  // A child spawned with a provider it has no credential for dies on its first call. Inherit instead.
  if (!providerUsable(provider, 'backgroundProvider')) return {};
  const env: Record<string, string> = { AYIN_LLM_PROVIDER: provider };
  const model = backgroundModelName();
  // PER PROVIDER, because each reads its own. `direct` and `resource` have none — their model is the
  // endpoint's or the preset's to decide, and naming one here would be this process dictating what
  // sits on a card it does not own.
  if (model && provider === 'openai') env.AYIN_OPENAI_MODEL = model;
  if (model && provider === 'ollama') env.AYIN_OLLAMA_MODEL = model;
  return env;
}

/** What a lane hands `llmChat` in place of the module globals. */
export interface LaneTarget {
  provider: LlmProvider;
  dialect: ModelDialect;
  toolMode: 'native' | 'prompt';
  modelId: string;
}

let cached: { key: string; target: LaneTarget } | null = null;

/**
 * The provider a backgrounded call should use, or null to stay in the foreground.
 *
 * Null on every ordinary call, so the foreground path is unchanged and costs one `getStore()`.
 * Memoized by provider+model: constructing a provider per call would re-read credentials and rebuild
 * a client on every round of a long background task.
 */
export async function laneTarget(): Promise<LaneTarget | null> {
  if (!inBackground()) return null;
  const provider = backgroundProviderName();
  if (!provider) return null; // detached but not re-pointed — see the header
  // Configured but uncredentialed: stay in the foreground rather than fail the call.
  if (!providerUsable(provider, 'backgroundProvider')) return null;
  const model = backgroundModelName();
  const key = `${provider}:${model}`;
  if (cached?.key === key) return cached.target;

  const target = await buildTarget(provider, model);
  if (!target) return null;
  cached = { key, target };
  log('INFO', 'background_lane_provider', { provider, model: model || '(default)' });
  return target;
}

async function buildTarget(provider: string, model: string): Promise<LaneTarget | null> {
  if (provider === 'openai') {
    const { createOpenAiProvider } = await import('./llm/providers/openai.js');
    // The API carries the schemas, so the lane declares tools natively and parses with the dialect
    // that expects the runtime to have done the parsing. Reading `toolMode()` here instead would
    // apply the FOREGROUND model's answer to a different model entirely.
    return {
      provider: createOpenAiProvider(),
      dialect: new NativeToolDialect(),
      toolMode: 'native',
      modelId: model || 'openai',
    };
  }
  if (provider === 'ollama') {
    const { createOllamaProvider } = await import('./llm/providers/ollama.js');
    return {
      provider: createOllamaProvider(),
      dialect: new NativeToolDialect(),
      toolMode: 'native',
      modelId: model || 'ollama',
    };
  }
  // `direct` and `resource` point at the same endpoint the foreground already uses, so a lane on
  // either is a lane in name only — it would queue behind the very turn it was meant to unblock.
  log('WARN', 'background_lane_unsupported', { provider });
  return null;
}

/** Forget the memoized provider — after `/set-background-model`, or a credential change. */
export function resetLaneProvider(): void {
  cached = null;
}

// ── what the model is told when its tool is taken away ───────────────

/**
 * The result handed back to the model in place of the output it was waiting for.
 *
 * IT MUST NOT ASK THE MODEL TO POLL. That is the exact mistake this repo already made and reverted:
 * a backgrounded subagent the parent polled six times, hit the poll cap, was told "blocked", and
 * ended the turn having never read a report the child had finished correctly. The result is PUSHED
 * when it lands — as a message into the session — so the only correct instruction here is to carry
 * on without it and not to re-run it.
 */
export function detachNotice(runId: number, tool: string, moved: boolean): string {
  return [
    `\`${tool}\` was moved to the background by the operator (run #${runId}).`,
    moved
      ? 'It is still running, on a separate model, and does not hold this turn up any more.'
      : 'It is still running and does not hold this turn up any more.',
    'Its result will be delivered as a message the moment it finishes — there is nothing to poll and'
    + ' nothing to wait for. Do whatever else the task needs; if everything left depends on this run,'
    + ' say what you are waiting for and end the turn. Do NOT start it again.',
  ].join(' ');
}

/** How a finished background run announces itself, as a message into the next turn. */
export function completionMessage(tool: string, runId: number, ms: number, ok: boolean, output: string): string {
  const secs = (ms / 1000).toFixed(0);
  const head = ok
    ? `[background run #${runId} — \`${tool}\` finished after ${secs}s]`
    : `[background run #${runId} — \`${tool}\` failed after ${secs}s]`;
  return `${head}\n\n${output}`;
}

/** The one line the operator sees when a run leaves the turn. */
export function backgroundHandoffLine(runId: number, tool: string, moved: boolean): string {
  return moved
    ? `⏱ ${tool} → background (run #${runId}, on ${backgroundProviderName()}) — the turn is yours again.`
    : `⏱ ${tool} → background (run #${runId}) — still on this model; /set-background-model to give it its own.`;
}

// ── adoption: nobody is awaiting it, so somebody must ────────────────

/** A detached run still going. Kept so `/status` can answer "what did I background?". */
export interface AdoptedRun {
  id: number;
  tool: string;
  params: string;
  since: number;
}

const adopted = new Map<number, AdoptedRun>();

/** Background runs still going, oldest first. */
export function backgroundRuns(): AdoptedRun[] {
  return [...adopted.values()].sort((a, b) => a.since - b.since);
}

/**
 * Take ownership of a run the turn stopped waiting for, and deliver its result when it lands.
 *
 * THE DELIVERY IS A PUSH, AND THAT IS THE WHOLE POINT. The previous backgrounding in this codebase
 * handed the model a task id and told it to poll; the poll cap ended a turn while a correct report
 * sat unread. Here the result is enqueued as a message the moment the promise settles, so it reaches
 * the model whether the turn that started it is still running or long over.
 *
 * NEVER REJECTS. `startRun` does not throw — a failed tool is an outcome — but an adopted promise
 * with no `catch` would still be an unhandled rejection at process level if that ever changed, and
 * taking down the session because a background task failed is the opposite of what this is for.
 */
export function adoptBackgroundRun(
  id: number,
  tool: string,
  params: string,
  done: Promise<{ ok: boolean; ms: number; output: string; cancelled: boolean }>,
): void {
  adopted.set(id, { id, tool, params, since: Date.now() });
  void done.then(
    async (o) => {
      adopted.delete(id);
      log('INFO', 'background_run_done', { id: String(id), tool, ok: String(o.ok), ms: String(o.ms) });
      // A run cancelled by the operator needs no announcement — they stopped it, they know.
      if (o.cancelled) return;
      const { enqueueAgentMessage } = await import('./agent.js');
      const { addMessage } = await import('./ui/index.js');
      const { saveArtifact } = await import('./artifacts.js');
      // THE OPERATOR MUST BE ABLE TO READ IT WHATEVER THE MODEL DOES. The message below reaches the
      // model on the next round; the artifact reaches the human on the same key that backgrounded it
      // — Ctrl+O is the browser, and it is where a background result lands.
      saveArtifact(tool, params, o.output);
      addMessage('system', `${o.ok ? '✔' : '✘'} background run #${id} — ${tool} finished after ${(o.ms / 1000).toFixed(0)}s. Ctrl+O to read it.`);
      enqueueAgentMessage(completionMessage(tool, id, o.ms, o.ok, o.output));
    },
    (err) => {
      adopted.delete(id);
      log('WARN', 'background_run_threw', { id: String(id), tool, error: err instanceof Error ? err.message : String(err) });
    },
  );
}
