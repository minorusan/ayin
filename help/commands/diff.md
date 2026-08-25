Renders your working tree — staged, unstaged, and untracked changes — as an HTML review page and opens it in your browser.

Your session serves the page and opens its URL, which is what makes it a review rather than a printout: hover a line, write a comment, send it. The comment starts its **own headless ayin** on that repo — one comment, one run — which makes the change and replies under your line, and the page reloads itself showing the new tree. Two comments written a minute apart are answered in parallel, and neither waits for whatever you are doing in the terminal.

Everything the run says arrives in the thread while it works, small and quiet under your comment; the reply lands last, larger, and **folds** if it is long. Comments still waiting on an answer keep their status and their clock through a reload, and a run that dies says so naming its log (`~/.ayin-cli/diffs/comment-<id>.log`).

Two FABs in the bottom-right corner delete things, and they are different things: the red trashcan discards uncommitted **code**, and the red **X** above it clears every review **comment** in this repo — back to full defaults, with your files untouched. Both ask first and name what would go.

It lists changed files with additions/deletions, filters by extension, and marks changed tokens per file. An argument is any git rev to compare against instead of the default `HEAD` — `/diff main` reviews everything since branching from main. `ayin diff` from a plain shell opens the same live page when a session is up, and otherwise writes a static, self-contained file to `~/.ayin-cli/diffs` (pruned after 24 hours) with the comment boxes absent.

## Examples

    /diff
    /diff main
    /diff HEAD~3
