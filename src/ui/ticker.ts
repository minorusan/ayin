/**
 * Ticker — the one animation heartbeat for the whole TUI.
 *
 * Widgets subscribe for frames instead of owning their own setInterval, so all animations
 * stay phase-locked (no drifting spinners), there is exactly ONE re-render per beat no matter
 * how many things animate, and the interval runs ONLY while something is subscribed — an idle
 * TUI burns zero CPU on animation.
 *
 * Speeds are expressed as divisors of the base beat (80ms): a widget animating every 2nd
 * tick runs at 160ms, every 4th at 320ms, etc.
 */

export const TICK_MS = 80;

type TickListener = (tick: number) => void;

const listeners = new Set<TickListener>();
let timer: ReturnType<typeof setInterval> | null = null;
let tick = 0;

function beat(): void {
  tick++;
  for (const l of listeners) {
    try { l(tick); } catch { /* one bad animation must not stop the heartbeat */ }
  }
}

/** Subscribe to the heartbeat; returns an unsubscribe. Starts the clock on first subscriber. */
export function onTick(listener: TickListener): () => void {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(beat, TICK_MS);
    timer.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function currentTick(): number {
  return tick;
}
