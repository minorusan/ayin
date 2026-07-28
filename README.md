# ayin

**A small, model-agnostic terminal coding agent.** ayin runs an agentic loop in your
shell — read, search, edit, run, iterate — driven by an open-weights LLM you host
yourself (Ollama, or any compatible endpoint). It has both a full-screen TUI and a
headless mode for scripting and automation.

> **ayin** (עין) — "eye". A small agent that looks at your code and acts.

```
┌──────────────────────────────────────────────┐
│  > add a /health endpoint and a test for it   │
│                                                │
│  ⠹ Running bash(npm test) 3s                  │
│  ● connected  qwen3-coder:30b   1.2k/32k tok  │
└──────────────────────────────────────────────┘
```

## Why ayin

- **Local-first & open.** No SaaS, no API key required. Point it at your own Ollama
  server (or OpenAI if you prefer). Your code never leaves your machine.
- **Model-agnostic.** A small **LLM-manager + dialect** layer (`src/llm/`) isolates the
  only thing that differs between models — how tool calls are formatted and parsed — so
  ayin works with **gemma**, **Qwen3-Coder**, and is a ~30-line dialect away from any
  other. The active model is detected at runtime; the right dialect is selected
  automatically. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- **Text tool-calling.** Works with models that don't have a native function-calling API —
  ayin uses the XML tool-call convention (`<function=…><parameter=…>`) that open coder
  models emit, with a lenient parser that tolerates each model's quirks.
- **Headless or interactive.** A blessed TUI for live work; `-p "task"` for one-shot,
  scriptable runs (CI, batch jobs, parent agents).

## Quickstart

```bash
git clone <this-repo> ayin && cd ayin
npm install
npm run build

# Connect to a local Ollama model via the bundled adapter (see SETUP.md for details):
OLLAMA_MODEL=qwen3-coder:30b node examples/ollama-adapter.mjs &      # terminal 1
KELI_URL=http://localhost:9100 node dist/index.js                    # terminal 2 (TUI)

# …or one-shot headless:
KELI_URL=http://localhost:9100 node dist/index.js -p "Explain what src/agent.ts does"
```

**Full instructions — including the three ways to connect an LLM — are in
[`SETUP.md`](SETUP.md).**

### Installing from a registry

