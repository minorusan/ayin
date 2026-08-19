Undo the last commit and keep everything it contained.

`/git-softreset` runs `git reset --soft HEAD~1`: HEAD moves back one commit and that commit's content stays staged in the working tree. The commit that should not have been made is gone from history; the work it held is still in front of you, ready to be amended, split, or thrown away deliberately.

**Nothing is destroyed, which is why there is no stash here** — that is the whole difference from `/git-hardreset`. The old commit's sha is printed before and after, and it stays reachable through the reflog, so `git reset --hard <sha>` puts history back exactly as it was.

It asks first, naming the commit and how many files it touched, and it says so in that dialog when:

- the commit is **already on a remote** — undoing it locally means the next push rewrites history someone else may have pulled;
- HEAD is a **merge commit** — `--soft` resets to its first parent, dropping the other side of the merge from history.

A **root commit** is refused outright: `HEAD~1` does not exist, and git's own error ("ambiguous argument") explains nothing. Unmaking a repository's only commit is `git update-ref -d HEAD`, by hand, if you mean it.

For the working tree rather than history — discard edits, delete new files — use `/git-hardreset`.

## Examples

    /git-softreset
