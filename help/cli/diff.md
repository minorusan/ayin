Render the working tree as a reviewable HTML page and open it.

`ayin diff [<rev>]` collects staged, unstaged and untracked changes against HEAD (or against `<rev>` when given, e.g. `main` to review a whole branch) and writes a self-contained page to `~/.ayin-cli/diffs/diff-<timestamp>.html`, then opens it with the platform's default handler for an HTML file. The page needs no server: it is a `file://` URL, which also works on a machine with no network. Pages older than 24 hours are pruned each time the command runs. Extension filters start collapsed to `.cs .asset .ts .js .py`; everything else is one click away, and the count of files hidden by the default filters is always shown on screen.

Reach for this to review a change before committing it, or to hand a colleague a branch comparison without a diff tool. It writes only inside `~/.ayin-cli/diffs`; nothing in the repo itself is touched.

## Options

    <rev>       compare against this instead of HEAD, e.g. `ayin diff main`
    --no-open   write the page and print its path, but do not open it
    --help, -h  print usage and exit

## Examples

    ayin diff
    ayin diff main
    ayin diff --no-open
