/**
 * UI — Full-screen TUI layout using blessed.
 *
 * Layout:
 *   ┌─────────────────────────────────┐
 *   │                                 │
 *   │  (empty space / old messages)   │  ← chatBox (scrollable)
 *   │                                 │
 *   │  newest message here            │
 *   │  ⠹ Thinking...                  │  ← agent status (animated)
 *   ├─────────────────────────────────┤
 *   │  /summary — session summary     │  ← cmdHints (shows when typing /)
 *   │  /clear — clear chat            │
 *   ├─────────────────────────────────┤
 *   │ > user types here               │  ← inputBox
 *   ├─────────────────────────────────┤
 *   │ ● connected │ 1.2k/8k tokens   │  ← statusBar
 *   └─────────────────────────────────┘
 */

import blessed from 'blessed';
import { renderMarkdown } from './markdown.js';
import { navigateUp, navigateDown, resetNavigation } from './history.js';

// ── Headless detection ──────────────────────────────────────────────
// Must happen before any blessed initialization.

export const HEADLESS = process.argv.some(a => a === '-p' || a === '--prompt' || a === '--non-interactive');
export const THINKING_MODE = process.argv.includes('--thinking');

// ── Commands registry ───────────────────────────────────────────────

export interface SlashCommand {
  name: string;
  description: string;
}

const COMMANDS: SlashCommand[] = [
  { name: '/summary', description: 'Show session summary (Esc to close)' },
  { name: '/resume',  description: 'Continue previous chat session' },
  { name: '/clear',   description: 'Clear chat' },
  { name: '/help',    description: 'Show available commands' },
  { name: '/quit',    description: 'Exit' },
];

export function registerCommand(cmd: SlashCommand): void {
  if (!COMMANDS.find(c => c.name === cmd.name)) COMMANDS.push(cmd);
}

// ── Screen ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopScreen: any = {
  key: () => {}, on: () => {}, render: () => {}, destroy: () => {},
  removeListener: () => {}, append: () => {}, remove: () => {},
  width: 80, height: 24,
  program: { showCursor: () => {}, hideCursor: () => {}, cup: () => {} },
};

export const screen: blessed.Widgets.Screen = HEADLESS
  ? noopScreen
  : blessed.screen({ smartCSR: true, title: 'ayin', fullUnicode: true });

// ── Chat area ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopBox: any = {
  height: 24, width: 80, bottom: 0,
  setContent: () => {}, setScrollPerc: () => {}, scroll: () => {},
  append: () => {}, remove: () => {}, destroy: () => {},
};

export const chatBox: blessed.Widgets.BoxElement = HEADLESS
  ? noopBox
  : blessed.box({
    parent: screen,
    top: 0, left: 0, right: 0, bottom: 4,
    scrollable: true, alwaysScroll: true,
    scrollbar: { style: { bg: 'grey' } },
    mouse: true, tags: true,
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    style: { fg: 'white', bg: 'default' },
  });

// ── Command hints (hidden by default, shows above input when typing /) ──

const cmdHintsBox: blessed.Widgets.BoxElement = HEADLESS
  ? noopBox
  : blessed.box({
    parent: screen,
    bottom: 4, left: 0, right: 0, height: 0,
    tags: true,
    padding: { left: 2, right: 1 },
    style: { fg: '#999', bg: '#111' },
  });

let cmdHintsVisible = false;

function showCmdHints(filter: string): void {
  const prefix = filter.toLowerCase();
  const matching = COMMANDS.filter(c => c.name.startsWith(prefix));

  if (matching.length === 0) {
    hideCmdHints();
    return;
  }

  const lines = matching.map(c =>
    `{#7B8CDE-fg}${c.name}{/}  {#666-fg}${c.description}{/}`
  );

  const height = Math.min(lines.length, 6);
  cmdHintsBox.height = height;
  cmdHintsBox.setContent(lines.join('\n'));

  const inputH = Number(inputWrapper.height ?? INPUT_MIN_HEIGHT);
  cmdHintsBox.bottom = 1 + inputH;
  chatBox.bottom = 1 + inputH + height;

  cmdHintsVisible = true;
  renderChat();
}

function hideCmdHints(): void {
  if (!cmdHintsVisible) return;
  cmdHintsBox.height = 0;
  cmdHintsBox.setContent('');
  const inputH = Number(inputWrapper.height ?? INPUT_MIN_HEIGHT);
  chatBox.bottom = 1 + inputH;
  cmdHintsVisible = false;
  renderChat();
}

// ── Input area ──────────────────────────────────────────────────────

