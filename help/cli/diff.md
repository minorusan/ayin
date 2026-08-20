Render the working tree as a reviewable HTML page and open it.

`ayin diff [<rev>]` collects staged, unstaged and untracked changes against HEAD (or against `<rev>` when given, e.g. `main` to review a whole branch) and shows them as a review page.

With an ayin session open on the same repo, the page is SERVED by that session and the browser is pointed at its URL. That page is live: hover any line for a comment box, and what you write goes to that session's agent as an ordinary prompt. When it has made the change, the page reloads itself against the new working tree and the agent's reply appears under your comment. In the TUI the same exchange reads as normal chat. A refresh button sits in the bottom-right corner: it rebuilds the page against whatever the working tree holds right now — useful after editing outside the page — and lands you back on the file you were reading rather than at the top.

With no session listening, the page is written to `~/.ayin-cli/diffs/diff-<timestamp>.html` and opened as a `file://` URL — self-contained, no port, works on a machine with no network, and says on screen that comments are off, because there is no agent to send one to. A static file has no server to rebuild from, so it carries no refresh button and no index buttons either — staging is a git write and there is nothing listening; re-run `ayin diff` for a fresh page. Those files are pruned after 24 hours each time the command runs. Extension filters start collapsed to `.cs .asset .ts .js .py`; everything else is one click away, and the count of files hidden by the default filters is always shown on screen.

At the top of the page sits the **commit message**, read from `.git/COMMIT_EDITMSG` — the same file `git commit` prefills from, so what you see is what your editor will show. It is drafted from the diff, this repo's local Claude Code session (scoped to the current branch) and any Jira tickets named in the branch, the session, the recent commit subjects or the diff — and only after Jira has CONFIRMED that each ticket key is a real issue. **Draft** re-runs that now; when it declines it says why and lists the keys it saw, because a button that silently does nothing is indistinguishable from a broken one. No confirmed ticket means no model call at all.

The file list is split into **Staged** and **Unstaged**, each with its own count, and a file with changes on both sides appears in both — the diff you see under each heading is only that side's hunks. Every file card carries one index button (`stage` on an unstaged card, `unstage` on a staged one), and the top panel has a **Stage** button that applies your project type's policy.

In a Unity repo that policy stages `.anim`/`.controller` and `.prefab` whole; an `.asset` only when it lives under `Assets/` and is a ScriptableObject of a script in this project, so third-party assets and `ProjectSettings`/`EditorSettings` are left alone; a `.meta` only when its asset was staged; and a `.cs` **line by line** — a model picks out live debug output (`Debug.Log`, `print`, `Console.Write`, but not `Debug.LogError`), the rest is staged, and the debug lines stay behind as that file's remaining unstaged change. Every file it skipped says why, on the card. A non-Unity repo has no policy yet and the button stages nothing rather than guessing.

Reach for this to review a change before committing it, or to hand a colleague a branch comparison without a diff tool. Apart from the index — which only the buttons you press ever move, and only ever with `git add` and `git restore --staged`, never touching your working tree — it writes only inside `~/.ayin-cli/diffs`; nothing in the repo itself is touched.

## Options

    <rev>       compare against this instead of HEAD, e.g. `ayin diff main`
    --no-open   write the static file and print its path, open nothing (never serves)
    --help, -h  print usage and exit

## Examples

    ayin diff
    ayin diff main
    ayin diff --no-open
