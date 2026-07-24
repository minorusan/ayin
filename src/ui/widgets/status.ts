/**
 * StatusBar — the one-row bar at the very bottom: connection · tokens · update hint · cwd.
 */

import blessed from 'blessed';
import { HEADLESS, noopBox } from '../headless.js';
import { screen, render } from '../screen.js';
import { theme } from '../theme.js';

export interface StatusState {
  connection: 'connected' | 'disconnected' | 'connecting';
  tokens: { used: number; total: number } | null;
  cwd: string;
  update: string | null; // e.g. "v1.0.30 available"
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export class StatusBar {
  readonly box: blessed.Widgets.BoxElement;
  private state: StatusState = {
    connection: 'disconnected',
    tokens: null,
    cwd: process.cwd(),
    update: null,
  };

  constructor() {
    this.box = HEADLESS
      ? noopBox
      : blessed.box({
        parent: screen,
        bottom: 0, left: 0, right: 0, height: 1,
        tags: true,
        style: { fg: theme.statusFg, bg: theme.statusBg },
        padding: { left: 1, right: 1 },
      });
  }

  set(partial: Partial<StatusState>): void {
    if (HEADLESS) return;
    Object.assign(this.state, partial);
    this.redraw();
  }

  tokensDisplay(): string {
    if (!this.state.tokens) return 'tokens: unknown';
    const pct = Math.round((this.state.tokens.used / this.state.tokens.total) * 100);
    return `${formatTokens(this.state.tokens.used)} / ${formatTokens(this.state.tokens.total)} tokens (${pct}%)`;
  }

  getHeight(): number {
    return 1;
  }

  setBottom(row: number): void {
    this.box.bottom = row;
  }

  redraw(): void {
    if (HEADLESS) return;
    const parts: string[] = [];

    if (this.state.connection === 'connected') parts.push(`{${theme.ok}-fg}●{/} connected`);
    else if (this.state.connection === 'connecting') parts.push(`{${theme.warn}-fg}◐{/} connecting`);
    else parts.push(`{${theme.err}-fg}●{/} disconnected`);

    if (this.state.tokens) {
      const pct = Math.round((this.state.tokens.used / this.state.tokens.total) * 100);
      const color = pct > 80 ? theme.err : pct > 60 ? theme.warn : theme.ok;
      parts.push(`{${color}-fg}${formatTokens(this.state.tokens.used)}/${formatTokens(this.state.tokens.total)} tokens{/}`);
    }

    if (this.state.update) parts.push(`{${theme.warn}-fg}↑ ${this.state.update}{/}`);

    const cwdMax = Math.floor((screen.width as number) * 0.35);
    let cwd = this.state.cwd;
    if (cwd.length > cwdMax) cwd = '…' + cwd.slice(cwd.length - cwdMax + 1);

    this.box.setContent(`${parts.join(` {${theme.faint}-fg}│{/} `)}{|}${cwd}`);
    render();
  }
}
