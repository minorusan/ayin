/**
 * modes.ts — operator toggles that change how ayin WRITES, not what it is allowed to do.
 *
 * Two of them, both persisted in `~/.ayin-cli/prompts.json` so they survive a restart: a mode the
 * operator has to re-enable every session is a mode they stop using.
 *
 *   - **brevity (default ON, `/verbose` turns it off)** — answers are as short as the question
 *     allows. The default used to be whatever the model felt like, which on a coding model is
 *     several paragraphs restating the task before the one line that matters.
 *   - **log coverage (default OFF, `/logcover` turns it on)** — while building a feature, instrument
 *     it heavily. Off by default because logging every branch is the right call while a thing is
 *     being brought up and the wrong one for a small edit to code that already works.
 *
 * Both are injected as prompt TEXT (`prompts/ayin/{brevity,logCoverage}.txt`) into the system
 * message's stable prefix. They change only when the operator types a command — never mid-turn — so
 * the KV-prefix cache survives a turn intact and pays for the toggle exactly once.
 */

import { getConfigIfSet, setConfigValue } from './prompts.js';

/** Off by default: the shortest answer the question allows is the DEFAULT, so `/verbose` opts out. */
export function isVerbose(): boolean {
  return getConfigIfSet('verbose') === 1;
}

export function setVerbose(on: boolean): void {
  setConfigValue('verbose', on ? 1 : 0);
}

/** Off by default — heavy instrumentation is a choice for feature work, not a standing tax. */
export function isLogCoverage(): boolean {
  return getConfigIfSet('logCoverage') === 1;
}

export function setLogCoverage(on: boolean): void {
  setConfigValue('logCoverage', on ? 1 : 0);
}
