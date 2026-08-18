Restores every one of ayin's own prompts to the shipped defaults, discarding any local edits you made to them under `~/.ayin-cli/prompts/`.

Reach for it when a prompt you tuned stops working as expected and you want to get back to a known-good baseline rather than hunting for what you changed. This does not touch the session, the chat, or the agent's context — for that, see `/clear` (clears the screen only) or start a fresh terminal for a genuinely new session. `/reset` is specifically about the editable prompt files, the same ones documented for tuning ayin's behaviour.

## Examples

    /reset
