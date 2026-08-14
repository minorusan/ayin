#!/usr/bin/env node

/**
 * Ayin CLI v1 — Terminal Coding Agent
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
  screen, addMessage, setStatus, setAgentStatus, clearChat,
  onInput, onGlobalKey, focusInput, blurInput, shutdown, getTokensDisplay,
  showAlert, setStickyAlert, clearStickyAlert,
} from './ui.js';
import { isTranscribing, startTranscript, stopTranscript, transcriptPath, transcriptSize, flush as flushTranscript } from './transcript.js';
import { executeWipe, humanBytes, planWipe, wipeOverview, type WipeScope } from './wipe.js';
import { connect, disconnect, onConnectionChange, isConnected, currentRequestId } from './connection.js';
import { refreshActiveModel, activeModelId } from './llm/manager.js';
import { initLlmProvider } from './llm/select.js';
import { getSummaryText, getSummary, resetSummary } from './summary.js';
import { estimateSessionTokens } from './tokens.js';
import { loadHistory, pushEntry } from './history.js';
import { forcePlanNextTurn, togglePlanSession } from './plan/index.js';
import { toggleQaSession, forceQaNextTurn } from './qa/index.js';
import { togglePresenterSession, forcePresenterNextTurn } from './presenter/index.js';
import { runAgent, interruptAgent, enqueueAgentMessage, restoreConversation } from './agent.js';
import { startPromptServer } from './prompt-server.js';
import { acquireLlm, type LlmHold } from './llm/authority.js';
import { setProviderOverride, providerOverrideName, llmProvider } from './llm/select.js';
import { openAiKey, openAiModel } from './llm/providers/openai.js';
import { handleModelCommand, releaseModelHold, isModelBooked, lockSession, unlockSession, isSessionLocked, lockSupported } from './model-picker.js';
import { showDialog } from './dialog.js';
import { startLlmStatusPoll, findOwnPlace } from './llm-status.js';
import { startUpdateWatch, checkForUpdate } from './updater.js';
import { getSessionArtifacts, readArtifact } from './artifacts.js';
import { renderMarkdown } from './markdown.js';
import { HEADLESS } from './ui.js';
import { loadRules } from './rules.js';
import { setConfigValue, resetPromptsToDefaults, promptDriftWarnings, KNOWN_CONFIG_KEYS } from './prompts.js';
import { getGoal, setGoal, clearGoal, refreshGoal } from './goal.js';
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
    const s = getSummary();
    const est = await estimateSessionTokens(s.summary, s.recent);
    setStatus({ tokens: { used: est.promptTokens, total: est.contextWindow } });
  } catch { /* silent */ }
}

// ── Summary overlay ─────────────────────────────────────────────────

import blessed from 'blessed';

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