If ayin is published to an npm registry (a private one is fine — that is how it's distributed on
the author's LAN), you can skip the checkout entirely:

```bash
npm i -g ayin --registry http://<registry-host>:4873
ayin                      # TUI
ayin version              # what you're running
ayin update               # fetch + install the newest build
ayin update --check       # report only, install nothing
```

`ayin update` resolves the registry from `--registry` → `AYIN_UPDATE_REGISTRY` →
`/set update-registry <url>` (persisted per machine) → npm's own configured registry, and shells out
to `npm i -g` so a half-finished download can never replace a working binary. If the global prefix
isn't writable it tells you to re-run with `sudo`. Running from a source checkout, it says so —
there, updating is `git pull && npm run build`.

> **`ayin` is a taken name on public npm, and that package is not this one.** `ayin update` therefore
> **refuses** to fall back to registry.npmjs.org: a machine whose npm defaulted to the public
> registry resolved `latest` to a stranger's `0.0.2`, and only the "local build is ahead" check
> stopped it — `--force` would have installed someone else's code over the agent. Point it at your
> own registry once with `/set update-registry http://<host>:4873`. Passing
> `--registry https://registry.npmjs.org/` explicitly is still honoured, with a warning.

The status bar carries `↑ vX available` when the registry has a newer build (checked at boot and
every 10 min). It only ever asks a **private** registry — `AYIN_UPDATE_REGISTRY`, or npm's own
configured registry when that isn't public npmjs — so a fresh checkout never phones home uninvited
and can't be told a stranger's `ayin` package is your update. `AYIN_UPDATE_CHECK=0` turns it off.

### `/fix` — ayin fixing itself

From inside the TUI:

```
/fix the status bar should show the git branch in bold
```

ayin writes the request into its own codebase (`fixes/fix-<id>.md`) and runs **headless Claude
Code** over the source checkout. Claude implements it — typecheck, build, docs, version bump,
commit, publish — or writes `fixes/rejection-<id>.md` saying what it would need instead, and stops.

- `/fix` — the board: what's running, what's queued, what was refused
- `/fix show <id>` — read a rejection · `/fix clear` — acknowledge them
- A bold red **FIX REJECTED** sits in the status bar until you acknowledge it.

Runs are **detached and queued on disk**: closing ayin doesn't stop one, and a run interrupted by a
crash or a power cut is requeued automatically at the next start. Requires a source checkout
(`AYIN_REPO`) and the `claude` binary (`AYIN_CLAUDE_BIN`).

## Tools

ayin's loop calls these tools (each is a unique name; the model invokes them by name):

| Tool | What it does | Notes |
|------|--------------|-------|
| `read_file` | Read a file (line numbers, optional offset/limit) | auto-approved |
| `grep` | Regex search across files | auto-approved |
| `find_files` | Find files by glob | auto-approved |
| `write_file` | Create / overwrite a file | approval (auto in headless) |
| `str_replace` | Surgical single-match edit of an existing file | approval; **preferred for edits** |
| `bash` | Run a shell command | approval (auto in headless) |
| `explore` | A focused sub-investigation with its own mini agent loop | for "find/read X" questions |
| `diagram` | **PlantUML diagram, validated in a loop** until it really parses | needs `plantuml` to verify + render |
| `status` | Check progress of backgrounded tools | — |
| `web_search` | Web search | optional — needs a search backend (see SETUP) |
| `codex` | Hand a hard research task to the OpenAI Codex CLI | optional — needs Codex installed + a key |
| `jira` | Run a JQL query | optional — needs Jira creds |
| `fixme` | Rewrite ayin's own persona prompts in a requested style | fun/meta |

The **core eight** (`read_file`, `grep`, `find_files`, `write_file`, `str_replace`, `bash`,
`explore`, `status`) need nothing but Node + a POSIX shell. The rest are optional
integrations you can ignore.

Every tool lives **inside this repo** — a static array in `src/tools.ts`, resolved by unique name, with
no plugin directory and no runtime discovery. Adding one means adding a `Tool` there and shipping a
build; the upside is that a release cannot half-work because a plugin was missing.

**Repeats are policed** (`tool-guard.ts`). A second identical call in one turn is skipped with the
result you already have; a third is **blocked for the rest of the turn** and named in the system prompt
so it can't scroll out of view; a call you *denied* is dead immediately. Polling is the one legitimate
repeat, so `status` keeps working — rate-limited, with an explicit "don't poll again for Ns", capped at
6 per turn. A blocked `bash` call is told its way out: `sleep 5; <command>` is a different call and runs.

## Plan mode — big requests get a plan first

**Say so and it plans, at any size** — "plan it", "plan the auth rewrite", "deep investigate the
codebase", "deep dive", "think it through first", or `/plan <text>` for the no-ambiguity door. An
explicit ask cannot be vetoed by triage; you asked, so it plans.

Otherwise a prompt of 2000+ characters is triaged in one cheap call: is this actually cross-feature? If it is,
ayin surveys the project, explores the relevant code, and writes **`ayin-plan-<timestamp>.md`** —
reasoning, existing context, dependencies, **third-party API research**, **gaps** (each with how to
resolve it, never a guess), a files-to-change table, ordered steps, **log coverage and debugging**, and
risks.

**If the work touches somebody else's API, looking it up is mandatory.** The same triage call names the
services involved, and each is researched on the web *before the plan is written* — current base URL,
auth scheme, endpoints, rate limits, deprecations, with sources cited. This is the one thing a model must
never answer from memory: auth schemes get replaced and fields renamed after training, so recalled API
code looks perfectly reasonable, passes review, and fails only against the live service. If a lookup
fails, the plan marks those details **UNVERIFIED** and makes reading the vendor's docs step one. The QA
gate then enforces the other half: a change that talks to an external API and shows no sign the current
API was checked is failed. Only then does your
prompt reach the model, with the plan already in context.

The plan is on disk *before* implementation starts, so an interrupted machine leaves the thinking
behind rather than half a feature. `AYIN_PLAN=0` opts out; `planMinChars` / `planExploreCalls` tune it.

## QA gate — the completion report gets checked

When a turn changed files **and** ayin's closing message reads like "done, I've implemented X", that
claim is reviewed before you have to trust it:

1. **Intent** is read from *your own prompts* this session (off the session record on disk), not from
   the agent's summary of them.
2. **Acceptance criteria** are written *before* the changed files are looked at — a reviewer shown the
   answer first invents criteria the answer passes. Standing bars apply by file kind: UI is never left
   looking like an MVP; a webview is actually reachable from another machine; one responsibility per
   module; a README exists and still matches; markdown uses the format's range.
3. **Probes** measure what reading can't: a real HTTP GET on loopback *and* on the LAN address, so
   "running but loopback-only" is caught — the failure that looks perfect on the machine that built it
   and is invisible from your phone. Plus README staleness, markdown richness, structural SRP signals.
4. **Verdict** — long investigation, short answer. Pass: one line. Fail: each issue names the file and
   the fix, ayin repairs them and is reviewed again, up to 3 passes, then reports honestly what it could
   not fix.

`AYIN_QA=0` opts out; `qaMaxPasses` / `qaMinAnswerChars` tune it. The reviewer's prompts (`qaCriteria`,
`qaReview`) live in `prompts.json` like every other prompt, so you can rewrite the bar yourself.

