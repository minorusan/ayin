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
git clone <this-repo> ayin
cd ayin
npm install      # blessed (TUI), sharp (image downscale), undici, telegram — all public npm
npm run build    # tsc → dist/
```

This produces `dist/index.js`, the entry point you run.

---

## 3. Connect an LLM  ← **the important part**

ayin is just the agent loop — it brings **no model**. It talks to an LLM over a tiny HTTP
contract (deliberately small, so anything can serve it):

```
POST /api/generate   { messages, temperature?, thinking?, images? }  ->  { content }
GET  /api/status     ->  { ok: true, model }
```

`/api/status` is how ayin learns **which model** it's talking to, so it can pick the right
**dialect** (tool-call format). ayin finds the endpoint via, in priority order:

1. the **`KELI_URL`** environment variable,
2. a persisted `keliUrl` in `~/.ayin-cli/prompts.json` (set once with `/set keli-url …`),
3. `http://localhost:9100` (the default).

Pick **one** of the three options below.

### Option A — Local Ollama (recommended, fully local) 🦙

> **Important:** ayin does **not** speak Ollama's native API. Ollama exposes `/api/chat`
> with a different request/response shape. So you run a tiny **adapter** (bundled, zero
> dependencies) that maps ayin's contract onto Ollama. That's all that's needed for ayin
> to connect to Ollama.

```bash
# 1. Install Ollama:  https://ollama.com/download
# 2. Pull a coding model (a MoE coder is a great fit for a 24GB GPU):
ollama pull qwen3-coder:30b
#    (smaller option for less VRAM:  ollama pull qwen2.5-coder:7b)

# 3. Run the adapter (terminal 1) — it bridges ayin's contract to Ollama:
OLLAMA_MODEL=qwen3-coder:30b node examples/ollama-adapter.mjs
#    → listening on http://localhost:9100

# 4. Run ayin pointed at the adapter (terminal 2):
KELI_URL=http://localhost:9100 node dist/index.js
```

The adapter (`examples/ollama-adapter.mjs`) honours these env vars: `OLLAMA_MODEL`
(required), `OLLAMA_URL` (default `http://localhost:11434`), `PORT` (default `9100`),
`NUM_CTX` (default `32768`).

### Option B — A Maradel / keli-shaped backend

If you already run a backend that serves the `/api/generate` + `/api/status` contract
(e.g. a backend that proxies Ollama and adds extras), just point ayin at it — no adapter
needed:

```bash
KELI_URL=http://<backend-host>:9100 node dist/index.js
# or persist it once inside the TUI:   /set keli-url http://<backend-host>:9100
```

### Option C — OpenAI (no local model)

If `KELI_URL` is unreachable and an OpenAI key is configured, ayin falls back to OpenAI.

```bash
node dist/index.js
# in the TUI:
/set openai-key <your-api-key>
```

---

## 4. Run it

**Interactive (TUI):**
```bash
KELI_URL=http://localhost:9100 node dist/index.js
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
KELI_URL=http://localhost:9100 node /path/to/ayin/dist/index.js -p "Add a /health route and a test for it, then run the tests."
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
| `/set keli-url http://host:9100` | the LLM endpoint ayin talks to |
| `/set openai-key <key>` | OpenAI fallback key |

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

## 6. Optional tools

The core tools (`read_file`, `grep`, `find_files`, `write_file`, `str_replace`, `bash`,
`explore`, `status`) work out of the box. These extra tools need setup and are otherwise
inert:

- **`web_search`** — needs a search backend. Not portable as shipped (the original shelled
  out to a host-specific binary); route it through your backend's web-search endpoint, or
  ignore it.
- **`jira`** — runs a JQL query; needs `JIRA_EMAIL` + `JIRA_API_TOKEN` (via
  `~/.egregor/config.env`).
- **`send_push`** — asks the configured backend to push a notification to a phone; inert
  unless that backend implements it.

- **Update check** — disabled by default. Set `AYIN_UPDATE_REGISTRY=https://registry.npmjs.org/`
  to enable a best-effort version check; left unset, ayin never contacts any registry.

---

## 7. Troubleshooting

- **`No reachable LLM backend at …`** — nothing is serving the contract at `KELI_URL`.
  Start the Ollama adapter (Option A) or fix the URL. Verify: `curl $KELI_URL/api/status`
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
  powershell -ExecutionPolicy Bypass -File tool\install-watch-windows.ps1 -KeliUrl http://<backend-host>:9100
  ayin watch --repo C:\path\to\repo    # register each repo to review
  ```
  Uninstall: `Unregister-ScheduledTask -TaskName AyinWatch -Confirm:$false`.
- **Shell override:** `AYIN_SHELL=C:\path\to\bash.exe` forces a specific POSIX shell (WSL/MSYS).