const INPUT_MIN_HEIGHT = 3;  // border + 1 line + border
const INPUT_MAX_HEIGHT = 10; // cap growth

const inputWrapper: blessed.Widgets.BoxElement = HEADLESS
  ? noopBox
  : blessed.box({
    parent: screen,
    bottom: 1, left: 0, right: 0, height: INPUT_MIN_HEIGHT,
    border: { type: 'line' },
    style: { border: { fg: '#444' }, bg: 'default' },
  });

export const inputBox: blessed.Widgets.BoxElement = HEADLESS
  ? noopBox
  : blessed.box({
    parent: inputWrapper,
    top: 0, left: 1, right: 1, height: 1,
    style: { fg: 'white', bg: 'default' },
  });

if (!HEADLESS) {
  blessed.text({
    parent: inputWrapper,
    top: 0, left: 0, width: 1, height: 1,
    content: '>',
    style: { fg: '#7B8CDE', bg: 'default' },
  });
}

// ── Status bar ──────────────────────────────────────────────────────

export const statusBar: blessed.Widgets.BoxElement = HEADLESS
  ? noopBox
  : blessed.box({
    parent: screen,
    bottom: 0, left: 0, right: 0, height: 1,
    tags: true,
    style: { fg: '#888', bg: '#1a1a1a' },
    padding: { left: 1, right: 1 },
  });

// ── Messages ────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const messages: Message[] = [];
let agentStatus = '';
let agentSpinnerInterval: ReturnType<typeof setInterval> | null = null;
let agentSpinnerTick = 0;
let agentStartTime = 0;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function renderChat(): void {
  const chatHeight = Number(chatBox.height ?? 20) - 1;

  const contentLines: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      contentLines.push('');
      contentLines.push(`{bold}{#7B8CDE-fg} > ${msg.content}{/}`);
    } else if (msg.role === 'assistant') {
      contentLines.push('');
      const rendered = renderMarkdown(msg.content);
      for (const line of rendered.split('\n')) {
        contentLines.push(`   ${line}`);
      }
    } else if (msg.role === 'system') {
      contentLines.push(`{#555-fg}   ${msg.content}{/}`);
    }
  }

  if (agentStatus) {
    const frame = SPINNER_FRAMES[agentSpinnerTick % SPINNER_FRAMES.length];
    const elapsed = formatElapsed(Date.now() - agentStartTime);
    contentLines.push('');
    contentLines.push(`{#7B8CDE-fg} ${frame} ${agentStatus} {#555-fg}${elapsed}{/}`);
  }

  const padLines = Math.max(0, chatHeight - contentLines.length);
  const padded = Array(padLines).fill('').concat(contentLines);

  chatBox.setContent(padded.join('\n'));
  chatBox.setScrollPerc(100);
  screen.render();
}

export function addMessage(role: 'user' | 'assistant' | 'system', content: string): void {
  if (HEADLESS) {
    if (role === 'assistant') process.stdout.write(content + '\n');
    else if (role === 'system') process.stderr.write(`[${role}] ${content}\n`);
    return;
  }
  messages.push({ role, content });
  renderChat();
}

export function updateLastAssistant(content: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      messages[i].content = content;
      renderChat();
      return;
    }
  }
  addMessage('assistant', content);
}

function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

export function formatToolResultForChat(tool: string, content: string): string {
  if (tool !== 'write_file') return content;

  const lines = content.split('\n');
  const rendered: string[] = [];

  for (const line of lines) {
    const escaped = escapeBlessedTags(line);
    if (line.startsWith('File: ')) {
      rendered.push(`{bold}{#f4f7ff-fg}{#365b8c-bg} ${escaped} {/#365b8c-bg}{/}`);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }
    if (line.startsWith('@@')) {
      rendered.push(`{#dbe7ff-fg}{#2a3342-bg} ${escaped} {/#2a3342-bg}{/}`);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      rendered.push(`{#eafff1-fg}{#173d2d-bg} ${escaped} {/#173d2d-bg}{/}`);
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      rendered.push(`{#fff1f1-fg}{#4a1f24-bg} ${escaped} {/#4a1f24-bg}{/}`);
      continue;
    }
    if (line.startsWith(' ')) {
      rendered.push(`{#9aa7b7-fg}${escaped}{/}`);
      continue;
    }
    rendered.push(escaped);
  }

  return rendered.join('\n');
}

