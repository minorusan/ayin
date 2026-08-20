/**
 * agent-activity.ts — what the agent is doing right now, readable from outside the TUI.
 *
 * `setAgentState` already carries the honest answer — `thinking`, or `tool` with `Running grep(...)` —
 * but it only ever went into a blessed widget. A page served by the same session had no way to say
 * anything more useful than "working", so it said nothing and spun.
 *
 * A HOLDER, NOT A LOG. One current value, overwritten. Nothing here accumulates, because nothing needs
 * history: a progress indicator answers "what now", and a page that wanted the transcript would ask for
 * the transcript.
 *
 * It records even in headless, deliberately — the recorder runs before the widget, so a `-p` run that
 * has no TUI at all still reports what it is doing to anything that asks.
 */

export type ActivityState = 'idle' | 'thinking' | 'tool' | 'explaining' | 'summarizing';

export interface AgentActivity {
  state: ActivityState;
  /** Whatever the caller labelled it: a tool call with its arguments, or a phase. Empty when unlabelled. */
  label: string;
  /** When this state STARTED, so a reader can age it without the writer ticking anything. */
  since: number;
  /** Turns started since boot. A reader uses it to tell "still the same turn" from "a new one began". */
  turns: number;
}

let current: AgentActivity = { state: 'idle', label: '', since: Date.now(), turns: 0 };

/**
 * Record a state change. `since` only moves when the STATE changes, not when the label does — a tool
 * label updates several times inside one thinking phase, and resetting the clock on each would make a
 * long phase look like a series of short ones.
 */
export function noteAgentState(state: ActivityState, label = ''): void {
  const sameState = state === current.state;
  current = {
    state,
    label,
    since: sameState ? current.since : Date.now(),
    turns: current.turns + (state !== 'idle' && current.state === 'idle' ? 1 : 0),
  };
}

export function agentActivity(): AgentActivity {
  return current;
}
