Turn on everything this launch supports, for this launch only.

`ayin --full` is the three switches an operator most often wants together, in one word:

    --debug                          writes a debug bundle at boot, so the path exists before anything goes wrong
    AYIN_QA=1                        the QA session toggle on, as if you had typed /qa
    --dangerously-skip-permissions   the permission gate stepped around for this session

It is exactly equivalent to `AYIN_QA=1 ayin --dangerously-skip-permissions --debug`, and nothing is written to disk — the flag lives in the command line, so it does not survive a restart. That is deliberate for the permission gate: one that silently stayed off after a restart is one nobody remembers turning off, and the first you learn of it is the thing it would have stopped. With `--full` you re-state the intent every launch.

**`git push`, `git pull` and `git checkout` still refuse.** That guard runs above every permission rule and denies under any skip flag rather than allowing, because those actions are unrecoverable and public. `--full` inherits the refusal; there is no flag that turns it off.

Reach for it on a throwaway tree you can diff and revert, when you are debugging ayin itself and do not want to approve every step. Do not reach for it on work you care about.

## Examples

    ayin --full
    ayin --full -p "what does src/log.ts do?"
