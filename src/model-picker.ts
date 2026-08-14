/**
 * `/model` — the model picker and the session's model booking.
 *
 * `/model` with no argument opens the popup (the same overlay the tool-permission prompt uses):
 * every chat model the backend has installed, polled live from the llm resource, with the active
 * one pre-selected. Enter initiates the reload; Esc changes nothing.
 * `/model qwen` · `/model gemma4:26b` skip the popup and switch straight away.
 *
 * ONE DOOR. ayin never touches a model runtime and never picks a model by itself: it takes the
 * `ayin` authority through the provider and calls the guarded `setModel` action with that token,
 * so the swap is serialized against every other GPU consumer. Switching back to the SHARED model
 * is a RELEASE, not a set — the provider reverts on its own when the stack empties, which is also
 * what happens if ayin is killed (the grant TTL-expires, keepalive is unref'd).
 *
 * A swap costs 30-60s of VRAM churn, so the wait is explicit and bounded: we poll until the model
 * is resident, narrating each step, and give up with a clear message rather than hanging the TUI.
 * The live phase in the status bar shows the same swap independently.
 *
 * NOT EVERY PROVIDER HAS ANY OF THIS. `setModel` and `acquire` are OPTIONAL capabilities of the LLM
 * port; the public `direct` provider has neither. Then `/model` says, in one line, that this
 * installation serves a fixed model, `/lock` says there is no authority to take, and nothing else
 * in the UI mentions either — no empty popup, no failed request, no error.
 *
 * TECH DEBT — see docs/TechDebt.md "model picker & GPU status".
 */

import { addMessage, setAgentStatus } from './ui.js';
import { showDialog, type DialogOption } from './dialog.js';
import { acquireLlm, type LlmHold } from './llm/authority.js';
import { llmProvider } from './llm/select.js';
import { setRequestAuthority } from './connection.js';
import { fetchCatalog, fetchGpu, resolveModelName, statusSource, type GpuInfo, type ModelCatalog, type QueueInfo } from './llm-status.js';
import { refreshActiveModel, activeModelId, setAdapter, adapterNames, activeAdapter } from './llm/manager.js';
import { getConfig, getConfigString } from './prompts.js';
import { log } from './log.js';

/** The session's booking. Held until /quit, /model <shared>, or process exit (grant TTL). */
let modelHold: LlmHold | null = null;

/**
 * `/lock` — hold this session's PRIORITY BAND until the client exits or stops responding.
 *
 * The mechanism is the grant TTL itself, which is why it needs no server-side session tracking: the
 * hold is taken with a SHORT 10-minute ttl and refreshed every 2 minutes while ayin is alive. Quit
 * cleanly and it is released immediately; die, hang, or lose the network and the grant simply lapses
 * within 10 minutes and the backend reverts on its own. Nothing can be left locked forever by a
 * process that no longer exists.
 *
 * A LOCK IS NOT A MODEL CHOICE, and never sets one. It used to: taking the authority made an endpoint
 * with a per-owner model policy swap to its coding default, so the lock had to compensate — pin the
 * model, remember it, re-apply it whenever the grant rotated. All of that machinery existed only to
 * fight a policy on the other side of the wire. The endpoint no longer applies one, and the operator's
 * rule is now explicit: **ayin never selects a model implicitly.** It runs on whatever the endpoint is
 * serving and changes it only when a human asks (`/model <name>`) — one door, one deliberate request.
 */
const LOCK_TTL_MS = 10 * 60 * 1000;
const LOCK_KEEPALIVE_MS = 2 * 60 * 1000;
let locked = false;

export function isSessionLocked(): boolean {
  return locked && isModelBooked();
}

/**
 * Whether locking means anything here. Callers that lock on their own initiative (the interactive
 * auto-lock) must check this and stay SILENT when it is false — an installation without an authority
 * layer has nothing to lock, and saying so unprompted is noise about a feature it never had.
 */
export async function lockSupported(): Promise<boolean> {
  return typeof (await llmProvider()).acquire === 'function';
}

/**
 * Take the lock. Returns '' on success, else a human reason.
 *
 * Authority ONLY — it fires no model swap, in any code path. Everything this function used to do about
 * models (a `pinTo` target, remembering `lockedModel`, a "put it back" corrective swap, a re-pin when
 * the grant rotated) was compensation for an endpoint that swapped the model on `ownership.gained`.
 * Three releases (1.0.207-1.0.209) went into making that compensation land correctly on every machine;
 * removing the policy removes the whole problem, so the compensation goes with it. If a session wants a
 * particular model, a human types `/model <name>`.
 */
