Undo everything a turn did to the working tree — including files it created.

`/git-hardreset` is the two commands you would type anyway (`git reset --hard` then `git clean -fd`) behind one keystroke, with the part that makes them survivable done for you. Tracked files go back to HEAD and untracked files are deleted, so the tree matches the last commit exactly.

**Everything is stashed first, and that is not optional.** `git clean -fd` deletes work no commit and no reflog has ever seen — a file the agent just created is simply gone. So a `git stash push --include-untracked` runs before anything else, labelled with the time; if the stash fails, nothing is reset and your tree is untouched. The reset and clean still run afterwards, so you get the clean tree you asked for, and the previous one is one `git stash pop` away.

It asks first, naming how many tracked and untracked changes are about to go and what HEAD is. Esc cancels and touches nothing.

Use `/git-softreset` when the agent created new files worth keeping.

## Examples

    /git-hardreset
