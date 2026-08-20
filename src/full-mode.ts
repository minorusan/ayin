/**
 * full-mode.ts — `--full`, and the one place that says what it means.
 *
 * Three switches an operator turns on together often enough to want one word for it: the debug bundle
 * written at boot, the QA session toggle, and the permission gate stepped around. Each already had its
 * own way in (`--debug`, `AYIN_QA=1`, `--dangerously-skip-permissions`) and each is read by a DIFFERENT
 * module at import time, so a composite flag has to be resolvable from argv alone with no dependencies
 * — otherwise `permissions.ts` would import a module that imports it back.
 *
 * DEFINED ONCE, HERE. Three copies of `argv.includes('--full')` would be three places for the meaning
 * of the flag to drift apart, and the one that drifted would be the permission gate.
 *
 * IT IS SESSION-SCOPED BY CONSTRUCTION. Nothing is written to disk, because it is read from argv and
 * argv does not survive a restart. That matters most for the permission gate: `permissions.ts` argues
 * that a gate which silently stayed off after a restart is one nobody remembers turning off, and the
 * first they learn of it is the thing it would have stopped. A flag typed per launch keeps that
 * property — the operator re-states the intent every time.
 *
 * WHAT IT DOES NOT DO. It does not reach the push/pull/checkout guard. That check runs above every
 * permission rule and DENIES under a skip flag rather than allowing, because those actions are
 * unrecoverable and public. `--full` inherits that refusal unchanged.
 */

/** True when this launch asked for everything. Read from argv so any module can ask without a cycle. */
export function isFullMode(): boolean {
  return process.argv.includes('--full');
}
