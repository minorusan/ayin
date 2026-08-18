Renders your working tree — staged, unstaged, and untracked changes — to a self-contained HTML review page and opens it in your browser.

The page is written to disk rather than served over a port, so it works with no network and no daemon; it lists changed files with additions/deletions, filters by extension, and marks changed tokens per file. An argument is any git rev to compare against instead of the default `HEAD` — `/diff main` reviews everything since branching from main. Pages are written to `~/.ayin-cli/diffs` and pruned after 24 hours. `ayin diff` from a plain shell does the same thing without starting the TUI.

## Examples

    /diff
    /diff main
    /diff HEAD~3
