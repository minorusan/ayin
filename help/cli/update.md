Update ayin to the newest build available to this machine.

When the running binary resolves to a git checkout — the normal case, since ayin is distributed as a repo rather than a plain npm package — `ayin update` operates on it directly: fetch, refuse to pull over uncommitted changes other than its own lockfile, `git pull --ff-only`, reinstall dependencies, rebuild, and re-point the global `ayin` command at the checkout with `npm link` if it did not already resolve there. A detached HEAD is refused; check out a branch first. Otherwise it installs `ayin@<tag>` from a registry resolved from `--registry`, `AYIN_UPDATE_REGISTRY`, the `updateRegistry` setting, or npm's own config — and refuses the public npm registry as a fallback, since `ayin` there belongs to someone else; an explicit `--registry` pointed at it is still honored, with a warning. On success it restarts a running `ayin watch` daemon so it picks up the new build immediately — through `launchctl kickstart` when launchd owns that daemon, because killing a launchd job and spawning a replacement is a race launchd wins, and it wins with whatever path its plist names. A plist still pointing at an old checkout is how every update can report success while the daemon stays behind.

`--check` reports what would happen without touching anything. The same passive check runs every 10 minutes in the interactive TUI, showing a hint in the status bar; this command is what applies it.

## Options

    --check             report what would update, without doing it
    --registry <url>    use this registry instead of the configured one
    --tag <dist-tag>    dist-tag to install (default: latest)
    --force             reinstall/pull even when already up to date. Over a DIRTY tree it stashes the
                        uncommitted changes (labelled, recoverable with `git stash pop`) so the pull
                        can land — it used to skip the guard and then fail inside git, doing nothing.
    --registry          bare: install the PUBLISHED build from the configured registry, even when the
                        running ayin resolves to a git checkout

## Examples

    ayin update
    ayin update --check
    ayin update --registry
    ayin update --registry http://<host>:4873
