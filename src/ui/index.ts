/**
 * UI assembly + public façade.
 *
 * Layout (bottom-up stack, managed by layout.ts):
 *   ┌─────────────────────────────────┐
 *   │  (empty space / old messages)   │  ← ChatLog (scrollable)
 *   │  newest message here            │
 *   │  ▍⠹ Thinking··  12s             │  ← ThinkingIndicator (stateful animation)
 *   ├─────────────────────────────────┤
 *   │  /summary — session summary     │  ← CmdHints (shows when typing /)
 *   ├─────────────────────────────────┤
 *   │ > user types here               │  ← InputBar (grows 3..10 rows)
 *   ├─────────────────────────────────┤
 *   │ ● connected │ 1.2k/8k tokens    │  ← StatusBar
 *   └─────────────────────────────────┘
 *
 * The exported function API is unchanged from the old single-file ui.ts, so every existing
 * caller keeps working; new code may use the widget instances (chat, input, …) directly.
 */

import { livePhase } from '../live-mirror.js';
import { HEADLESS, THINKING_MODE } from './headless.js';
import { screen, render } from './screen.js';
import { registerStack, relayout } from './layout.js';
import { installKeyRouter, type GlobalKeyHandler } from './keys.js';
import { ChatLog, formatToolResultForChat, formatToolCallForChat, formatGateCardForChat, formatShellForChat, escapeBlessedTags, stripBlessedTags, toItalic, type MessageRole } from './widgets/chat.js';
import { InputBar } from './widgets/input.js';
import { CmdHints, registerCommand, type SlashCommand } from './widgets/hints.js';
import { StatusBar, type StatusState } from './widgets/status.js';
import { AlertRow, type Alert, type AlertLevel } from './widgets/alert.js';
import type { AgentState } from './widgets/thinking.js';
import { noteAgentState } from '../agent-activity.js';

export { HEADLESS, THINKING_MODE, screen, registerCommand, formatToolResultForChat, formatToolCallForChat, formatGateCardForChat, formatShellForChat, escapeBlessedTags, stripBlessedTags, toItalic };
export type { SlashCommand, StatusState, AgentState, MessageRole, Alert, AlertLevel };

// ── construct widgets (order matters only for z-stacking of overlays) ─

export const chat = new ChatLog();
export const hints = new CmdHints();
export const input = new InputBar();
export const status = new StatusBar();
export const alert = new AlertRow();

// Bottom-up stack: the ALERT row owns the very bottom line (0 rows when there is nothing wrong),
// then the status bar, then input, then hints; chat gets the rest.
registerStack(
  [
    { getHeight: () => alert.getHeight(), setBottom: (r) => alert.setBottom(r) },
    { getHeight: () => status.getHeight(), setBottom: (r) => status.setBottom(r) },
    { getHeight: () => input.getHeight(), setBottom: (r) => input.setBottom(r) },
    { getHeight: () => hints.getHeight(), setBottom: (r) => hints.setBottom(r) },
  ],
  { setBottom: (r) => chat.setBottom(r), redraw: () => chat.redraw() },
);
relayout();

// input ↔ hints wiring: hints follow whatever is being typed
input.handlers({
  onChange: (text) => hints.update(text),
  // Tab completes to the panel's first row — one definition of "matching", in the panel that shows it.
  onComplete: (text) => hints.firstMatch(text),
});

// ── legacy-compatible function API ────────────────────────────────────

export const chatBox = chat.box;
export const inputBox = input.box;
export const statusBar = status.box;

let _onGlobalKey: GlobalKeyHandler | null = null;

export function onGlobalKey(handler: GlobalKeyHandler): void {
  _onGlobalKey = handler;
}

export function onInput(handler: (text: string) => void): void {
  input.handlers({ onSubmit: handler });
}

/**
 * The last thing the agent SAID, kept because something outside the terminal has to be able to show it.
 * A diff-page comment thread reports the reply next to the line it was written on, and the chat widget
 * renders messages without keeping any addressable copy of them.
 *
 * Streaming lands as one `addMessage` plus many `updateLastAssistant` calls, so both write here.
 */
let _lastAssistant = '';

