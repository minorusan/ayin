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
import { connect, disconnect, onConnectionChange, isConnected, currentRequestId } from './connection.js';
import { refreshActiveModel } from './llm/manager.js';
import { getSummaryText, getSummary, resetSummary } from './summary.js';
import { estimateSessionTokens } from './tokens.js';
import { loadHistory, pushEntry } from './history.js';
import { runAgent, interruptAgent, enqueueAgentMessage, restoreConversation } from './agent.js';
import { startPromptServer } from './prompt-server.js';
import { acquireLlm, type LlmHold } from './resource-client.js';
import { handleModelCommand, releaseModelHold, isModelBooked, lockSession, unlockSession, isSessionLocked } from './model-picker.js';
import { showDialog } from './dialog.js';
import { startLlmStatusPoll, findOwnPlace } from './llm-status.js';
import { startUpdateWatch, checkForUpdate } from './updater.js';
import {
  createRequest, acknowledgeRejections, readRejection, listRequests,
  snapshot as fixSnapshot, startFixSupervisor, repoPath as ayinRepoPath,
} from './fix.js';
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
  resolveSessionId,
  type CliSessionMeta,
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
// `/model` opens the picker popup; `/model <name>` switches straight away. Booking the GPU (the
// `ayin` authority on the backend llm resource) and the swap wait live in model-picker.ts. The hold
// is released on /quit and on SIGINT/SIGTERM; a hard kill lets the backend grant TTL-expire (the
// keepalive is unref'd, so it stops on exit).

// ── /fix — ayin fixing itself via headless Claude ─────────────────────
// The queue, the detached agent and the boot recovery live in fix.ts; this is only the command
// surface and the status-bar plumbing.

function refreshFixStatus(): void {
  const s = fixSnapshot();
  setStatus({ fix: { running: !!s.running, queued: s.queued, rejected: s.rejected.length } });
}

async function handleFixCommand(arg: string): Promise<void> {
  const t = arg.trim();
  const s = fixSnapshot();

  // `/fix` — the board: what's running, what's waiting, what was refused.
  if (!t) {
    const repo = ayinRepoPath();
    addMessage('system', repo ? `Fix repo: ${repo}` : 'No ayin source checkout found — /fix needs one (set AYIN_REPO).');
    if (s.running) addMessage('system', `Running: ${s.running.id} — ${s.running.prompt}`);
    if (s.queued) addMessage('system', `Queued: ${s.queued}`);
    for (const id of s.rejected) {
      const body = readRejection(id) ?? '';
      const why = body.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---')) ?? '(see the file)';
      addMessage('system', `REJECTED ${id}: ${why.slice(0, 160)}`);
    }
    if (!s.running && !s.queued && !s.rejected.length) {
      const recent = listRequests(3);
      if (recent.length) for (const r of recent) addMessage('system', `${r.status.padEnd(8)} ${r.id}  ${r.prompt.slice(0, 80)}`);
      else addMessage('system', 'No fixes yet. Usage: /fix <what should change about ayin>');
    }
    addMessage('system', '/fix <prompt> — request a change · /fix show <id> — read a rejection · /fix clear — acknowledge rejections');
    return;
  }

  if (t === 'clear' || t === 'ack') {
    const n = acknowledgeRejections();
    addMessage('system', n ? `Acknowledged ${n} rejection(s) — moved to fixes/archive/.` : 'No rejections to clear.');
    refreshFixStatus();
    return;
  }

  if (t.startsWith('show')) {
    const id = t.slice(4).trim() || s.rejected[s.rejected.length - 1];
    const body = id ? readRejection(id) : null;
    addMessage('system', body ? `── rejection ${id} ──\n${body}` : `No rejection found${id ? ` for ${id}` : ''}.`);
    return;
  }

  // Anything else is the request itself.
  const res = createRequest(t);
  if ('error' in res) { addMessage('system', `/fix: ${res.error}`); return; }
  addMessage('system', `Fix ${res.id} queued — headless Claude will implement it, then commit + publish (or write a rejection).`);
  addMessage('system', 'It runs detached: closing ayin does not stop it, and an interrupted run is requeued on the next start.');
  refreshFixStatus();
}

