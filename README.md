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

`ayin update` resolves the registry from `--registry` → `AYIN_UPDATE_REGISTRY` → whatever npm
itself is configured with, and shells out to `npm i -g` so a half-finished download can never
replace a working binary. If the global prefix isn't writable it tells you to re-run with `sudo`.
Running from a source checkout, it says so — there, updating is `git pull && npm run build`.

The passive "vX available" hint in the status bar stays **opt-in** (`AYIN_UPDATE_REGISTRY`): a
fresh checkout never contacts a registry you didn't configure.

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
| `status` | Check progress of backgrounded tools | — |
| `web_search` | Web search | optional — needs a search backend (see SETUP) |
| `docs_search` | Semantic search over a project's docs | optional — needs a backend endpoint |
| `codex` | Hand a hard research task to the OpenAI Codex CLI | optional — needs Codex installed + a key |
| `jira` | Run a JQL query | optional — needs Jira creds |
| `fixme` | Rewrite ayin's own persona prompts in a requested style | fun/meta |

The **core eight** (`read_file`, `grep`, `find_files`, `write_file`, `str_replace`, `bash`,
`explore`, `status`) need nothing but Node + a POSIX shell. The rest are optional
integrations you can ignore.

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

## RAG corpus generator

```bash
ayin rag --repo /path/to/repo --questions "How does X work?" "Where is Y handled?"
```

For each question ayin runs a real investigation against the repo (explore: commands,
excerpts) and synthesizes a detailed **grounded** markdown answer — every claim cites files
and quotes code verbatim. After the initial questions are answered, it generates **5 more
close-to-domain questions per initial question** and answers those too.

A **fabrication guard** keeps the corpus honest: every code block the model "quotes" is
verified against the investigation data; unverifiable blocks trigger one re-synthesis and are
otherwise stripped with a visible warning (and `groundingWarnings` in the doc's meta).

Every answer is saved through the backend **logs resource** (`rag.save`) into a per-repo
store on the backend host (`~/.maradel/logs/rag/<repoKey>/<slug>.md` + `.json`) — the corpus
for later chunking/vectorising/retrieval. Runs are resume-safe: docs already in the store are
skipped on re-run, and generated follow-up questions are persisted before being answered, so
an interrupted run re-uses the same set. The LLM is held as the `ayin` authority for the whole
run and released on exit.

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
