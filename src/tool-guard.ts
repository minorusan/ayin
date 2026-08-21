/**
 * Tool guard — repeat, refusal and polling policy for one turn.
 *
 * THE BUG THIS EXISTS FOR. The old duplicate detector answered every repeat with the same warning
 * and let the model try again. A model that is stuck does not learn from a transient
 * `<tool_response>`: it re-emits the identical call, gets the identical warning, and the transcript
 * fills with `[Loop detected: status called again with same params]` five times in a row while two
 * background tasks sit there running. The warning was advice, and advice is not a rule.
 *
 * SO REFUSALS ESCALATE, AND THEY PERSIST. A second identical call is not warned — it is BLOCKED for
 * the rest of the turn, and the block is written into the SYSTEM PROMPT every round
 * (`guardDirective()`), where the model cannot scroll past it. Same for a call the user denied: once
 * denied, that exact call is dead for the turn. Nothing is forgotten between rounds.
 *
 * POLLING IS THE ONE LEGITIMATE REPEAT. Checking on a backgrounded task IS calling the same tool
 * with the same parameters, on purpose — blocking it would be wrong. So pollable tools keep working,
 * but rate-limited: identical polls closer together than `pollMinIntervalMs` still run (a local
 * status read is free) and come back with an explicit "do not poll again for N s — do other work or
 * say you are waiting", and past `pollMaxPerTurn` they stop entirely. The model is told which
 * regime it is in, in words, every time.
 *
 * IN-TURN STATE ONLY. This is a per-turn budget, not durable state: a new user turn is a new
 * intention and starts clean (`guardBeginTurn`). Nothing here needs to survive a restart, so nothing
 * here pretends to persist.
 */

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { getConfig } from './prompts.js';
import { log } from './log.js';

/** Tools whose whole job is to be called again — repeats are the feature, not the failure. */
const POLLABLE = new Set(['status']);

/**
 * Calls whose REPEAT IS THE POINT, and which must never be rate-limited either.
 *
 * `entangle op=next` drives the implementation loop: the same call returns a DIFFERENT type each time,
 * because the answer is a function of what has landed since. The repeat guard read it as a loop and
 * blocked it — measured, and it destroyed a run: the model spun hunting for a call the guard would accept,
 * burned every round, and finally emitted malformed XML. Polling a task is rate-limited because a poll
 * costs a task nothing; this costs a step, so it is exempt outright.
 */
const IDEMPOTENT_DRIVERS: Array<{ tool: string; when: (p: Record<string, string>) => boolean }> = [
  { tool: 'entangle', when: (p) => (p.op ?? '').trim().toLowerCase() === 'next' },
];

function isDriver(name: string, params: Record<string, string>): boolean {
  return IDEMPOTENT_DRIVERS.some((d) => d.tool === name && d.when(params));
}

export interface GuardDecision {
  /** Whether the call should actually execute. */
  allow: boolean;
  /** Text to append to the result (when allowed) or to feed back as the result (when not). */
  note?: string;
  /** Short label for the transcript, e.g. "blocked (3rd identical call)". */
  label?: string;
}

interface CallState {
  count: number;
  lastAt: number;
  /** What the call's target looked like when it last ran — see `witnessOf`. */
  witness: string;
  /** The mutation epoch at that moment, for calls whose target is not one file. */
  epoch: number;
}

const calls = new Map<string, CallState>();

/**
 * WHY A REPEAT IS SOMETIMES THE RIGHT CALL.
 *
 * The escalation above is written for a model that is stuck, and it was blocking a model that was
 * WORKING: read a file, fix it, read it again to check the fix — the third read is the same call with the
 * same parameters, and it was refused with "the answer will not change by asking again". The answer had
 * changed. That refusal cost real fixes, because the alternative offered ("use the result already in your
 * context") is the STALE result.
 *
 * So a repeat is judged against the world, not only against the transcript, by two signals:
 *
 *   · the WITNESS — mtime and size of the file the call names. Exact, and it catches a change made by
 *     anything at all: another tool, a build, the operator in their editor, git.
 *   · the EPOCH — a counter bumped whenever ayin's own edit tools write a file. This is what covers the
 *     calls whose target is not a single file (a grep over a directory, a find).
 *
 * `bash` deliberately does NOT bump the epoch. A build or a test run mutates plenty, but letting it lift
 * the block would re-open the loop this guard exists to close — `npm test` five times in a row, each run
 * excusing the next. A bash repeat still lifts when the FILE it names changed, which is the honest signal.
 *
 * A user DENIAL is never lifted by either. That was a decision about permission, not about freshness.
 */
let mutationEpoch = 0;

/** Bumped by the agent loop after a tool that writes files succeeds. */
export function guardNoteMutation(tool: string, paths: string[]): void {
  mutationEpoch++;
  log('INFO', 'guard_mutation_noted', { tool, epoch: String(mutationEpoch), paths: paths.slice(0, 3).join(',') });
}