### You can always see when a gate is running

Both gates spend GPU time on work you didn't directly ask for, so neither is allowed to hide behind a
generic spinner. While one is active the thinking line names it and keeps the queue detail that tells
you *why* it's slow:

```
▍ ⠹ PLAN · researching the Stripe API (current docs, not recall) · ⏳ queued #2/3      1m12s
▍ ⠹ QA 1/3 · reviewing 4 artifacts against 7 criteria · ▸ generating on qwen3.6:27b     41s
```

and the status bar carries a `▣ PLAN` / `▣ QA 1/3` chip that stays lit through the parts with no model
call at all — probing ports, snapshotting git, writing the plan file. The transcript records the
decisions too: which features triage found, where the plan was written, and a verdict card for every QA
pass. Ctrl+C during a gate stops it like anything else.

### Diagrams — "I don't understand, explain better"

Say that, or anything like it, and ayin draws the picture *before* it answers:

```
❯ I don't understand how the fix queue works — explain better
Diagram: /home/you/project/i-don-t-understand-how-the-fix-queue-works.puml
◉ …walks you through the diagram it just wrote…
```

Two ways in. The `diagram` tool the model can call, and a **deterministic trigger** — the phrases
above (`diagram`, `visualise`, `puml`, `flowchart`, `explain better`, `don't understand`, `unclear`,
`confused`, `draw`…) run the diagram pass *before* the base call and pre-prompt its result, so the
answer is written around a picture that already exists. `AYIN_DIAGRAM=0` opts out.

It's a **loop, not a one-shot**, because models get PlantUML syntax wrong often enough that a
single-shot tool would mostly write broken files. Each round is validated by the real renderer
(`plantuml -syntax`, which reports `ERROR / <line> / <message>`), and the error is fed back verbatim
for repair — up to 4 rounds. So a returned diagram always parses; a failing one is saved as
`*.invalid.puml` with the error, rather than reported as success.

Output lands next to your work (`<subject-slug>.puml` + a rendered `.svg`), and is opened in VS Code
when the `code` CLI is on PATH — otherwise it's simply left in place and referenced by path.

- **Nothing leaves your machine.** PlantUML's public server would render in one HTTP call, but a
  diagram of your architecture is exactly what not to POST to a third party. Rendering is local;
  point `AYIN_PUML_SERVER` at your own PlantUML/Kroki instance if you want remote.
- Without `plantuml` installed the file is still written, checked structurally, and clearly labelled
  as unverified.
