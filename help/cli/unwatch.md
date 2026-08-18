Stop watching a repository and remove everything `ayin watch` installed into it.

Deleting a hook by hand does not stop the watching — the daemon's self-heal re-adds a missing hook within five minutes, because a missing hook looks identical to a fresh clone. `ayin unwatch` is the one command that actually ends it: it removes what is ayin's from each hook file first and deregisters the repo from `~/.ayin-cli/watch/repos.json` last — that order is deliberate, so an interrupted run leaves the repo registered and self-healing rather than half-unhooked and forgotten. A hook that is entirely ours is deleted outright; a hook ayin chained onto an existing one (git-lfs, husky) has only the fenced block removed, byte-exact, leaving the host hook untouched; a hook it does not recognize at all is reported and left alone. It also removes the `ayin-hound.mjs` Stop-hook script and its entry from `.claude/settings.json`, deleting the whole `Stop` key only if nothing else uses it. The queue and past review reports under `~/.ayin-cli/watch` are kept — `ayin watch --repo <path>` re-adds a repo later without losing that history.

Use `--stop` to just kill the daemon process without touching any repo's hooks or its registration, so watching resumes on the next `ayin watch`. With no target and no `--all`, it acts on the current directory's repo.

## Options

    --repo <path>   the repo to unwatch (default: current directory's repo)
    --all           unwatch every currently registered repo
    --stop          stop the daemon process only; hooks and registration are untouched

## Examples

    ayin unwatch
    ayin unwatch --repo ~/project
    ayin unwatch --all
    ayin unwatch --stop
