Turn on everything this launch supports, for this launch only.

`ayin --full` is the switches an operator most often wants together, in one word:

    --debug                          writes a debug bundle at boot, so the path exists before anything goes wrong (TUI only)
    /qa                              the QA gate on for the session, as if you had typed it
    --dangerously-skip-permissions   the permission gate stepped around for this session

Plan mode is **already on by default** — `--full` does not need to turn it on and does not turn it
off. `AYIN_PLAN=0` still disables it, and `/plan` still toggles it mid-session.

Nothing is written to disk — the flag lives in the command line, so it does not survive a restart.
That is deliberate for the permission gate: one that silently stayed off after a restart is one
nobody remembers turning off, and the first you learn of it is the thing it would have stopped. With
`--full` you re-state the intent every launch.

**One of the three is TUI-only.** The boot-time debug bundle is written from the TUI's session-init
path, so it does not fire under `-p`. Measured: `ayin --full -p "…"` left the bundle count unchanged.
So headless `--full` is **the QA toggle plus the skipped permission gate**; for a bundle from a script
use `ayin debug`, which writes the same one.

**It does not turn on the presenter.** `/present` is the only way in, per session.

**`git push`, `git pull` and `git checkout` still refuse.** That guard runs above every permission
rule and denies under any skip flag rather than allowing, because those actions are unrecoverable and
public. `--full` inherits the refusal; there is no flag that turns it off.

Reach for it on a throwaway tree you can diff and revert, when you are debugging ayin itself and do
not want to approve every step. Do not reach for it on work you care about.

## Examples

    ayin --full
    ayin --full -p "what does src/log.ts do?"
    ayin --full --arbiter          # …and delegate every stage instead of typing it
