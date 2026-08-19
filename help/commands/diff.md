Renders your working tree — staged, unstaged, and untracked changes — as an HTML review page and opens it in your browser.

Your session serves the page and opens its URL, which is what makes it a review rather than a printout: hover a line, write a comment, send it. The comment enters this chat as a prompt like any other, the agent makes the change, and the page reloads itself showing the new tree with the reply under your line. Comments still waiting on an answer keep their status through a reload.

It lists changed files with additions/deletions, filters by extension, and marks changed tokens per file. An argument is any git rev to compare against instead of the default `HEAD` — `/diff main` reviews everything since branching from main. `ayin diff` from a plain shell opens the same live page when a session is up, and otherwise writes a static, self-contained file to `~/.ayin-cli/diffs` (pruned after 24 hours) with the comment boxes absent.

## Examples

    /diff
    /diff main
    /diff HEAD~3
