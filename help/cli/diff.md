Render the working tree as a reviewable HTML page and open it.

`ayin diff [<rev>]` collects staged, unstaged and untracked changes against HEAD (or against `<rev>` when given, e.g. `main` to review a whole branch) and shows them as a review page.

With an ayin session open on the same repo, the page is SERVED by that session and the browser is pointed at its URL. That page is live: hover any line for a comment box, and what you write starts its own headless ayin on that repo — one comment, one run, so two comments are answered in parallel and neither waits for whatever the session is doing. Everything the run says shows up under your comment as it works, small and quiet; when it has made the change the page reloads itself against the new working tree and the reply lands last, larger, folding away if it is long. It is rendered as markdown — headings, bullets, inline symbols and fenced code all read as they were written rather than as raw asterisks. A refresh button sits in the bottom-right corner: it rebuilds the page against whatever the working tree holds right now — useful after editing outside the page — and lands you back on the file you were reading rather than at the top. Above it sits a red trashcan that discards uncommitted code, and above that a red X that clears every review comment in the repo; both ask first, and neither does the other's job.

With no session listening, the page is written to `~/.ayin-cli/diffs/diff-<timestamp>.html` and opened as a `file://` URL — self-contained, no port, works on a machine with no network, and says on screen that comments are off, because there is no agent to send one to. A static file has no server to rebuild from, so it carries no refresh button and no index buttons either — staging is a git write and there is nothing listening; re-run `ayin diff` for a fresh page. Those files are pruned after 24 hours each time the command runs. Extension filters start collapsed to `.cs .asset .ts .js .py`; everything else is one click away, and the count of files hidden by the default filters is always shown on screen. Your selection is remembered in a cookie, so the next page opens with the chips you left on — `defaults` puts the shipped set back.

At the top of the page sit two editable fields — **Subject** and **Description** — read from `.git/COMMIT_EDITMSG` — the same file `git commit` prefills from, so what you see is what your editor will show. It is drafted from the diff, this repo's local Claude Code session (scoped to the current branch) and any Jira tickets named in the branch, the session, the recent commit subjects or the diff — and only after Jira has CONFIRMED that each ticket key is a real issue. Everything it looks at is **staged** — `git commit` takes the index, so unstaged edits are never described.

**Draft** re-runs that pipeline now; when it declines it says why and lists the keys it saw, because a button that silently does nothing is indistinguishable from a broken one. No confirmed ticket means no model call at all. **rephrase** refits the subject alone against the staged diff, leaving your description untouched. The subject counter turns red past 50 characters — git's own convention — and nothing is truncated; with two ticket keys in the line, 50 is often out of reach and the red is there to tell you so. **Commit** opens a read-only preview first: the exact files the index holds, the subject, and the description as they will be written. Nothing there is editable — change the text in the fields behind it — and the Commit inside the sheet is what actually commits, printing the sha plus `git reset --soft HEAD~1` to undo it. Escape or a click outside closes it.

A message git left behind from an earlier `git commit` is not treated as a draft: ayin stamps which HEAD its draft describes, so once you commit, the panel goes back to saying there is none.

In the file list each row carries a small icon: the **shape** says what kind of file it is — code, prefab, scene, ScriptableObject, animation, image, audio, material, `.meta` sidecar, config, prose, compiled blob — and the **colour** says its git status, green added, amber modified, red deleted, blue renamed. Hovering names both.

The file list is split into **Staged** and **Unstaged**, each with its own count, and a file with changes on both sides appears in both — the diff you see under each heading is only that side's hunks. Every file card carries one index button — a green **+** to stage, a quiet **−** to unstage —, and the top panel has a **Stage** button that applies your project type's policy.

In a Unity repo that policy stages `.anim`/`.controller` and `.prefab` whole; an `.asset` only when it lives under `Assets/` and is a ScriptableObject of a script in this project, so third-party assets and `ProjectSettings`/`EditorSettings` are left alone; a `.meta` only when its asset was staged; and a `.cs` **line by line** — a model picks out live debug output (`Debug.Log`, `print`, `Console.Write`, but not `Debug.LogError`), the rest is staged, and the debug lines stay behind as that file's remaining unstaged change. Every file it skipped says why, on the card. A non-Unity repo has no policy yet and the button stages nothing rather than guessing.

A **red trashcan** sits above the refresh button, and every file card has a small one of its own. The FAB runs `git reset --hard && git clean -fd` on the whole tree; the per-file one restores that file to HEAD, or deletes it when it is untracked. Both ask first, and the dialog lists the files by name — untracked ones separately, because those are deleted outright and git cannot bring them back. Each extension chip has a bin too, which discards every changed file of that type and nothing else. Files matched by `.gitignore` are never touched by any of the three. **There is no undo for any of them.**

Reach for this to review a change before committing it, or to hand a colleague a branch comparison without a diff tool. Apart from the index — which only the buttons you press ever move, and only ever with `git add` and `git restore --staged`, never touching your working tree — it writes only inside `~/.ayin-cli/diffs`; nothing in the repo itself is touched.

## Options

    <rev>       compare against this instead of HEAD, e.g. `ayin diff main`
    --no-open   write the static file and print its path, open nothing (never serves)
    --help, -h  print usage and exit

## Examples

    ayin diff
    ayin diff main
    ayin diff --no-open
