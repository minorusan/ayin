Brings back a past session, replaying its recent turns into the chat and restoring the agent's own context window so new turns append to that session's record rather than starting fresh.

Bare `/resume` lists this directory's sessions, newest first, in a picker (arrow keys to choose, Enter to restore, Esc to cancel) — sessions are scoped to the current directory by default because a session from another repo is just noise here. `/resume all` widens the list to every directory on the machine. An argument skips the picker: a number is a 1-based index into the last listing shown, anything else is treated as a session id or id prefix.

## Examples

    /resume
    /resume all
    /resume 3
