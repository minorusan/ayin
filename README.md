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

## Lineage

ayin began life inside the **egregor** stack as `@egregor/ayin-cli` and was **vendored and
decoupled** into the **Maradel** assistant as `@maradel/ayin`. The egregor-specific plumbing
(service discovery, remote session sync,
a private registry) has been stripped; what remains is a standalone agent that needs only
Node, the POSIX tools its file tools shell out to, and an LLM endpoint.

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

## Requirements

- **Node ≥ 18** (uses global `fetch` + `AbortSignal.timeout`; Node 20+ recommended).
- A **POSIX shell** at `/bin/bash` — present on macOS and Linux. On Windows, run ayin under
  **WSL** (the file tools shell out to `bash`/`grep`/`find`).
- An **LLM endpoint** (local Ollama via the bundled adapter, a Maradel backend, or OpenAI).
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
