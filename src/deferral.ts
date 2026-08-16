/**
 * deferral.ts — "the fix is to locate X" is not a fix.
 *
 * A small fast model, asked to diagnose something, will happily end its turn with the SHAPE of an
 * answer: *the fix is to locate the method that adds the bonus*, *you should investigate the scoring
 * path*, *the next step is to check where this is called*. Every one of those is the model handing
 * the work back while sounding finished, and the loop cannot tell it from a result — "here is my
 * plan" and "here is my answer" are the same to a check that only asks whether a tool was called.
 *
 * The rule this encodes: a final answer must contain something the operator did not already have.
 * Naming what to look for is not that. Naming where it IS — a path, a line, a change — is.
 *
 * DELIBERATELY NARROW, because the failure mode of getting this wrong is worse than the failure it
 * catches. A good answer often says "worth checking X" ALONGSIDE a real finding, and nagging that
 * answer would train the operator to ignore the nudge. So a deferral is only a deferral when the
 * reply has no concrete anchor at all: no file:line, no code, no diff, no quoted identifier.
 */

/** Phrases that hand the work back. Matched only in a reply that carries nothing concrete. */
const DEFERRAL = new RegExp([
  String.raw`\b(?:the\s+)?fix\s+is\s+to\s+(?:locate|find|identify|investigate|search|look|determine|check)`,
  String.raw`\b(?:you|we)\s+(?:should|need\s+to|would\s+need\s+to|must)\s+(?:locate|find|investigate|search|check|examine|review)\b`,
  String.raw`\b(?:the\s+)?next\s+steps?\s+(?:is|are|would\s+be)\s+to\s+(?:locate|find|investigate|search|check|examine)`,
  String.raw`\bfurther\s+(?:investigation|analysis)\s+(?:is|would\s+be)\s+(?:needed|required)`,
  String.raw`\b(?:i|we)\s+(?:recommend|suggest)\s+(?:locating|finding|investigating|searching|checking)`,
].join('|'), 'i');

/** Anything that makes a reply a RESULT rather than a direction. */
function hasConcreteAnchor(text: string): boolean {
  if (/```/.test(text)) return true;                              // code or a diff
  if (/\b[\w./-]+\.(?:ts|js|tsx|jsx|cs|py|go|rs|java|kt|rb|php|c|cpp|h|hpp|swift|sql|json|ya?ml)\b/i.test(text)) return true;
  if (/:\d+(?:-\d+)?\b/.test(text)) return true;                  // a line or a range
  if (/\bline\s+\d+/i.test(text)) return true;
  return false;
}

/**
 * True when this reply is a direction rather than a result.
 *
 * `didWork` is the escape hatch that matters: a turn that actually edited a file has DONE something,
 * and its closing "you should also check X" is a caveat, not a dodge.
 */
export function looksLikeDeferral(text: string, didWork: boolean): boolean {
  if (didWork) return false;
  const t = (text ?? '').trim();
  if (t.length < 40) return false;          // too short to be a diagnosis either way
  if (hasConcreteAnchor(t)) return false;
  return DEFERRAL.test(t);
}

/**
 * What to say back. One nudge only — the caller enforces that.
 *
 * Names the specific move rather than scolding: a model told "you are slacking" has nothing to act
 * on, while a model told "you have the tools, use them now" does. Kept short because it arrives at
 * the end of a long window, where a paragraph is skimmed.
 */
export const DEFERRAL_NUDGE =
  'That names what to look for, not what you found — which leaves the work where it started.\n'
  + 'You have the tools. Run the search now and answer from what it returns: the file, the line, and '
  + 'the change. If you look and genuinely cannot determine it, say exactly that and say what blocked you.';
