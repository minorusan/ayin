Run the repo-watching daemon that reviews every commit landing in a git repository.

`ayin watch --repo <path>` chains a `post-commit` and `post-merge` git hook onto that repo (leaving any hook already there intact) and starts a daemon polling a shared queue at `~/.ayin-cli/watch/queue.jsonl`. The hooks only append one line per commit and never block it, so a downed daemon just leaves backlog to accumulate. On boot and after any interruption the daemon reviews everything not yet in `~/.ayin-cli/watch/processed.jsonl`, so a reboot or kill costs at most the one review in flight; every 5 minutes it also re-installs any hook a re-clone or reset removed. For each commit it sends a capped diff to the model against a catalog of code-smell signals and writes `reviews/<shortHash>/CodeReview.md` in the repo (or under `AYIN_REVIEW_DIR`), plus an `AssetDiff.md` for a Unity repo. It also writes a pointer block into `CLAUDE.md`/`GEMINI.md` naming pending reports, and installs a Claude Code Stop hook that, at the end of every turn, checks whether the C# types added in the working tree are on the repo's naamah design — no model, and it only ever nudges.

If `accelerator-endpoint` is set and that host answers, each watched Unity project is also kept pointed at it via `ProjectSettings/EditorSettings.asset` on install and on every self-heal; an unreachable endpoint is never written, and a previously-written one is never cleared.

Run with no `--repo` to start the daemon over already-registered repos — the form a login item or systemd unit should use. Only one instance runs; a second invocation reports the running pid and exits.

## Keeping the design in step with the source — `--weave`

`ayin watch --weave` adds a second kind of watch to a repo: the daemon keeps its naamah design diagram matching its source, continuously, on the working tree and before anything is committed. A diagram is written once during the conversation where it is useful and is wrong within a week — not through carelessness, but because updating it is a separate act performed by the one person who already knows what changed and therefore needs it least. So it is a daemon's job.

Run it in the repo you want kept current: `ayin watch --weave`, or name the file with `ayin watch --weave docs/design.puml`. Without a path the design is discovered the way the hound discovers it — the first tracked-or-untracked `.puml` that declares at least one type. A tree with no such file is an error, said while you are still looking at the terminal.

Every 15 seconds the daemon hashes the repo's source files (whatever `entangle` handles: C#, TypeScript/JavaScript, Dart) and compares the types and public members they declare against the ones the `.puml` declares. That comparison is a set operation — free, instant, the same every time — and most edits are method bodies, which are not a surface, so most passes cost one `git ls-files` and nothing else. Only a real surface delta spends a model.

When there is one, and once the tree has been **still for 45 seconds** (a refactor in progress emits a different delta on every save, and none of the intermediate ones is the answer), one headless ayin is spawned in the repo with the delta already computed: types added, types whose file is gone, types whose public members drifted, and types that merely moved between files. It reconciles the design with the `naama` tool — one fact per line, never a rewrite — then checks and re-renders it. It edits that one file and nothing else, and it never commits.

The result is verified rather than trusted: the design is re-parsed, re-validated and re-diffed after the run. A run that left work undone is retried with backoff, up to three attempts against the same delta, and the source snapshot advances **only** on success — so a machine that dies mid-weave recomputes the same delta on boot and runs it again.

First registration is a **baseline, not a job**: the snapshot is taken and any existing gap is reported but not woven, because catching up a years-old diagram in one run is a decision for you and a prompt nothing can act on. From then on it reacts to changes.

What it writes: `~/.ayin-cli/watch/weave-state.json` (the snapshot), `weave-log.jsonl` (one line per weave), and one log per run under `~/.ayin-cli/watch/weave/`. `ayin unwatch` removes the registration and drops the snapshot with it.

Note the direction: this makes the **design follow the code**. `entangle` is the opposite — it stops code that breaks the design. Do not point `--weave` at a design you are entangling to, or the contract will amend itself to match whatever was just written.

## Options

    --repo <path>       install the hooks in this repo and register it for watching
    --weave [design]    also keep this repo's naamah design matching its source (see above);
                        implies --repo . when no --repo is given
    --once              process the current backlog for all watched repos, then exit

## Examples

    ayin watch --repo ~/project
    ayin watch
    ayin watch --once
    ayin watch --weave
    ayin watch --weave docs/specs/engine.puml
