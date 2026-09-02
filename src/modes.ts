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
 *   - **naamah (default OFF, `/naamah on` turns it on)** — the design-before-code workflow. Off
 *     because it is instruction, not preference: left on it made a design directory before a one-line
 *     edit, and cost 3,377 prompt characters on every turn to do it.
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

/**
 * The naamah design workflow — OFF by default, `/naamah on` turns it on.
 *
 * OFF, because it is the most opinionated thing ayin does and it was not opt-in. "DESIGN BEFORE CODE —
 * the default workflow, not an option you offer" sat in the system prompt of every turn, 3,377
 * characters of vocabulary and format rules, on a repo that may have no design directory and an
 * operator who never asked for one. Every character of it was spending attention that the actual task
 * needed — and worse, it was INSTRUCTION: a turn that should have been one edit began by making a
 * design directory.
 *
 * TWO THINGS ARE GATED, and both matter. The prompt text is not injected, so nothing tells the model
 * to design first; and the `naamah` tool is withheld from the catalogue, so it cannot reach for it
 * anyway. Text alone would leave a tool in the list with no instructions, which is how a model invents
 * its own workflow for one.
 *
 * The page (`/naamah` with no argument) is unaffected: looking at a design that already exists is not
 * the same as being told to make one.
 */
export function isNaamah(): boolean {
  return getConfigIfSet('naamah') === 1;
}

export function setNaamah(on: boolean): void {
  setConfigValue('naamah', on ? 1 : 0);
}

/** Off by default — heavy instrumentation is a choice for feature work, not a standing tax. */
export function isLogCoverage(): boolean {
  return getConfigIfSet('logCoverage') === 1;
}

export function setLogCoverage(on: boolean): void {
  setConfigValue('logCoverage', on ? 1 : 0);
}
