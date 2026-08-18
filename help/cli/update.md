Update ayin to the newest build available to this machine.

When the running binary resolves to a git checkout — the normal case, since ayin is distributed as a repo rather than a plain npm package — `ayin update` operates on it directly: fetch, refuse to pull over uncommitted changes other than its own lockfile, `git pull --ff-only`, reinstall dependencies, rebuild, and re-point the global `ayin` command at the checkout with `npm link` if it did not already resolve there. A detached HEAD is refused; check out a branch first. Otherwise it installs `ayin@<tag>` from a registry resolved from `--registry`, `AYIN_UPDATE_REGISTRY`, the `updateRegistry` setting, or npm's own config — and refuses the public npm registry as a fallback, since `ayin` there belongs to someone else; an explicit `--registry` pointed at it is still honored, with a warning. On success it restarts a running `ayin watch` daemon so it picks up the new build immediately.

`--check` reports what would happen without touching anything. The same passive check runs every 10 minutes in the interactive TUI, showing a hint in the status bar; this command is what applies it.

## Options

    --check             report what would update, without doing it
    --registry <url>    use this registry instead of the configured one
    --tag <dist-tag>    dist-tag to install (default: latest)
    --force             reinstall/pull even when already up to date, or over a dirty tree

## Examples

    ayin update
    ayin update --check
    ayin update --registry http://<host>:4873