export function lastAssistantMessage(): string {
  return _lastAssistant;
}

export function addMessage(role: MessageRole, content: string, opts?: { interim?: boolean }): void {
  // `_lastAssistant` is what something OUTSIDE the terminal shows as the reply (a diff-page comment
  // thread). A mid-turn note is not the reply, so it must not overwrite it — otherwise the page reports
  // "let me check the mapper first" as the answer to the comment it asked about.
  if (role === 'assistant' && !opts?.interim) _lastAssistant = content;
  chat.add(role, content, opts?.interim === true);
}

/**
 * TOKEN COST ON EVERY MESSAGE, wired from the LLM manager's usage hook (see `TurnUsage`).
 *
 * The UI is the subscriber, not the source: nothing under `llm/` may import this module, and the manager
 * is the only place that sees every provider's reply. Both numbers are the server's own counts — Ollama's
 * `prompt_eval_count`/`eval_count`, OpenAI's `usage` — never an estimate made here.
 */
export function noteCallCost(usage: { in: number; out: number; growth: number | null; main: boolean }): void {
  // A sub-call (a connector loop, the critic, a QA pass) prints nothing, so a label for it would land on
  // whatever message came next and misprice it. Its numbers are in the log.
  if (!usage.main) return;
  // A tool result is priced by the NEXT call's prompt, so this lands one round late — which is the
  // earliest it can be known without shipping a tokenizer or spending a call to count.
  if (usage.growth !== null) chat.setLastToolCost(`+${tok(usage.growth)} tok into the prompt`);
  if (usage.in > 0 || usage.out > 0) chat.noteCost(`${tok(usage.in)} in · ${tok(usage.out)} out`);
}

/** 12 · 1.2k · 42k — a price is read at a glance, and four digits of it are noise. */
function tok(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

export function updateLastAssistant(content: string): void {
  _lastAssistant = content;
  chat.updateLastAssistant(content);
}

export function clearChat(): void {
  chat.clear();
}

export function setAgentStatus(text: string): void {
  chat.setAgentStatus(text);
  // Mirrored where a reader on another machine can see it. The terminal shows this text; a wedged
  // terminal shows it forever, and nothing outside the process knows how long it has been there.
  livePhase(text);
}

/** Explicit stateful variant — pick the animation state directly. */
export function setAgentState(state: AgentState, label?: string): void {
  // Recorded BEFORE the widget, so a headless run — which has no widget — still reports what it is
  // doing to anything that asks. This is the single funnel every caller goes through.
  noteAgentState(state, label ?? '');
  chat.setAgentState(state, label);
}

export function setStatus(partial: Partial<StatusState>): void {
  status.set(partial);
}

/**
 * The bottom alert row. `showAlert` is a transient warning/error (auto-clears); `setStickyAlert` is a
 * standing condition for the session (transcription on) that reappears when transients expire.
 * Headless is a no-op — there is no row to paint, and these already go to the log.
 */
export function showAlert(level: AlertLevel, text: string, ttlMs?: number): void {
  alert.show({ level, text, ...(ttlMs !== undefined ? { ttlMs } : {}) });
}

export function setStickyAlert(level: AlertLevel, text: string): void {
  alert.setSticky({ level, text });
}

export function clearStickyAlert(): void {
  alert.setSticky(null);
}

export function getTokensDisplay(): string {
  return status.tokensDisplay();
}

/**
 * Clear whatever is typed. Returns false when there was nothing to clear, so a caller can tell a
 * clear from a no-op without reaching into the widget.
 */
export function clearInput(): boolean {
  return input.clearIfAny();
}

export function focusInput(): void {
  input.focus();
}

export function blurInput(): void {
  input.blur();
}

export function shutdown(): void {
  if (HEADLESS) { process.exit(0); return; }
  chat.destroy();
  screen.destroy();
  process.exit(0);
}

// ── global listeners ──────────────────────────────────────────────────

installKeyRouter({
  chat,
  input,
  getGlobalHandler: () => _onGlobalKey,
  shutdown,
});

if (!HEADLESS) {
  screen.on('resize', () => {
    chat.redraw();
    status.redraw();
    input.redraw();
  });
  status.redraw();
  render();
}
