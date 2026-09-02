/**
 * Ayin CLI — the application: TUI, slash commands, the agent loop's caller.
 *
 * NOT the entry point. `index.ts` is, and it runs the preflight gate before importing this module —
 * because `ui/screen.ts` creates the blessed screen at import scope, so anything checked here would
 * already have lost the terminal. See preflight.ts.
 */

// Redirect all console output to file — blessed owns the terminal.
import { log, captureConsole } from './log.js';
captureConsole();

// Hand `tools/` its model and log delegates before anything can call a tool. Idempotent, and every
// other entry point (`plan`, `explain`, the arduino executors, the registry) does the same — wiring
// that depends on another module's import order is the bug this replaced.
import { ensureToolRuntime } from './tool-wiring.js';
import { disentangle, entangledTo } from './entangle/index.js';
ensureToolRuntime();

import {
  screen, addMessage, setStatus, setAgentStatus, clearChat, noteCallCost,
  onInput, onGlobalKey, focusInput, blurInput, shutdown, getTokensDisplay,
  showAlert, setStickyAlert, clearStickyAlert, registerCommand, formatShellForChat, clearInput,
  lastAssistantMessage, onAssistantMessage,
} from './ui.js';
import { isTranscribing, startTranscript, stopTranscript, transcriptPath, transcriptSize, flush as flushTranscript } from './transcript.js';
import { executeWipe, humanBytes, planWipe, wipeOverview, type WipeScope } from './wipe.js';
import { connect, disconnect, onConnectionChange, isConnected, currentRequestId } from './connection.js';
import { refreshActiveModel, activeModelId, activeContextTokens, lastUsage, onLlmUsage } from './llm/manager.js';
import { initLlmProvider } from './llm/select.js';
import { getSummaryText, getSummary, resetSummary } from './summary.js';
import { estimateSessionTokens } from './tokens.js';
import { loadHistory, pushEntry, forgetEntry } from './history.js';
import { forcePlanNextTurn, togglePlanSession } from './plan/index.js';
import { toggleQaSession, forceQaNextTurn } from './qa/index.js';
import { togglePresenterSession, forcePresenterNextTurn } from './presenter/index.js';
import { runAgent, interruptAgent, enqueueAgentMessage, restoreConversation, recordSlashTurn } from './agent.js';
import { findToolBySlash, slashTools, loadTools } from './tools.js';
import { startPromptServer, serverLanUrl, serverUrl } from './prompt-server.js';
import { appendTurn as appendTicketTurn } from './sprint/chat.js';
import { addNote, markDone, markFailed, reapAbandoned } from './diff/comments.js';
import { runLogPath } from './diff/runner.js';
import { llmProvider } from './llm/select.js';
import { showIndulgePicker, showSubagentModelPicker, showBackgroundModelPicker, handleModelCommand, releaseModelHold, isModelBooked } from './model-picker.js';
import { backgroundAllRuns } from './runs.js';
import { showDialog } from './dialog.js';
import { startLlmStatusPoll, findOwnPlace } from './llm-status.js';
import { startUpdateWatch, checkForUpdate } from './updater.js';
import { getSessionArtifacts, readArtifact } from './artifacts.js';
import { renderMarkdown } from './markdown.js';
import { HEADLESS } from './ui.js';
import { armPostmortem, markCleanExit } from './postmortem.js';
import { loadRules } from './rules.js';
import { runBang, cancelBang, bangRunning } from './bang.js';
import { getConfigString, setConfigValue, resetPromptsToDefaults, promptDriftWarnings, KNOWN_CONFIG_KEYS } from './prompts.js';
import { isCorpusInjection, isLogCoverage, isVerbose, setCorpusInjection, setLogCoverage, setVerbose } from './modes.js';
import { clearPendingCorpus, corpusForPrompt, setPendingCorpus } from './indulge/inject.js';

// `/embed` for the session, `/embedthis` for one prompt — the same shape as /plan and /qa, because
// a third convention for the same idea is one more thing to remember.
/** The running `naamah show` daemon, so a second /naamah replaces it rather than stacking ports. */
let naamahSession: import('./naamah/index.js').NaamahSession | null = null;
let embedSession = false;
let embedNextTurn = false;
/** The FIRST prompt states the task; later ones are refinements. Only the first is automatic. */
let promptsThisSession = 0;
import { getGoal, setGoal, clearGoal, refreshGoal } from './goal.js';
import { SECTIONS, entriesInSection, suggestNames } from './help.js';
import { runArduinoDiagram, formatArduinoDiagramOutcome } from './tools/arduino-diagram.js';
import { runExplain, formatExplainOutcome as formatExplainReportOutcome } from './explain/index.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initSession,
  listSessions,
  loadSessionCheckpoint,
  resolveSessionId,
  type CliSessionMeta,
  setSessionId,
  SESSION_NAMESPACE,
} from './session-store.js';

function getVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── Non-interactive mode ────────────────────────────────────────────

function getNonInteractivePrompt(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-p' || args[i] === '--prompt') && args[i + 1]) {
      return args[i + 1];
    }
    if (args[i].startsWith('--prompt=')) {
      return args[i].slice('--prompt='.length);
    }
    if (args[i] === '--non-interactive' && args[i + 1]) {
      return args[i + 1];
    }
  }
  return null;
}

// ── Token refresh ───────────────────────────────────────────────────

async function refreshTokens(): Promise<void> {
  try {
    // MEASURED BEATS ESTIMATED, and the difference is not small. Nothing here serves `/api/estimate`, so
    // the meter spent its whole life on the characters ÷ 4 fallback — a number that drifts with how a
    // model tokenises code, punctuation and CJK, in a bar an operator consults to decide whether the
    // window is about to overflow. Every reply now reports `prompt_eval_count`, which IS the prompt size
    // in the tokenizer that read it, so the last round of this turn is the honest number. The estimate
    // remains for the first prompt of a session, marked `~`.
    const measured = lastUsage();
    if (measured && measured.in > 0) {
      setStatus({ tokens: { used: measured.in, total: activeContextTokens() } });
      return;
    }
    const s = getSummary();
    const est = await estimateSessionTokens(s.summary, s.recent);
    setStatus({ tokens: { used: est.promptTokens, total: est.contextWindow, estimated: true } });
  } catch { /* silent */ }
}

// ── Summary overlay ─────────────────────────────────────────────────

import blessed from 'blessed';
import { startLiveMirror } from './live-mirror.js';
import { registerShippedPrompts } from './prompts.js';
import { isFullMode } from './full-mode.js';

let summaryOverlay: blessed.Widgets.BoxElement | null = null;

function showSummaryOverlay(): void {
  if (summaryOverlay) return;
  blurInput();

  summaryOverlay = blessed.box({
    parent: screen,
    top: 1,
    left: 2,
    right: 2,
    bottom: 2,
    border: { type: 'line' },
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    // no mouse:true — keeps terminal-native text selection/copy working (scroll: PgUp/PgDn)
    padding: { left: 1, right: 1, top: 0, bottom: 1 },
    style: {
      fg: 'white',
      bg: '#111',
      border: { fg: '#7B8CDE' },
    },
    label: ' Summary (Esc to close) ',
  });

  const text = getSummaryText();
  const tokens = getTokensDisplay();
  summaryOverlay.setContent(`${text}\n\n{#555-fg}─────────────────────────────{/}\n{#7B8CDE-fg}${tokens}{/}`);
  screen.render();
}

function closeSummaryOverlay(): void {
  if (!summaryOverlay) return;
  summaryOverlay.destroy();
  summaryOverlay = null;
  focusInput();
  screen.render();
}

// ── Document overlay: a slash tool whose answer is a page, not a message ──────
//
// `/prefab` prints a recursive tree that is hundreds of lines long. As a chat message it scrolls the
// conversation out of reach and cannot be paged back through; here it is read, scrolled and closed, and
// the conversation is exactly where it was. Same keys as the other two overlays — Esc closes, PgUp/PgDn
// scroll — because a third set of keys for the third overlay is one more thing to remember.

let docOverlay: blessed.Widgets.BoxElement | null = null;

function showDocOverlay(title: string, body: string): void {
  if (docOverlay) closeDocOverlay();
  blurInput();
  docOverlay = blessed.box({
    parent: screen,
    top: 1, left: 2, right: 2, bottom: 2,
    border: { type: 'line' },
    // tags OFF: this is tool output, and a `{` in a prefab's YAML must not be read as a style tag.
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    padding: { left: 1, right: 1, top: 0, bottom: 1 },
    style: { fg: 'white', bg: '#111', border: { fg: '#7B8CDE' } },
    label: ` ${title} (Esc to close · PgUp/PgDn) `,
  });
  docOverlay.setContent(body);
  screen.render();
}

function closeDocOverlay(): void {
  if (!docOverlay) return;
  docOverlay.destroy();
  docOverlay = null;
  focusInput();
  screen.render();
}

// ── Artifacts viewer overlay ────────────────────────────────────────

let artifactsOverlay: blessed.Widgets.BoxElement | null = null;
let artifactIdx = 0;

function showArtifactsOverlay(): void {
  const artifacts = getSessionArtifacts();
  if (artifacts.length === 0) {
    addMessage('system', 'No artifacts yet.');
    return;
  }
  if (artifactsOverlay) return;
  blurInput();
  artifactIdx = artifacts.length - 1; // start at most recent
  renderArtifactsOverlay();
}

function renderArtifactsOverlay(): void {
  const artifacts = getSessionArtifacts();
  if (artifacts.length === 0) { closeArtifactsOverlay(); return; }

  if (artifactsOverlay) {
    artifactsOverlay.destroy();
    artifactsOverlay = null;
  }

  const a = artifacts[artifactIdx];
  const content = readArtifact(a);
  const total = artifacts.length;
  const ts = new Date(a.timestamp).toLocaleTimeString();

  artifactsOverlay = blessed.box({
    parent: screen,
    top: 1,
    left: 2,
    right: 2,
    bottom: 2,
    border: { type: 'line' },
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    // no mouse:true — keeps terminal-native text selection/copy working (scroll: PgUp/PgDn)
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    style: {
      fg: 'white',
      bg: '#111',
      border: { fg: '#7B8CDE' },
    },
    label: ` ${a.tool} — ${artifactIdx + 1}/${total} (←/→ navigate, Esc close) `,
  });

  const header = `{#7B8CDE-fg}${a.tool}{/} {#555-fg}${a.params}{/}\n{#555-fg}${ts}{/}\n{#555-fg}${'─'.repeat(40)}{/}\n`;
  artifactsOverlay.setContent(header + content);
  screen.render();
}

function closeArtifactsOverlay(): void {
  if (!artifactsOverlay) return;
  artifactsOverlay.destroy();
  artifactsOverlay = null;
  focusInput();
  screen.render();
}

// ── Global key handler (works even while agent is busy) ─────────────

/** How close two Escapes must be to count as one gesture. */
const DOUBLE_ESCAPE_MS = 600;
let lastIdleEscapeAt = 0;

