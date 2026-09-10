Runs the rest of the line in your shell, with one tiny spell-check in front of it.

Typing `!git status -sb` hands `git status -sb` straight to the platform shell and shows the output in bold in the chat. Nothing is added to the model's context and no agent round is spent — this is a passthrough, not a prompt the agent interprets. Reach for it for anything you'd otherwise alt-tab to a terminal for: checking status, running a quick script, killing a process. The command has a 10-minute timeout and output past 200,000 characters is truncated (announced, not silent). Esc or Ctrl+C cancels the whole process tree while it runs.

**The spell-check.** Before the shell is spawned, one small model call reads the line and answers with the corrected version or `OK` — so `!gti staus -sb` runs `git status -sb` instead of costing you a "command not found" and a retype. It corrects spelling and syntax only, and what comes back is vetted without a model: a rewrite that introduces an `rm`, a `sudo`, a redirection, a force flag or a `git push/pull/checkout` you did not type — or that respells what is inside your quotes, because `grep -rn "wrold"` is a search for exactly that — is thrown away, and your line runs as typed. When it does change something it says so in one line, above the output. It never blocks — a timeout, a busy card or an endpoint that is down runs what you typed. `/set bang-check-ms 0` turns it off; any other number is the millisecond budget (default 3000).

## Examples

    !git status -sb
    !npm run build
    !ls -la
