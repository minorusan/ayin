/**
 * ThinkingIndicator — the animated agent-status line shown under the newest chat message.
 *
 * A small state machine: each AgentState owns its animation (frames, speed, color) so new
 * states are one entry in STATE_SPECS, not new plumbing. The indicator renders to a tagged
 * string; the chat widget appends it while rendering and subscribes to ticks for animation.
 *
 * Anatomy of the line:
 *   ▍ ⠹ Thinking··   12s
 *   │ │  │       │    └ elapsed, dim
 *   │ │  │       └ animated ellipsis (breathes 0→3 dots)
 *   │ │  └ label, pulsing between state color and bright
 *   │ └ spinner frames of the current state
 *   └ state-colored gutter bar
 */

import { theme } from '../theme.js';
import { onTick } from '../ticker.js';

export type AgentState = 'idle' | 'thinking' | 'tool' | 'explaining' | 'summarizing';

interface StateSpec {
  frames: string[];
  color: string;       // state color (gutter + spinner)
  pulse?: string;      // label pulses color ↔ pulse (defaults to no pulse)
  every: number;       // base ticks (80ms, see ui/ticker.ts) per frame
  dots: boolean;       // animated ellipsis after the label
}

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const STATE_SPECS: Record<Exclude<AgentState, 'idle'>, StateSpec> = {
  thinking:    { frames: BRAILLE, color: theme.thinking, pulse: theme.accentBright, every: 1, dots: true },
  tool:        { frames: ['◢', '◣', '◤', '◥'], color: theme.tool, every: 2, dots: false },
  explaining:  { frames: BRAILLE, color: theme.explaining, pulse: theme.accentBright, every: 1, dots: true },
  summarizing: { frames: ['◐', '◓', '◑', '◒'], color: theme.summarizing, every: 2, dots: true },
};

/** Compat inference so plain setAgentStatus(text) picks a sensible state from its phrasing. */
export function inferState(text: string): Exclude<AgentState, 'idle'> {
  if (/^running /i.test(text)) return 'tool';
  if (/^explaining/i.test(text)) return 'explaining';
  if (/^summariz/i.test(text)) return 'summarizing';
  return 'thinking';
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export class ThinkingIndicator {
  private state: AgentState = 'idle';
  private label = '';
  private tick = 0;
  private startTime = 0;
  private unTick: (() => void) | null = null; // shared ticker subscription (ui/ticker.ts)
  private notify: () => void;

  constructor(onChange: () => void) {
    this.notify = onChange;
  }

  /** Explicit state + label. Same state keeps the clock; a new state restarts it. */
  set(state: AgentState, label?: string): void {
    if (state === 'idle') {
      this.stop();
      return;
    }
    const restart = state !== this.state;
    this.state = state;
    // The ellipsis is ours to animate — drop a static one at the end OR before a trailing
    // parenthetical ("Thinking... (round 2)" → "Thinking (round 2)").
    this.label = (label ?? this.label).replace(/\.{2,}(\s*\([^)]*\))?\s*$/, '$1');
    if (restart) {
      this.tick = 0;
      this.startTime = Date.now();
      if (!this.unTick) {
        this.unTick = onTick(() => {
          this.tick++;
          this.notify();
        });
      }
    }
    this.notify();
  }

  /** Compat shim for setAgentStatus(text): '' clears, otherwise state is inferred. */
  setFromText(text: string): void {
    if (!text) { this.stop(); return; }
    this.set(inferState(text), text);
  }

  stop(): void {
    this.state = 'idle';
    this.label = '';
    if (this.unTick) { this.unTick(); this.unTick = null; }
    this.notify();
  }

  active(): boolean {
    return this.state !== 'idle';
  }

  /** The rendered line (blessed tags), or null when idle. */
  line(): string | null {
    if (this.state === 'idle') return null;
    const spec = STATE_SPECS[this.state];
    const frame = spec.frames[Math.floor(this.tick / spec.every) % spec.frames.length];
    // label pulse: a slow breathe between the state color and its bright variant (480ms)
    const labelColor = spec.pulse && Math.floor(this.tick / 6) % 2 === 1 ? spec.pulse : spec.color;
    // ellipsis breathes 0→3 dots (320ms per step)
    const dots = spec.dots ? '·'.repeat(Math.floor(this.tick / 4) % 4) : '';
    const elapsed = formatElapsed(Date.now() - this.startTime);
    return `{${spec.color}-fg}▍ ${frame}{/} {${labelColor}-fg}${this.label}{/}{${theme.dim}-fg}${dots}   ${elapsed}{/}`;
  }

  destroy(): void {
    if (this.unTick) { this.unTick(); this.unTick = null; }
  }
}
