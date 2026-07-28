/**
 * CmdHints — the slash-command hint panel that appears above the input while typing `/…`.
 * Owns the command registry. Height changes go through layout.relayout(), never by poking
 * other widgets.
 */

import blessed from 'blessed';
import { HEADLESS, noopBox } from '../headless.js';
import { screen } from '../screen.js';
import { theme } from '../theme.js';
import { relayout } from '../layout.js';

export interface SlashCommand {
  name: string;
  description: string;
}

const COMMANDS: SlashCommand[] = [
  { name: '/goal',    description: 'Set the session goal (shown in cursive above the chat) · /goal clear' },
  { name: '/plan',    description: 'Force plan mode: survey → third-party API research → explore → a written ayin-plan-*.md, then execute it' },
  { name: '/model',   description: 'Pick the served model (popup) · /model <name> to switch straight away' },
  { name: '/lock',    description: 'Hold the model for this session — ⚿ in the bar; frees itself if this client dies · /unlock' },
  { name: '/summary', description: 'Show session summary (Esc to close)' },
  { name: '/resume',  description: "This directory's past sessions — /resume <n> restores one · /resume all" },
  { name: '/clear',   description: 'Clear chat' },
  { name: '/help',    description: 'Show available commands' },
  { name: '/quit',    description: 'Exit' },
];

export function registerCommand(cmd: SlashCommand): void {
  if (!COMMANDS.find(c => c.name === cmd.name)) COMMANDS.push(cmd);
}

const MAX_ROWS = 6;

export class CmdHints {
  readonly box: blessed.Widgets.BoxElement;
  private visible = false;

  constructor() {
    this.box = HEADLESS
      ? noopBox
      : blessed.box({
        parent: screen,
        bottom: 4, left: 0, right: 0, height: 0,
        tags: true,
        padding: { left: 2, right: 1 },
        style: { fg: theme.subtle, bg: theme.panelBg },
      });
  }

  /** Show hints matching the typed prefix; hides itself when nothing matches. */
  update(input: string): void {
    if (HEADLESS) return;
    if (!input.startsWith('/')) { this.hide(); return; }

    const prefix = input.toLowerCase();
    const matching = COMMANDS.filter(c => c.name.startsWith(prefix));
    if (matching.length === 0) { this.hide(); return; }

    const lines = matching.map(c => `{${theme.accent}-fg}${c.name}{/}  {${theme.muted}-fg}${c.description}{/}`);
    this.box.height = Math.min(lines.length, MAX_ROWS);
    this.box.setContent(lines.join('\n'));
    this.visible = true;
    relayout();
  }

  hide(): void {
    if (HEADLESS || !this.visible) return;
    this.box.height = 0;
    this.box.setContent('');
    this.visible = false;
    relayout();
  }

  getHeight(): number {
    return this.visible ? Number(this.box.height ?? 0) : 0;
  }

  setBottom(row: number): void {
    this.box.bottom = row;
  }
}
