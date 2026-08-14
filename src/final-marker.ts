/**
 * The FINISHED-REPLY marker, `$`, and where models actually put it.
 *
 * The contract (`prompts/ayin/system.txt`, first line) is that a finished reply STARTS with `$`: a
 * tool-less reply without it is read as work-in-progress and the model is asked to continue. That
 * mechanical check is what stopped runs ending at "here is what I will do next".
 *
 * BUT THE POSITION IS NOT THE SIGNAL. gemma4 routinely appends the marker instead — the whole answer,
 * then `$` at the end. Read strictly, that is a reply with no leading marker, so the loop nudged a model
 * that had just told it, in the agreed vocabulary, that it was done. Rejecting a signal over its position
 * is the harness being pedantic at the operator's expense, and it costs a full extra round every turn.
 *
 * A TRAILING MARKER NEEDS WHITESPACE BEFORE IT, which is what keeps this from firing on ordinary prose:
 * `it costs 5$` ends with a dollar sign but has none, while `done. $` and a `$` alone on the last line
 * both do. Own module, no imports, so the gates can exercise it without loading the TUI.
 */

/** `$` as the first non-space character. */
export const FINAL_MARKER = /^\s*\$\s?/;

/** `$` as the last non-space character, with whitespace before it. */
export const FINAL_MARKER_TRAILING = /(?:^|\s)\$\s*$/;

/** Whether the model signalled "finished", at either end. */
export function hasFinalMarker(text: string): boolean {
  return FINAL_MARKER.test(text) || FINAL_MARKER_TRAILING.test(text);
}

/** The reply with the marker removed, wherever it was. */
export function stripFinalMarker(text: string): string {
  return text.replace(FINAL_MARKER, '').replace(FINAL_MARKER_TRAILING, '');
}
