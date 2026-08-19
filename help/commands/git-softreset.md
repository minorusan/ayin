Reset the files that existed, keep the ones the agent created.

`/git-softreset` runs `git reset --hard` and stops there: tracked files go back to HEAD, untracked files stay exactly where they are. That is the right one after a turn that wrote something worth reading — a new module, a report, a scratch script — while mangling files that were already in the repo.

Like `/git-hardreset` it stashes first (tracked changes only, since nothing untracked is at risk), asks before doing anything, names the counts, and prints the `git stash pop` that brings the previous state back. If the stash fails, nothing is reset.

The name is about SCOPE, not about `git reset --soft`: this does not move HEAD and does not touch your commits, it only decides whether untracked files are deleted.

## Examples

    /git-softreset
