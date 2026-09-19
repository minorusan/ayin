import type { Tool } from '../base.js';

/**
 * `finish` — the ONLY way a working turn ends, and the reason ayin no longer has to guess.
 *
 * WHAT THIS REPLACES, and why guessing failed. Termination used to be INFERRED FROM ABSENCE: a reply
 * with no tool call meant the agent was done. That conflates two states a harness must never confuse —
 * "I have finished" and "I was describing what I am about to do". A 27B model narrates constantly, so
 * the second was read as the first and the turn ended mid-sentence.
 *
 * Measured across a suite of real repository issues: EVERY empty-patch run, in every configuration, six of six, ended
 * exactly that way. The last thing each one said was an intention — "Let me confirm the exact mechanism
 * with a minimal reproduction before fixing." Then the harness switched it off. It had found the bug.
 *
 * WHY NOT A MARKER. The previous answer was a convention: a finished reply starts with `$`. It is
 * mechanically checkable, which is the right instinct, and it still failed — because it asks the model
 * to comply with a formatting rule, and a model that will not comply has no way to be made to. The
 * enforcement then gave up after two unmarked replies BY DESIGN, which withdrew the protection from
 * exactly the models too weak to follow it. A tool call is not a convention: it is the thing the model
 * already does all day, in a shape the harness parses anyway.
 *
 * CALLING IT IS NOT A CLAIM THAT THE WORK SUCCEEDED. `cause` exists so that "I found it and I am
 * deliberately not fixing it" is a first-class answer rather than something that only ever happened by
 * accident when the loop cut a session short. For an agent whose job is to diagnose, that is the most
 * valuable thing it can say.
 *
 * THE TOOL DOES NOT COMPOSE THE ANSWER. It validates and echoes; `agent.ts` adds what actually happened
 * — files changed, tools run — because tools may not import the turn's state (see check-gates:
 * "tools/ imports nothing outside tools/"). That split is also what makes this cheap: the old Presenter
 * spent a whole extra model call reshaping prose into a fixed form. Here the model hands over its
 * summary as an argument it was going to write anyway, and the harness supplies the facts for free.
 */
export const tool: Tool = {
  name: 'finish',
  icon: '✅',
  description:
    'End the task and report. Call this the moment the work is done — or when you have identified the '
    + 'cause and are deliberately NOT fixing it, which is a complete answer, not a failure. Nothing else '
    + 'ends a turn: a reply with no tool call is treated as work in progress and you will be asked to '
    + 'continue. Do not invent further work to avoid calling this.',
  parameters: [
    {
      name: 'summary',
      type: 'string',
      description: 'What you did or found, in your own words. Someone who did not watch the session should '
        + 'understand the outcome from this alone. State what you changed, or what you concluded.',
      required: true,
    },
    {
      name: 'cause',
      type: 'string',
      description: 'The root cause, when you are reporting a diagnosis rather than a fix — the file, the '
        + 'function, and the mechanism. Use this when you know what is wrong but are not changing it.',
      required: false,
    },
  ],
  async execute(params) {
    const summary = String(params.summary ?? '').trim();
    // FAIL LOUD ON AN EMPTY SUMMARY rather than ending the turn with nothing to show. A finish with no
    // content is the silent stop this tool exists to abolish, wearing the new vocabulary.
    if (!summary) {
      return 'Error: summary required — finish() ends the turn, so it must say what was done or found. '
        + 'If you are not finished, take the next step instead.';
    }
    const cause = String(params.cause ?? '').trim();
    return cause ? `${summary}\n\nCause: ${cause}` : summary;
  },
};
