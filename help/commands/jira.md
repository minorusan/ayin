Asks Jira a plain-language question — an inner agentic loop against Jira's own API composes and runs the actual query, so you never write JQL.

Scoped to the current sprint for whoever `/jira-auth` authenticated: which tickets are assigned to you, their status and priority, what a ticket says, or who commented on it. It's operator-only, not something the main agent can reach for itself — a connector call costs several round trips against an external API, which is worth paying deliberately from the command line rather than mid-turn when the agent decides it wants to check. The question and its answer still land in the conversation window, so the agent sees the result even though it couldn't trigger the call.

## Examples

    /jira what is still open on me?
    /jira any replies on the login bug?
