#!/usr/bin/env node

/**
 * Ayin CLI v1 — Terminal Coding Agent
 */

// Redirect all console output to file — blessed owns the terminal.
import { log, captureConsole } from './log.js';
captureConsole();

import {
  screen, addMessage, setStatus, setAgentStatus, clearChat,
  onInput, onGlobalKey, focusInput, blurInput, chatBox, shutdown, getTokensDisplay,
} from './ui.js';
import { connect, disconnect, onConnectionChange, isConnected } from './connection.js';
import { getSummaryText, getSummary, resetSummary } from './summary.js';
import { estimateSessionTokens } from './tokens.js';
import { loadHistory, pushEntry } from './history.js';
import { runAgent, interruptAgent, enqueueAgentMessage } from './agent.js';
import { startPromptServer } from './prompt-server.js';
import { checkForUpdate } from './updater.js';
import { getSessionArtifacts, readArtifact } from './artifacts.js';
import { renderMarkdown } from './markdown.js';
import { HEADLESS } from './ui.js';
import { loadRules } from './rules.js';
import { setConfigValue, resetPromptsToDefaults } from './prompts.js';
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
    mouse: true,
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
    mouse: true,
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
}

// ── Connection ──────────────────────────────────────────────────────

onConnectionChange((state) => {
  setStatus({ connection: state });
  if (state === 'connected') {
    addMessage('system', 'Connected to Egregor');
    refreshTokens();
  } else {
    addMessage('system', 'Disconnected from Egregor');
  }
});

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
        await disconnect();
        shutdown();
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
      case '/reset':
        resetPromptsToDefaults();
        addMessage('system', 'Prompts restored to defaults ✓');
        return;
      case '/help':
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
    addMessage('system', 'Not connected. Waiting for Egregor...');
    return;
  }

  // Run agent loop
  busy = true;
  try {
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

  try {
    await runAgent(prompt);
  } catch (err) {
    process.stderr.write(`ayin: agent error — ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  await disconnect();
  process.exit(0);
}

async function runInteractive(): Promise<void> {
  loadHistory();
  setStatus({ connection: 'connecting', cwd: process.cwd() });
  addMessage('system', `ayin v${getVersion()}`);
  addMessage('system', process.cwd());

  startPromptServer();

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
