Toggles the QA gate for the rest of the session: a short agentic check that runs after the agent claims to be done, verifying the build and artifacts against what you actually asked for.

The agent's own closing message ("Done — implemented the panel and updated the docs") is written by the same model that did the work, from the context that made any mistakes, and rewarded for sounding complete — so it is a claim, not a fact. With the gate on, it fires deterministically whenever a turn changed files and the reply reads like a completion report, running probes and a review, and sending issues back to the agent to fix (up to a few passes) before it reaches you. `/qa` is a bare toggle; `/qathis <message>` forces the gate for one reply only, independent of whether the toggle is on.

## Examples

    /qa
    /qathis did you actually run the migration?
