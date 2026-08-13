/**
 * GLYPH RULE — same as the status bar: BMP only, `Emoji_Presentation=false`. blessed reports width 1
 * for an emoji the terminal draws 2 cells wide, and a one-row box that overflows wraps, shifts every
 * row below it, and corrupts the redraw. `npm run check:glyphs` enforces it.
 *
 * AlertRow — the BOTTOM-most row of the screen: warnings and errors, and nothing else.
 *
 * Everything used to land in the chat log as a grey `system` message, which means a real error scrolled
 * away behind the next tool result at exactly the moment you needed it. This row does not scroll. It is
 * the one place that answers "is something wrong right now", and it is red so the answer is pre-attentive
 * — you see it before you read it.
 *
 * TWO LAYERS, because they answer different questions:
 *   - a STICKY notice ("this session is being transcribed") — a standing condition, shown whenever
 *     nothing more urgent is. It must not be lost to a transient blip, so it is stored separately.
 *   - a TRANSIENT alert (an LLM error, a blocked tool) — takes the row for its ttl, then falls back
 *     to the sticky notice. Newest wins; nothing queues, because a stale error is a lie.
 *
 * Hidden (height 0) when there is nothing to say — the row costs a terminal line, and a permanently
 * empty red bar teaches you to ignore red bars.
 */

import blessed from 'blessed';
import { HEADLESS, noopBox } from '../headless.js';
import { screen, render } from '../screen.js';
import { theme } from '../theme.js';
import { relayout } from '../layout.js';

export type AlertLevel = 'warn' | 'error';

export interface Alert {
  level: AlertLevel;
  text: string;
  /** auto-clear after this many ms (transient). Omit for a sticky notice. */
  ttlMs?: number;
}

/** ▲ (U+25B2) and ■ (U+25A0): BMP, no emoji presentation, width 1 everywhere. */
const MARK: Record<AlertLevel, string> = { warn: '▲', error: '■' };
const LABEL: Record<AlertLevel, string> = { warn: 'WARN', error: 'ERROR' };

export class AlertRow {
  readonly box: blessed.Widgets.BoxElement;
  private sticky: Alert | null = null;
  private transient: Alert | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.box = HEADLESS
      ? noopBox
      : blessed.box({
        parent: screen,
        bottom: 0, left: 0, right: 0, height: 0,
        tags: true,
        padding: { left: 1, right: 1 },
        style: { fg: theme.err, bg: theme.panelBg },
      });
  }

  getHeight(): number {
    return this.current() ? 1 : 0;
  }

  setBottom(row: number): void {
    if (HEADLESS) return;
    this.box.bottom = row;
    this.box.height = this.getHeight();
  }

  private current(): Alert | null {
    return this.transient ?? this.sticky;
  }

  /** A standing condition for this session (transcription on). Pass null to clear it. */
  setSticky(alert: Alert | null): void {
    this.sticky = alert;
    this.paint();
  }

  /** A one-off warning or error. Overrides the sticky notice for its ttl (default 8s). */
  show(alert: Alert): void {
    this.transient = alert;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.transient = null;
      this.timer = undefined;
      this.paint();
    }, alert.ttlMs ?? 8000);
    this.timer.unref?.();
    this.paint();
  }

  clearTransient(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.transient = null;
    this.paint();
  }

  private paint(): void {
    if (HEADLESS) return;
    const a = this.current();
    const wasVisible = this.box.height !== 0;
    if (!a) {
      this.box.setContent('');
      if (wasVisible) relayout(); // giving the row back to the chat is a geometry change
      render();
      return;
    }
    const color = a.level === 'error' ? theme.err : theme.warn;
    // One line, never wrapped: a wrapped alert row overflows its own height and shifts the redraw.
    const room = Math.max(20, (screen.width as number) - 14);
    const text = a.text.length > room ? `${a.text.slice(0, room - 1)}…` : a.text;
    this.box.setContent(`{${color}-fg}{bold}${MARK[a.level]} ${LABEL[a.level]}{/bold}  ${text}{/}`);
    if (!wasVisible) relayout();
    render();
  }
}
