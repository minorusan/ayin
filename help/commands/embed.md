Toggles corpus lookup for every prompt of the session, instead of just the first.

Normally only your first prompt of a session is looked up against the repo's corpus (built by `ayin indulge`) — it's the one that states the task, later prompts are usually refinements. `/embed` widens that to every prompt for the rest of the session, which costs one extra lookup per turn but means a mid-conversation pivot to a different part of the codebase still gets corpus answers. For a single prompt without changing the session setting, use `/embedthis <question>` instead. This only has anything to look up once a corpus exists and `/corpus` injection is on.

## Examples

    /embed
    /embed off
