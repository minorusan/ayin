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
import { slashEntries } from '../../help.js';

export interface SlashCommand {
  name: string;
  description: string;
}

// Derived from src/help.ts, never hand-maintained here. This array WAS a second list, and it
// drifted: `/diff` shipped with no hint entry at all. One source, three consumers.
const COMMANDS: SlashCommand[] = slashEntries().map(e => ({ name: e.name, description: e.short }));

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

  /**
   * The commands this input would show — the ONE definition of "matching", shared with Tab completion.
   *
   * Tab must complete to what the panel says is first, and a second filter written beside the first is
   * how those two drift apart. Only while the input is still one word: once a space has been typed the
   * operator is writing an argument, and completing then would rewrite the command out from under them.
   */
  matches(input: string): SlashCommand[] {
    if (!input.startsWith('/') || /\s/.test(input)) return [];
    const prefix = input.toLowerCase();
    return COMMANDS.filter(c => c.name.startsWith(prefix));
  }

  /** What Tab completes to: the first row of the panel, or null when there is nothing to complete. */
  firstMatch(input: string): string | null {
    const [first] = this.matches(input);
    // Completing a name to itself is not a completion — it must not clear the panel or move the cursor.
    return first && first.name !== input ? first.name : null;
  }

  /** Show hints matching the typed prefix; hides itself when nothing matches. */
  update(input: string): void {
    if (HEADLESS) return;
    if (!input.startsWith('/')) { this.hide(); return; }

    const matching = this.matches(input);
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
