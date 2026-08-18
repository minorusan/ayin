Runs tool calls for this session without asking for confirmation first.

Meant for a benchmark or unattended run where a permission dialog would just sit there — several agents on one prompt, none of them able to stop and wait for a person. It is session-scoped only (a restart brings the prompts back) and stays loud the whole time: a sticky warning banner stays up for as long as it is on, because a gate that is silently off is the one thing an operator must never have to remember. `git push`, `git pull`, and `git checkout` stay gated even with this on — and with prompts disabled they are denied outright rather than silently allowed.

## Examples

    /skip-permissions
    /skip-permissions off
