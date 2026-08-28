Asks Slack a plain-language question — an inner agentic loop composes and runs the actual search, read, and thread calls, so you never look up a channel id yourself.

READ-ONLY, on the user token `/slack-auth` stored: every public channel, private channel and DM you can see, exactly as far as your own account reaches and no further. It starts by searching, then reads around a hit or opens its thread as the question needs.

It's operator-only, not something the main agent can reach for itself — a connector call costs several round trips against Slack's API, worth paying deliberately from the command line rather than mid-turn when the agent decides to go check. The question and its answer still land in the conversation window, so the agent sees the result even though it couldn't trigger the call.

## Examples

    /slack what has anyone said about the outage last week?
    /slack what happened in that thread about the release?
    /slack who is on the infra channel?
