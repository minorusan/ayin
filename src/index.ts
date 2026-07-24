#!/usr/bin/env node

/**
 * Ayin CLI v1 — Terminal Coding Agent
 */

// Redirect all console output to file — blessed owns the terminal.
import { log, captureConsole } from './log.js';
captureConsole();

import {
  screen, addMessage, setStatus, setAgentStatus, clearChat,
  onInput, onGlobalKey, focusInput, blurInput, shutdown, getTokensDisplay,
} from './ui.js';
import { connect, disconnect, onConnectionChange, isConnected } from './connection.js';
import { refreshActiveModel, activeModelId } from './llm/manager.js';
import { getSummaryText, getSummary, resetSummary } from './summary.js';
import { estimateSessionTokens } from './tokens.js';
import { loadHistory, pushEntry } from './history.js';
import { runAgent, interruptAgent, enqueueAgentMessage } from './agent.js';
import { startPromptServer } from './prompt-server.js';
import { acquireLlm, type LlmHold } from './resource-client.js';
import { checkForUpdate } from './updater.js';
import { getSessionArtifacts, readArtifact } from './artifacts.js';
import { renderMarkdown } from './markdown.js';
import { HEADLESS } from './ui.js';
import { loadRules } from './rules.js';
import { setConfigValue, resetPromptsToDefaults } from './prompts.js';
import { getGoal, setGoal, clearGoal, refreshGoal } from './goal.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initSession,
  listSessions,
  loadSessionCheckpoint,
  setSessionId,
  SESSION_NAMESPACE,
} from './tiferet-session.js';

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
// Interactive booking of the coder model: `/model qwen` takes the llm resource as the `ayin`
// authority (backend swaps gemma → qwen-coder) and HOLDS it for the whole session; `/model gemma`
// releases it. The hold is released on /quit and on SIGINT/SIGTERM; a hard kill lets the backend
// grant TTL-expire (the keepalive is unref'd, so it stops on exit).
let modelHold: LlmHold | null = null;

async function releaseModelHold(): Promise<void> {
  const h = modelHold;
  modelHold = null;
  if (h && typeof h === 'object') await h.release().catch(() => {});
}

async function handleModelCommand(arg: string): Promise<void> {
  const t = arg.trim().toLowerCase();
  const held = modelHold && typeof modelHold === 'object';

  if (!t) {
    addMessage('system', `Model: ${activeModelId() || '(resolving…)'}${held ? ' — booked by you until quit' : ' (shared)'}`);
    addMessage('system', '/model qwen — book the coder model (qwen) for this session; holds the GPU until you quit');
    addMessage('system', '/model gemma — release back to the shared model (gemma)');
    return;
  }

  if (t === 'qwen' || t === 'coder') {
    if (held) { addMessage('system', 'qwen is already booked for this session.'); return; }
    addMessage('system', 'Booking qwen — requesting the coder authority from the backend…');
    setAgentStatus('Switching to qwen…');
    const hold = await acquireLlm('interactive /model qwen (held for session)');
    setAgentStatus('');
    if (hold === 'busy') { addMessage('system', 'GPU is busy — another authority holds the model right now. Try /model qwen again shortly.'); return; }
    if (hold === 'no-resource-layer') { addMessage('system', 'Backend has no resource layer (or is unreachable) — cannot switch the model from here.'); return; }
    modelHold = hold;
    await new Promise((r) => setTimeout(r, 1500)); // let the backend load qwen before re-resolving
    await refreshActiveModel().catch(() => {});
    addMessage('system', `Booked ${activeModelId() || 'qwen-coder'} — held until you /quit (or /model gemma).`);
    return;
  }

  if (t === 'gemma' || t === 'chat' || t === 'release') {
    if (!held) { addMessage('system', 'Nothing booked — the shared model (gemma) is already served.'); return; }
    await releaseModelHold();
    await new Promise((r) => setTimeout(r, 1000));
    await refreshActiveModel().catch(() => {});
    addMessage('system', `Released — back to the shared model (${activeModelId() || 'gemma'}).`);
    return;
  }

  addMessage('system', `Unknown model "${arg.trim()}". Use: /model qwen  ·  /model gemma`);
}

