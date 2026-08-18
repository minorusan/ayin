Toggles the Presenter pass for the rest of the session: instead of showing whatever prose shape the model happened to write, completed work gets reformatted into a consistent answer — what was asked, one sentence on what this reply satisfies, and a bulleted list of files changed — with a diagram when the project type earns one (an Arduino sketch gets its wiring diagram; a generic project gets none).

It runs on the same trigger as `/qa` (files changed this turn, and the reply looks like a completion report) but is an independent toggle — you can turn on nicer formatting with no QA judging, or the reverse. While this is new, the raw reply still prints too, in italics below the presentation, so you can compare. `/present` is a bare toggle; `/presentthis <message>` forces one presented reply without turning the toggle on.

## Examples

    /present
    /presentthis wrap up the migration
