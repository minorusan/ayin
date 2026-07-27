/**
 * `/model` — the model picker and the session's model booking.
 *
 * `/model` with no argument opens the popup (the same overlay the tool-permission prompt uses):
 * every chat model the backend has installed, polled live from the llm resource, with the active
 * one pre-selected. Enter initiates the reload; Esc changes nothing.
 * `/model qwen` · `/model gemma4:26b` skip the popup and switch straight away.
 *
 * ONE DOOR. ayin never touches Ollama and never picks a model by itself: it takes the `ayin`
 * authority on the backend llm resource and calls the guarded `setModel` action with that token,
 * so the swap is serialized against every other GPU consumer. Switching back to the SHARED model
 * is a RELEASE, not a set — the backend reverts to gemma on its own when the stack empties, which
 * is also what happens if ayin is killed (the grant TTL-expires, keepalive is unref'd).
 *
 * A swap costs 30-60s of VRAM churn, so the wait is explicit and bounded: we poll the resource
 * until the model is resident, narrating each step, and give up with a clear message rather than
 * hanging the TUI. The live phase in the status bar (SSE) shows the same swap independently.
 *
 * TECH DEBT — see docs/TechDebt.md "model picker & GPU status".
 */

import { addMessage, setAgentStatus } from './ui.js';
import { showDialog, type DialogOption } from './dialog.js';
import { acquireLlm, resourceOp, type LlmHold } from './resource-client.js';
import { fetchCatalog, fetchGpu, resolveModelName, statusSource, type GpuInfo, type ModelCatalog, type QueueInfo } from './llm-status.js';
import { refreshActiveModel, activeModelId } from './llm/manager.js';
import { log } from './log.js';

/** The session's booking. Held until /quit, /model <shared>, or process exit (grant TTL). */
let modelHold: LlmHold | null = null;

export function isModelBooked(): boolean {
  return !!modelHold && typeof modelHold === 'object';
}

export async function releaseModelHold(): Promise<void> {
  const h = modelHold;
  modelHold = null;
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
  if (m.name === cat.maradelModel) bits.push('shared');
  if (m.name === cat.coderModel) bits.push('coder');
  if (m.name === cat.activeModel) bits.push('● active');
  return bits.join(' · ');
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
  // The shared model is the backend's default: release ownership and let it revert. Setting it
  // while still holding the authority would keep the GPU booked for a model we don't own.
  if (model === cat.maradelModel) {
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
  const res = await resourceOp('llm', 'setModel', { model, authority: token }, 10_000);
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

/** The popup: pick a model from what the backend actually has installed. */
export async function openModelPicker(): Promise<void> {
  setAgentStatus('Reading the model catalog…');
  const [cat, telemetry] = await Promise.all([fetchCatalog({ force: true }), fetchGpu()]);
  setAgentStatus('');

  if (!cat || cat.models.length === 0) {
    addMessage('system', `Cannot read the model catalog from ${statusSource()} — is the backend up?`);
    return;
  }

  const options: DialogOption[] = cat.models.map((m) => ({ label: m.name, note: noteFor(m, cat) }));
  const activeIdx = Math.max(0, cat.models.findIndex((m) => m.name === cat.activeModel));

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
  const picked = cat.models[choice];
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
  if (!t) { await openModelPicker(); return; }

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
