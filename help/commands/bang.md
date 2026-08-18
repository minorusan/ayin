Runs the rest of the line in your shell, verbatim, with the model nowhere near it.

Typing `!git status -sb` hands `git status -sb` straight to the platform shell, unmodified, and shows the output in bold in the chat. Nothing is added to the model's context and no round is spent — this is a passthrough, not a prompt the agent interprets. Reach for it for anything you'd otherwise alt-tab to a terminal for: checking status, running a quick script, killing a process. The command has a 10-minute timeout and output past 200,000 characters is truncated (announced, not silent). Esc or Ctrl+C cancels the whole process tree while it runs.

## Examples

    !git status -sb
    !npm run build
    !ls -la