// ── Live model + GPU in the status bar ────────────────────────────────
// One poll of the llm resource's read ops feeds both segments. It survives backend restarts on its
// own (every failure just clears the segments and the next tick retries), and the interval is
// unref'd so it never keeps the process alive.
// Launching ayin through the machine's launcher BOOKS the coder model, which evicts the shared one
// — so a swap is usually already in flight before the TUI even paints, and the first reply pays for
// it. Say so once, when it starts and when it lands: being told "qwen" while gemma is still the
// resident model (or nothing is) is the single most confusing state in the whole UI.
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
        addMessage('system', 'Launching ayin books the coder model. /model to see the queue and pick another; the shared model needs no load.');
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
      case '/model':
        await handleModelCommand(text.slice('/model'.length));
        return;
      case '/lock': {
        // Hold the model for this session: short TTL + fast keepalive, so it self-releases if this
        // client dies rather than stranding the GPU. See model-picker.ts#lockSession.
        if (isSessionLocked()) { addMessage('system', 'Already locked. /unlock releases it.'); return; }
        const err = await lockSession();
        if (err) { addMessage('system', `/lock failed: ${err}`); return; }
        addMessage('system', 'Locked ⚿ — this session holds the model until you /quit, /unlock, or stop responding for 10 minutes.');
        return;
      }
      case '/unlock':
        if (!isSessionLocked()) { addMessage('system', 'Not locked.'); return; }
        await unlockSession();
        addMessage('system', 'Unlocked — the backend may reclaim the model.');
        return;
      case '/fix':
        await handleFixCommand(text.slice('/fix'.length));
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
        const keyMap: Record<string, string> = { 'openai-key': 'openAiKey', 'keli-url': 'keliUrl', 'update-registry': 'updateRegistry' };
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
        addMessage('system', '/model — popup: pick from the models the backend has installed (Enter reloads the GPU with it)');
        addMessage('system', '/model <name|qwen|gemma> — switch straight away; a non-shared model stays booked until you /quit');
        addMessage('system', '/fix <prompt> — headless Claude changes ayin itself, then commits + publishes (or writes a rejection)');
        addMessage('system', '/fix · /fix show <id> · /fix clear — the fix board, read a rejection, acknowledge rejections');
        addMessage('system', '/lock — hold the model for this session (self-releases 10 min after you stop responding) · /unlock');
        addMessage('system', '/summary — show session summary (Esc to close)');
        addMessage('system', '/resume — list this directory\'s sessions (newest first) · /resume all for every directory');
        addMessage('system', '/resume <n>|<id> — restore one by list number or id prefix; new turns append to its record');
        addMessage('system', '/clear — clear chat');
        addMessage('system', '/set keli-url <http://host:9100> — point ayin at the Maradel backend (gemma) on the LAN');
        addMessage('system', '/set update-registry <http://host:4873> — where `ayin update` looks (public npm is refused: "ayin" there is someone else)');
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
  if (process.argv[2] === 'update') {
    // Self-update from the configured npm registry (the nuk's private Verdaccio on this LAN).
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

  // Establish a session id so the per-run record (session-record.ts) has a key to write under.
  // Headless runs (ayin -p, the watch daemon) need this exactly like the interactive REPL does.
  await initSession().catch(() => {});

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

  // Always-on model + GPU segments (polled from the llm resource's read ops).
  startModelStatusPoll();

  // AUTO-LOCK. An interactive session is a human waiting at a keyboard, so it takes the priority
  // band by default instead of sitting in LOW behind every habit — the failure mode that produced
  // "GPU: chatOnce 306s · 1 waiting" and then a 10-minute client abort reported as `fetch failed`.
  // It also pins the model, which stops the gemma↔qwen flapping mid-session that another consumer's
  // ownership change would otherwise cause. Self-releasing (10-min TTL + 2-min keepalive), released
  // on /quit, and opt-out with AYIN_AUTOLOCK=0 for a session that should yield to background work.
  if (process.env.AYIN_AUTOLOCK !== '0') {
    void lockSession().then((err) => {
      if (err) addMessage('system', `Could not take the priority lock: ${err} — /lock to retry.`);
      else addMessage('system', 'Locked ⚿ — priority band + model pinned for this session (/unlock to yield).');
    });
  }

  // /fix supervisor: recovers anything that was in flight when we last died, drains the queue, and
  // keeps the fix/rejection segments current. Notes land in the chat as they happen.
  // A finished fix may have published a new version — re-check immediately rather than waiting
  // out the 10-minute update poll.
  startFixSupervisor((note) => { addMessage('system', note); refreshFixStatus(); void checkForUpdate(); });
  setInterval(refreshFixStatus, 10_000).unref?.();
  refreshFixStatus();
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
