Render the working tree as a reviewable HTML page and open it.

`ayin diff [<rev>]` collects staged, unstaged and untracked changes against HEAD (or against `<rev>` when given, e.g. `main` to review a whole branch) and shows them as a review page.

With an ayin session open on the same repo, the page is SERVED by that session and the browser is pointed at its URL. That page is live: hover any line for a comment box, and what you write goes to that session's agent as an ordinary prompt. When it has made the change, the page reloads itself against the new working tree and the agent's reply appears under your comment. In the TUI the same exchange reads as normal chat. A refresh button sits in the bottom-right corner: it rebuilds the page against whatever the working tree holds right now — useful after editing outside the page — and lands you back on the file you were reading rather than at the top.

With no session listening, the page is written to `~/.ayin-cli/diffs/diff-<timestamp>.html` and opened as a `file://` URL — self-contained, no port, works on a machine with no network, and says on screen that comments are off, because there is no agent to send one to. A static file has no server to rebuild from, so it carries no refresh button either; re-run `ayin diff` for a fresh page. Those files are pruned after 24 hours each time the command runs. Extension filters start collapsed to `.cs .asset .ts .js .py`; everything else is one click away, and the count of files hidden by the default filters is always shown on screen.

Reach for this to review a change before committing it, or to hand a colleague a branch comparison without a diff tool. It writes only inside `~/.ayin-cli/diffs`; nothing in the repo itself is touched.

## Options

    <rev>       compare against this instead of HEAD, e.g. `ayin diff main`
    --no-open   write the static file and print its path, open nothing (never serves)
    --help, -h  print usage and exit

## Examples

    ayin diff
    ayin diff main
    ayin diff --no-open