/**
 * What the call's target looks like right now: `mtime:size`, or `missing`, or '' when the call names no
 * path at all. Two calls with the same witness are asking the same question of the same bytes.
 */
function witnessOf(params: Record<string, string>): string {
  const raw = params.path ?? params.file ?? '';
  if (!raw.trim()) return '';
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  try {
    const st = statSync(abs);
    // A directory's own mtime moves when entries are added or removed — weaker than a file's, and still
    // the difference between "the folder I searched is the folder I searched" and a guess.
    return st.isDirectory() ? `dir:${Math.floor(st.mtimeMs)}` : `${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return 'missing';
  }
}
const blocked = new Map<string, string>(); // key → why
let denied = new Map<string, string>();    // key → what the user refused

export function callKey(name: string, params: Record<string, string>): string {
  const p = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
  return `${name}|${p}`;
}

/** Reset for a new user turn. */
export function guardBeginTurn(): void {
  calls.clear();
  blocked.clear();
  denied = new Map();
  // The epoch is NOT reset: it counts writes, and a turn boundary does not un-write them. Resetting it
  // would only matter if a stale CallState survived the turn, and none does.

}

/** Remember that the user refused this exact call — it must not be attempted again this turn. */
export function guardNoteDenied(name: string, params: Record<string, string>): void {
  const key = callKey(name, params);
  denied.set(key, name);
  log('INFO', 'guard_denied_recorded', { tool: name });
}

const preview = (params: Record<string, string>): string =>
  Object.entries(params).map(([k, v]) => `${k}=${v.length > 40 ? `${v.slice(0, 37)}…` : v}`).join(', ');

/**
 * Decide what happens to this call. Call it once per tool call, before execution.
 *
 * The returned `note` is written for the MODEL, not the user: it says what happened, why, and what
 * to do instead — a refusal with no alternative is what produces the next identical attempt.
 */
export function guardCheck(name: string, params: Record<string, string>): GuardDecision {
  const key = callKey(name, params);

  // Before anything else: a driver's repeat is its purpose, and no policy below applies to it.
  if (isDriver(name, params)) return { allow: true, label: 'next step' };

  if (denied.has(key)) {
    return {
      allow: false,
      label: 'blocked (already denied by the user)',
      note: `BLOCKED. You already called ${name}(${preview(params)}) this turn and the user DENIED it. `
        + `A denial is final for this turn — do not call it again in any form. Either achieve the goal a `
        + `different way with the tools you have, or stop and tell the user what you need from them.`,
    };
  }

  const now = Date.now();
  const witness = witnessOf(params);
  const prior = calls.get(key);

  /**
   * THE WORLD MOVED, so this is a new question rather than a repeat.
   *
   * Checked BEFORE the block above on purpose: a block set three rounds ago was about a file that has
   * since been edited, and keeping it would be the guard insisting on a stale answer. The counter resets
   * too — the escalation should start over for the new state of the file, not resume mid-ladder.
   */
  if (prior) {
    const fileChanged = witness !== '' && prior.witness !== '' && witness !== prior.witness;
    const filesWritten = mutationEpoch > prior.epoch;
    if (fileChanged || filesWritten) {
      calls.set(key, { count: 1, lastAt: now, witness, epoch: mutationEpoch });
      const wasBlocked = blocked.delete(key);
      const why = fileChanged ? 'the file it reads has changed since' : 'files have been written since';
      log('INFO', 'guard_repeat_allowed_stale', { tool: name, reason: why, unblocked: String(wasBlocked) });
      return {
        allow: true,
        label: fileChanged ? 'allowed (target changed)' : 'allowed (files written since)',
        note: `\n\n[This repeats an earlier call, and it ran because ${why} — the earlier result is stale. `
          + `Nothing else about the repeat policy has changed: an identical call with nothing changed in between is still blocked.]`,
      };
    }
  }

  const why = blocked.get(key);
  if (why) {
    return {
      allow: false,
      label: 'blocked (repeat)',
      note: `BLOCKED. ${why} This exact call is disabled for the rest of this turn — nothing it reads has changed since. `
        + `Use what is already in your context, take a materially different approach, or answer with what you have. `
        + `If you CHANGE the file first, reading it again is allowed.`,
    };
  }

  const state = prior ?? { count: 0, lastAt: 0, witness, epoch: mutationEpoch };
  const sinceMs = state.lastAt ? now - state.lastAt : Infinity;
  state.count++;
  state.lastAt = now;
  state.witness = witness;
  state.epoch = mutationEpoch;
  calls.set(key, state);

  // First time — nothing to police.
  if (state.count === 1) return { allow: true };

  // ── polling: allowed, rate-limited, capped ──────────────────────────
  if (POLLABLE.has(name)) {
    const maxPolls = getConfig('pollMaxPerTurn', 6);
    const minInterval = getConfig('pollMinIntervalMs', 15_000);
    if (state.count > maxPolls) {
      blocked.set(key, `You polled ${name} ${state.count - 1} times in this turn (the cap is ${maxPolls}).`);
      log('WARN', 'guard_poll_capped', { tool: name, count: String(state.count) });
      return {
        allow: false,
        label: `blocked (poll cap ${maxPolls})`,
        note: `BLOCKED. You have polled ${name} ${state.count - 1} times this turn — that is the cap. `
          + `Stop polling. Either continue with other work while the task runs, or tell the user plainly that `
          + `it is still running and what you will do when it finishes. Its result will arrive on its own.`,
      };
    }
    if (sinceMs < minInterval) {
      const waitS = Math.ceil((minInterval - sinceMs) / 1000);
      log('INFO', 'guard_poll_throttled', { tool: name, count: String(state.count), sinceMs: String(Math.round(sinceMs)) });
      return {
        allow: true,
        label: `poll ${state.count} (too soon)`,
        note: `\n\n[POLLING NOTICE: this is poll ${state.count} of ${maxPolls}, ${Math.round(sinceMs / 1000)}s after the last one. `
          + `Do NOT poll ${name} again for at least ${waitS}s. If the task is still running, either do other useful `
          + `work now or tell the user you are waiting — a completed background task reports itself automatically.]`,
      };
    }
    return { allow: true, label: `poll ${state.count}`, note: `\n\n[POLLING NOTICE: poll ${state.count} of ${maxPolls}.]` };
  }

  // ── everything else: warn once, then block for the turn ─────────────
  if (state.count === 2) {
    log('WARN', 'guard_repeat_warned', { tool: name });
    return {
      allow: false,
      label: 'skipped (identical repeat)',
      note: `You already ran ${name}(${preview(params)}) with these exact parameters in this turn, nothing it reads has `
        + `changed since, and the result is already in your context. Use it. If it was not what you needed, change the `
        + `parameters or the approach — an identical third call will be BLOCKED for the rest of the turn. Editing the `
        + `file and reading it again is not a repeat, and is allowed.`,
    };
  }

  blocked.set(key, `You called ${name} with identical parameters ${state.count} times in this turn.`);
  log('WARN', 'guard_repeat_blocked', { tool: name, count: String(state.count) });
  // The escape hatch matters: "check whether the server came up yet" is a legitimate reason to run
  // the same command twice, and a block with no alternative is how a model ends up stuck instead of
  // waiting. A command with a wait in front of it is a DIFFERENT call, and it is allowed.
  const waitHint = name === 'bash'
    ? ` If you were waiting for something to become ready, do not repeat the identical command — put a wait in front of it `
      + `(e.g. \`sleep 5; <command>\`), which is a different call and will run.`
    : '';
  return {
    allow: false,
    label: `blocked (${state.count} identical calls)`,
    note: `BLOCKED. You called ${name}(${preview(params)}) ${state.count} times with identical parameters. `
      + `This call is now disabled for the rest of this turn. The answer will not change by asking again: `
      + `use the result already in your context, try a genuinely different approach, or report what you have.${waitHint}`,
  };
}

/**
 * The blocked-call list for the system prompt — this is what makes a refusal STICK.
 *
 * A tool result is one message in a window that scrolls; a system-prompt line is present in every
 * single round. Anything the guard has killed is named here for as long as the turn lasts.
 */
const DIRECTIVE_MAX = 8; // the list is a reminder, not a transcript — it must not crowd out the prompt

export function guardDirective(): string {
  if (blocked.size === 0 && denied.size === 0) return '';
  const lines: string[] = [];
  if (denied.size > 0) {
    lines.push('The user DENIED these calls. They are final — never attempt them again in this turn:');
    for (const [key] of [...denied].slice(0, DIRECTIVE_MAX)) {
      lines.push(`  - ${key.split('|')[0]}(${key.split('|').slice(1).join(', ').slice(0, 120)})`);
    }
  }
  if (blocked.size > 0) {
    lines.push('These calls are BLOCKED for the rest of this turn (repeated identically, or polled past the cap).');
    lines.push('Calling any of them again is wasted and will be refused — change approach or answer with what you have:');
    for (const [key, why] of [...blocked].slice(0, DIRECTIVE_MAX)) lines.push(`  - ${key.split('|')[0]}: ${why}`);
  }
  const shown = Math.min(denied.size, DIRECTIVE_MAX) + Math.min(blocked.size, DIRECTIVE_MAX);
  const total = denied.size + blocked.size;
  if (total > shown) lines.push(`  (+${total - shown} more blocked call(s) not listed)`);
  return lines.join('\n');
}

/** How many distinct calls are currently blocked — for logging and the status line. */
export function guardBlockedCount(): number {
  return blocked.size + denied.size;
}
