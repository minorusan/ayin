Stores a Sentry credential parsed out of pasted text — auth token, organization slug, optionally a project — verifying it against Sentry before saving.

The organization slug is the field people forget: a token stored without one authenticates fine and then returns a 403 on every real query. Called with no arguments, it reports what is configured and whether it actually works, which catches exactly that case. Like `/jira-auth`, this is operator-only and never reachable by the agent, since the argument is a secret.

## Examples

    /sentry-auth
    /sentry-auth token: abc123... org: mycompany