if (!HEADLESS) {
  onGlobalKey((key) => {
    if (key === 'escape') {
      // Escape has a job before it has this one. Anything it actually DID also resets the
      // double-press window: closing the summary and then hitting Escape again out of habit must not
      // wipe a prompt that took a minute to type. The clear is only ever reachable from an Escape
      // that had nothing else to do.
      if (artifactsOverlay) { closeArtifactsOverlay(); lastIdleEscapeAt = 0; return; }
      if (summaryOverlay) { closeSummaryOverlay(); lastIdleEscapeAt = 0; return; }
      if (docOverlay) { closeDocOverlay(); lastIdleEscapeAt = 0; return; }
      // A `!` command owns the foreground while it runs, so it gets the interrupt first — otherwise
      // `!npm run build` would be uncancellable and the UI would sit there until the timeout.
      if (bangRunning()) { cancelBang(); lastIdleEscapeAt = 0; return; }
      if (busy) { interruptAgent(); lastIdleEscapeAt = 0; return; }

      // Nothing to close, cancel or interrupt — so this Escape is free to mean "clear what I typed",
      // on the second press. One press does nothing on purpose: a single stray Escape is the most
      // likely keystroke in the terminal, and losing a typed prompt to one would be unforgivable.
      const now = Date.now();
      if (now - lastIdleEscapeAt < DOUBLE_ESCAPE_MS) {
        lastIdleEscapeAt = 0;
        clearInput();
      } else {
        lastIdleEscapeAt = now;
      }
      return;
    }
    /**
     * Ctrl+B — move whatever is running to the background and take the turn back.
     *
     * ITS OWN KEY, NOT AN OVERLOAD OF Ctrl+O. This was first built onto Ctrl+O on the theory that the
     * two never collide — a browser is what you want when nothing is running, and there is nothing to
     * detach then either. That reasoning holds and it is still the wrong call: Ctrl+O is a key people
     * already press by habit, and a key whose meaning depends on what the agent happens to be doing
     * is one that eventually does the other thing. Backgrounding is not undoable by pressing it again.
     *
     * Silent when nothing is running. A key that reports "there was nothing to background" is noise
     * on the one press that was a mistyped Ctrl+C.
     */
    if (key === 'C-b') {
      backgroundAllRuns(); // the handoff line is printed by the agent loop, per run
      return;
    }
    if (key === 'C-o') {
      if (!artifactsOverlay && !summaryOverlay) showArtifactsOverlay();
      else if (artifactsOverlay) closeArtifactsOverlay();
    }
    if (key === 'C-s') {
      if (!summaryOverlay && !artifactsOverlay) showSummaryOverlay();
      else if (summaryOverlay) closeSummaryOverlay();
    }
  });

  // Left/right for artifacts navigation — need screen.key since these go through inputActive gate
  screen.key(['left'], () => {
    if (artifactsOverlay && artifactIdx > 0) { artifactIdx--; renderArtifactsOverlay(); }
  });

  screen.key(['right'], () => {
    if (artifactsOverlay) {
      const artifacts = getSessionArtifacts();
      if (artifactIdx < artifacts.length - 1) { artifactIdx++; renderArtifactsOverlay(); }
    }
  });

  // Overlays scroll by keyboard (mouse tracking is off so terminal selection stays native).
  // The chat box has its own PgUp/PgDn in the input handler; it is inert while an overlay is open.
  const overlayScroll = (dir: 1 | -1) => {
    const box = artifactsOverlay ?? summaryOverlay ?? docOverlay;
    if (!box) return;
    box.scroll(dir * Math.floor((box.height as number) / 2));
    screen.render();
  };
  screen.key(['pageup'], () => overlayScroll(-1));
  screen.key(['pagedown'], () => overlayScroll(1));
}

// ── Connection ──────────────────────────────────────────────────────

onConnectionChange((state) => {
  setStatus({ connection: state });
  if (state === 'connected') {
    addMessage('system', 'Connected to backend');
    refreshTokens();
  } else {
    addMessage('system', 'Disconnected from backend');
  }
});

// ── Model authority (/model) ──────────────────────────────────────────
// `/model` opens the picker popup; `/model <name>` switches straight away. Booking the GPU (the
// `ayin` authority on the backend llm resource) and the swap wait live in model-picker.ts. The hold
// is released on /quit and on SIGINT/SIGTERM; a hard kill lets the backend grant TTL-expire (the
// keepalive is unref'd, so it stops on exit).

// ── Live model + GPU in the status bar ────────────────────────────────
// One poll of the llm resource's read ops feeds both segments. It survives backend restarts on its
// own (every failure just clears the segments and the next tick retries), and the interval is
// unref'd so it never keeps the process alive.
// A model swap is no longer something gaining/losing the `ayin` authority causes (1.0.210 —
// for reasons of its own — a schedule, an explicit `setModel` from any other consumer, or another
// workload borrowing the card — none of which this client can see the cause of,
// only the effect. So this narration DELIBERATELY never attributes a reason: it just says what's
// happening, once when it starts and once when it lands, because being told "qwen" while gemma is
// still resident (or nothing is) is the single most confusing state in the whole UI regardless of
// why the swap is running.
let announcedSwapTo: string | null = null;

function startModelStatusPoll(): void {
  if (HEADLESS) return;
  startLlmStatusPoll(({ catalog, gpu, queue, authority }) => {
    const own = findOwnPlace(queue, currentRequestId());
    if (catalog) {
      const swapping = catalog.loadedModel !== catalog.activeModel;
      if (swapping && announcedSwapTo !== catalog.activeModel) {
        announcedSwapTo = catalog.activeModel;
        addMessage('system', `Backend is loading ${catalog.activeModel} (${catalog.loadedModel} still resident) — ~17GB out, ~16GB in. Your first reply waits for it.`);
        addMessage('system', `A model swap is in flight, started elsewhere (the schedule, another consumer, or a manual pick) — not something this ayin session asked for. /model to see the queue or switch yourself.`);
      } else if (!swapping && announcedSwapTo) {
        addMessage('system', `${catalog.loadedModel} is resident now.`);
        announcedSwapTo = null;
      }
    }
    setStatus({
      model: catalog
        ? {
          name: catalog.activeModel,
          loaded: catalog.loadedModel,
          booked: isModelBooked(),
          swapping: catalog.loadedModel !== catalog.activeModel,
        }
        : null,
      gpu,
      queue: queue
        ? {
          running: queue.running,
          runningForMs: queue.runningForMs,
          depth: queue.depth,
          // Our own place in line, matched by the correlation id sent with the in-flight request.
          ...(own ? { ownPosition: own.position, ownOf: own.of, ownRunning: own.running } : {}),
        }
        : null,
      authority: authority
        ? {
          holder: authority.holder,
          expiresInMs: Math.max(0, authority.expiresAt - Date.now()),
          // The launcher, the watcher and a dispatched code agent all hold as `ayin` — our family,
          // not necessarily this session. Never claim more than that.
          mine: authority.holder === 'ayin',
        }
        : null,
    });
  });
}

// ── Input handler ───────────────────────────────────────────────────

// The last `/resume` listing, so `/resume 2` can mean "the second one you just showed me". The old
// command printed [1] [2] [3] and then only accepted a full uuid — numbers you could not use.
let resumeList: CliSessionMeta[] = [];

/**
 * One `/resume` row. The GOAL is the label when the session recorded one — it is what the session
 * became about, whereas the first prompt is often a throwaway question ("Hey! What model are you?").
 * The second line is the detail you actually weigh before resuming: when, how much work, what kind
 * of work, how much context comes back, and whether a summary exists at all.
 */
function sessionRow(s: CliSessionMeta, showDir: boolean): { label: string; note: string; sub: string } {
  const r = s.rich;
  const label = r?.goal || s.title || '(no prompt recorded)';
  const bits: string[] = [relativeWhen(s.updatedAt)];
  if (r) {
    bits.push(`${r.prompts} turn${r.prompts === 1 ? '' : 's'}`);
    if (r.toolCalls) bits.push(`${r.toolCalls} tools`);
    if (r.tools.length) bits.push(r.tools.slice(0, 2).map((t) => `${t.name}×${t.count}`).join(' '));
    if (r.filesWritten.length) bits.push(`${r.filesWritten.length} file${r.filesWritten.length === 1 ? '' : 's'} written`);
    if (r.artifactCount) bits.push(`${r.artifactCount} artifacts`);
    bits.push(r.contextChars ? `~${(r.approxTokens / 1000).toFixed(1)}k ctx` : 'no summary');
    if (r.durationMs > 60_000) bits.push(`${Math.round(r.durationMs / 60_000)}m long`);
  } else {
    bits.push(`${s.messageCount} events`);
  }
  bits.push(s.sessionId.slice(0, 8));
  if (showDir && s.cwd !== process.cwd()) bits.push(s.cwd);
  return {
    label,
    // A goal-labelled row hides its first prompt; say so, since they can differ a lot.
    note: r?.goal && s.title && s.title !== r.goal ? '(goal)' : '',
    sub: bits.join(' · '),
  };
}