- **Install a current PlantUML, not your distro's.** Because the validator is ground truth, a stale
  renderer rejects source that is perfectly valid — Ubuntu 24.04 still ships 1.2020.2, which fails on
  `!theme`, newer C4/mindmap syntax and much else, so the repair loop burns its rounds "fixing" code
  that was never broken. Drop the release jar from
  [plantuml/plantuml](https://github.com/plantuml/plantuml/releases) somewhere like
  `/usr/local/lib/plantuml/plantuml.jar` with a one-line `exec java -Djava.awt.headless=true -jar …`
  wrapper earlier on `PATH`, or just point `AYIN_PUML_BIN` at it. Needs a JRE, plus Graphviz (`dot`)
  for class/component diagrams; sequence and mindmap diagrams render without it.
- `!include` / `!includeurl` are stripped from generated source — PlantUML resolves those at render
  time (reading local files, fetching URLs into the image), which is an exfiltration path for
  anything that can influence the model's output.

Env: `AYIN_PUML_BIN` · `AYIN_PUML_DIR` · `AYIN_PUML_RENDER` (`svg`|`png`|`0`) · `AYIN_PUML_OPEN`
(`auto`|`0`).

## Repo watcher — automatic post-commit code review

```bash
ayin watch --repo /path/to/your/repo        # install the hook + run the daemon (foreground)
ayin watch --once                           # process any queued commits, then exit
```

`ayin watch` installs a `post-commit` hook in the target repo and runs a persistent daemon.
Every commit is queued (a JSON line in `~/.ayin-cli/watch/queue.jsonl`) and reviewed by the
LLM against a catalog of ~20 typical code-smell signals (long functions, swallowed errors,
race conditions, hardcoded secrets, injection risk, unbounded memory, …); each finding is
reported **with a confidence score**. The review lands as `CodeReview-<shortHash>.md` in the
repo root — commit metadata first, then the findings, then a verdict.

Reviews are LLM work, so the daemon takes the backend's **llm resource as the `ayin`
authority** for each review batch (the backend swaps to the coder model, and reverts when the
batch drains — the same dance as interactive ayin). If the resource is busy, reviews are
**deferred**, not run on the side; a backend without the resource layer falls back to
best-effort on the served model.

Built to survive interruption: the hook never blocks a commit and never needs the daemon up —
the queue accumulates, and on its next start the daemon processes the whole backlog (a
processed-ledger keeps reviews exactly-once; a crash mid-review just re-runs it). One daemon
serves any number of watched repos. Commits that only touch `CodeReview-*.md` are skipped, so
committing a review never triggers a review of the review.

To keep it running on macOS: `nohup ayin watch --repo <repo> &`, or wrap it in a launchd
agent with `KeepAlive` — the daemon is safe to kill and restart at any point.

**Repo hygiene** — alongside the hooks, `ayin watch` maintains two managed blocks in every watched
repo (and re-asserts them in the 5-min self-heal, so a reset or fresh clone gets them back):

- `.gitignore` — a `# >>> ayin:local-cruft >>>` block ignoring the local dev cruft that must never
  be committed: ayin's own `AYIN-REPORT-*` / `CodeReview-*` / `AssetDiff-*` reports, `system_specs.md`
  / `.txt` (machine hardware dumps — hostname/serial/UUID), `STUDY_PERF-*/` scratch notes,
  `.claude/hooks/`, and the local-only `Assets/LiveOpsHub` + `Assets/Plugins/AltTester` folders.
- `CLAUDE.md` **and** `GEMINI.md` — an `<!-- ayin:hygiene:begin -->` block quoting the same list as
  an instruction, so Claude Code / Gemini CLI don't stage those paths either. The same two files
  also carry the `<!-- ayin:reports:begin -->` pointer to pending reports.

Only the fenced regions are touched — the rest of each file is yours, and a file is written only
when its bytes actually change. `AYIN_WATCH_HYGIENE=0` turns the whole thing off. Note that
`.gitignore` only affects *untracked* files: cruft already tracked in the repo needs a one-time
`git rm --cached`.

**Unity repos** (`Assets/` + `ProjectSettings/`) get **two files per commit**:
`CodeReview-<hash>.md` (the LLM review) and `AssetDiff-<hash>.md` — a **deterministic asset
diff** from the external `unity_asset_diff` tool: object-level changes with full hierarchy
paths (`MonoBehaviour at Path/To/Object · field old → new`) for prefabs/scenes/assets. The
review links to it and the reviewer is fed its content as ground truth. Tool path:
`~/tools/unity_asset_diff.py` or `AYIN_UNITY_DIFF`. Non-Unity repos never spawn it and get
only the review file.

## Requirements

- **Node ≥ 18** (uses global `fetch` + `AbortSignal.timeout`; Node 20+ recommended).
- A **POSIX shell** at `/bin/bash` — present on macOS and Linux. On Windows, run ayin under
  **WSL** (the file tools shell out to `bash`/`grep`/`find`).
- An **LLM endpoint** (local Ollama via the bundled adapter, any compatible backend, or OpenAI).
  See [`SETUP.md`](SETUP.md).

## Configuration

Runtime config and prompts live in `~/.ayin-cli/prompts.json` (created on first run, edited
live — changes take effect immediately). Set values from inside the TUI with `/set`:

```
/set keli-url http://localhost:9100     # the LLM endpoint ayin talks to
/set openai-key <your-api-key>          # optional OpenAI fallback
```

See [`SETUP.md`](SETUP.md) for the full list and the prompt schema.

## Documentation

- [`SETUP.md`](SETUP.md) — install, connect an LLM (Ollama / backend / OpenAI), run.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the agent loop, the LLM manager &
  dialects, tools, parser, and how everything fits.

## License

[MIT](LICENSE).