export async function lockSession(): Promise<string> {
  const provider = await llmProvider();
  if (!provider.acquire) return 'this LLM provider has no authority layer — there is nothing to lock';
  if (!isModelBooked()) {
    setAgentStatus('Taking the priority lock…');
    const hold = await acquireLlm('ayin /lock (held while this session lives)', {
      ttlMs: LOCK_TTL_MS,
      keepaliveMs: LOCK_KEEPALIVE_MS,
      force: true, // a human at the keyboard outranks background work of equal or lower rank
      // A backend restart wipes the in-memory authority stack, so the next keepalive returns a NEW
      // grant instead of a refresh. Left alone that breaks the lock silently: the token we send for
      // priority is dead. Re-adopt the new token — and ONLY the token. Re-pinning a model here is
      // exactly the implicit selection that is no longer ayin's business.
      onRegrant: (token, via) => {
        setRequestAuthority(locked ? token : '');
        if (!locked) return;
        addMessage('system', `Lock re-established after the backend dropped it (${via}).`);
        log('INFO', 'lock_regranted', { via });
      },
    });
    setAgentStatus('');
    if (hold === 'busy') return 'the GPU is held by a higher authority right now — try again shortly';
    if (hold === 'no-resource-layer') return 'backend has no resource layer (or is unreachable)';
    modelHold = hold;
  }
  locked = true;
  // From here every generation carries the token, so the backend can promote this session to the
  // front of the GPU queue instead of leaving it in the LOW band behind every habit.
  setRequestAuthority((modelHold as { token: string }).token);
  log('INFO', 'session_locked', { ttlMinutes: String(LOCK_TTL_MS / 60000) });
  return '';
}

/**
 * REMOVED in 1.0.210 — `lockSessionWithDefaultModel()`.
 *
 * It was the startup path that took the lock AND loaded a configured `defaultModel`, waiting until that
 * model was resident. Together with `lockSession`'s "put it back" swap and its re-pin-on-regrant, it
 * meant **launching ayin silently changed which model the shared GPU was serving** — for every other
 * consumer on the machine, not just this session. Three releases (1.0.207-1.0.209) were spent making
 * that behaviour land deterministically; the operator's decision is that it should not happen at all.
 *
 * A model is now only ever loaded because a human asked in the session: `/model` (picker) or
 * `/model <name>`. `/set default-model` is gone with this function — a stored preference that nothing
 * applies is worse than no preference. Sessions start on whatever the endpoint is serving; the status
 * bar and `/model` show what that is.
 */

/** Release the lock (and the booking it took). */
export async function unlockSession(): Promise<void> {
  locked = false;
  setRequestAuthority(''); // back to the LOW band immediately, before the grant is even released
  await releaseModelHold();
  log('INFO', 'session_unlocked', {});
}

export function isModelBooked(): boolean {
  return !!modelHold && typeof modelHold === 'object';
}

export async function releaseModelHold(): Promise<void> {
  const h = modelHold;
  modelHold = null;
  locked = false;
  setRequestAuthority(''); // a stale token would just be ignored, but never send one
  if (h && typeof h === 'object') await h.release().catch(() => {});
}

function gpuLine(g: GpuInfo | null): string {
  if (!g) return 'gpu n/a';
  return `gpu ${g.util}% · ${(g.usedMiB / 1024).toFixed(1)}/${(g.totalMiB / 1024).toFixed(0)}G · ${g.tempC}°C`;
}

/** " · queue: chatOnce 12s +3 waiting" — empty when the shared slot is free. */
function queueLine(q: QueueInfo | null): string {
  if (!q || (!q.running && q.depth === 0)) return '';
  const held = q.running ? `${q.running} ${Math.round(q.runningForMs / 1000)}s` : 'idle';
  return ` · queue: ${held}${q.depth > 0 ? ` +${q.depth} waiting` : ''}`;
}

function noteFor(m: ModelCatalog['models'][number], cat: ModelCatalog): string {
  const bits: string[] = [];
  if (m.parameterSize) bits.push(m.parameterSize);
  if (m.quantization) bits.push(m.quantization);
  if (m.sizeBytes > 0) bits.push(`${(m.sizeBytes / 1024 ** 3).toFixed(1)}G`);
  // The window this model actually gets. Showing one global figure for every row was simply wrong:
  // the KV cost per token is architectural, so the backend sets it per model.
  if (m.ctx) bits.push(`${Math.round(m.ctx / 1024)}k ctx`);
  if (cat.sharedModel && m.name === cat.sharedModel) bits.push('shared');
  if (cat.coderModel && m.name === cat.coderModel) bits.push('coder');
  if (m.name === cat.activeModel) bits.push('● active');
  return bits.join(' · ');
}

