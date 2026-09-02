/**
 * `/model` — the model picker and the session's model booking.
 *
 * `/model` with no argument opens a popup (the same overlay the tool-permission prompt uses) whose rows
 * are PROVIDERS — who answers: the local endpoint, or OpenAI. Enter switches; Esc changes nothing.
 *
 * It used to list every chat model the backend had installed. That stopped being ayin's business when
 * the model became the endpoint's to choose — ayin does not know or control what is served — but the
 * popup was the right shape and is kept: this is a pick-one-from-a-short-list decision, and printing a
 * paragraph that asks the operator to type a second command is not.
 *
 * `/model gemma|qwen|auto` is a DIFFERENT choice on the same command: the adapter, i.e. how ayin formats
 * tool calls for a model family. It stays on the argument form so it cannot be mistaken in a list for
 * something that changes the model.
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
 * installation serves a fixed model, the picker says so, and nothing else
 * in the UI mentions either — no empty popup, no failed request, no error.
 *
 * TECH DEBT — see docs/TechDebt.md "model picker & GPU status".
 */

import { addMessage, setAgentStatus } from './ui.js';
import { showDialog, type DialogOption } from './dialog.js';
import { setConfigValue } from './prompts.js';
import { llmProvider, llmProviderName, setProviderOverride, providerOverrideName, resetProviderResolution } from './llm/select.js';
import { openAiKey, openAiModel } from './llm/providers/openai.js';
import { noKeyMessage } from './tools/credentials/openai.js';
import { fetchCatalog, fetchGpu, resolveModelName, statusSource, type GpuInfo, type ModelCatalog, type QueueInfo } from './llm-status.js';
import { refreshActiveModel, activeModelId, resetModelResolution, setAdapter, adapterNames, activeAdapter } from './llm/manager.js';
import { getConfig, getConfigString } from './prompts.js';
import { log } from './log.js';

/**
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
/** Model booking is gone with the lock: ayin runs on whatever the endpoint serves. */
export function isModelBooked(): boolean {
  return false;
}