/** "12m ago" / "3h ago" / "2d ago 14:20" — a picker row wants recency, not a full timestamp. */
function relativeWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  const d = new Date(t);
  return `${Math.round(mins / (60 * 24))}d ago ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
let busy = false;

/**
 * ONE PATH FOR EVERY PROMPT. The review page's comments come through here too, which is what makes them
 * indistinguishable from typing in the chat: same history entry, same `user` bubble, same busy/queue
 * rules, same agent loop. A second entry point would be a second set of those decisions to keep in
 * sync, and the first thing to drift would be the one the operator only sees when it breaks.
 */
async function handleInput(text: string): Promise<void> {
  if (busy) {
    // A slash command typed while the agent works is REFUSED below, so its argument is never acted on —
    // and an argument that is never acted on has no business being persisted, least of all a credential
    // pasted into /jira-auth. Only the command word goes to history.
    pushEntry(text.startsWith('/') ? text.split(' ')[0] : text);
    addMessage('user', text);

    if (text.startsWith('/')) {
      addMessage('system', 'Queued slash commands are not executed while the agent is busy. Press Esc to cancel first if you want to run a command.');
      return;
    }

    enqueueAgentMessage(text);
    addMessage('system', 'Queued for the agent.');
    return;
  }

  pushEntry(text);
  addMessage('user', text);

  // `!<command>` — straight to the shell, no model, no round. Placed before the slash block because
  // it is a passthrough rather than a command: everything after the `!` is the operator's, verbatim.
  if (text.startsWith('!')) {
    const command = text.slice(1).trim();
    if (!command) {
      addMessage('system', 'Nothing after the `!`. `!<command>` runs it in your shell; the model never sees it.');
      return;
    }
    setAgentStatus('Running...');
    const r = await runBang(command);
    setAgentStatus('');
    addMessage('tool', formatShellForChat(command, r.output, r));
    return;
  }

  // Slash commands
  if (text.startsWith('/')) {
    const cmd = text.split(' ')[0];
    switch (cmd) {
      case '/quit': case '/q': case '/exit':
        await releaseModelHold(); // give qwen back to the shared model
        await disconnect();
        shutdown();
        return;
      /**
       * `/openai` is no longer a case here — it is the `openai_auth` TOOL's slash command, which stores
       * the key (verified against OpenAI first, into `~/.ayin-cli/openai.env` at 0600, and kept out of
       * both the input history and the model's context).
       *
       * Choosing OpenAI to ANSWER is `/model openai`. Setting a credential and deciding to spend money
       * are two decisions; the old `/openai` merged them, so storing a key and switching to a billed
       * provider were the same keystroke.
       */
      case '/model':
        await handleModelCommand(text.slice('/model'.length));
        return;
      /**
       * `/indulge-model` — what a CORPUS BUILD runs on, which is a different decision from `/model`.
       *
       * A build is hours of a model reading source; a chat turn is seconds. An operator legitimately
       * wants them apart: the corpus on a hosted model for the window and the reasoning, the agent on
       * the card in the room at no cost per token. And the TIER is the whole cost of a build — the
       * same corpus on a flagship and on a cheap tier differ by an order of magnitude — so the model
       * is chosen here, not inherited from whatever the agent happens to be using.
       *
       * Stored, not per-session: a build runs unattended, usually from another terminal, and a
       * setting that died with this session would silently not apply to it.
       */
      case '/indulge-model': {
        const arg = text.slice('/indulge-model'.length).trim();
        // No argument = the DIALOG. The decision is two rows wide (your card vs a hosted model) and a
        // syntax nobody remembers is how a setting that matters goes unset.
        if (!arg) { await showIndulgePicker(); return; }
        if (arg.toLowerCase() === 'off') {
          setConfigValue('indulgeProvider', '');
          setConfigValue('indulgeModel', '');
          addMessage('system', 'indulge follows the agent\'s provider again.');
          return;
        }
        const [provider, ...rest] = arg.split(/\s+/);
        const model = rest.join(' ').trim();
        const known = ['openai', 'ollama', 'resource', 'direct'];
        if (!known.includes(provider.toLowerCase())) {
          addMessage('system', `Unknown provider "${provider}". One of: ${known.join(', ')} — or /indulge-model with no argument to choose.`);
          return;
        }
        setConfigValue('indulgeProvider', provider.toLowerCase());
        setConfigValue('indulgeModel', model);
        addMessage('system', `indulge will build on ${provider.toLowerCase()}${model ? ` · ${model}` : ' · that provider\'s default model'}.`
          + ' The interactive agent is unchanged.');
        return;
      }
      /**
       * `/set-subagent-model` — what a SUBAGENT runs on, which is a different decision from `/model`.
       *
       * The arbiter reads reports and picks the next phase; a child writes the code. Those are not the
       * same job and they do not want the same model. The card in the room arbitrates perfectly well
       * and costs nothing per token; the implementation is the part worth paying a hosted model for.
       * Before this a child inherited `process.env` wholesale, so the two were locked together — pay
       * flagship rates to arbitrate, or implement on whatever happened to be resident.
       *
       * Stored rather than per-session, exactly as `/indulge-model` is: a subagent runs unattended,
       * often from a headless parent in another terminal, and a setting that died with this session
       * would silently not apply to the run it was set for.
       */
      case '/set-subagent-model': {
        const arg = text.slice('/set-subagent-model'.length).trim();
        // No argument = the DIALOG. The decision is two questions deep — which provider, then which
        // TIER — and the tier is the whole cost of a build. A syntax nobody remembers is how a setting
        // that matters goes unset. The model list in it comes from the API, not from a table here.
        if (!arg) { await showSubagentModelPicker(); return; }
        if (arg.toLowerCase() === 'off') {
          setConfigValue('subagentProvider', '');
          setConfigValue('subagentModel', '');
          addMessage('system', 'Subagents follow the agent\'s provider again.');
          return;
        }
        const [provider, ...rest] = arg.split(/\s+/);
        const model = rest.join(' ').trim();
        const known = ['openai', 'ollama', 'resource', 'direct'];
        if (!known.includes(provider.toLowerCase())) {
          addMessage('system', `Unknown provider "${provider}". One of: ${known.join(', ')}, or off.`);
          return;
        }
        setConfigValue('subagentProvider', provider.toLowerCase());
        setConfigValue('subagentModel', model);
        addMessage('system', `Subagents will run on ${provider.toLowerCase()}${model ? ` · ${model}` : ' · that provider\'s default model'}.`
          + ' This agent is unchanged — it keeps arbitrating on what it already uses.'
          + (provider.toLowerCase() === 'openai' ? ' Every child now costs money per token.' : ''));
        return;
      }
      /**
       * `/set-background-model` — where a run sent away with `Ctrl+B` does its thinking.
       *
       * The setting that makes backgrounding mean something. One card is one QUEUE, so detaching a
       * task from the turn returns the prompt and not the GPU: the operator's next round still waits
       * behind the task they just got out of the way. A lane pointing at an endpoint with its own
       * capacity is the difference between "not blocking the UI" and actually running alongside.
       *
       * Unset is a working state, not a broken one — `Ctrl+B` still detaches and says the run stayed
       * put. Pressing a key to unblock yourself must never be what starts a bill.
       */
      case '/set-background-model': {
        const arg = text.slice('/set-background-model'.length).trim();
        if (!arg) { await showBackgroundModelPicker(); return; }
        const { resetLaneProvider } = await import('./background.js');
        if (arg.toLowerCase() === 'off') {
          setConfigValue('backgroundProvider', '');
          setConfigValue('backgroundModel', '');
          resetLaneProvider();
          addMessage('system', 'Background runs stay on this model. They still detach from the turn.');
          return;
        }
        const [provider, ...rest] = arg.split(/\s+/);
        const model = rest.join(' ').trim();
        // `direct` and `resource` are refused rather than stored: both point at the endpoint the
        // foreground already uses, so a lane on either would queue behind the very turn it exists to
        // unblock. Accepting it would store a setting that silently does nothing.
        const known = ['openai', 'ollama'];
        if (!known.includes(provider.toLowerCase())) {
          addMessage('system', `A background lane needs its own capacity — ${known.join(' or ')}, or off. `
            + `"${provider}" is the same endpoint this turn already queues on.`);
          return;
        }
        setConfigValue('backgroundProvider', provider.toLowerCase());
        setConfigValue('backgroundModel', model);
        resetLaneProvider();
        addMessage('system', `Ctrl+B now moves a run onto ${provider.toLowerCase()}${model ? ` · ${model}` : ' · that provider\'s default model'}.`
          + (provider.toLowerCase() === 'openai' ? ' A backgrounded run bills per token while it runs.' : ''));
        return;
      }
      /**
       * `/transcribe` — start the FULL, unclipped record of this session (see transcript.ts).
       * `/transcribe off` stops it. It is loud on purpose: the bottom row stays red for as long as it
       * runs, because this writes every byte the model saw — including whatever a tool printed — to a
       * file that will get large, and you should never discover that by accident.
       */
      /**
       * `/wipe` — delete ayin's own saved state. Two dialogs, never one: the first picks a scope and
       * shows what each currently costs, the second states the exact file count and byte total and
       * defaults to Cancel. The live session, the live transcript and this process's log file are
       * excluded by wipe.ts itself, not by this caller. `/wipe <scope>` skips only the menu.
       */
      /**
       * `/git-hardreset` — undo what a turn did to the WORKING TREE, in one keystroke.
       *
       * `git reset --hard` + `git clean -fd`: tracked files back to HEAD, untracked files deleted. It is
       * the two commands anyone types after a bad turn, and typing them by hand at 2am is where
       * `clean -fd` gets run in the wrong directory.
       *
       * A STASH IS TAKEN FIRST, ALWAYS, and this is not optional politeness: `clean -fd` deletes work that
       * no commit and no reflog has ever seen — a file the agent just created is simply gone, and this
       * repo's own rule is never to destroy hours of work without a backup in the same code path.
       * `git stash push -u` captures tracked AND untracked, leaves the tree clean (which is what was
       * asked for), and prints the ref that brings it back. A stash that FAILS aborts the whole thing.
       */
      case '/git-hardreset': {
        const status = await runBang('git status --porcelain');
        if (status.exitCode !== 0) {
          addMessage('system', `Not a git repository (or git failed): ${status.output.trim().split('\n')[0] ?? ''}`);
          return;
        }
        const lines = status.output.split('\n').map((l) => l.trimEnd()).filter(Boolean);
        if (!lines.length) { addMessage('system', 'The tree is already clean — nothing to reset.'); return; }
        const untracked = lines.filter((l) => l.startsWith('??')).length;
        const tracked = lines.length - untracked;
        const branch = (await runBang('git rev-parse --abbrev-ref HEAD')).output.trim();
        const head = (await runBang('git log --oneline -1')).output.trim();

        const pick = await showDialog(
          'Reset tracked files AND delete untracked ones?',
          [
            { label: `Yes — reset ${tracked} tracked, delete ${untracked} untracked`, danger: true, note: branch },
            { label: 'Cancel' },
          ],
          { subtitle: `HEAD is ${head}. Everything is stashed first — the tree ends clean and \`git stash pop\` brings it back.` },
        );
        if (pick !== 0) { addMessage('system', 'Reset cancelled — nothing was touched.'); return; }

        setAgentStatus('git-hardreset…');
        try {
          const label = `ayin /git-hardreset ${new Date().toISOString()}`;
          const stash = await runBang(`git stash push --include-untracked -m ${JSON.stringify(label)}`);
          if (stash.exitCode !== 0) {
            addMessage('system', `Stash failed, so NOTHING was reset — your tree is untouched:\n${stash.output.trim()}`);
            return;
          }
          const reset = await runBang('git reset --hard');
          const cleaned = await runBang('git clean -fd');
          const after = (await runBang('git status --porcelain')).output.split('\n').filter(Boolean).length;
          addMessage('tool', formatShellForChat(
            'git stash push -u && git reset --hard && git clean -fd',
            [stash.output.trim(), reset.output.trim(), cleaned.output.trim()].filter(Boolean).join('\n'),
            reset,
          ));
          addMessage('system', `${tracked} tracked and ${untracked} untracked change(s) reset · ${after} entr(y/ies) left in status`);
          addMessage('system', `recover with: git stash pop   (saved as "${label}")`);
        } finally {
          setAgentStatus('');
        }
        return;
      }

      /**
       * `/git-softreset` — UNDO THE LAST COMMIT, keep its changes.
       *
       * `git reset --soft HEAD~1`: HEAD moves back one, the commit's content stays staged in the working
       * tree. The commit the agent should not have made is gone from history; the work it contained is
       * still in front of you, ready to be amended, split or thrown away deliberately.
       *
       * NO STASH, because nothing is destroyed — that is the whole difference from `--hard`. The recovery
       * is the old commit's sha, printed before the reset and still reachable through the reflog, so
       * `git reset --hard <sha>` puts history back exactly as it was.
       *
       * TWO REFUSALS AND ONE WARNING, all of them cases where undoing costs more than it looks:
       *   · a ROOT commit has no parent, so `HEAD~1` does not exist — git fails with a message about an
       *     ambiguous argument that says nothing about why. Refused with the reason instead.
       *   · a commit that is already on the REMOTE is shared history. Undoing it locally means the next
       *     push is a force-push over something someone else may have pulled. Warned, in the dialog,
       *     because that is the moment the operator can still say no.
       *   · a MERGE commit resets to its FIRST parent, quietly discarding the other side of the merge from
       *     history. Said out loud rather than discovered later.
       */
      case '/git-softreset': {
        const head = await runBang('git rev-parse HEAD');
        if (head.exitCode !== 0) {
          addMessage('system', `Not a git repository (or no commits yet): ${head.output.trim().split('\n')[0] ?? ''}`);
          return;
        }
        const sha = head.output.trim();
        const parents = (await runBang('git rev-list --parents -n 1 HEAD')).output.trim().split(/\s+/).slice(1);
        if (parents.length === 0) {
          addMessage('system', 'HEAD is the ROOT commit — there is nothing to reset to. `git update-ref -d HEAD` would unmake the repo\'s only commit; do that by hand if you mean it.');
          return;
        }
        const subject = (await runBang('git log --oneline -1')).output.trim();
        const stat = (await runBang('git show --stat --oneline HEAD')).output.trim();
        const files = (await runBang('git diff --name-only HEAD~1 HEAD')).output.split('\n').filter(Boolean).length;
        const branch = (await runBang('git rev-parse --abbrev-ref HEAD')).output.trim();
        // On a remote already? `--contains` names every remote ref that has this commit.
        const onRemote = (await runBang(`git branch -r --contains ${sha}`)).output.split('\n').map((l) => l.trim()).filter(Boolean);
        const isMerge = parents.length > 1;

        const notes: string[] = [];
        if (onRemote.length) notes.push(`ALREADY PUSHED to ${onRemote.slice(0, 3).join(', ')} — undoing it locally means the next push rewrites shared history`);
        if (isMerge) notes.push('this is a MERGE commit: --soft resets to its FIRST parent, dropping the other side from history');

        const pick = await showDialog(
          `Undo the last commit, keeping its ${files} file(s) staged?`,
          [
            { label: `Yes — uncommit ${subject}`, danger: true, note: branch, ...(notes.length ? { sub: notes.join(' · ') } : {}) },
            { label: 'Cancel' },
          ],
          { subtitle: `git reset --soft HEAD~1 · nothing is deleted; recover the commit with git reset --hard ${sha.slice(0, 10)}` },
        );
        if (pick !== 0) { addMessage('system', 'Uncommit cancelled — history is unchanged.'); return; }

        setAgentStatus('git-softreset…');
        try {
          const reset = await runBang('git reset --soft HEAD~1');
          if (reset.exitCode !== 0) {
            addMessage('system', `git reset --soft HEAD~1 failed — history is unchanged:\n${reset.output.trim()}`);
            return;
          }
          const staged = (await runBang('git diff --cached --name-only')).output.split('\n').filter(Boolean).length;
          addMessage('tool', formatShellForChat('git reset --soft HEAD~1', [stat.split('\n')[0] ?? '', reset.output.trim()].filter(Boolean).join('\n'), reset));
          addMessage('system', `uncommitted ${subject} · ${staged} file(s) now staged, nothing lost`);
          addMessage('system', `put it back with: git reset --hard ${sha.slice(0, 10)}`);
          if (onRemote.length) addMessage('system', `note: that commit is still on ${onRemote.slice(0, 3).join(', ')} — a push from here rewrites it`);
        } finally {
          setAgentStatus('');
        }
        return;
      }

      case '/wipe': {
        const arg = text.slice('/wipe'.length).trim().toLowerCase().replace(/\s+/g, '-');
        const named: Record<string, WipeScope> = {
          '': 'sessions', sessions: 'sessions', all: 'sessions-all', 'sessions-all': 'sessions-all',
          artifacts: 'artifacts', logs: 'logs', transcripts: 'transcripts',
        };
        let scope = named[arg];
        if (!scope && arg) { addMessage('system', `Unknown scope "${arg}". Use: /wipe · /wipe all · /wipe artifacts · /wipe logs · /wipe transcripts`); return; }

        if (!arg) {
          const overview = await wipeOverview();
          const pick = await showDialog(
            'Wipe which saved state?',
            overview.map((o) => ({
              label: o.plan.label,
              note: humanBytes(o.plan.bytes),
              danger: true,
              sub: o.scope === 'transcripts' ? 'your debugging records — nothing else keeps a full copy' : undefined,
            })),
            { subtitle: 'Nothing under ~/.ayin-cli prunes itself. The live session, transcript and log are never touched.' },
          );
          if (pick < 0) { addMessage('system', 'Wipe cancelled.'); return; }
          scope = overview[pick].scope;
        }

        const plan = await planWipe(scope);
        if (plan.files.length === 0) { addMessage('system', `Nothing to wipe — ${plan.label}.`); return; }
        const confirm = await showDialog(
          `Delete ${plan.label}?`,
          [
            { label: 'Cancel', key: 'c' },
            { label: `Delete ${plan.files.length} files · ${humanBytes(plan.bytes)}`, key: 'd', danger: true },
          ],
          { subtitle: plan.kept ? `Keeping ${plan.kept} — ${plan.keptReason}. This cannot be undone.` : 'This cannot be undone.' },
        );
        if (confirm !== 1) { addMessage('system', 'Wipe cancelled.'); return; }
        const r = executeWipe(plan);
        showAlert('warn', `Wiped ${r.deleted} files (${humanBytes(r.bytes)})${r.failed ? ` — ${r.failed} could not be deleted` : ''}`);
        addMessage('system', `Wiped ${r.deleted} files · ${humanBytes(r.bytes)} freed${r.failed ? ` · ${r.failed} failed` : ''}.`);
        return;
      }
      case '/transcribe': {
        const arg = text.slice('/transcribe'.length).trim().toLowerCase();
        if (arg === 'off' || arg === 'stop') {
          if (!isTranscribing()) { addMessage('system', 'Not transcribing.'); return; }
          const p = stopTranscript();
          clearStickyAlert();
          addMessage('system', `Transcript closed — ${p}`);
          return;
        }
        if (isTranscribing()) {
          const { events, bytes } = transcriptSize();
          addMessage('system', `Already transcribing → ${transcriptPath()} (${events} events, ${(bytes / 1024).toFixed(0)} KB). /transcribe off to stop.`);
          return;
        }
        const p = startTranscript({ cwd: process.cwd(), ayin: getVersion(), model: activeModelId() });
        if (!p) { addMessage('system', 'Could not start a transcript — no session id yet. Try again in a moment.'); return; }
        setStickyAlert('warn', `FULL TRANSCRIPT RECORDING — every prompt, response and tool result is being written unclipped to ${p}`);
        addMessage('system', `Full transcript started → ${p}\nPrompts, raw model responses and complete tool results, nothing clipped. /transcribe off to stop.`);
        return;
      }
      case '/verbose': {
        // Brevity is the default, so this command turns it OFF. Named for what the operator wants
        // ("be verbose"), not for the flag it clears.
        const arg = text.slice('/verbose'.length).trim().toLowerCase();
        const on = arg === '' ? !isVerbose() : arg !== 'off' && arg !== '0';
        setVerbose(on);
        addMessage('system', on
          ? 'Verbose ON — full explanations. Takes effect on your next message.'
          : 'Verbose OFF — shortest answer that fully answers (the default).');
        return;
      }
      case '/embed': {
        const arg = text.slice('/embed'.length).trim().toLowerCase();
        embedSession = arg === '' ? !embedSession : arg !== 'off' && arg !== '0';
        addMessage('system', embedSession
          ? 'Corpus lookup ON for every prompt this session · /embed off'
          : 'Corpus lookup back to first-prompt-only. /embedthis <question> forces one.');
        return;
      }
      case '/embedthis': {
        const arg = text.slice('/embedthis'.length).trim();
        if (!arg) {
          addMessage('system', 'Usage: /embedthis <question> — looks the question up in the corpus for this one prompt');
          return;
        }
        embedNextTurn = true;
        text = arg;
        break;
      }
      case '/corpus': {
        const arg = text.slice('/corpus'.length).trim().toLowerCase();
        const on = arg === '' ? !isCorpusInjection() : arg !== 'off' && arg !== '0';
        setCorpusInjection(on);
        addMessage('system', on
          ? 'Corpus injection ON — reading a file also shows what `ayin indulge` already answered about it.'
          : 'Corpus injection OFF — nothing from the corpus is added to tool results (corpus_search still works).');
        return;
      }
      case '/sentinaile': {
        // A standing watch: plan once with the model, then run a fresh `ayin -p` shell on a schedule
        // until stopped. The supervisor is detached and rebuilds itself from disk, so the watch keeps
        // its promise across a reboot rather than dying silently with this session. See src/sentinaile/.
        const arg = text.slice('/sentinaile'.length);
        try {
          const { handleSentinaile } = await import('./sentinaile/index.js');
          if (arg.trim() && arg.trim().toLowerCase() !== 'stop') addMessage('system', 'sentinaile: planning…');
          addMessage('system', await handleSentinaile(arg, process.cwd()));
        } catch (err) {
          addMessage('system', `/sentinaile failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case '/skip-permissions': {
        // For a benchmark run: several agents, one prompt, none of them stopping on a dialog.
        // Session-scoped and LOUD — a gate that is off must never be a thing you have to remember.
        const { isSkippingPermissions, setSkipPermissions } = await import('./permissions.js');
        const arg = text.slice(text.indexOf(' ') + 1).trim().toLowerCase();
        const on = arg === '' ? !isSkippingPermissions() : arg !== 'off' && arg !== '0' && arg !== 'false';
        setSkipPermissions(on);
        if (on) {
          setStickyAlert('warn', 'PERMISSIONS SKIPPED — tool calls run unprompted (this session only)');
          addMessage('system',
            'Permissions SKIPPED for this session. Tool calls run without asking.\n'
            + '  · git push / pull / checkout are still gated — and with prompts off they are DENIED, not allowed.\n'
            + '  · Not persisted: a restart brings the prompts back.\n'
            + '  · /skip-permissions off to restore now.');
        } else {
          clearStickyAlert();
          addMessage('system', 'Permissions restored — tool calls ask again.');
        }
        return;
      }
      case '/logcover': {
        const arg = text.slice('/logcover'.length).trim().toLowerCase();
        const on = arg === '' ? !isLogCoverage() : arg !== 'off' && arg !== '0';
        setLogCoverage(on);
        addMessage('system', on
          ? 'Log coverage ON — features get heavy instrumentation while it lasts.'
          : 'Log coverage OFF — normal logging.');
        return;
      }
      case '/debug': {
        // Everything needed to diagnose a session, in one directory something else can read. See
        // src/debug-bundle.ts for what is deliberately left out, and why.
        const dest = text.slice('/debug'.length).trim();
        try {
          const { writeDebugBundle, defaultBundleDir } = await import('./debug-bundle.js');
          const { contextTokens } = await import('./indulge/budget.js');
          const { llmProviderName } = await import('./llm/select.js');
          const { activeAdapter, modelResolution } = await import('./llm/manager.js');
          const r = writeDebugBundle(dest || defaultBundleDir(), {
            version: getVersion(),
            provider: llmProviderName(),
            model: activeModelId() || 'unknown',
            dialect: activeAdapter().id,
            // THREE STATES, NOT TWO. "never resolved" and "not resolved YET" look identical to a
            // reader and mean opposite things: the first is a real misconfiguration worth chasing,
            // the second is a bundle taken a few hundred milliseconds after boot, before the
            // background probe has answered. Reporting the alarming one as fact sent two separate
            // investigations after a session that was fine.
            dialectSource: activeAdapter().forced ? 'chosen by the operator'
              : modelResolution().resolved ? 'matched the served model'
                : modelResolution().gaveUp
                  ? 'FALLBACK — the endpoint never reported a model'
                  : `not resolved YET — attempt ${modelResolution().attempts} still in flight, dialect is provisional`,
            contextTokens: contextTokens(),
            cwd: process.cwd(),
            sessionId: (await import('./session-store.js')).getSessionId(),
          });
          addMessage('system', `debug bundle → ${r.latest}   (stable — same bundle, no timestamp to quote)`);
          addMessage('system', `  history: ${r.dir}`);
          addMessage('system', `  ${r.files.join(', ')} · ${Math.round(r.bytes / 1024)} KB`
            + (r.omitted.length ? ` · nothing to write for: ${r.omitted.join(', ')}` : ''));
          addMessage('system', '  secrets are redacted by name — safe to hand to someone else');
        } catch (err) {
          addMessage('system', `/debug failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case '/diff': {
        // Working tree → a reviewable HTML page. An argument is any rev, so `/diff main` reviews a
        // branch with the same page. See src/diff/.
        const rev = text.slice('/diff'.length).trim() || 'HEAD';
        try {
          const { buildAndOpen, summarise } = await import('./diff/index.js');
          const r = buildAndOpen(process.cwd(), rev);
          addMessage('system', `${summarise(r)}${r.opened ? '' : '\n(could not open a browser — the path above is the page)'}`);
        } catch (err) {
          addMessage('system', `/diff failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case '/naamah': {
        // The DESIGN on a page, with comments wired to this session — `/diff` one step earlier, before
        // the code exists. An argument names a design directory; bare picks the newest `.naamah/<task>/`,
        // because the agent autocreates one per task and asking which is friction for nothing.
        const arg = text.slice('/naamah'.length).trim();
        try {
          const nm = await import('./naamah/index.js');
          const dir = nm.findDesignDir(process.cwd(), arg);
          if (!dir) {
            addMessage('system',
              'No design to show. A design is a directory of plain TypeScript or C# sketch files —\n'
              + 'ayin creates one per task at .naamah/<task-slug>/. Ask for a change and it will, or\n'
              + 'point at one: /naamah <dir>');
            return;
          }
          if (naamahSession) naamahSession.stop();
          naamahSession = nm.startNaamah(dir, {
            // A COMMENT BECOMES A TURN. The thread arrives as a prompt carrying what was commented on,
            // exactly as a /diff comment does, so the agent edits the design instead of asking which
            // card was meant.
            onThreads: (threads) => {
              for (const t of threads) {
                const pid = nm.runThreadAgent(dir, t, process.cwd());
                addMessage('system', pid
                  ? `naamah [${t.id}] on ${t.target?.id ?? 'the design'} — answering it (pid ${pid})`
                  : `naamah [${t.id}] arrived but a run could not be started — see ~/.ayin-cli/naamah/`);
              }
            },
          });
          // The URL arrives on the daemon's stderr a beat after spawn; report once it has.
          setTimeout(() => {
            addMessage('system', naamahSession?.url
              ? `naamah: ${dir}\n${naamahSession.url}  — click a type card to comment; the page rebuilds when the design changes`
              : `naamah: started on ${dir} (waiting for the daemon to report its URL)`);
          }, 900);
        } catch (err) {
          addMessage('system', `/naamah failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case '/sprint': {
        // The operator's sprint as a board in the browser. Served by this session, so a card can fetch
        // its own detail and the + box can post a comment to Jira. See src/sprint/.
        try {
          const { openSprintBoard, summariseSprint } = await import('./sprint/index.js');
          addMessage('system', summariseSprint(openSprintBoard(process.cwd())));
        } catch (err) {
          addMessage('system', `/sprint failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case '/unity-test': {
        // The same selection and report as `ayin unity test`, printed into the chat. Bare: what can be
        // run, and which are PlayMode — because nobody remembers an assembly name on demand.
        const csv = text.slice('/unity-test'.length).trim();
        addMessage('user', text);
        pushEntry(text);
        busy = true;
        setAgentStatus('unity test…');
        try {
          const { unityTestForChat } = await import('./unity/cli.js');
          const report = await unityTestForChat(process.cwd(), csv);
          addMessage('assistant', report);
          // Recorded like a slash tool's turn: an operator who runs the tests and then asks "why did
          // that one fail" means THOSE tests, and a loop that never saw them answers about nothing.
          recordSlashTurn(text, report);
        } catch (e) {
          addMessage('system', `unity test failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          busy = false;
          setAgentStatus('');
        }
        return;
      }
      case '/testrun': {
        // Domain-scoped C# test run. Selection is deterministic (corpus → files → assemblies); the
        // only interactive part is whether Unity may be quit. See src/testrun/.
        const domains = text.slice('/testrun'.length).split(',').map((d) => d.trim()).filter(Boolean);
        if (!domains.length) { addMessage('system', '/testrun <domains> — e.g. /testrun reward service'); return; }
        try {
          const { select, runSelection, formatReport } = await import('./testrun/index.js');
          const selection = select(process.cwd(), domains);
          addMessage('system', `testrun: ${selection.assemblies.length} assembly(ies) selected — running`);
          const result = await runSelection(process.cwd(), selection);
          addMessage('system', formatReport(result));
        } catch (err) {
          addMessage('system', `/testrun failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case '/clear':
        clearChat();
        return;
      case '/summary':
        showSummaryOverlay();
        return;
      case '/resume': {
        // Sessions are scoped to THIS directory by default — a session from another repo is noise,
        // and restoring one silently loads another codebase's context. `/resume all` widens it.
        const arg = text.slice('/resume'.length).trim();
        const wantAll = arg === 'all' || arg === '-a';
        try {
          const sessions = await listSessions(wantAll ? { all: true, limit: 15 } : { limit: 10 });
          if (sessions.length === 0) {
            addMessage('system', wantAll
              ? 'No sessions recorded on this machine yet.'
              : `No sessions recorded in ${process.cwd()} — try /resume all.`);
            return;
          }

          // No argument (or `all`) → the PICKER: the same overlay `/model` and the permission
          // prompt use. ↑/↓ to choose, Enter restores, Esc cancels. A printed list you then have to
          // retype a number from isn't a chooser.
          let targetId: string;
          if (!arg || wantAll) {
            resumeList = sessions;
            const picked = await showDialog(
              wantAll ? 'Resume a session (all directories)' : 'Resume a session',
              sessions.map((s) => sessionRow(s, wantAll)),
              {
                subtitle: wantAll ? 'every directory on this machine' : process.cwd(),
                selected: 0, // newest first, so the top row is almost always the one you want
                footer: '↑↓ choose · Enter resume · Esc cancel',
              },
            );
            if (picked < 0 || !sessions[picked]) return; // cancelled — say nothing, change nothing
            targetId = sessions[picked].sessionId;
          } else {
            // An argument still works: a 1-based index from the last listing, or an id / id-prefix.
            const asIndex = /^\d+$/.test(arg) ? Number(arg) : 0;
            const fromIndex = asIndex >= 1 && asIndex <= (resumeList.length || sessions.length)
              ? (resumeList[asIndex - 1] ?? sessions[asIndex - 1])
              : null;
            targetId = fromIndex ? fromIndex.sessionId : arg;
          }

          const checkpoint = await loadSessionCheckpoint(targetId);
          if (!checkpoint) {
            addMessage('system', `No session matches "${arg}" (ambiguous prefix, or nothing recorded). /resume to list.`);
            return;
          }
          if (checkpoint.cwd && checkpoint.cwd !== process.cwd()) {
            addMessage('system', `Note: that session ran in ${checkpoint.cwd} — you are in ${process.cwd()}.`);
          }
          setSessionId(resolveSessionId(targetId) ?? targetId);
          resetSummary();
          clearGoal(); // goal belongs to the session; re-seeds from the next message
          // Restore summary and recent into current session state
          const s = getSummary();
          s.summary = checkpoint.summary;
          s.recent = checkpoint.recent;

          // …and into the two places that actually matter, which the old code never touched:
          //  1. the AGENT's window — the only history buildMessages reads. Without this the model
          //     resumes with no idea what the session was about.
          //  2. the CHAT transcript — repaint it, or the screen still shows the session you left
          //     while claiming to have resumed another one.
          const restored = restoreConversation(checkpoint.recent);
          clearChat();
          addMessage('system', `── resumed ${(resolveSessionId(targetId) ?? targetId).slice(0, 8)} · ${restored} turns replayed below ──`);
          for (const turn of checkpoint.recent) {
            if (turn.role === 'user' || turn.role === 'assistant') addMessage(turn.role, turn.content);
          }
          addMessage('system', '── end of restored history · new turns continue this session ──');
          // Say what was actually restored — "resumed" with an empty window is a lie you only
          // discover two turns later.
          const rid = (resolveSessionId(targetId) ?? targetId).slice(0, 8);
          addMessage('system', `Resumed ${rid} — ${checkpoint.recent.length} turns of context${checkpoint.summary ? ' + rolling summary' : ' (no summary was checkpointed)'}. New turns append to the same record.`);
          if (checkpoint.summary) {
            addMessage('system', `Context: ${checkpoint.summary.substring(0, 200)}`);
          }
        } catch (err) {
          addMessage('system', `Resume failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case '/set': {
        const parts = text.split(' ');
        if (parts.length < 3) {
          addMessage('system', 'Usage: /set <key> <value>  (e.g. /set llm-url http://localhost:9100)');
          return;
        }
        const key = parts[1];
        const value = parts.slice(2).join(' ');
        // `default-model` was REMOVED in 1.0.210 — nothing applies it any more (ayin does not select a
        // model implicitly; see model-picker.ts). Rejected rather than silently stored, so nobody
        // configures a preference that will never take effect.
        if (key === 'default-model') {
          addMessage('system', 'default-model is no longer a setting — ayin runs on whatever the endpoint serves. Use /model <name> to switch.');
          return;
        }
        // fail, but it writes the NEW key — otherwise honouring the old name would keep re-creating
        // the deprecated config entry it is meant to retire.
        //
        // `/set` speaks kebab-case; every key the code reads is camelCase. That translation used to be
        // a hand-written map of four, so `/set ollama-model x` stored a key named `ollama-model` that
        // NOTHING reads and answered "Set ollama-model ✓" — a setting that lies is worse than one that
        // is missing. The conversion is general now, and a key outside the known list still stores
        // (an operator may know something this build does not) but says plainly that nobody reads it.
        // `openai-key` is refused rather than mapped: it wrote an UNVERIFIED secret into prompts.json,
        // beside prompt-tuning numbers, world-readable by default and easy to paste into a bug report.
        // `/openai` verifies the key against OpenAI first and writes a 0600 file. Redirect, don't store.
        if (key === 'openai-key') {
          addMessage('system', 'Use `/openai sk-…` — it verifies the key with OpenAI, then saves it to ~/.ayin-cli/openai.env (0600), and keeps it out of your shell history and the model\'s context.');
          return;
        }
        // Kebab → camel, then SNAP to the canonical key case-insensitively.
        //
        // The mechanical conversion is not enough on its own: `openai-model` becomes `openaiModel`
        // while the code reads `openAiModel`, so the natural name for a real setting stored a dead
        // key and warned about it. Writing another hand-map entry would fix that one and leave the
        // next; matching the known list ignoring case fixes the whole class, including keys added
        // later. The hand-map stays only for names that are not a case difference at all.
        const keyMap: Record<string, string> = {
          'llm-url': 'llmUrl',
          'update-registry': 'updateRegistry', 'llm-provider': 'llmProvider',
        };
        const camel = keyMap[key] ?? key.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
        const configKey = KNOWN_CONFIG_KEYS.find((k) => k.toLowerCase() === camel.toLowerCase()) ?? camel;
        setConfigValue(configKey, value);
        addMessage(
          'system',
          KNOWN_CONFIG_KEYS.includes(configKey)
            ? `Set ${key} ✓`
            : `Set ${key} ✓ — but nothing in ayin reads \`${configKey}\`. Known: ${KNOWN_CONFIG_KEYS.join(', ')}`,
        );
        return;
      }
      // `/plan` — bare session toggle (default OFF): flips whether every long-enough prompt runs the
      // survey + research + exploration pass for the REST of the session. Takes no argument — that's
      // what `/planthis` is for. See plan/index.ts's header doc for the toggle/force split.
      // Releasing a design is the OPERATOR's, which is why it lives here and not in the `entangle` tool:
      // given the affordance, the model used it to get past its own gate. See tools.ts's entangle branch.
      case '/disentangle': {
        const was = entangledTo();
        if (!was) { addMessage('system', 'Not entangled.'); return; }
        disentangle();
        addMessage('system', `Disentangled from ${was}. Writes are no longer checked against a design.`);
        return;
      }
      case '/plan': {
        const arg = text.slice('/plan'.length).trim();
        if (arg) {
          addMessage('system', 'Usage: /plan — bare toggle, no argument. For a one-off forced plan pass: /planthis <what to plan>');
          return;
        }
        const enabled = togglePlanSession();
        addMessage('system', `Plan mode ${enabled ? 'ON' : 'OFF'} for the rest of this session (AYIN_PLAN=0 still hard-disables it)`);
        return;
      }
      // `/planthis <text>` — the no-ambiguity door into plan mode for exactly ONE turn, regardless of
      // the session toggle above — for when you KNOW you want the survey + research + exploration pass
      // right now and don't want to phrase your way past a regex or flip the toggle for good. Falls
      // THROUGH to the agent (no `return`) with the command word stripped.
      case '/planthis': {
        const arg = text.slice('/planthis'.length).trim();
        if (!arg) {
          addMessage('system', 'Usage: /planthis <what to plan> — forces plan mode for this one prompt only');
          return;
        }
        forcePlanNextTurn();
        text = arg;
        break;
      }
      // `/qa` — bare session toggle (default OFF) for the QA gate. `/qathis <text>` forces it for one
      // turn. Independent of `/present` — see qa/index.ts's header doc.
      case '/qa': {
        const arg = text.slice('/qa'.length).trim();
        if (arg) {
          addMessage('system', 'Usage: /qa — bare toggle, no argument. For a one-off forced QA pass: /qathis <message>');
          return;
        }
        const enabled = toggleQaSession();
        addMessage('system', `QA gate ${enabled ? 'ON' : 'OFF'} for the rest of this session`);
        return;
      }
      case '/qathis': {
        const arg = text.slice('/qathis'.length).trim();
        if (!arg) {
          addMessage('system', 'Usage: /qathis <message> — forces the QA gate to run on this one reply only');
          return;
        }
        forceQaNextTurn();
        text = arg;
        break;
      }
      // `/present` — bare session toggle (default OFF) for the Presenter pass. `/presentthis <text>`
      // forces it for one turn. Independent of `/qa` — see presenter/index.ts's header doc.
      case '/present': {
        const arg = text.slice('/present'.length).trim();
        if (arg) {
          addMessage('system', 'Usage: /present — bare toggle, no argument. For a one-off forced presentation: /presentthis <message>');
          return;
        }
        const enabled = togglePresenterSession();
        addMessage('system', enabled
          ? 'Presenter pass ON for the rest of this session — each finished turn is presented, staged per '
            + "this project's policy, and opened in your editor"
          : 'Presenter pass OFF for the rest of this session');
        return;
      }
      case '/presentthis': {
        const arg = text.slice('/presentthis'.length).trim();
        if (!arg) {
          addMessage('system', 'Usage: /presentthis <message> — forces the Presenter pass to run on this one reply only');
          return;
        }
        forcePresenterNextTurn();
        text = arg;
        break;
      }
      // `/arduino-explain` — early-returns if cwd is not an Arduino project (probes for .ino/.pde or
      // platformio.ini/sketch.yaml). Otherwise: one wiring diagram per sketch (board rectangle + one
      // rectangle per grounded component, wires as labeled arrows — arduino-diagram.ts, PUML+SVG),
      // opened in VS Code if it's on PATH. The command name stayed the same; the artifact it produces
      // changed from a hand-rolled HTML page to a validated, draggable-in-a-vector-editor diagram.
      case '/arduino-explain': {
        addMessage('system', 'Generating wiring diagram(s)...');
        try {
          const outcome = await runArduinoDiagram(process.cwd());
          addMessage('system', formatArduinoDiagramOutcome(outcome));
        } catch (err) {
          addMessage('system', `/arduino-explain failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      // `/explain <feature>` — broader than explore: an explore pass + real git history/authorship +
      // any Jira tickets validated from commit messages, synthesized into one plain-prose story (no
      // diagram — see explain/index.ts's header doc for why). Also runnable headless as
      // `ayin explain "<question>"` (index.ts's `main()`) — same pipeline, one implementation.
      case '/explain': {
        const arg = text.slice('/explain'.length).trim();
        if (!arg) {
          addMessage('system', 'Usage: /explain <feature or path> — e.g. /explain the llm resource');
          return;
        }
        addMessage('system', `Explaining: ${arg}...`);
        try {
          const outcome = await runExplain(arg, process.cwd());
          addMessage('system', formatExplainReportOutcome(outcome));
        } catch (err) {
          addMessage('system', `/explain failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case '/goal': {
        const arg = text.slice('/goal'.length).trim();
        if (!arg) {
          const g = getGoal();
          addMessage('system', g
            ? `Goal: ${g}`
            : "No goal set. Usage: /goal <what you're working toward>  ·  /goal clear");
          return;
        }
        if (arg === 'clear' || arg === 'none') {
          clearGoal();
          addMessage('system', 'Goal cleared');
          return;
        }
        setGoal(arg);
        addMessage('system', 'Goal set ✓');
        return;
      }
      case '/reset': {
        // SAYS WHAT IT DID, because its name does not. `/reset` sounds like "start a new session" and
        // is in fact "overwrite every prompt with the shipped text" — an operator reaching for a clean
        // chat lost an evening of tuning and was told only `Prompts restored to defaults ✓`.
        const r = resetPromptsToDefaults();
        addMessage('system', `${r.restored.length} prompt(s) restored to the shipped text.`);
        if (r.backedUp.length) {
          addMessage('system', `Your edited copies were kept beside them as .bak-… : ${r.backedUp.join(', ')}`);
        }
        addMessage('system', 'This did not touch the conversation — /clear starts a new session.');
        return;
      }
      case '/help': {
        // Rendered from src/help.ts — the ONE list. This block used to be a hand-written run of
        // addMessage calls, which is how `!` ended up documented nowhere at all.
        for (const section of SECTIONS) {
          const entries = entriesInSection(section);
          if (!entries.length) continue;
          const width = Math.max(...entries.map((e) => e.name.length));
          addMessage('system', `── ${section} ${'─'.repeat(Math.max(2, 46 - section.length))}`);
          for (const e of entries) addMessage('system', `  ${e.name.padEnd(width)}  ${e.short}`);
        }
        // Tool-owned commands come from the registry, not from that list: the registry is a
        // directory, so an installed tool set can add commands this file has never heard of.
        // Awaited because discovery otherwise happens on the first AGENT turn — `/help` typed as the
        // very first thing would read an empty registry and throw.
        await loadTools();
        const tools = slashTools();
        if (tools.length) {
          addMessage('system', `── Tools ${'─'.repeat(41)}`);
          for (const t of tools) addMessage('system', `  ${t.slash!.usage}`);
        }
        return;
      }
      default: {
        // Not a built-in command — a TOOL may claim it (Tool.slash). Running it here rather than
        // letting the model pick skips two full prompt-cost rounds whose only content is relaying text
        // into a tool the operator already named, which is the whole point of typing the command.
        // Discovery normally happens on the first agent turn; a slash command can be the first thing
        // typed, so it is awaited here or the registry is read before it exists.
        await loadTools();
        const tool = findToolBySlash(cmd);
        if (!tool || !tool.slash) {
          // A typo is not a question for the model, and "Unknown command" alone leaves the operator to
          // guess which letter was wrong. The help list is the database of what exists, so it is also the
          // database of what was probably meant.
          const near = suggestNames(cmd, 'command');
          addMessage('system', near.length
            ? `Unknown command: ${cmd} — did you mean ${near.map((n) => `/${n}`).join(' · ')}?`
            : `Unknown command: ${cmd}. /help lists every command.`);
          return;
        }
        const arg = text.slice(cmd.length).trim();
        // A tool whose slash param is optional is allowed to run bare — that is how `/jira-auth` with
        // nothing after it reports status instead of printing usage at someone who typed it on purpose.
        const param = tool.parameters.find((p) => p.name === tool.slash!.param);
        if (!arg && param?.required !== false) {
          addMessage('system', tool.slash.usage);
          return;
        }
        // A credential must leave no copy behind: the history file is plaintext and outlives the session,
        // and anything in the conversation window is re-sent to the model every later round.
        if (tool.slash.secret) forgetEntry(text, cmd);
        busy = true;
        /**
         * THE SPINNER MUST STOP WHEN THE ANSWER ARRIVES.
         *
         * A slash tool is a CONNECTOR: its `execute` runs an inner agentic loop, so it drives the LLM
         * and the thinking indicator lights up from that activity. Only `runAgent`'s teardown ever
         * cleared it, and this path is not `runAgent` — so `/jira` printed its answer and then went on
         * spinning "thinking··· 23s" with the timer climbing, which reads as a hung turn on a turn that
         * is finished. Reported from a live session; the answer had been on screen for twenty seconds.
         */
        setAgentStatus(`${tool.name}…`);
        try {
          addMessage('system', `${tool.name}…`);
          const out = await tool.execute({ ...(tool.slash.defaults ?? {}), [tool.slash.param]: arg });
          if (tool.slash.overlay) {
            // In the chat too, so the transcript still shows what was asked and how big the answer was —
            // an overlay that closes must not take the only record of it with it.
            addMessage('assistant', `${tool.name}: ${out.split('\n').length} lines — shown in the overlay, Esc to close.`);
            showDocOverlay(`${tool.name} ${arg}`, out);
          } else {
            addMessage('assistant', out);
          }
          // The turn is recorded so the agent can refer back to it: an operator who runs /jira and then
          // asks "which of those is blocked?" means the tickets they just read, and a loop that never
          // saw them answers about nothing. Never for a secret argument.
          if (!tool.slash.secret) recordSlashTurn(text, out);
        } catch (err) {
          addMessage('system', `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          busy = false;
          setAgentStatus(''); // in `finally`: a connector that THREW must not leave the terminal thinking
        }
        return;
      }
    }
  }

  if (!isConnected()) {
    addMessage('system', 'Not connected. Waiting for the backend...');
    return;
  }

  // Run agent loop
  busy = true;
  try {
    // First real prompt of the session auto-determines the goal — one LLM call that distills
    // the user's direction into a stable one-liner (the anti-wander anchor). Derived before the
    // loop so it's in the agent's context from round 1. Overridable any time with /goal.
    // Bounded wait: llmCall's own ceiling is 10 min, so we cap the pre-loop block; if the
    // derivation is slow it keeps running in the background and lands on a later round + the
    // cursive line updates itself via the goal subscription.
    if (!getGoal()) {
      setAgentStatus('Determining goal...');
      // THREE SECONDS, NOT TWELVE. The goal is one short line and the derivation keeps running in the
      // background either way, landing on a later round — so the only thing a long block buys is
      // having it in round 1 instead of round 2. Twelve seconds of a dead terminal, on the FIRST
      // prompt of every session, before any work starts, is not worth that. When the endpoint is that
      // slow, waiting longer helps nobody: it is exactly when the operator most needs to see motion.
      await Promise.race([refreshGoal(text), new Promise(r => setTimeout(r, 3_000))]);
    }

    // Corpus lookup for this prompt: the first of the session (it states the task), or when asked.
    promptsThisSession++;
    const wantCorpus = isCorpusInjection() && (embedNextTurn || embedSession || promptsThisSession === 1);
    embedNextTurn = false;
    if (wantCorpus) {
      setAgentStatus('Checking the corpus...');
      try {
        const block = await corpusForPrompt(process.cwd(), text);
        setPendingCorpus(block);
        if (block) addMessage('system', 'corpus: found related answers from an earlier indulge run');
      } catch { setPendingCorpus(null); }
    }

    await runAgent(text);
  } catch (err) {
    setAgentStatus('');
    const msg = err instanceof Error ? err.message : String(err);
    addMessage('system', `Agent error: ${msg}`);
    log('ERROR', 'agent_error', { error: msg });
  }
  // The block belongs to the TURN. Clearing it here is what keeps a lookup made for "how does the
  // reward service work" out of the next turn about something else entirely.
  clearPendingCorpus();
  busy = false;

  // Refresh token display
  refreshTokens().catch(() => {});
}

onInput((text: string) => { void handleInput(text); });

// ── Start ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // The detached scheduler. Spawned by `/sentinaile`, never typed by a person — it owns the pid file
  // and polls persisted state, so a reboot costs one poll interval rather than the whole watch.
  if (process.argv[2] === 'sentinaile-supervisor') {
    const { runSupervisor } = await import('./sentinaile/supervisor.js');
    runSupervisor();
    return;
  }

  if (process.argv[2] === 'watch') {
    // Repo watcher daemon — no TUI, no agent loop. See src/watch.ts.
    const { runWatch } = await import('./watch.js');
    await runWatch(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'unwatch') {
    // The inverse of `watch`: remove the hooks from a repo and deregister it. See src/watch.ts.
    const { runUnwatch } = await import('./watch.js');
    await runUnwatch(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'kill') {
    // `ayin kill dog` — the hound kill switch. Two words because that is what the operator says out
    // loud; anything else after `kill` is an error rather than a guess at what was meant.
    const { runKillDog } = await import('./kill-dog.js');
    if (process.argv[3] !== 'dog') {
      process.stderr.write('ayin: the only thing you can kill is the dog — `ayin kill dog [--off | --status]`\n');
      process.exitCode = 1;
      return;
    }
    process.exitCode = runKillDog(process.argv.slice(4));
    return;
  }
  if (process.argv[2] === 'indulge') {
    // Overnight per-repo corpus build — no TUI, no agent loop, resumes itself. See src/indulge/.
    const { runIndulge } = await import('./indulge/index.js');
    process.exitCode = await runIndulge(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'launch') {
    // Opens a terminal window at the front Finder/Explorer directory and runs ayin in it. For a
    // global hotkey to call — there is no terminal to inherit a cwd from when one fires. See launch.ts.
    const { runLaunch } = await import('./launch.js');
    process.exitCode = await runLaunch(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'testrun') {
    const { runTestrunCli } = await import('./testrun/index.js');
    process.exitCode = await runTestrunCli(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'chore') {
    // Members added in recent commits that nothing uses. Deterministic — git plus grep, no model. Text by
    // default; `--html` writes the page `/chore` opens. See src/chore/.
    const { runChoreCli } = await import('./chore/cli.js');
    process.exitCode = runChoreCli(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'unity') {
    // One namespace for the Unity toolkit — prefab, animator, prefab_edit, test. No TUI, no model: every
    // one of them is deterministic, and three top-level subcommands would put Unity vocabulary in front
    // of everyone who never opens Unity. See src/unity/cli.ts.
    const { runUnityCli } = await import('./unity/cli.js');
    process.exitCode = await runUnityCli(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'debug') {
    // Same bundle, from a shell. A run that hung is often one nobody was sitting in front of.
    const { writeDebugBundle, defaultBundleDir } = await import('./debug-bundle.js');
    const { contextTokens } = await import('./indulge/budget.js');
    const dest = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : defaultBundleDir();
    const r = writeDebugBundle(dest, {
      version: getVersion(), provider: 'unresolved', model: 'unresolved', dialect: 'unresolved',
      // This process never talked to a model, so nothing was matched or fallen back to — it is a
      // separate `ayin debug` invocation reading the session the TUI left on disk.
      dialectSource: 'FALLBACK — model never resolved',
      contextTokens: contextTokens(), cwd: process.cwd(), sessionId: null,
    });
    process.stdout.write(`${r.latest}\n${r.dir}\n${r.files.join(', ')} · ${Math.round(r.bytes / 1024)} KB\n`);
    return;
  }
  if (process.argv[2] === 'diff') {
    // Same page as `/diff`, from a shell — and it SERVES it now rather than writing a snapshot, because
    // a comment is answered by its own headless run and no longer needs a chat to land in. Parks until
    // Ctrl+C. No TUI. See src/diff/ and src/serve-page.ts.
    const { runDiffCli } = await import('./diff/index.js');
    process.exitCode = await runDiffCli(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'sprint') {
    // Same board as `/sprint`, from a shell. It has no static form — the cards fetch their own detail —
    // so this serves it and parks. See src/sprint/.
    const { runSprintCli } = await import('./sprint/index.js');
    process.exitCode = await runSprintCli(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'update') {
    // Self-update from the configured npm registry, whichever one this install points at.
    // No TUI: it's a plain command that prints and exits. See src/updater.ts.
    const { runUpdate } = await import('./updater.js');
    await runUpdate(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'version' || process.argv[2] === '--version' || process.argv[2] === '-v') {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }
  loadRules(process.cwd());
  // A local prompt whose {{VAR}} contract has fallen behind the shipped one is INVISIBLE at every
  // other layer: the code passes the data, the prompt never asks for it, the model is never told,
  // nothing errors. Say so before anything else runs, on every path — headless included, where a
  // silently-degraded prompt is even harder to notice. See prompts.ts#promptDriftWarnings.
  for (const warning of promptDriftWarnings()) {
    log('WARN', 'prompt_drift', { detail: warning });
    process.stderr.write(`ayin: ${warning}\n`);
  }
  // Decide WHICH LLM provider serves this machine before anything paints or asks for a capability.
  // Never throws: an endpoint that exposes no resource surface (or none at all) lands on `direct`.
  await initLlmProvider();
  if (process.argv[2] === 'explain') {
    // `ayin explain "<question>"` — the SAME runExplain pipeline the interactive `/explain` command
    // uses (see explain/index.ts), invoked headlessly: connect, run it, print the narrative straight to
    // stdout, exit. `'explain'` is in ui/headless.ts's NO_TUI_COMMANDS so blessed never grabs the tty.
    await runExplainCli(process.argv.slice(3).join(' ').trim());
    return;
  }
  if (HEADLESS) {
    // ARMED BEFORE THE WORK, MARKED CLEAN AFTER IT. Anything between the two that ends the process —
    // a signal from a parent cancelling this subagent, an uncaught throw, a bare process.exit — leaves
    // a note saying where it got to. See `postmortem.ts`.
    armPostmortem();
    await runHeadless();
    markCleanExit();   // belt: runHeadless exits on its own path, and marks itself there
    return;
  }
  await runInteractive();
}

async function runExplainCli(feature: string): Promise<void> {
  if (!feature) {
    process.stderr.write('ayin: explain requires a feature or question — e.g. ayin explain "explain me the checkout feature"\n');
    process.exit(1);
  }

  try {
    await connect();
  } catch (err) {
    process.stderr.write(`ayin: connection failed — ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
  // Same as runHeadless: establishes a session id so the per-run record has a key to write under.
  await initSession().catch(() => {});
  await refreshActiveModel();

  try {
    const outcome = await runExplain(feature, process.cwd());
    if (!outcome.ok || !outcome.body) {
      process.stderr.write(`ayin: ${outcome.reason ?? 'nothing to report'}\n`);
      await disconnect();
      process.exit(1);
    }
    process.stdout.write(`${outcome.body}\n`);
    process.stderr.write(`\nFull report written to ${outcome.reportPath}${outcome.reportOpened ? ' (opened in editor)' : ''}\n`);
  } catch (err) {
    process.stderr.write(`ayin: explain error — ${err instanceof Error ? err.message : err}\n`);
    await disconnect();
    process.exit(1);
  }

  await disconnect();
  process.exit(0);
}

async function runHeadless(): Promise<void> {
  const prompt = getNonInteractivePrompt();
  if (!prompt) {
    process.stderr.write('ayin: -p/--prompt requires a prompt string\n');
    process.exit(1);
  }

  try {
    await connect();
  } catch (err) {
    process.stderr.write(`ayin: connection failed — ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  // Establish a session id so the per-run record (session-record.ts) has a key to write under.
  // Headless runs (ayin -p, the watch daemon) need this exactly like the interactive REPL does.
  const headlessSession = await initSession().catch(() => '');
  // AND THE LIVE MIRROR MOST OF ALL HERE. An unattended run has nobody to notice it stopped, and no
  // terminal to type `/debug` into — the mirror is the only thing that can say where it stopped.
  startLiveMirror({ sessionId: headlessSession || 'headless', version: getVersion() });

  // FULL TRANSCRIPT for an unattended run — `AYIN_TRANSCRIBE=1` or `--transcribe`. This is the mode
  // that matters most for it: an enqueued task has nobody watching, so the only way to answer "why did
  // it do that" afterwards is a complete record written while it ran. Announced on stderr because
  // stdout is the run's result and must stay parseable.
  if (process.env.AYIN_TRANSCRIBE === '1' || process.argv.includes('--transcribe')) {
    const p = startTranscript({ cwd: process.cwd(), ayin: getVersion(), model: activeModelId() });
    process.stderr.write(p ? `ayin: full transcript → ${p}\n` : 'ayin: could not start a transcript (no session id)\n');
  }

  await refreshActiveModel();

  // ── answering a review comment ────────────────────────────────────────────────
  //
  // A run spawned by diff/runner.ts carries the comment id it belongs to, and it SETTLES ITS OWN
  // THREAD. That is deliberate: the session that spawned it may be closed before the answer lands, and
  // an answer that only exists while its parent is alive is the failure this whole mechanism replaced.
  //
  // Every message goes into the thread as it is printed, not at the end — the operator watching the
  // page sees the run think, and a long edit stops looking like a dead one. Consecutive identical texts
  // are dropped because a streamed message is rewritten in place, and mirroring each rewrite would fill
  // the thread with drafts of one sentence.
  const commentId = process.env.AYIN_DIFF_COMMENT_ID ?? '';
  // The cwd the SERVER recorded, never this process's own: the store is keyed by that string and
  // `process.cwd()` has every symlink resolved out of it.
  const commentCwd = process.env.AYIN_DIFF_COMMENT_CWD || process.cwd();
  let lastFinal = '';
  if (commentId) {
    let lastMirrored = '';
    onAssistantMessage((text, interim) => {
      if (text === lastMirrored) return;
      lastMirrored = text;
      addNote(commentCwd, commentId, text);
      if (!interim) lastFinal = text;
    });
  }

  // ── answering a ticket question ──────────────────────────────────────────────
  //
  // The same mechanism, into a markdown thread instead of a JSONL store (sprint/runner.ts). It differs
  // in one way that matters: a thread turn cannot be relabelled once appended, so a message is HELD
  // until the next one arrives and only then written as a `note`. Whatever is still held when the run
  // ends IS the reply, appended as `ayin`. Mirroring immediately and appending the reply at the end
  // would put the same sentence in the thread twice under two different headings.
  const ticketKey = process.env.AYIN_SPRINT_CHAT_KEY ?? '';
  let heldTicketReply = '';
  if (ticketKey) {
    let lastMirrored = '';
    onAssistantMessage((text, interim) => {
      if (text === lastMirrored) return;
      lastMirrored = text;
      // An interim note is by definition not the reply, so it needs no holding.
      if (interim) { appendTicketTurn(ticketKey, 'note', text); return; }
      if (heldTicketReply) appendTicketTurn(ticketKey, 'note', heldTicketReply);
      heldTicketReply = text;
    });
  }

  try {
    await runAgent(prompt);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // The thread first, the terminal second: nobody is reading this stderr, and a page left spinning on
    // a run that threw is the one outcome the status field exists to prevent.
    if (commentId) markFailed(commentCwd, commentId, `the run failed — ${why}`);
    if (ticketKey) appendTicketTurn(ticketKey, 'ayin', `The run failed before answering — ${why}`);
    process.stderr.write(`ayin: agent error — ${why}\n`);
    process.exit(1);
  }

  if (commentId) {
    const reply = lastAssistantMessage() || lastFinal;
    if (reply) markDone(commentCwd, commentId, reply);
    else markFailed(commentCwd, commentId, `the run finished without saying anything — its log is ${runLogPath(commentId)}`);
  }

  if (ticketKey) {
    const reply = heldTicketReply || lastAssistantMessage();
    appendTicketTurn(ticketKey, 'ayin', reply
      || `The run finished without saying anything. Its log is ${process.env.AYIN_SPRINT_CHAT_LOG || '(unrecorded)'}`);
  }

  flushTranscript(); // belt and braces — the exit hook covers the rest
  await disconnect();
  // THE EXPECTED EXIT SEQUENCE. `runHeadless` exits the process itself, so marking it in the caller
  // after the await never ran — every clean headless run wrote a postmortem saying it had died.
  markCleanExit();
  process.exit(0);
}

async function runInteractive(): Promise<void> {
  loadHistory();
  setStatus({ connection: 'connecting', cwd: process.cwd() });

  // Tool-owned slash commands into the hint panel. Discovery is kicked here rather than awaited: a
  // command the operator cannot see typed is a command they will not learn exists, but blocking the TUI
  // on it would make an unrelated bad tool package delay the whole boot. `/help` and the dispatcher await
  // discovery themselves, so a command typed before this resolves still works.
  void loadTools()
    .then(() => {
      for (const t of slashTools()) registerCommand({ name: `/${t.slash!.command}`, description: t.description });
    })
    .catch((err) => log('WARN', 'slash_registration_failed', { error: err instanceof Error ? err.message : String(err) }));

  // Live LLM phase in the status bar (swapping/preprocessing/responding/postprocessing) —
  // fed by the backend llm resource's SSE event stream, reconnects on its own.
  const { subscribeLlmPhase } = await import('./llm-events.js');
  subscribeLlmPhase((p) => setStatus({ llm: p.phase ? { phase: p.phase, detail: p.detail } : null }));

  // Always-on model + GPU segments (polled from the llm resource's read ops).
  startModelStatusPoll();

  addMessage('system', `ayin v${getVersion()}`);
  addMessage('system', process.cwd());

  // EVERY MESSAGE CARRIES ITS PRICE. The manager reports what each call cost (the server's own
  // counts); the UI is the subscriber because nothing under `llm/` may import the screen.
  onLlmUsage((u) => {
    noteCallCost(u);
    // The meter tracks the ROUND, not the turn: a tool result that added 20k tokens should move the bar
    // when it lands, not after the answer. Free now — the measured path is a read, not a request.
    if (u.main) void refreshTokens();
  });

  startPromptServer();

  /**
   * The review page's route into the session. `handleInput` decides whether this starts a turn or joins
   * the running one; either way the comment shows up in the chat exactly as if it had been typed.
   */
  // The sprint ticket thread. The key is held until the turn ends and the closing message is appended to
  // it here — busy means the message goes on the queue, so it is held aside until a turn absorbs it.
  // NEITHER A REVIEW COMMENT NOR A TICKET QUESTION IS A TURN HERE ANY MORE. It is answered by its own headless ayin, spawned by
  // Each is answered by its own headless ayin, spawned by the route that took it (diff/runner.ts,
  // sprint/runner.ts) — so this session neither queues one nor settles one, and a comment written while
  // the operator is mid-conversation no longer waits for work it has nothing to do with. See
  // docs/ARCHITECTURE.md "One comment, one run".

  // Runs whose process is gone leave comments nothing will ever answer. Fail those by name at boot
  // instead of letting a reopened page poll a dead run — a run still ALIVE is left alone, which is why
  // the store records its pid.
  const reaped = reapAbandoned(process.cwd());
  if (reaped) addMessage('system', `${reaped} diff comment(s) were left unanswered by a run that is gone — re-send them from the page.`);

  const url = serverUrl('/diff');
  if (url) addMessage('system', `review page: ${url}`);
  // AND THE ADDRESS A PHONE CAN REACH. The port is bound on the LAN (prompt-server.ts), so the review
  // page and the sprint board are readable from a handset on the same Wi-Fi — but only if the operator
  // is told the address, which nothing else in a TUI is going to tell them.
  const lan = serverLanUrl('/diff');
  if (lan) addMessage('system', `  on this network: ${lan}   (phone, tablet — /sprint too)`);

  // Release a booked model (/model qwen) if we're killed — /quit already does this; a hard kill
  // otherwise leaves the grant to TTL-expire on the backend.
  process.on('SIGTERM', () => { void releaseModelHold(); });
  process.on('SIGINT', () => { void releaseModelHold(); });

  focusInput();
  screen.render();

  // Check for updates (non-blocking)
  // "↑ vX available" in the status bar — at boot and every 10 min, so a fix published from this
  // session (or another machine) surfaces without a restart.
  startUpdateWatch();

  try {
    await connect();
    log('INFO', 'connected');
    // Open a local session record (non-blocking — failure is non-fatal)
    initSession().then(id => {
      addMessage('system', `Session: ${id.substring(0, 16)}  (${SESSION_NAMESPACE})`);
      // From here the run explains itself from OUTSIDE, continuously — see live-mirror.ts. A hang
      // cannot produce its own debug bundle, so the bundle stops being the only way to see one.
      startLiveMirror({ sessionId: id, version: getVersion() });
      // Shipped prompt fixes land at BOOT, and they are ANNOUNCED. A prompt replaced silently is the
      // same class of problem as one never replaced: text the operator cannot reason about.
      const pr = registerShippedPrompts();
      for (const r of pr.repaired) {
        addMessage('system', `prompt ${r.id} could no longer carry what the code sends — replaced with the shipped text. Yours: ${r.backupPath}`);
      }
      if (pr.refreshed.length) addMessage('system', `prompt(s) updated to the shipped version: ${pr.refreshed.join(', ')}`);

      // `ayin --debug` — the flag form of `/debug`, applied FROM THE START.
      //
      // The bundle's value is a path someone else can read, and the moment you need it is the moment the
      // session stopped answering — which is also the moment there is no prompt to type `/debug` into.
      // Writing it at boot means the path exists before anything goes wrong, and `/debug` (or
      // `ayin debug`) refreshes the same stable directory later. Fired here rather than earlier on
      // purpose: the session id and the resolved model are what make the bundle worth reading, and both
      // exist only once `initSession` has answered. A dialect probe still in flight is reported as
      // provisional by the bundle itself, not guessed at here.
      if (process.argv.includes('--debug') || isFullMode()) void handleInput('/debug');
    }).catch(err => {
      log('WARN', 'session_init_failed', { error: err instanceof Error ? err.message : String(err) });
    });
  } catch (err) {
    setStatus({ connection: 'disconnected' });
    addMessage('system', `Connection failed: ${err instanceof Error ? err.message : err}`);
    log('ERROR', 'connect_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

main().catch((err) => {
  screen.destroy();
  console.error = process.stderr.write.bind(process.stderr);
  log('ERROR', 'fatal', { error: err instanceof Error ? err.message : String(err) });
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