/**
 * Which models the popup actually lists. `modelPickerMinSizeGiB` (default 15, 0 disables) hides tiny
 * utility/sidecar models (a domain router, a 3B fallback) from a picker meant for choosing a real
 * coding model — without it the list is dominated by entries nobody would ever pick from a TUI popup.
 *
 * THE ACTIVE MODEL IS NEVER HIDDEN, size or no size. A size filter that could hide what is actually
 * SERVING you would be worse than no filter: the popup would silently mis-highlight (or fail to
 * highlight anything) while claiming to show your options. If a threshold this aggressive left NOTHING
 * (an unlikely rig with nothing installed above it, or `models` reporting zero sizes), fall back to
 * the unfiltered list rather than present an empty, useless popup.
 */
export function filterModelsForPicker(cat: ModelCatalog): { models: ModelCatalog['models']; hiddenCount: number } {
  const minGiB = getConfig('modelPickerMinSizeGiB', 15);
  if (minGiB <= 0) return { models: cat.models, hiddenCount: 0 };
  const minBytes = minGiB * 1024 ** 3;
  // sizeBytes 0 = a HOSTED model, which has no size to compare. The floor exists to hide tiny local
  // sidecars; applying it to a cloud model would empty the picker for the openai provider entirely.
  const kept = cat.models.filter((m) => m.sizeBytes === 0 || m.sizeBytes >= minBytes || m.name === cat.activeModel);
  if (kept.length === 0) return { models: cat.models, hiddenCount: 0 };
  return { models: kept, hiddenCount: cat.models.length - kept.length };
}

/**
 * Wait for the backend to finish the swap: `loadedModel` is what is actually resident in VRAM, so
 * that — not `activeModel`, which flips synchronously — is the finish line. Bounded; a swap that
 * outlives the budget leaves the TUI usable and says so.
 */
