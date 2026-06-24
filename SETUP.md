# Setup guide

Get ayin running from a fresh clone — install, connect it to an LLM (this is the part that
matters), and run it as your terminal coding agent.

---

## 1. Prerequisites

- **Node ≥ 18** (Node 20+ recommended). Check: `node --version`.
- **A POSIX shell at `/bin/bash`** — ayin's file tools shell out to `bash`/`grep`/`find`/`git`.
  - macOS & Linux: already present.
  - **Windows: run ayin under [WSL](https://learn.microsoft.com/windows/wsl/).** Native
    PowerShell is not supported.
- **git** (for cloning; also used by some tools).

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
(e.g. the Maradel backend, which proxies Ollama and adds extras like `docs_search`), just
point ayin at it — no adapter needed:

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
`Ctrl+S` session summary, `PageUp/Down` scroll, `Ctrl+C` quit. When a tool needs approval
you get a y/a/n prompt.

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

All runtime config + prompts live in **`~/.ayin-cli/prompts.json`** (created on first run,
re-read on every access — edits apply immediately). Set values from the TUI:

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

…and the `system` / `summarizer` prompt text. The tool-call **format** block is injected by
the active **dialect** (see `docs/ARCHITECTURE.md`), so you normally don't touch it.

---

## 6. Optional tools

The core tools (`read_file`, `grep`, `find_files`, `write_file`, `str_replace`, `bash`,
`explore`, `status`) work out of the box. These extra tools need setup and are otherwise
inert:

- **`web_search`** — needs a search backend. Not portable as shipped (the original shelled
  out to a host-specific binary); route it through your backend's web-search endpoint, or
  ignore it.
- **`docs_search`** — semantic search over a project's docs; needs a backend exposing
  `POST /api/docs/search`. Ignore it if you don't run one.
- **`codex`** — hands a hard research task to the OpenAI **Codex CLI**; needs that CLI
  installed and an OpenAI key (`OPENAI_API_KEY`, or `~/.egregor/config.env`, or
  `/set openai-key`).
- **`jira`** — runs a JQL query; needs `JIRA_EMAIL` + `JIRA_API_TOKEN` (via
  `~/.egregor/config.env`).

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
- **Windows** — use WSL; ayin needs `/bin/bash`.
- **Slow first response** — the model is loading into VRAM on the first call; subsequent
  calls are fast.
