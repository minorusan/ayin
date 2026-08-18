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

/**
 * `$` opening the LAST line of a multi-line reply — the third place models put it.
 *
 * Neither pattern above catches `…\n$ Done.`: the marker is not at the string start (no `m` flag, by
 * design) and not the last non-space character, because a word follows it. Observed in real use, and
 * it reached the operator's screen as `$ Done.` after they had asked for the marker to be gone.
 *
 * THE HAZARD IS SHELL EXAMPLES. An answer that ends with a fenced block whose last line is
 * `$ npm run build` must keep its dollar — that is a prompt character, not a signal. So this refuses
 * to fire inside a code fence, counted from the text itself rather than guessed at by length.
 */
const FINAL_MARKER_LAST_LINE = /\n[ \t]*\$[ \t]+(?=\S)/;

/** Is the offset inside a ``` fenced block? Counts fences before it — odd means inside. */
function insideCodeFence(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  return ((before.match(/^\s*```/gm) ?? []).length % 2) === 1;
}

/** The reply with the marker removed, wherever it was. */
export function stripFinalMarker(text: string): string {
  const out = text.replace(FINAL_MARKER, '').replace(FINAL_MARKER_TRAILING, '');
  // Only the LAST line, and only outside a fence: anywhere earlier, a `$` is prose or a shell prompt.
  const lastBreak = out.lastIndexOf('\n');
  if (lastBreak === -1) return out;
  const tail = out.slice(lastBreak);
  const m = FINAL_MARKER_LAST_LINE.exec(tail);
  if (!m) return out;
  if (insideCodeFence(out, lastBreak)) return out;
  return out.slice(0, lastBreak) + tail.replace(FINAL_MARKER_LAST_LINE, '\n');
}