if (!HEADLESS) {
  onGlobalKey((key) => {
    if (key === 'escape') {
      if (artifactsOverlay) { closeArtifactsOverlay(); return; }
      if (summaryOverlay) { closeSummaryOverlay(); return; }
      if (busy) { interruptAgent(); return; }
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
    const box = artifactsOverlay ?? summaryOverlay;
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
// model-picker.ts#lockSession takes priority only, never a model). The backend now moves the model
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
          locked: isSessionLocked(),
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

onInput(async (text: string) => {
  if (busy) {
    pushEntry(text);
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
       * `/openai` — switch this session to the hosted model for a task worth paying for, and back.
       *
       * Never automatic: a provider that bills per token is asked for, never fallen into. The command
       * reports what it switched to, because "which model am I paying for" must never be a guess.
       *   /openai            → toggle on/off
       *   /openai <model>    → switch on, using that model
       *   /openai key sk-…   → store the key (env OPENAI_API_KEY still wins)
       */
      case '/openai': {
        const arg = text.slice('/openai'.length).trim();
        if (arg.startsWith('key ')) {
          const k = arg.slice(4).trim();
          if (!k.startsWith('sk-')) { addMessage('system', 'That does not look like an OpenAI key (expected sk-…).'); return; }
          setConfigValue('openAiKey', k);
          addMessage('system', `OpenAI key stored (…${k.slice(-4)}). Switch with /openai.`);
          return;
        }
        if (providerOverrideName() && !arg) {
          setProviderOverride(null);
          await refreshActiveModel();
          addMessage('system', `Back on the local provider (${activeModelId() || 'resolving…'}).`);
          return;
        }
        if (!openAiKey()) {
          addMessage('system', 'No OpenAI key. Set one with `/openai key sk-…` or export OPENAI_API_KEY.');
          return;
        }
        setProviderOverride('openai');
        const provider = await llmProvider();
        if (arg) await provider.setModel?.(arg);
        const status = await provider.status();
        if (!status.ok) {
          setProviderOverride(null);
          addMessage('system', 'OpenAI rejected the key or is unreachable — staying local.');
          return;
        }
        await refreshActiveModel();
        addMessage('system', `Switched to OpenAI (${openAiModel()}) — billed per token. /openai again to go back.`);
        return;
      }
      case '/model':
        await handleModelCommand(text.slice('/model'.length));
        return;
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
      case '/lock': {
        // Hold the PRIORITY BAND for this session: short TTL + fast keepalive, so it self-releases if
        // this client dies rather than stranding the GPU. It does not change the model — see
        // model-picker.ts#lockSession.
        // An LLM provider without an authority layer has nothing to lock — say it once, plainly,
        // because the user asked; nothing else in the UI ever mentions locking on such a setup.
        if (!(await lockSupported())) {
          addMessage('system', 'No authority layer on this LLM endpoint — /lock has nothing to hold here.');
          return;
        }
        if (isSessionLocked()) { addMessage('system', 'Already locked. /unlock releases it.'); return; }
        const err = await lockSession();
        if (err) { addMessage('system', `/lock failed: ${err}`); return; }
        addMessage('system', 'Locked ⚿ — this session holds priority (not the model choice) until you /quit, /unlock, or stop responding for 10 minutes.');
        return;
      }
      case '/unlock':
        if (!isSessionLocked()) { addMessage('system', 'Not locked.'); return; }
        await unlockSession();
        addMessage('system', 'Unlocked — the backend may reclaim the model.');
        return;
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
          addMessage('system', 'Usage: /set <key> <value>  (e.g. /set openai-key sk-...)');
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
        const keyMap: Record<string, string> = {
          'openai-key': 'openAiKey', 'llm-url': 'llmUrl',
          'update-registry': 'updateRegistry', 'llm-provider': 'llmProvider',
        };
        const configKey = keyMap[key] ?? key.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
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
        addMessage('system', `Presenter pass ${enabled ? 'ON' : 'OFF'} for the rest of this session`);
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
      case '/reset':
        resetPromptsToDefaults();
        addMessage('system', 'Prompts restored to defaults ✓');
        return;
      case '/help':
        addMessage('system', '/goal <text> — set the session goal (shown in cursive above the chat); /goal clear to unset');
        addMessage('system', '/model — popup: pick from the models the backend has installed (Enter reloads the GPU with it)');
        addMessage('system', '/model <name|qwen|gemma> — switch straight away; a non-shared model stays booked until you /quit');
        addMessage('system', '/lock — hold the model for this session (self-releases 10 min after you stop responding) · /unlock');
        addMessage('system', '/summary — show session summary (Esc to close)');
        addMessage('system', '/resume — list this directory\'s sessions (newest first) · /resume all for every directory');
        addMessage('system', '/resume <n>|<id> — restore one by list number or id prefix; new turns append to its record');
        addMessage('system', '/plan — toggle plan mode for the session (default OFF) · /planthis <text> — force it for one prompt only');
        addMessage('system', '/qa — toggle the QA gate for the session (default OFF) · /qathis <message> — force it for one reply only');
        addMessage('system', '/present — toggle the Presenter pass for the session (default OFF) · /presentthis <message> — force it for one reply only');
        addMessage('system', '/arduino-explain — for an Arduino project in this dir: a validated wiring diagram per sketch (board + component rectangles, PUML+SVG), opened in VS Code');
        addMessage('system', '/explain <feature> — the story of a feature in plain prose: history/authorship, lifecycle/bugs, composition, how it\'s wired up — grounded in explore + real git history + validated Jira tickets, opened in VS Code. Also runnable headless: ayin explain "<question>"');
        addMessage('system', '/clear — clear chat');
        addMessage('system', '/set llm-url <http://host:9100> — point ayin at the LLM endpoint (an adapter, or a backend). Env: AYIN_LLM_URL');
        addMessage('system', '/set llm-provider <ollama|direct|resource|auto> — ollama talks to a local runtime directly (tools declared natively); the others expect the HTTP contract (default: auto-detect)');
        addMessage('system', '/set ollama-model <name> — which model the ollama provider asks for (default: whatever is loaded) · ollama-url, ollama-ctx');
        // (`/set default-model` was removed in 1.0.210 — ayin no longer picks a model implicitly.)
        addMessage('system', '/set update-registry <http://host:4873> — where `ayin update` looks (public npm is refused: "ayin" there is someone else)');
        addMessage('system', '/openai — switch to the hosted model for a hard task (billed per token); again to switch back');
        addMessage('system', '/openai <model> — switch and pick the model · /openai key <sk-...> — store the key');
        addMessage('system', '/model adapter <gemma|qwen|auto> — how ayin SPEAKS to whatever is served; it does not move the model on a shared host');
        addMessage('system', '/disentangle — release a bound design (the agent cannot: it would only switch its own gate off)');
        addMessage('system', '/reset — restore default prompts');
        addMessage('system', '/quit — exit');
        return;
      default:
        addMessage('system', `Unknown command: ${cmd}`);
        return;
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
      await Promise.race([refreshGoal(text), new Promise(r => setTimeout(r, 12_000))]);
    }
    await runAgent(text);
  } catch (err) {
    setAgentStatus('');
    const msg = err instanceof Error ? err.message : String(err);
    addMessage('system', `Agent error: ${msg}`);
    log('ERROR', 'agent_error', { error: msg });
  }
  busy = false;

  // Refresh token display
  refreshTokens().catch(() => {});
});

// ── Start ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.argv[2] === 'watch') {
    // Repo watcher daemon — no TUI, no agent loop. See src/watch.ts.
    const { runWatch } = await import('./watch.js');
    await runWatch(process.argv.slice(3));
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
    await runHeadless();
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
  await initSession().catch(() => {});

  // FULL TRANSCRIPT for an unattended run — `AYIN_TRANSCRIBE=1` or `--transcribe`. This is the mode
  // that matters most for it: an enqueued task has nobody watching, so the only way to answer "why did
  // it do that" afterwards is a complete record written while it ran. Announced on stderr because
  // stdout is the run's result and must stay parseable.
  if (process.env.AYIN_TRANSCRIBE === '1' || process.argv.includes('--transcribe')) {
    const p = startTranscript({ cwd: process.cwd(), ayin: getVersion(), model: activeModelId() });
    process.stderr.write(p ? `ayin: full transcript → ${p}\n` : 'ayin: could not start a transcript (no session id)\n');
  }

  // Coder authority (AYIN_ACQUIRE_LLM=1): take the llm resource for this run. PRIORITY ONLY — it does
  // not swap the model (no per-owner policy since 1.0.210); the run uses whatever is resident.
  // Sliding grant + unref'd keepalive → auto-released when the process exits; also released
  // explicitly on normal completion so nothing waits on a grant this run no longer needs.
  // FOREGROUND BY DEFAULT. `/api/generate` is LOW priority so background agents yield to a human — but
  // `ayin -p` IS a human waiting at a terminal, and it used to run in LOW. Measured: a run's final call
  // sat ~11 minutes behind a journal habit and a CPU embedding load on an otherwise idle GPU, with the
  // wait invisible (the narrator is TUI-only). runInteractive already auto-locks for exactly this
  // reason; this is the same decision for the headless path, through the same tested grant.
  //
  // `AYIN_ACQUIRE_LLM=0` opts out — the watch daemon and anything cron-driven genuinely IS background
  // work and should keep yielding to a person.
  let llmHold: LlmHold = 'no-resource-layer';
  if (process.env.AYIN_ACQUIRE_LLM !== '0') {
    llmHold = await acquireLlm('ayin -p (foreground — a human is waiting on this)');
  }

  // Resolve the active model (gemma/qwen) → dialect before the first round.
  await refreshActiveModel();

  try {
    await runAgent(prompt);
  } catch (err) {
    process.stderr.write(`ayin: agent error — ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  } finally {
    if (typeof llmHold === 'object') { try { await llmHold.release(); } catch { /* autoreleased on process exit */ } }
  }

  flushTranscript(); // belt and braces — the exit hook covers the rest
  await disconnect();
  process.exit(0);
}

async function runInteractive(): Promise<void> {
  loadHistory();
  setStatus({ connection: 'connecting', cwd: process.cwd() });

  // Live LLM phase in the status bar (swapping/preprocessing/responding/postprocessing) —
  // fed by the backend llm resource's SSE event stream, reconnects on its own.
  const { subscribeLlmPhase } = await import('./llm-events.js');
  subscribeLlmPhase((p) => setStatus({ llm: p.phase ? { phase: p.phase, detail: p.detail } : null }));

  // Always-on model + GPU segments (polled from the llm resource's read ops).
  startModelStatusPoll();

  // AUTO-LOCK. An interactive session is a human waiting at a keyboard, so it takes the priority
  // band by default instead of sitting in LOW behind every habit — the failure mode that produced
  // "GPU: chatOnce 306s · 1 waiting" and then a 10-minute client abort reported as `fetch failed`.
  // Self-releasing (10-min TTL + 2-min keepalive), released on /quit, and opt-out with
  // AYIN_AUTOLOCK=0 for a session that should yield to background work. On a provider with no
  // authority layer this is not a failure to report — there is no lock to take and never was. Check
  // first and stay silent, or every public clone opens with an error about a resource layer its
  // owner has never heard of.
  //
  // PRIORITY ONLY — it does not choose or load a model (1.0.210). Starting ayin no longer changes
  // what the shared GPU is serving for everyone else on the machine; use `/model` to ask for one.
  if (process.env.AYIN_AUTOLOCK !== '0') {
    void (async () => {
      if (!(await lockSupported())) return;
      const err = await lockSession();
      if (err) addMessage('system', `Could not take the priority lock: ${err} — /lock to retry.`);
      else addMessage('system', 'Locked ⚿ — priority band for this session (/unlock to yield). Model unchanged: /model to switch.');
    })();
  }

  addMessage('system', `ayin v${getVersion()}`);
  addMessage('system', process.cwd());

  startPromptServer();

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
