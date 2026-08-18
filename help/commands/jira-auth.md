Stores a Jira credential parsed out of whatever you paste — token, site, email, expiry, in any order — verifying it against Jira before saving.

Paste the whole block you copied from wherever you generated the token; an LLM call in the tool picks out the fields regardless of the order or format they're in. Called with no arguments it doesn't configure anything — it reports who is currently authenticated and when that token expires, which is the natural way to check "am I still logged in" before it fails mid-task. This only sets up `/jira`'s credential; it is operator-only and never callable by the agent, since its own argument is a secret.

## Examples

    /jira-auth
    /jira-auth token: abc123... site: mycompany.atlassian.net expires: 2026-12-01