/** Kept as a no-op so callers need not learn that booking is gone. Nothing is held any more. */
export async function releaseModelHold(): Promise<void> {
  /* the authority layer was removed: ayin holds nothing */
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

  // No booking: ayin asks the endpoint to serve a model and works on whatever it serves. Nothing is
  // held, so nothing has to be released, and no other consumer waits on this session.

  const res = await provider.setModel(model, '');
  if (!res) {
    addMessage('system', `Backend refused the swap to ${model} (unknown model, or it declined the request).`);
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
/**
 * `/model` — pick the ADAPTER. Nothing else.
 *
 * There is no physical connection between this command and anything on a GPU. ayin does not know what
 * Ollama has pulled, what the resource layer is serving, or whether a card exists at all — and it has no
 * business knowing. An adapter is a MODEL SPECIFICATION: how that family formats and parses tool calls.
 * Gemma is Google's and does it differently from Qwen. That is the entire subject.
 *
 * So this reads from ayin's OWN list of adapters and makes no network call. If the endpoint is serving
 * qwen and the operator selects gemma, ayin speaks gemma and is blindfolded — deliberately, because that
 * is the operator's decision to make and ayin is in no position to overrule it.
 *
 * It used to fetch a catalogue and swap the served model. On a shared card that is ayin reaching into
 * someone else's business: another process may be mid-run on that model, and one session promoting its
 * own preference is the race the host's queue exists to prevent.
 */
/**
 * `/model openai` and `/model local` — WHICH BRAIN, as opposed to which adapter.
 *
 * These sit in the same command because they answer the same operator question ("what is answering me,
 * and how do I change it?"), and separating them put the two halves of one decision behind two verbs.
 * They remain different KINDS of choice, and the listing says so: an adapter is how ayin speaks to
 * whatever the endpoint serves; the provider is who serves it.
 *
 * OpenAI is never entered without a key. Switching to a provider that then throws on every prompt is a
 * worse failure than refusing the switch, because the operator has already moved on by the time it
 * surfaces — and it is billed per token, so the refusal costs them nothing to discover.
 */
async function handleProviderChoice(want: string): Promise<boolean> {
  if (want === 'openai' || want === 'gpt') {
    if (!openAiKey()) {
      addMessage('system', noKeyMessage());
      return true;
    }
    setProviderOverride('openai');
    const provider = await llmProvider();
    const status = await provider.status();
    if (!status.ok) {
      setProviderOverride(null);
      addMessage('system', 'OpenAI is unreachable or rejected the key — staying on the local provider. Re-check with /openai.');
      return true;
    }
    // PERSIST it. The override is a module variable, so choosing OpenAI here used to last exactly
    // as long as this process — and `ayin indulge`, `ayin explain`, `ayin watch` and the next TUI
    // are all different processes. The operator picks a provider once; every later invocation has to
    // honour that without being told again on the command line.
    setConfigValue('llmProvider', 'openai');
    resetModelResolution(); // a new provider serves a different model — never inherit the old id
    await refreshActiveModel();
    addMessage('system', `Now on OpenAI (${status.model || openAiModel()}) — billed per token, for this and every later run. /model local to go back.`);
    return true;
  }

  if (want === 'local') {
    /**
     * "AM I ON OPENAI?" IS NOT THE SAME QUESTION AS "DID I ASK FOR OPENAI?" — and conflating them made
     * this command lie.
     *
     * It used to answer from `providerOverrideName()`, which only `/model openai` sets. But OpenAI is
     * ALSO where resolution lands when nothing local is configured (select.ts, the fresh-clone default),
     * and that sets no override. So on a machine with no local endpoint, `/model` reported "already on
     * the local provider" while the status bar showed gpt-5.5 and every token was billed. Reported by the
     * operator, who could see both lines at once.
     *
     * So: ask what is actually RESOLVED, and after clearing the override, ask again — because clearing an
     * override cannot conjure a local model that was never configured.
     */
    const before = (await llmProvider()).name;
    if (before !== 'openai') {
      addMessage('system', `Already on the local provider (${before}${activeModelId() ? ` · ${activeModelId()}` : ''}).`);
      return true;
    }
    setProviderOverride(null);
    // Persisted too, symmetrically: a choice that only one direction remembers is worse than one
    // neither remembers, because "go back to local" would silently last one process.
    setConfigValue('llmProvider', '');
    resetProviderResolution(); // config may have changed; re-decide instead of reusing the boot answer
    resetModelResolution(); // …and the model id with it, or the old provider's dialect survives the switch
    const after = (await llmProvider()).name;
    await refreshActiveModel();
    if (after === 'openai') {
      addMessage('system',
        'No local model is configured, so OpenAI is still what answers — clearing the choice cannot '
        + 'invent one.\nPoint ayin at a local model, then run /model local again:\n'
        + '  /set llm-provider ollama            (a local Ollama)\n'
        + '  /set llm-url http://host:9100       (an endpoint serving the HTTP contract)');
      return true;
    }
    addMessage('system', `Now on the local provider (${after}${activeModelId() ? ` · ${activeModelId()}` : ''}).`);
    return true;
  }
  return false;
}

/**
 * Bare `/model` — a POPUP, and the choice is WHO ANSWERS.
 *
 * It used to list the models installed on a backend, which stopped being ayin's business when the model
 * became the endpoint's to choose. The popup is the right shape though: this is a pick-one-from-a-short-
 * list decision, and a printed paragraph asking the operator to type a second command is not.
 *
 * The rows are providers. Adapters stay on the argument form (`/model gemma|qwen|auto`) because they are
 * a different kind of choice — how ayin SPEAKS, not who it speaks to — and mixing both into one list
 * would make an adapter look like something that changes the model.
 */
async function showProviderPicker(): Promise<void> {
  // The RESOLVED provider, which is the only honest answer to "what answers me right now" — an override
  // is one of several ways to arrive at OpenAI, and the default is another.
  const active = (await llmProvider()).name;
  const onOpenAi = active === 'openai';
  const key = openAiKey();
  const cur = activeAdapter();
  const localName = onOpenAi ? (llmProviderName() === 'openai' ? '' : llmProviderName()) : llmProviderName();
  const localModel = activeModelId();

  const options: DialogOption[] = [
    {
      label: 'Local',
      note: onOpenAi ? (localName || 'not configured') : `${localName} · active`,
      sub: onOpenAi
        ? (localName ? 'a model you host — nothing leaves this machine'
          : 'nothing local configured yet — /set llm-provider ollama, or /set llm-url http://host:9100')
        : (localModel ? `serving ${localModel}` : 'a model you host — nothing leaves this machine'),
    },
    {
      label: 'OpenAI',
      note: key ? (onOpenAi ? 'active · billed per token' : 'billed per token') : 'no key',
      // The absence of a key is the whole reason a row would not work, so it says the fix here rather
      // than after the operator has already picked it.
      sub: key ? `${openAiModel()} · hosted, needs no GPU` : 'run /openai sk-… first — the key is verified before it is saved',
    },
  ];

  const choice = await showDialog('Who answers', options, {
    subtitle: `adapter ${cur.id}${cur.forced ? ' (chosen)' : ' (matched)'} · /model gemma|qwen|auto to change how ayin formats tool calls`,
    selected: onOpenAi ? 1 : 0,
    footer: '↑↓ select · Enter switch · Esc cancel',
  });

  if (choice < 0) return;
  if (choice === 1) {
    await handleProviderChoice('openai');
    return;
  }
  await handleProviderChoice('local');
}

/**
 * `/indulge-model` — WHO builds the corpus, picked the same way as who answers.
 *
 * A build is hours of a model reading source; a chat turn is seconds. Those are different jobs, and
 * the operator legitimately wants them on different machines — the corpus on a hosted model for the
 * window and the reasoning, the agent on the card in the room at no cost per token. The decision that
 * matters is exactly two rows wide, which is why it is a dialog and not a syntax to remember.
 *
 * The TIER is the whole cost of a build. The same corpus on a flagship and on the cheap tier differ
 * by an order of magnitude, and a build is thousands of calls, so choosing OpenAI asks a second
 * question rather than silently taking that provider's default — which is the expensive one.
 */
export async function showIndulgePicker(): Promise<void> {
  const { indulgeBackend } = await import('./indulge/index.js');
  const cur = indulgeBackend();
  const key = openAiKey();
  const local = llmProviderName();
  const localModel = activeModelId();

  const options: DialogOption[] = [
    {
      label: 'Local',
      note: cur.provider && cur.provider !== 'openai' ? `${cur.provider} · chosen` : local,
      sub: localModel
        ? `${localModel} · your card, no cost per token, hours instead of minutes`
        : 'a model you host — no cost per token, and slower',
    },
    {
      label: 'OpenAI',
      note: key ? (cur.provider === 'openai' ? `${cur.model || 'default model'} · chosen` : 'billed per token') : 'no key',
      sub: key
        ? 'hosted — a build is thousands of calls, so the tier is the whole bill'
        : 'run /openai sk-… first — the key is verified before it is saved',
    },
    {
      label: 'Follow the agent',
      note: cur.provider ? '' : 'current',
      sub: 'build on whatever /model is set to — one choice instead of two',
    },
  ];

  const choice = await showDialog('What builds the corpus', options, {
    subtitle: 'indulge only — the interactive agent is not touched',
    selected: cur.provider === 'openai' ? 1 : cur.provider ? 0 : 2,
    footer: '↑↓ select · Enter choose · Esc cancel',
  });
  if (choice < 0) return;

  if (choice === 2) {
    setConfigValue('indulgeProvider', '');
    setConfigValue('indulgeModel', '');
    addMessage('system', 'indulge follows the agent\'s provider again.');
    return;
  }

  if (choice === 0) {
    setConfigValue('indulgeProvider', llmProviderName());
    setConfigValue('indulgeModel', '');
    addMessage('system', `indulge builds on ${llmProviderName()} — whatever model is resident. The agent is unchanged.`);
    return;
  }

  if (!key) {
    addMessage('system', 'No OpenAI key stored. Run /openai sk-… first — it is verified before it is saved.');
    return;
  }

  // The tier, as its own question. Prices move and this list will rot: it says so, and any other id
  // can still be set with `/indulge-model openai <model>`.
  const tiers: DialogOption[] = [
    { label: 'gpt-4.1', note: cur.model === 'gpt-4.1' ? 'current' : 'cheap', sub: 'the working tier for a corpus — thousands of calls at a rate you can afford' },
    { label: 'gpt-5.4', note: cur.model === 'gpt-5.4' ? 'current' : '', sub: 'general-work tier — better reasoning, several times the bill' },
    { label: 'gpt-5.5', note: cur.model === 'gpt-5.5' ? 'current' : 'expensive', sub: 'flagship — for a corpus this is rarely worth it' },
    { label: "that provider's default", note: cur.model ? '' : 'current', sub: 'whatever openai.ts picks — today the expensive tier' },
  ];
  const tier = await showDialog('Which OpenAI model', tiers, {
    subtitle: 'the tier IS the cost of a build · any other id: /indulge-model openai <model>',
    selected: Math.max(0, tiers.findIndex((t) => t.note === 'current')),
    footer: '↑↓ select · Enter choose · Esc cancel',
  });
  if (tier < 0) return;

  setConfigValue('indulgeProvider', 'openai');
  setConfigValue('indulgeModel', tier === 3 ? '' : tiers[tier].label);
  addMessage('system', `indulge builds on openai${tier === 3 ? " · that provider's default model" : ` · ${tiers[tier].label}`}.`
    + ' The interactive agent is unchanged.');
}

export async function handleModelCommand(arg: string): Promise<void> {
  const want = arg.trim().toLowerCase();
  const names = adapterNames();
  const cur = activeAdapter();

  if (!want) {
    await showProviderPicker();
    return;
  }

  if (await handleProviderChoice(want)) return;

  if (!setAdapter(want)) {
    addMessage('system',
      `No adapter "${arg.trim()}". Available: ${names.join(', ')}, auto — or openai / local to change `
      + `WHO answers. An adapter selects how ayin SPEAKS, not what the endpoint serves — ayin cannot `
      + `change that and does not know what it is.`);
    return;
  }

  const now = activeAdapter();
  addMessage('system', now.forced
    ? `Adapter: ${now.id}. ayin will speak ${now.id} regardless of what the endpoint serves.`
    : `Adapter: automatic — ${now.id}, matched from the served model id.`);
}

/**
 * `/set-subagent-model` with no argument — pick what the CHILDREN run on.
 *
 * WHY IT IS A DIALOG. The decision has two axes and neither is guessable from a flag: which provider,
 * and then which TIER of it. The tier is the whole cost of a build — a five-phase job is five children,
 * each with its own context and its own budget — and a syntax nobody remembers is how a setting that
 * matters goes unset. `/indulge-model` made the same argument first; this is that shape.
 *
 * THE MODEL LIST IS THE ACCOUNT'S OWN, NOT A TABLE IN THIS FILE. `/indulge-model` hardcodes ids and
 * says out loud that the list will rot — and it has: it still offers `gpt-4.1` as its top row. Asking
 * the API which models this key can actually reach cannot rot, cannot offer an id that 404s, and picks
 * up whatever shipped last week without an ayin release. What IS hardcoded is only the guidance
 * attached to ids we recognise, matched by substring so a point release inherits it.
 */
export async function showSubagentModelPicker(): Promise<void> {
  const key = openAiKey();
  const curProvider = (getConfigString('subagentProvider') ?? '').trim();
  const curModel = (getConfigString('subagentModel') ?? '').trim();

  const top: DialogOption[] = [
    {
      label: 'OpenAI — pick a tier',
      note: curProvider === 'openai' ? 'current' : '',
      sub: key ? 'the children get a hosted model; this agent keeps arbitrating on your card'
        : 'needs a key first — /openai sk-…',
    },
    {
      label: 'Follow this agent',
      note: curProvider ? '' : 'current',
      sub: 'children run on whatever /model is set to — one choice instead of two, and no bill',
    },
  ];
  const which = await showDialog('What do subagents run on', top, {
    subtitle: 'children only — the agent that arbitrates is not touched',
    selected: curProvider === 'openai' ? 0 : 1,
    footer: '↑↓ select · Enter choose · Esc cancel',
  });
  if (which < 0) return;

  if (which === 1) {
    setConfigValue('subagentProvider', '');
    setConfigValue('subagentModel', '');
    addMessage('system', 'Subagents follow the agent\'s provider again.');
    return;
  }
  if (!key) {
    addMessage('system', noKeyMessage());
    return;
  }

  const ids = await openAiChatModels();
  if (!ids.length) {
    addMessage('system', 'Could not list models for that key. Set one directly: /set-subagent-model openai <id>.');
    return;
  }

  const tiers: DialogOption[] = rankForAgentic(ids).slice(0, 8).map((m) => ({
    label: m.id,
    note: m.id === curModel ? 'current' : m.tag,
    sub: m.why,
  }));
  tiers.push({
    label: "that provider's default",
    note: curModel ? '' : 'current',
    sub: 'whatever openai.ts picks — re-read when the lineup moves',
  });

  const tier = await showDialog('Which OpenAI model for the children', tiers, {
    subtitle: 'the tier IS the cost — a five-phase build is five children · any other id: /set-subagent-model openai <id>',
    selected: Math.max(0, tiers.findIndex((t) => t.note === 'current')),
    footer: '↑↓ select · Enter choose · Esc cancel',
  });
  if (tier < 0) return;

  const chosen = tier === tiers.length - 1 ? '' : tiers[tier].label;
  setConfigValue('subagentProvider', 'openai');
  setConfigValue('subagentModel', chosen);
  addMessage('system', `Subagents will run on openai${chosen ? ` · ${chosen}` : " · that provider's default model"}.`
    + ' This agent is unchanged. Every child now costs money per token.');
}

/**
 * `/set-background-model` — where a run sent to the background with `Ctrl+B` does its thinking.
 *
 * THIS IS THE SETTING THAT MAKES BACKGROUNDING REAL. On a self-hosted card the model is one queue:
 * detaching a task from the turn hands back the prompt but not the GPU, so the operator's next round
 * still waits behind the task they just got out of the way. Pointing the lane at a hosted endpoint
 * with its own capacity is what turns "not blocking the UI" into "actually running alongside".
 *
 * Left unset, `Ctrl+B` still detaches — it just says the run stayed on this model. A key press to
 * unblock yourself must never be the thing that starts spending money.
 */
export async function showBackgroundModelPicker(): Promise<void> {
  const key = openAiKey();
  const curProvider = (getConfigString('backgroundProvider') ?? '').trim();
  const curModel = (getConfigString('backgroundModel') ?? '').trim();

  const top: DialogOption[] = [
    {
      label: 'OpenAI — pick a tier',
      note: curProvider === 'openai' ? 'current' : '',
      sub: key ? 'a backgrounded run gets its own capacity — genuinely parallel with your next turn'
        : 'needs a key first — /openai sk-…',
    },
    {
      label: 'Stay on this model',
      note: curProvider ? '' : 'current',
      sub: 'Ctrl+B still detaches, but the run keeps queueing on the same card — no bill, no parallelism',
    },
  ];
  const which = await showDialog('Where background runs think', top, {
    subtitle: 'only runs you send away with Ctrl+B · this agent and its subagents are not touched',
    selected: curProvider === 'openai' ? 0 : 1,
    footer: '↑↓ select · Enter choose · Esc cancel',
  });
  if (which < 0) return;

  const { resetLaneProvider } = await import('./background.js');
  if (which === 1) {
    setConfigValue('backgroundProvider', '');
    setConfigValue('backgroundModel', '');
    resetLaneProvider();
    addMessage('system', 'Background runs stay on this model. They still detach from the turn.');
    return;
  }
  if (!key) {
    addMessage('system', noKeyMessage());
    return;
  }

  const ids = await openAiChatModels();
  if (!ids.length) {
    addMessage('system', 'Could not list models for that key. Set one directly: /set-background-model openai <id>.');
    return;
  }

  const tiers: DialogOption[] = rankForAgentic(ids).slice(0, 8).map((m) => ({
    label: m.id,
    note: m.id === curModel ? 'current' : m.tag,
    sub: m.why,
  }));
  tiers.push({
    label: "that provider's default",
    note: curModel ? '' : 'current',
    sub: 'whatever openai.ts picks — re-read when the lineup moves',
  });

  const tier = await showDialog('Which OpenAI model for background runs', tiers, {
    subtitle: 'a backgrounded task runs unattended — the tier is what it costs while you are not watching',
    selected: Math.max(0, tiers.findIndex((t) => t.note === 'current')),
    footer: '↑↓ select · Enter choose · Esc cancel',
  });
  if (tier < 0) return;

  const chosen = tier === tiers.length - 1 ? '' : tiers[tier].label;
  setConfigValue('backgroundProvider', 'openai');
  setConfigValue('backgroundModel', chosen);
  resetLaneProvider();
  addMessage('system', `Ctrl+B now moves a run onto openai${chosen ? ` · ${chosen}` : " · that provider's default model"}.`
    + ' Nothing else changes provider; a backgrounded run bills per token while it runs.');
}

/** The chat-capable ids this key can actually reach. Empty when the call fails — never a guess. */
async function openAiChatModels(): Promise<string[]> {
  try {
    const { createOpenAiProvider } = await import('./llm/providers/openai.js');
    const catalog = await createOpenAiProvider().models?.();
    return (catalog?.models ?? []).map((m) => m.name).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * What each id is FOR, when we recognise it — the part a list of ids cannot tell you.
 *
 * Researched 2026-09-02 and it will age: the GPT-5.6 family (Sol $4/$20, Terra $2/$12, Luna
 * $0.20/$1.20) went GA in July 2026, Luna's price fell 80% on the 30th, and Sol's coding strength is
 * specifically AGENTIC — terminal workflows, multi-step tool coordination, long-horizon engineering —
 * which is exactly what a subagent does. GPT-5.5 ($5/$30, ~88.7% SWE-bench Verified) is the older
 * flagship and costs MORE than Sol for less agentic focus. Codex is the coding-specialised, cheaper
 * line. Matched by SUBSTRING so a point release inherits the note rather than falling through.
 *
 * An unrecognised id is still offered, unannotated. This file's opinion is not a whitelist.
 */
export interface Ranked { id: string; tag: string; why: string; rank: number }

export function rankForAgentic(ids: string[]): Ranked[] {
  const seen = ids.map((id) => {
    const l = id.toLowerCase();
    // MEASURED AGAINST THE LIVE API, 2026-09-02, not inferred from prices — and it reorders the list.
    // gpt-5.5 is the only tier here that takes function tools WITH reasoning; the whole 5.6 family
    // requires reasoning_effort:'none' (openai.ts sends it), and Codex refuses /v1/chat/completions
    // outright, which is the endpoint this client speaks.
    if (/codex/.test(l)) return { id, tag: 'unsupported', why: 'needs the /v1/responses endpoint — this client speaks chat/completions, so it cannot drive tools here', rank: 8 };
    if (/5\.5/.test(l) && !/pro/.test(l)) return { id, tag: 'agentic', why: 'the only tier that takes tools WITH reasoning on this endpoint — ~$5/$30', rank: 0 };
    if (/sol/.test(l)) return { id, tag: 'agentic', why: 'agentic flagship, ~$4/$20 — tools work, but with reasoning off (API restriction)', rank: 1 };
    if (/terra/.test(l)) return { id, tag: 'balanced', why: 'balanced production tier, ~$2/$12 — tools with reasoning off', rank: 3 };
    if (/luna/.test(l)) return { id, tag: 'cheap', why: 'cheap + fast, ~$0.20/$1.20 — tools with reasoning off; fine for small or repetitive phases', rank: 4 };
    if (/nano/.test(l)) return { id, tag: 'cheapest', why: 'cheapest tier — expect it to struggle on a real phase', rank: 5 };
    if (/mini/.test(l)) return { id, tag: 'cheap', why: 'cheap tier — a phase that loops will still cost you', rank: 5 };
    if (/pro/.test(l)) return { id, tag: 'very costly', why: '~$30/$180 — a runaway phase here is expensive', rank: 7 };
    if (/gpt-4/.test(l)) return { id, tag: 'old', why: 'a generation behind — not what you want driving tools', rank: 9 };
    return { id, tag: '', why: '', rank: 6 };
  });
  return seen.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}