async function awaitResident(model: string, budgetMs = 180_000): Promise<boolean> {
  const started = Date.now();
  let lastNote = '';
  while (Date.now() - started < budgetMs) {
    const cat = await fetchCatalog();
    if (cat) {
      if (cat.loadedModel === model) return true;
      const note = `loading ${model} — ${Math.round((Date.now() - started) / 1000)}s`;
      if (note !== lastNote) { setAgentStatus(note); lastNote = note; }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

/** Switch the served model, through the authority. Returns true when the model is resident. */
export async function switchModel(model: string, cat: ModelCatalog): Promise<boolean> {
  const provider = await llmProvider();
  if (!provider.setModel) {
    addMessage('system', `This LLM provider serves a fixed model (${cat.activeModel}) — switching it from here isn't part of the setup.`);
    return false;
  }

  // The shared model is the provider's default: release ownership and let it revert. Setting it
  // while still holding the authority would keep the GPU booked for a model we don't own.
  if (cat.sharedModel && model === cat.sharedModel) {
    if (!isModelBooked()) {
      addMessage('system', `${model} is the shared model and nothing is booked — already served.`);
      return true;
    }
    addMessage('system', `Releasing the coder authority — the backend reverts to ${model}…`);
    setAgentStatus('Releasing the model…');
    await releaseModelHold();
    const ok = await awaitResident(model, 120_000);
    setAgentStatus('');
    await refreshActiveModel().catch(() => {});
    addMessage('system', ok ? `Released — back to the shared model (${model}).` : `Released — ${model} is still loading in the background.`);
    return ok;
  }

  // Any other model means we own the GPU for this session.
  if (!isModelBooked()) {
    addMessage('system', `Requesting the ayin authority from the backend…`);
    setAgentStatus('Acquiring the GPU…');
    const hold = await acquireLlm(`interactive /model ${model} (held for session)`);
    setAgentStatus('');
    if (hold === 'busy') {
      addMessage('system', 'GPU is busy — another authority holds the model right now. Try again shortly.');
      return false;
    }
    if (hold === 'no-resource-layer') {
      addMessage('system', 'Backend has no resource layer (or is unreachable) — cannot switch the model from here.');
      return false;
    }
    modelHold = hold;
  }

  const token = (modelHold as { token: string }).token;
  const res = await provider.setModel(model, token);
  if (!res) {
    addMessage('system', `Backend refused the swap to ${model} (authority lost or unknown model).`);
    log('WARN', 'model_set_failed', { model });
    return false;
  }

  addMessage('system', `Loading ${model} — a swap frees and refills VRAM, it takes a while…`);
  setAgentStatus(`Loading ${model}…`);
  const ok = await awaitResident(model);
  setAgentStatus('');
  await refreshActiveModel().catch(() => {});
  addMessage('system', ok
    ? `${model} is resident — booked until you /quit (or pick the shared model).`
    : `${model} is taking longer than expected; the backend is still loading it. The status bar will settle when it lands.`);
  log('INFO', 'model_switched', { model, resident: String(ok) });
  return ok;
}

/**
 * Is there a model manager here at all? A provider without `setModel` cannot switch models, so the
 * only honest thing `/model` can do is name what is serving you and stop. One line, no popup — the
 * feature is absent, not broken.
 */
async function reportFixedModel(): Promise<boolean> {
  const provider = await llmProvider();
  if (provider.setModel) return false;
  const served = (await provider.status()).model || activeModelId();
  addMessage('system', served
    ? `Serving ${served}. This setup has no model manager, so there is nothing to switch to.`
    : `No model manager here, and ${statusSource()} isn't naming a model — check the endpoint.`);
  return true;
}

/** The popup: pick a model from what the provider actually has installed. */
export async function openModelPicker(): Promise<void> {
  if (await reportFixedModel()) return;
  setAgentStatus('Reading the model catalog…');
  const [cat, telemetry] = await Promise.all([fetchCatalog({ force: true }), fetchGpu()]);
  setAgentStatus('');

  if (!cat || cat.models.length === 0) {
    addMessage('system', `Cannot read the model catalog from ${statusSource()} — is the backend up?`);
    return;
  }

  const { models, hiddenCount } = filterModelsForPicker(cat);
  if (hiddenCount > 0) {
    const minGiB = getConfig('modelPickerMinSizeGiB', 15);
    addMessage('system', `${hiddenCount} smaller model(s) under ${minGiB}G hidden — set modelPickerMinSizeGiB to 0 in prompts.json to show everything.`);
  }
  const options: DialogOption[] = models.map((m) => ({ label: m.name, note: noteFor(m, cat) }));
  const activeIdx = Math.max(0, models.findIndex((m) => m.name === cat.activeModel));

  const choice = await showDialog(
    'Model',
    options,
    {
      // The queue line matters here: picking a model when 4 calls are already waiting means the
      // swap itself queues behind them, so the reload will feel slow for reasons that aren't yours.
      subtitle: `${isModelBooked() ? 'booked by you' : 'shared'} · ${gpuLine(telemetry.gpu)}${queueLine(telemetry.queue)} · ${statusSource()}`,
      selected: activeIdx,
      footer: '↑↓ select · Enter reload · Esc cancel',
    },
  );

  if (choice < 0) return;
  const picked = models[choice];
  if (!picked) return;
  if (picked.name === cat.activeModel && cat.loadedModel === cat.activeModel) {
    addMessage('system', `${picked.name} is already the served model.`);
    return;
  }
  await switchModel(picked.name, cat);
}

/** `/model` → popup · `/model <name|qwen|gemma>` → straight switch. */
export async function handleModelCommand(arg: string): Promise<void> {
  const t = arg.trim();

  // `/model adapter <name>` — choose how ayin SPEAKS to whatever is served, rather than what is served.
  // On a shared host ayin does not own the model: another process may be using it, and forcing a swap to
  // suit this session is the race the authority layer exists to prevent. The adapter is the half ayin can
  // legitimately decide.
  const ad = /^adapter(?:\s+(\S+))?$/i.exec(t);
  if (ad) {
    const want = ad[1];
    if (!want) {
      const cur = activeAdapter();
      addMessage('system',
        `Adapter: ${cur.id}${cur.forced ? ' (forced)' : ' (matched from the served model)'}. `
        + `Available: ${adapterNames().join(', ')}, auto. Set with /model adapter <name>.`);
      return;
    }
    if (!setAdapter(want)) {
      addMessage('system', `No adapter "${want}". Available: ${adapterNames().join(', ')}, auto.`);
      return;
    }
    const cur = activeAdapter();
    addMessage('system', cur.forced
      ? `Adapter forced to ${cur.id} — ayin will speak ${cur.id} whatever the endpoint serves.`
      : `Adapter back to automatic — now ${cur.id}, matched from the served model.`);
    return;
  }

  if (!t) { await openModelPicker(); return; }
  if (await reportFixedModel()) return;

  const cat = await fetchCatalog({ force: true });
  if (!cat) {
    addMessage('system', `Cannot reach the llm resource at ${statusSource()} — model unchanged (serving ${activeModelId() || 'unknown'}).`);
    return;
  }
  const model = resolveModelName(t, cat);
  if (!model) {
    addMessage('system', `No installed model matches "${t}". Known: ${cat.models.map(m => m.name).join(', ')}`);
    return;
  }
  if (model === cat.activeModel && cat.loadedModel === cat.activeModel) {
    addMessage('system', `${model} is already the served model.`);
    return;
  }
  await switchModel(model, cat);
}
