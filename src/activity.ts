/**
 * What ayin is doing right now — one named activity, on every surface that shows waiting.
 *
 * THE BUG THIS EXISTS FOR. The gates narrated themselves with `setAgentStatus('QA pass 1/3 —
 * reviewing…')` and it worked for about two seconds. Every LLM call goes through
 * `narrateWait('thinking', …)`, which repaints the thinking line every 2s with its own composed
 * text — so the gate's label flashed once and was overwritten, and a QA pass or a plan-mode research
 * step (the two slowest things ayin does, minutes each on a queued GPU) looked exactly like an
 * ordinary "thinking". The user could not tell a normal turn from a three-pass review, which is the
 * one moment they most need to know, because it is the one moment ayin is spending their GPU on
 * something they did not directly ask for.
 *
 * So the activity is state, not a message: a stack (phases nest — a QA pass contains an LLM call) that
 * the wait narrator READS instead of overwriting, and that also lights a chip in the status bar so the
 * indication survives the gaps between LLM calls, when nothing is narrating at all.
 *
 * Stack, not a single value, because the pops must not fight: an inner phase ending restores the
 * outer one rather than clearing the line. Everything is best-effort and non-throwing — an indicator
 * must never be able to break the work it describes.
 */

import { setAgentState, setStatus } from './ui.js';

export interface Activity {
  /** Short, stable, and worth a glance: `PLAN`, `QA 1/3`. */
  label: string;
  /** What that phase is doing right now: `researching the Stripe API`. */
  detail?: string;
}

const stack: Activity[] = [];

/** The innermost active phase, or null when ayin is doing ordinary work. */
export function currentActivity(): Activity | null {
  return stack.length ? stack[stack.length - 1] : null;
}

/** One line for the thinking indicator: `QA 1/3 · reviewing 4 artifacts`. */
export function activityText(): string | null {
  const a = currentActivity();
  if (!a) return null;
  return a.detail ? `${a.label} · ${a.detail}` : a.label;
}

function paint(): void {
  const a = currentActivity();
  try {
    setStatus({ gate: a ? { label: a.label, detail: a.detail } : null });
    // Paint the thinking line too, so the label is right in the gaps where no LLM call is running
    // and nothing else is narrating (the probe phase, the git snapshot, writing the plan file).
    const text = activityText();
    if (text) setAgentState('thinking', text);
  } catch { /* the indicator is a nicety — never let it break the phase it describes */ }
}

/**
 * Enter a named phase. Returns the exit function — call it in a `finally`, always, or the status bar
 * keeps claiming ayin is mid-QA long after the turn ended.
 *
 * Exiting is idempotent and order-independent: a stale exit removes its own entry wherever it sits in
 * the stack rather than popping whatever happens to be on top.
 */
export function pushActivity(label: string, detail?: string): () => void {
  const entry: Activity = { label, detail };
  stack.push(entry);
  paint();
  let exited = false;
  return () => {
    if (exited) return;
    exited = true;
    const i = stack.lastIndexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    paint();
  };
}

/** Update the innermost phase's detail in place — same phase, next step. */
export function setActivityDetail(detail: string): void {
  const a = currentActivity();
  if (!a) return;
  a.detail = detail;
  paint();
}

/** Drop everything. Called when a turn ends, so no label can outlive the work. */
export function clearActivity(): void {
  stack.length = 0;
  paint();
}
