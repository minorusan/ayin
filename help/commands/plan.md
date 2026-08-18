Toggles plan mode for the rest of the session: a big request first gets a survey, API research, and an explore pass, written out as `ayin-plan-*.md`, before the agent touches anything.

It exists because a 2000-character request is usually several features wearing one paragraph — handed straight to the agent, it starts on whichever sentence it read last and spends its budget repairing its own first guess in round nine. `/plan` is a bare toggle with no argument; once on, a long enough prompt triggers one cheap triage call that decides whether the request is genuinely multi-feature before paying for the full plan pass. For a single prompt you want planned right now, without flipping the session toggle, use `/planthis <text>` instead — it forces the pass once, even while the toggle is off.

## Examples

    /plan
    /planthis rewrite the auth flow to use refresh tokens
