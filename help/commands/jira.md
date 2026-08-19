Asks Jira a plain-language question — an inner agentic loop against Jira's own API composes and runs the actual query, so you never write JQL.

Your current sprint is the context for whoever `/jira-auth` authenticated: which tickets are assigned to you, their status and priority, what a ticket says, or who commented on it. **Name a ticket key and it is read directly, sprint or not** — `PROJ-1234` anywhere in the question is fetched before the board is, so a closed ticket from two releases ago answers just as well as today's. A bare number (`13804`) is resolved only against your sprint, because a number without a project prefix is not an address.

It's operator-only, not something the main agent can reach for itself — a connector call costs several round trips against an external API, which is worth paying deliberately from the command line rather than mid-turn when the agent decides it wants to check. The question and its answer still land in the conversation window, so the agent sees the result even though it couldn't trigger the call. The agent has its own deterministic one-request tool for a ticket it already has the key for (`jira_ticket`).

## Examples

    /jira what is still open on me?
    /jira any replies on the login bug?
    /jira what does PERF-1234 say needs changing?
