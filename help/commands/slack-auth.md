Stores a Slack credential parsed out of a pasted User OAuth Token, verifying it against Slack before saving.

Paste the token from your Slack app's **OAuth & Permissions** page — the **User OAuth Token**, which starts `xoxp-`. A **bot token** (`xoxb-`) is refused outright, before any network call: it cannot search, and it only sees channels the bot was invited into, so it cannot answer what `/slack` is for. Called with no arguments it reports what is configured and whether it still works. This only sets up `/slack`'s credential; it is operator-only and never callable by the agent, since its own argument is a secret.

## Examples

    /slack-auth
    /slack-auth xoxp-111-222-333-abcabcabcabc
