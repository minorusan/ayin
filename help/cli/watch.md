Run the repo-watching daemon that reviews every commit landing in a git repository.

`ayin watch --repo <path>` chains a `post-commit` and `post-merge` git hook onto that repo (leaving any hook already there intact) and starts a daemon polling a shared queue at `~/.ayin-cli/watch/queue.jsonl`. The hooks only append one line per commit and never block it, so a downed daemon just leaves backlog to accumulate. On boot and after any interruption the daemon reviews everything not yet in `~/.ayin-cli/watch/processed.jsonl`, so a reboot or kill costs at most the one review in flight; every 5 minutes it also re-installs any hook a re-clone or reset removed. For each commit it sends a capped diff to the model against a catalog of code-smell signals and writes `reviews/<shortHash>/CodeReview.md` in the repo (or under `AYIN_REVIEW_DIR`), plus an `AssetDiff.md` for a Unity repo. It also writes a pointer block into `CLAUDE.md`/`GEMINI.md` naming pending reports, and installs a Claude Code Stop hook that checks staged changes at the end of every turn.

Run with no `--repo` to start the daemon over already-registered repos — the form a login item or systemd unit should use. Only one instance runs; a second invocation reports the running pid and exits.

## Options

    --repo <path>   install the hooks in this repo and register it for watching
    --once          process the current backlog for all watched repos, then exit

## Examples

    ayin watch --repo ~/project
    ayin watch
    ayin watch --once