export function setAgentStatus(text: string): void {
  if (HEADLESS) return;
  agentStatus = text;

  if (text && !agentSpinnerInterval) {
    agentSpinnerTick = 0;
    agentStartTime = Date.now();
    agentSpinnerInterval = setInterval(() => {
      agentSpinnerTick++;
      renderChat();
    }, 80);
  } else if (!text && agentSpinnerInterval) {
    clearInterval(agentSpinnerInterval);
    agentSpinnerInterval = null;
  }

  renderChat();
}

export function clearChat(): void {
  messages.length = 0;
  agentStatus = '';
  renderChat();
}

// ── Status bar ──────────────────────────────────────────────────────

interface StatusState {
  connection: 'connected' | 'disconnected' | 'connecting';
  tokens: { used: number; total: number } | null;
  cwd: string;
  update: string | null; // e.g. "v1.0.30 available"
}

const status: StatusState = {
  connection: 'disconnected',
  tokens: null,
  cwd: process.cwd(),
  update: null,
};

export function setStatus(partial: Partial<StatusState>): void {
  if (HEADLESS) return;
  Object.assign(status, partial);
  renderStatus();
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function renderStatus(): void {
  const parts: string[] = [];

  if (status.connection === 'connected') {
    parts.push('{green-fg}●{/} connected');
  } else if (status.connection === 'connecting') {
    parts.push('{yellow-fg}◐{/} connecting');
  } else {
    parts.push('{red-fg}●{/} disconnected');
  }

  if (status.tokens) {
    const pct = Math.round((status.tokens.used / status.tokens.total) * 100);
    const color = pct > 80 ? 'red' : pct > 60 ? 'yellow' : 'green';
    parts.push(`{${color}-fg}${formatTokens(status.tokens.used)}/${formatTokens(status.tokens.total)} tokens{/}`);
  }

  if (status.update) {
    parts.push(`{yellow-fg}↑ ${status.update}{/}`);
  }

  const cwdMax = Math.floor((screen.width as number) * 0.35);
  let cwd = status.cwd;
  if (cwd.length > cwdMax) cwd = '…' + cwd.slice(cwd.length - cwdMax + 1);

  const left = parts.join(' {#444-fg}│{/} ');
  statusBar.setContent(`${left}{|}${cwd}`);
  screen.render();
}

// ── Token info for overlays ─────────────────────────────────────────

export function getTokensDisplay(): string {
  if (!status.tokens) return 'tokens: unknown';
  const pct = Math.round((status.tokens.used / status.tokens.total) * 100);
  return `${formatTokens(status.tokens.used)} / ${formatTokens(status.tokens.total)} tokens (${pct}%)`;
}

// ── Input handling ──────────────────────────────────────────────────

type InputHandler = (text: string) => void;
let _onInput: InputHandler = () => {};

type GlobalKeyHandler = (key: string) => void;
let _onGlobalKey: GlobalKeyHandler | null = null;

export function onGlobalKey(handler: GlobalKeyHandler): void {
  _onGlobalKey = handler;
}

export function onInput(handler: InputHandler): void {
  _onInput = handler;
}

let inputActive = false;
let inputBuffer = '';
let cursorPos = 0;

function getInputWidth(): number {
  return Math.max(1, Number(screen.width ?? 80) - 4); // -2 border -1 prompt -1 padding
}

function wrapInputLines(text: string, width: number): string[] {
  const logicalLines = text.split('\n');
  const wrapped: string[] = [];

  for (const line of logicalLines) {
    if (line.length === 0) {
      wrapped.push('');
      continue;
    }

    for (let i = 0; i < line.length; i += width) {
      wrapped.push(line.slice(i, i + width));
    }
  }

  return wrapped.length > 0 ? wrapped : [''];
}

function getCursorRenderPosition(text: string, cursor: number, width: number): { row: number; col: number } {
  let row = 0;
  let col = 0;

  for (let i = 0; i < cursor; i++) {
    const ch = text[i];
    if (ch === '\n') {
      row++;
      col = 0;
      continue;
    }

    col++;
    if (col >= width) {
      row++;
      col = 0;
    }
  }

  return { row, col };
}

function renderInput(): void {
  const width = getInputWidth();
  const wrappedLines = wrapInputLines(inputBuffer, width);
  const { row: cursorRow, col: cursorCol } = getCursorRenderPosition(inputBuffer, cursorPos, width);
  const lineCount = Math.max(wrappedLines.length, cursorRow + 1);
  const wantedHeight = Math.min(INPUT_MAX_HEIGHT, lineCount + 2); // +2 for borders
  const currentHeight = Number(inputWrapper.height ?? INPUT_MIN_HEIGHT);

  if (wantedHeight !== currentHeight) {
    inputWrapper.height = wantedHeight;
    inputBox.height = wantedHeight - 2;
    // Adjust chat and hints above
    const hintsH = cmdHintsVisible ? Number(cmdHintsBox.height ?? 0) : 0;
    chatBox.bottom = 1 + wantedHeight + hintsH;
    cmdHintsBox.bottom = 1 + wantedHeight;
    renderChat(); // re-pad messages for new chat height
  }

  const visibleLines = Math.max(1, wantedHeight - 2);
  const startLine = Math.max(0, cursorRow - visibleLines + 1);
  inputBox.setContent(wrappedLines.slice(startLine, startLine + visibleLines).join('\n'));

  if (inputActive) {
    const row = Number(inputWrapper.atop ?? 0) + 1 + (cursorRow - startLine);
    const col = Number(inputWrapper.aleft ?? 0) + 2 + cursorCol;
    screen.program.cup(row, col);
    screen.program.showCursor();
  }
  screen.render();
}

export function focusInput(): void {
  if (HEADLESS) return;
  inputActive = true;
  screen.program.showCursor();
  renderInput();
}

export function blurInput(): void {
  if (HEADLESS) return;
  inputActive = false;
  screen.program.hideCursor();
  screen.render();
}

function onInputChanged(): void {
  // Show/hide command hints based on input
  if (inputBuffer.startsWith('/') && inputBuffer.length >= 1) {
    showCmdHints(inputBuffer);
  } else {
    hideCmdHints();
  }
}

if (!HEADLESS) screen.on('keypress', (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => {
  // Global keys work even when input is not active (agent is busy)
  if (key.full === 'C-o' || key.full === 'C-s' || key.full === 'escape') {
    if (_onGlobalKey) _onGlobalKey(key.full);
    if (!inputActive) return;
  }
  if (key.full === 'C-c') { shutdown(); return; }

  if (!inputActive) return;

  if (key.full === 'return' || key.full === 'enter') {
    const text = inputBuffer.trim();
    if (text) {
      inputBuffer = '';
      cursorPos = 0;
      resetNavigation();
      hideCmdHints();
      renderInput();
      _onInput(text);
    }
    return;
  }

  if (key.full === 'backspace') {
    if (cursorPos > 0) {
      inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
      cursorPos--;
      renderInput();
      onInputChanged();
    }
    return;
  }

  if (key.full === 'delete') {
    if (cursorPos < inputBuffer.length) {
      inputBuffer = inputBuffer.slice(0, cursorPos) + inputBuffer.slice(cursorPos + 1);
      renderInput();
      onInputChanged();
    }
    return;
  }

  if (key.full === 'up') {
    const entry = navigateUp(inputBuffer);
    if (entry !== null) {
      inputBuffer = entry;
      cursorPos = inputBuffer.length;
      renderInput();
      onInputChanged();
    }
    return;
  }
  if (key.full === 'down') {
    const entry = navigateDown();
    if (entry !== null) {
      inputBuffer = entry;
      cursorPos = inputBuffer.length;
      renderInput();
      onInputChanged();
    }
    return;
  }

  if (key.full === 'left') { if (cursorPos > 0) { cursorPos--; renderInput(); } return; }
  if (key.full === 'right') { if (cursorPos < inputBuffer.length) { cursorPos++; renderInput(); } return; }
  if (key.full === 'home' || key.full === 'C-a') { cursorPos = 0; renderInput(); return; }
  if (key.full === 'end' || key.full === 'C-e') { cursorPos = inputBuffer.length; renderInput(); return; }
  if (key.full === 'C-u') { inputBuffer = ''; cursorPos = 0; hideCmdHints(); renderInput(); return; }

  if (key.full === 'pageup') {
    chatBox.scroll(-Math.floor((chatBox.height as number) / 2));
    screen.render();
    return;
  }
  if (key.full === 'pagedown') {
    chatBox.scroll(Math.floor((chatBox.height as number) / 2));
    screen.render();
    return;
  }

  if (ch && !key.ctrl && !key.meta) {
    inputBuffer = inputBuffer.slice(0, cursorPos) + ch + inputBuffer.slice(cursorPos);
    cursorPos++;
    renderInput();
    onInputChanged();
  }
});  // end if (!HEADLESS) keypress

if (!HEADLESS) {
  // Re-render on resize
  screen.on('resize', () => {
    renderChat();
    renderStatus();
    renderInput();
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────

export function shutdown(): void {
  if (HEADLESS) { process.exit(0); return; }
  if (agentSpinnerInterval) clearInterval(agentSpinnerInterval);
  screen.destroy();
  process.exit(0);
}

// Initial render
if (!HEADLESS) renderStatus();
