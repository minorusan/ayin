Asks Sentry a plain-language question about production errors — an inner agentic loop composes and runs the actual query against Sentry's API.

Scoped to unresolved issues in your organization from the last 14 days: which ones are unresolved, how often they fire, how many users they affect, or what a stacktrace says. Operator-only like `/jira` — a connector call is several round trips against an external service, worth triggering deliberately rather than letting the main agent decide mid-turn to go check Sentry.

## Examples

    /sentry what breaks most for users?
    /sentry why is the checkout crashing?