// ── Input handler ───────────────────────────────────────────────────

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
      case '/model':
        await handleModelCommand(text.slice('/model'.length));
        return;
      case '/clear':
        clearChat();
        return;
      case '/summary':
        showSummaryOverlay();
        return;
      case '/resume': {
        if (busy) return;
        addMessage('system', `Loading sessions from ${SESSION_NAMESPACE}...`);
        try {
          const sessions = await listSessions();
          if (sessions.length === 0) {
            addMessage('system', 'No sessions found for this version.');
            return;
          }
          const arg = text.split(' ')[1]; // /resume <sessionId>
          let targetId: string;
          if (arg) {
            targetId = arg;
          } else {
            // List sessions and prompt user to pick
            sessions.forEach((s, i) => {
              const ts = new Date(s.updatedAt).toLocaleString();
              const title = s.title || '(no title)';
              addMessage('system', `[${i + 1}] ${s.sessionId.substring(0, 16)}  ${ts}  ${title}`);
            });
            addMessage('system', 'Use /resume <sessionId> to restore a session.');
            return;
          }
          const checkpoint = await loadSessionCheckpoint(targetId);
          if (!checkpoint) {
            addMessage('system', `Session ${targetId} has no checkpoint.`);
            return;
          }
          setSessionId(targetId);
          resetSummary();
          clearGoal(); // goal belongs to the session; re-seeds from the next message
          // Restore summary and recent into current session state
          const s = getSummary();
          s.summary = checkpoint.summary;
          s.recent = checkpoint.recent;
          addMessage('system', `Resumed session ${targetId.substring(0, 16)} (${checkpoint.artifacts.length} artifacts, synced ${new Date(checkpoint.syncedAt).toLocaleTimeString()})`);
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
        const keyMap: Record<string, string> = { 'openai-key': 'openAiKey', 'keli-url': 'keliUrl' };
        const configKey = keyMap[key] ?? key;
        setConfigValue(configKey, value);
        addMessage('system', `Set ${key} ✓`);
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
        addMessage('system', '/model qwen|gemma — book qwen-coder for this session (held until quit) or release to the shared model');
        addMessage('system', '/summary — show session summary (Esc to close)');
        addMessage('system', '/resume — list sessions for this version');
        addMessage('system', '/resume <sessionId> — restore a specific session');
        addMessage('system', '/clear — clear chat');
        addMessage('system', '/set keli-url <http://host:9100> — point ayin at the Maradel backend (gemma) on the LAN');
        addMessage('system', '/set openai-key <sk-...> — configure OpenAI API key');
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
  if (process.argv[2] === 'rag') {
    // Grounded Q&A corpus generator — no TUI. See src/rag.ts.
    const { runRag } = await import('./rag.js');
    await runRag(process.argv.slice(3));
    return;
  }
  loadRules(process.cwd());
  if (HEADLESS) {
    await runHeadless();
    return;
  }
  await runInteractive();
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

  // Coder authority (AYIN_ACQUIRE_LLM=1): take the llm resource so the backend swaps gemma → the
  // coder model (qwen) for this run. Sliding grant + unref'd keepalive → auto-released when the
  // process exits; we also release explicitly on normal completion so gemma reverts promptly.
  let llmHold: LlmHold = 'no-resource-layer';
  if (process.env.AYIN_ACQUIRE_LLM === '1') {
    llmHold = await acquireLlm('ayin -p (coder authority)');
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
  checkForUpdate().catch(() => {});

  try {
    await connect();
    log('INFO', 'connected');
    // Create session on Tiferet (non-blocking — failure is non-fatal)
    initSession().then(id => {
      addMessage('system', `Session: ${id.substring(0, 16)}  (${SESSION_NAMESPACE})`);
    }).catch(err => {
      log('WARN', 'tiferet_session_init_failed', { error: err instanceof Error ? err.message : String(err) });
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
