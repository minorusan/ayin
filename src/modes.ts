/**
 * modes.ts — operator toggles that change how ayin WRITES, not what it is allowed to do.
 *
 * Two of them, both persisted in `~/.ayin-cli/prompts.json` so they survive a restart: a mode the
 * operator has to re-enable every session is a mode they stop using.
 *
 *   - **verbose (default ON, `/verbose off` turns it off)** — say what was done, what was not, and
 *     what to do next. It was the other way round, and the terse default was answering a question
 *     nobody had asked twice: the original problem was a coding model restating the task in several
 *     paragraphs before the one line that mattered, and `brevity.txt` fixed that by forbidding
 *     preamble — but it also forbade the RECAP and the NEXT STEP, so a finished turn ended on "Done."
 *     and the operator had to ask what changed and what to do about it. Short is a property of
 *     preamble, not of a report. Terse is still one command away for anyone who wants it.
 *   - **log coverage (default OFF, `/logcover` turns it on)** — while building a feature, instrument
 *     it heavily. Off by default because logging every branch is the right call while a thing is
 *     being brought up and the wrong one for a small edit to code that already works.
 *
 * Both are injected as prompt TEXT (`prompts/ayin/{brevity,logCoverage}.txt`) into the system
 * message's stable prefix. They change only when the operator types a command — never mid-turn — so
 * the KV-prefix cache survives a turn intact and pays for the toggle exactly once.
 */

import { getConfigIfSet, setConfigValue } from './prompts.js';

/**
 * ON by default: a turn ends with what changed and what to do next, so `/verbose off` opts out.
 *
 * `!== 0` rather than `=== 1`, which is what makes an install that never touched the setting verbose
 * rather than silent — the same shape `isCorpusInjection` uses for the same reason.
 */
export function isVerbose(): boolean {
  return getConfigIfSet('verbose') !== 0;
}

export function setVerbose(on: boolean): void {
  setConfigValue('verbose', on ? 1 : 0);
}

/**
 * Corpus injection — ON by default, `/corpus off` disables it.
 *
 * On by default because a corpus nobody consults was a night of GPU spent for nothing. Switchable
 * because "does retrieval actually help?" is answered by running the same task with it off, not by
 * intuition — and every injected token costs attention that the rest of the prompt needed.
 */
export function isCorpusInjection(): boolean {
  return getConfigIfSet('corpusInject') !== 0;
}

export function setCorpusInjection(on: boolean): void {
  setConfigValue('corpusInject', on ? 1 : 0);
}

/** Off by default — heavy instrumentation is a choice for feature work, not a standing tax. */
export function isLogCoverage(): boolean {
  return getConfigIfSet('logCoverage') === 1;
}

export function setLogCoverage(on: boolean): void {
  setConfigValue('logCoverage', on ? 1 : 0);
}
