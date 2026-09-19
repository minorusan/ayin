/**
 * "I have the full picture" — the moment a turn stops being an investigation, detected mechanically.
 *
 * MEASURED, NOT GUESSED. Mined from 100 finding-statements across three recorded runs. The
 * model announces a diagnosis constantly and acts on it almost never: a stated finding was followed by
 * an edit SIX times in a hundred. The rest of the time it re-derives the same conclusion — verbatim,
 * 16 times in one django session, 6 in a matplotlib one — each restatement followed by re-reading the
 * file it just read, or re-running the repro it just ran. The vocabulary is small and formulaic enough
 * that a regex catches it, which is the only reason this is worth doing without a model call.
 *
 * A FINDING IS NOT A COMPLETION CLAIM, and conflating them would fire this at the end of every
 * successful turn. "The issue is that X" is a diagnosis with work still to do; "The fix is in place"
 * is a report on work already done. Both are common, both match loose phrasing, and only the first is
 * a cue to act — so the completion forms are excluded explicitly rather than left to luck.
 *
 * Own module, no imports, so a gate can exercise it without loading the TUI.
 */

/** A diagnosis has been reached and work remains. */
const FINDING = [
  /\bI have (?:the )?(?:full |complete |clear )?picture\b/i,
  /\bI have enough (?:to|evidence|information)\b/i,
  /\bthe (?:root )?cause is\b/i,
  /\bthe bug is\b/i,
  /\bthe bug:/i,
  /\bthat'?s the bug\b/i,
  /\bthe (?:issue|problem) is that\b/i,
  /\bI'?ve confirmed the bug\b/i,
  /\bnow I understand\b/i,
  /\bthe fix is to\b/i,
];

/**
 * Work already done — a report, not a cue. Checked FIRST and wins, because "the fix is in place"
 * contains no finding phrase but "the fix is to ..." and "the issue is that ..." routinely appear in
 * the same paragraph as "Done." when a model summarises what it changed.
 */
const COMPLETION = [
  /\bthe (?:fix|change|edit) is (?:in place|complete|applied|done)\b/i,
  /\bfix is already (?:in place|applied)\b/i,
  /\b(?:is|was) (?:now )?(?:in place and )?verified\b/i,
  /^\s*done[.!,]/i,
  /\bready for QA\b/i,
];

/** Does this reply announce a diagnosis that has not yet been acted on? */
export function hasClearPicture(text: string): boolean {
  if (!text) return false;
  const t = text.slice(0, 4000);
  if (COMPLETION.some((re) => re.test(t))) return false;
  return FINDING.some((re) => re.test(t));
}

/**
 * What the model is asked for once a picture is detected. DELIBERATELY NOT A FORM.
 *
 * The first version demanded FILE / SYMBOL / PROBLEM / CHANGE, which presupposes the answer: that the
 * finding is a bug in a file with an edit attached. Plenty of real pictures are not — "you are on the
 * wrong branch", "this is configured that way", "the property fails because you call it before init,
 * and that is your code, not this repo". A model held to that form fills the lines anyway, and the
 * result is a manufactured confident edit built on a correct diagnosis. Worse than the loop it fixes.
 *
 * So it is asked plainly and the classification is left to the reader — see the dispatch in agent.ts,
 * which hands the answer to a fresh process told it may be receiving either an implementation request
 * or a finished answer, and to check which before acting.
 */
export const PICTURE_REQUEST =
  'Stop investigating and state the full picture: what you found, and what you believe should happen '
  + 'about it. Include everything that matters — this text is all that gets passed on, and whoever '
  + 'reads it will not have seen this session.';

/** Nothing to pass on. The only check there is, because there is no format to validate. */
export function briefIsUsable(brief: string): boolean {
  return brief.trim().length > 20;
}
