Toggles the skeptic pass for the rest of the session: a pre-mortem on a finished change, asking not whether it does what you asked but how it breaks in production anyway.

`/qa` checks conformance — the build, the artifacts, your actual request. A change can satisfy all of that, compile, pass its tests, and still fail at 03:00, because the failure was never in the request: it was in the blast radius. So this pass reads the turn's **diff** plus **every other place in the repo that names what changed** (found by grep, not by a model — a reviewer that cannot see the callers can only review a file, not a change) and reports concrete failure modes: a call site the new signature breaks, what a power cut leaves half-written, the real input rather than the demo one, two of these at once, a dependency down, a hard limit.

It never blocks and never fixes anything. Each finding names a trigger, what you then experience, and whether the model is certain or guessing; you get a card and the turn is already over. `/skeptic` is a bare toggle; `/skepticthis <message>` runs it on one reply only. It is independent of `/qa` — wanting the cheap non-blocking pre-mortem is not the same as wanting the loop that can send work back for repair.

## Examples

    /skeptic
    /skepticthis rename the port and update its callers
