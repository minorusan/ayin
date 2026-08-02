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

import { HEADLESS, THINKING_MODE } from './headless.js';
import { screen, render } from './screen.js';
import { registerStack, relayout } from './layout.js';
import { installKeyRouter, type GlobalKeyHandler } from './keys.js';
import { ChatLog, formatToolResultForChat, formatToolCallForChat, formatGateCardForChat, escapeBlessedTags, toItalic, type MessageRole } from './widgets/chat.js';
import { InputBar } from './widgets/input.js';
import { CmdHints, registerCommand, type SlashCommand } from './widgets/hints.js';
import { StatusBar, type StatusState } from './widgets/status.js';
import { AlertRow, type Alert, type AlertLevel } from './widgets/alert.js';
import type { AgentState } from './widgets/thinking.js';

export { HEADLESS, THINKING_MODE, screen, registerCommand, formatToolResultForChat, formatToolCallForChat, formatGateCardForChat, escapeBlessedTags, toItalic };
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
input.handlers({ onChange: (text) => hints.update(text) });

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

export function addMessage(role: MessageRole, content: string): void {
  chat.add(role, content);
}

export function updateLastAssistant(content: string): void {
  chat.updateLastAssistant(content);
}

export function clearChat(): void {
  chat.clear();
}

export function setAgentStatus(text: string): void {
  chat.setAgentStatus(text);
}

/** Explicit stateful variant — pick the animation state directly. */
export function setAgentState(state: AgentState, label?: string): void {
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
