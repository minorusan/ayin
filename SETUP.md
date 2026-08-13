# Setup guide

Get ayin running from a fresh clone — install, connect it to an LLM (this is the part that
matters), and run it as your terminal coding agent.

---

## 1. Prerequisites

- **Node ≥ 18** (Node 20+ recommended). Check: `node --version`.
- **A shell for the file tools** (they shell out to `grep`/`find`/`git`/etc):
  - macOS & Linux: uses `/bin/bash` — already present.
  - **Windows (native): install [Git for Windows](https://git-scm.com/download/win).** ayin
    auto-detects its bundled **Git Bash** (`…\Git\bin\bash.exe`) and runs tool commands through it,
    so the POSIX-style commands the model emits work. If Git Bash isn't found it falls back to
    `cmd.exe` (most tool commands won't work there). Override the shell with `AYIN_SHELL`
    (e.g. a WSL or MSYS bash path). WSL also works and needs no extra setup.
- **git** (for cloning; also used by some tools). On Windows, Git for Windows also runs the
  `ayin watch` git hooks (they're portable `#!/bin/sh`).

## 2. Clone, install, build

```bash
git clone --recursive <this-repo> ayin      # --recursive fetches naamah, the diagram renderer
cd ayin
npm install      # 3 deps: blessed (TUI), sharp (image downscale), undici — all public npm
npm run build    # tsc → dist/
```

This produces `dist/index.js`, the entry point you run.

---

## 3. Connect an LLM  ← **the important part**

ayin is just the agent loop — it brings **no model**. A **provider** connects it to one. Pick the
option that matches what you have; Option A is the one to use if you have Ollama.

### Option A — Local Ollama, spoken natively (recommended) 🦙

ayin talks to Ollama's own `/api/chat`, with nothing in between:

```bash
# 1. Install Ollama:  https://ollama.com/download
# 2. Pull a coding model (a MoE coder is a great fit for a 24GB GPU):
ollama pull qwen3-coder:30b
#    (smaller option for less VRAM:  ollama pull qwen2.5-coder:7b)

# 3. Run ayin:
AYIN_LLM_PROVIDER=ollama AYIN_OLLAMA_MODEL=qwen3-coder:30b node dist/index.js
```

Persist it once and drop the env vars: `/set llm-provider ollama`, `/set ollama-model …`.

**Why this one.** `/api/chat` accepts a `tools` array, so Ollama renders the schemas in the model's
own chat template and returns parsed tool calls. The model emits the syntax it was trained on, and
ayin's prompt drops its own 14-tool catalogue and format instructions entirely. Over the text
contract (Options B/C) neither is possible: the schemas have nowhere to go, and Qwen3-Coder's trained
`<tool_call>…</tool_call>` wrapper becomes a generation boundary — measured, a run ends with zero
tool calls.

| env | config key | default |
|---|---|---|
| `AYIN_OLLAMA_URL` | `ollamaUrl` | `http://127.0.0.1:11434` |
| `AYIN_OLLAMA_MODEL` | `ollamaModel` | whichever model is resident |
| `AYIN_OLLAMA_CTX` | `ollamaCtx` | `16384` |
| `AYIN_OLLAMA_THINK` | — | off |

On 16K: measured across agent runs of 12, 24 and 33 tool calls, no prompt exceeded ~8K tokens — the
loop bounds its own context on purpose. A bigger window is bought with VRAM that is no longer holding
layers; when 10 layers spilled to CPU the same work ran ~7× slower. Raise it only on a card with room.

### Option B — Any backend that serves the contract

ayin also speaks a deliberately tiny HTTP contract, so anything can serve it:

```
POST /api/generate   { messages, temperature?, thinking?, images? }  ->  { content }
GET  /api/status     ->  { ok: true, model }
```

`/api/status` is how ayin learns **which model** it's talking to, so it can pick the right
**dialect** (tool-call format). It finds the endpoint via, in priority order:

1. the **`AYIN_LLM_URL`** environment variable,
2. a persisted `llmUrl` in `~/.ayin-cli/prompts.json` (set once with `/set llm-url …`),
3. `http://localhost:9100` (the default).

```bash
AYIN_LLM_URL=http://<backend-host>:9100 node dist/index.js
# or persist it once inside the TUI:   /set llm-url http://<backend-host>:9100
```

A backend that additionally exposes an llm **resource** with an authority layer is detected by probe
and unlocks `/lock`, the model picker and GPU/queue telemetry. Nothing breaks without it — those
segments simply do not appear.

### Option C — Ollama behind the contract, via the bundled adapter

For when you want the contract shape rather than the native path — a shared endpoint several tools
point at, or a runtime that isn't Ollama sitting behind the same URL. A zero-dependency adapter is
bundled:

```bash
OLLAMA_MODEL=qwen3-coder:30b node examples/ollama-adapter.mjs      # terminal 1 → :9100
AYIN_LLM_URL=http://localhost:9100 node dist/index.js              # terminal 2
```

Env: `OLLAMA_MODEL` (required), `OLLAMA_URL` (default `http://localhost:11434`), `PORT` (default
`9100`), `NUM_CTX` (default `32768`). Tools are declared in the prompt here, not natively — prefer
Option A when you can.

### Option D — OpenAI, when a task is worth paying for

A hosted model, and **never selected automatically** — not by probe, not as a fallback when a local
endpoint blinks. A provider that can bill you is one you have to ask for:

```bash
export OPENAI_API_KEY=sk-…        # or, in the TUI:  /openai key sk-…

# in the TUI:
/openai                # switch on (reports the model), again to switch back to local
/openai <model>        # switch on with a specific model
```

The API takes function schemas and returns structured calls, so this is a native-tools provider too.
A rejected key drops you straight back to local rather than leaving a session that cannot generate.

---

## 4. Run it

**Interactive (TUI):**
```bash
AYIN_LLM_URL=http://localhost:9100 node dist/index.js
```
Type a task; ayin works in your **current directory**. Keys: `Ctrl+O` browse tool outputs,
`Ctrl+S` session summary, `Ctrl+C` quit. When a tool needs approval you get a y/a/n prompt.

**Scrolling the transcript:** the **mouse wheel**, `PageUp`/`PageDown`, or `Shift+↑`/`Shift+↓` for one
line. Plain `↑`/`↓` walk your **prompt history** instead (inside a multi-line prompt they move the
cursor between lines first, so history never eats what you were writing). Scrolling up stops following
live output; scroll back to the bottom to resume.

> The wheel needs terminal mouse reporting, which normally takes over text selection — **hold Shift
> while dragging** to select and copy as usual. If your terminal doesn't support that bypass, set
> `AYIN_MOUSE=0` for keyboard-only scrolling.

**Headless (one-shot, scriptable):**
```bash
cd /path/to/your/project
AYIN_LLM_URL=http://localhost:9100 node /path/to/ayin/dist/index.js -p "Add a /health route and a test for it, then run the tests."
```
In headless mode ayin auto-approves its own `write_file`/`bash` and runs until the task is
done (or it exhausts its round budget), printing a final summary. **Run it inside the repo
you want it to work on** — its tools use the current working directory.

> ⚠️ **Headless auto-approves file writes and shell commands.** Run it on code you can
> afford to have edited, ideally a git working tree you can diff/revert. There is no
> network sandbox — `bash` can do anything your shell can.

---

## 5. Configuration

Runtime **config** lives in **`~/.ayin-cli/prompts.json`** (created on first run, re-read on every
access — edits apply immediately). **Prompt text** lives in **`~/.ayin-cli/prompts/<namespace>/<id>.txt`**
— one file per prompt, copied there from the shipped defaults on first run and never overwritten
afterwards, so your edits survive every upgrade. Set config values from the TUI:

| Command | Effect |
|---------|--------|
| `/set llm-provider ollama` | talk to a local Ollama runtime directly (tools declared natively) |
| `/set ollama-model <name>` | which model that provider asks for (also `ollama-url`, `ollama-ctx`) |
| `/set llm-url http://host:9100` | the HTTP endpoint, for the contract-shaped providers |
| `/set openai-key <key>` | the hosted model's key, reached with `/openai` |
| `/set searxng-url http://host:8080` | optional: prefer your own SearXNG over DuckDuckGo (§6) |

`prompts.json` also holds tunables under `config`:

| Key | Default | Meaning |
|-----|---------|---------|
| `windowSize` | 20 | messages of history kept in the LLM context |
| `maxToolRounds` | 10 | max tool calls per task (interactive; headless runs longer) |
| `summaryMaxWords` | 180 | rolling-summary length cap |
| `qaMaxPasses` | 3 | QA gate: max review→fix passes after a completion report (`0` disables) |
| `qaMinAnswerChars` | 400 | how big a closing message counts as a completion report |
| `pollMinIntervalMs` | 15000 | tool guard: minimum gap between identical polls of `status` |
| `pollMaxPerTurn` | 6 | tool guard: identical polls allowed per turn before the call is blocked |
| `planMinChars` | 2000 | plan mode: prompt size that triggers the cross-feature triage (`0` disables) |
| `planExploreCalls` | 2 | plan mode: `explore` passes spent gathering context (each is real GPU time) |
| `planApiSearches` | 3 | plan mode: web searches spent on third-party API docs (mandatory when an API is involved) |
| `modelPickerMinSizeGiB` | 15 | `/model` popup: hides installed models smaller than this (`0` shows everything); never hides the active model |

### Editing prompts

Prompt text is **not** in `prompts.json`. Each prompt is its own `.txt` file under
`~/.ayin-cli/prompts/<namespace>/`, one namespace per subsystem:

| Namespace | Holds |
|---|---|
| `ayin` | the core loop — `system`, `summarizer`, `goal`, the QA/plan entry prompts, and the headless guardrails (critic, judge, CTA nudges, self-audit) |
| `watch` | the `ayin watch` daemon's reviewers — post-commit, post-merge, working-tree |
| `qa` | the QA gate's baseline criteria, one file each |
| `plan` | plan mode's exploration + API-research prompts |
| `explore` | the `explore` tool's investigation loop |
| `diagram` | the `diagram` tool's authoring + repair prompts |

Edit a file and the next call uses it — no rebuild, no restart. Rewriting these changes the bar ayin
holds itself to, which is the point. `ls ~/.ayin-cli/prompts/*` is the current list; a namespace only
appears once the code that owns it has run at least once.

Placeholders are `{{UPPER_SNAKE}}` and are filled by ayin; leave the ones you don't understand alone.
The tool-call **format** block is injected by the active **dialect** (see `docs/ARCHITECTURE.md`), so
you normally don't touch it. The shipped originals stay untouched in the package's `prompts/` folder;
upgrading never overwrites a file you edited, and only adds prompts that are genuinely new.

Kill switches, when you want the behaviour gone for one run rather than tuned:
`AYIN_QA=0` (no QA gate) · `AYIN_PLAN=0` (no plan mode) · `AYIN_PLAN_DIR` (where plans are written) ·
`AYIN_QA_PORT` / `AYIN_QA_PORT_DENY` (force or exclude a port in the webview reachability probe) ·
`AYIN_MOUSE=0` (no wheel scrolling; keyboard only).

---

## 6. Diagrams and design enforcement

`naama` authors a design as facts, one line each, into a `.puml`. `entangle <that file>` then checks every
write against it: a type the design does not declare, a public member it does not list, or a reference the
file's own assembly/package manifest forbids will not land, and the turn stops with the gap and your
options. Amending the design is a legitimate outcome — the point is that the change is *yours*, not one
made quietly mid-implementation.

`naama op=render` draws the design as a single self-contained page, via **naamah** — a submodule, since it
is a separate program that renders any `.puml` and ayin is only one of its callers. It needs
[plantuml](https://plantuml.com) on PATH.

Both degrade cleanly: cloned without `--recursive`, or with no plantuml, designs are still authored and
still enforced — you just do not get the picture, and ayin tells you which piece is missing.

```bash
git submodule update --init      # if you cloned without --recursive
```

## 7. Web search

`web_search` works with **no key, no container and nothing to install** — it queries DuckDuckGo
in-process and reads the top pages itself. Nothing to configure.

The one thing to know: DuckDuckGo rate-limits scrapers, answering with a challenge page instead of
results. ayin detects that and says so — *"was RATE-LIMITED, not empty"* — rather than reporting no
results, because those call for opposite responses from the agent. Requests are paced to avoid it, and
a blocked answer is never cached. If you search heavily and hit it often, run a
[SearXNG](https://github.com/searxng/searxng) instance and point ayin at it:

```bash
export AYIN_SEARXNG_URL=http://<host>:8080      # or, in the TUI:  /set searxng-url http://<host>:8080
```

Configured, it is tried first and DuckDuckGo becomes the fallback. Unconfigured, it is never contacted.

## 8. Optional tools

The tools that need something extra, and what each absence costs:

- **`diagram`, `arduino_diagram`, and `naama op=render`** — need [plantuml](https://plantuml.com) on PATH.
  Without it a design is still authored and still enforced; only the picture is missing.
- **`arduino_db`** works offline against a shipped catalogue — nothing to install.
- **Update check** — passive, and only ever asks a NON-public registry (`AYIN_UPDATE_REGISTRY`, or npm's
  own configured registry when that is not public npmjs). A fresh clone with neither contacts nothing.
  `AYIN_UPDATE_CHECK=0` turns it off entirely.

**Adding your own tools takes no fork.** Point `AYIN_TOOL_DIRS` (or `/set tool-dirs`) at a directory of
`.js` modules, each exporting `tool` or `tools`. A module that fails to load is reported rather than
silently missing, and a name that collides with a built-in is refused at boot.

## 9. Troubleshooting

- **`No reachable LLM backend at …`** — nothing is serving the contract at `AYIN_LLM_URL`.
  Start the Ollama adapter (Option A) or fix the URL. Verify: `curl $AYIN_LLM_URL/api/status`
  should return `{"ok":true,"model":"…"}`.
- **Wrong / garbled tool calls** — ayin picks its dialect from `/api/status`'s `model`
  field. If your model isn't recognised (not gemma/qwen), it defaults to the gemma dialect;
  add a dialect in `src/llm/dialects/` (a few lines — see `docs/ARCHITECTURE.md`).
- **Windows: tools do nothing / "not recognized"** — Git Bash wasn't found and ayin fell back
  to `cmd.exe`. Install Git for Windows, or set `AYIN_SHELL` to a bash path. Check which shell
  ayin resolved in the version/status line.
- **Slow first response** — the model is loading into VRAM on the first call; subsequent
  calls are fast.

## Windows deployment

ayin runs natively on Windows (no WSL required) once **Git for Windows** is installed — its Git
Bash is auto-detected and used for the file tools; the `ayin watch` git hooks are portable
`#!/bin/sh` and run through it.

- **Interactive / headless:** same as macOS/Linux — `node dist\index.js` (TUI) or `-p "…"`.
- **The watch daemon** (the launchd equivalent) installs as a **Task Scheduler** job that starts
  at logon and restarts on failure:
  ```powershell
  npm run build
  powershell -ExecutionPolicy Bypass -File tool\install-watch-windows.ps1 -LlmUrl http://<backend-host>:9100
  ayin watch --repo C:\path\to\repo    # register each repo to review
  ```
  Uninstall: `Unregister-ScheduledTask -TaskName AyinWatch -Confirm:$false`.
- **Shell override:** `AYIN_SHELL=C:\path\to\bash.exe` forces a specific POSIX shell (WSL/MSYS).
