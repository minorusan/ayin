# CLAUDE.md — ayin

Instructions for any coding agent (and any human) working in this repo. These override default
behaviour.

If you are reading this on a **fresh clone** and ayin is not yet running, go to
[§1 Set it up](#1-set-it-up-fresh-clone) and do that first. Everything after it is the discipline for
changing the code.

---

## What ayin is

A **model-agnostic terminal coding agent** in TypeScript: one agentic loop that turns a
natural-language task into read/search/edit/run tool calls, driven by an open-weights LLM the user
hosts themselves. Blessed TUI plus a headless `-p` mode. It brings **no model** — it talks to an LLM
over a deliberately tiny HTTP contract so almost anything can serve it.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before changing behaviour. It is the
behavioural source of truth; code that disagrees with it is a bug in one of the two.

---

## 1 · Set it up (fresh clone)

Goal: a working agent on this machine. Do these in order and **verify each step actually worked**
rather than assuming — a silent failure here looks exactly like a broken agent later.

### 1.1 Check the prerequisites

- **Node ≥ 18** (20+ preferred): `node --version`.
- **A POSIX shell.** macOS/Linux already have one. On native Windows install
  [Git for Windows](https://git-scm.com/download/win) — ayin auto-detects its bundled Git Bash;
  override with `AYIN_SHELL`. WSL works with no extra setup.
- **git**, for the repo and for the `ayin watch` hooks.

### 1.2 Install and build

```bash
npm install
npm run build      # tsc → dist/ ; also runs the glyph + prompt gates
```

`npm run build` must exit 0. If a gate fails, fix that before continuing — the gates exist because
each one caught a real shipped bug.

### 1.3 Give it a model

ayin speaks this contract, and nothing else:

```
POST /api/generate   { messages, temperature?, thinking?, images? }  ->  { content, reasoning? }
GET  /api/status     ->  { ok: true, model }
```

`/api/status` is how ayin learns **which** model it is talking to, so it can select the matching
**dialect** (how that model formats tool calls). Pick one of:

**Local Ollama (recommended, fully local).** ayin does *not* speak Ollama's native API, so a tiny
zero-dependency adapter bridges the two. It ships in `examples/`:

```bash
# 1. Install Ollama: https://ollama.com/download
# 2. Pull a coder model sized to the GPU (see the table below)
ollama pull qwen3-coder:30b

# 3. Terminal 1 — the adapter:
OLLAMA_MODEL=qwen3-coder:30b node examples/ollama-adapter.mjs      # listens on :9100

# 4. Terminal 2 — ayin:
KELI_URL=http://localhost:9100 node dist/index.js
```

Adapter env: `OLLAMA_MODEL` (required), `OLLAMA_URL` (default `http://localhost:11434`), `PORT`
(default 9100), `NUM_CTX` (default 32768).

**An existing endpoint** that already serves the contract: point `KELI_URL` at it, no adapter needed.

**OpenAI**, if `KELI_URL` is unreachable and a key is set (`/set openai-key <key>` in the TUI).

#### Which model

ayin ships dialects for **qwen** and **gemma** families; anything else falls back to the gemma
dialect and may format tool calls imperfectly. Prefer a **coder** model — this is a tool-calling
agent, not a chat partner.

| VRAM | Reasonable pull |
|---|---|
| 24 GB+ | `qwen3-coder:30b` (MoE — fast for its size) |
| 12–16 GB | `qwen2.5-coder:14b` |
| 8 GB | `qwen2.5-coder:7b` |

Bigger is better here: the loop asks the model to emit **structured tool calls**, and small models
fail at the format long before they fail at the reasoning.

### 1.4 Verify it actually works

Do not report success until a real task has run end to end:

```bash
node dist/index.js -p "In one sentence, what does src/log.ts do? Read it first."
```

That exercises the whole chain — system prompt → model → tool-call parse → `read_file` → result fed
back → answer. If the model replies without calling `read_file`, the dialect or the model is wrong;
check `GET /api/status` reports the model you think it does.

### 1.5 Then

- `node dist/index.js` for the TUI. `Ctrl+O` browse tool output, `Ctrl+S` summary, `Ctrl+C` quit.
- `/set keli-url <url>` persists the endpoint so you stop passing `KELI_URL`.
- Prompts are editable files — see §3. That is the fastest way to change how ayin behaves.

> **Headless auto-approves file writes and shell commands.** Run it on a git working tree you can
> diff and revert. There is no network sandbox: `bash` can do whatever your shell can.

---

## 2 · Documentation is part of the work

**Every behaviour change updates `docs/` in the same change.** `docs/ARCHITECTURE.md` is the
behavioural source of truth. A code change whose docs still describe the old behaviour is not done —
it is a bug with a passing build.

---

## 3 · Prompts live in files — NEVER inline in source (NON-NEGOTIABLE)

> **Every prompt you write, and every prompt you notice inlined in code, goes into a `prompts/`
> folder as a `.txt` file. No exceptions, in the same change.**

Prompts are content, not code. They are the thing an operator most wants to tune, they are what a
model's behaviour actually hinges on, and a prompt buried in a template literal is invisible,
un-diffable and un-editable without a rebuild. Treat this like localization: code names a key, the
text lives in a file, the environment owns the copy.

**The two homes** (`src/prompts-service.ts` owns the relationship):

| | Where | Who owns it |
|---|---|---|
| **SOURCE** | ships beside the code — ayin's own in `prompts/<namespace>/*.txt`, a tool's in `<tool-package>/prompts/*.txt` | the repo; read-only at runtime |
| **LOCAL** | `~/.ayin-cli/prompts/<namespace>/<id>.txt` — **the only thing read at call time** | the operator; survives every upgrade |

**How it flows.** A tool declares `promptsSourceDir`. At registration ayin materializes any id
missing locally (atomic write — temp + rename, so an interrupted run can never leave a truncated
prompt) and **injects the resulting `PromptBundle` into the tool**, which then calls
`this.prompt(id, vars)`. A tool never learns that `~/.ayin-cli` exists. That injection is what lets a
tool package live in its own repo and depend on an interface rather than on ayin's filesystem layout.

**Materialization never overwrites.** A local file is the operator's, full stop. A newly shipped id
appears on the next boot; an edited one is left alone. `restoreDefaults()` is the only overwriting
path and it is explicit. That is the whole upgrade story — do not add another.

**Rules when you touch a prompt:**
- Adding a prompt = a new `.txt` in the owning package's `prompts/` dir. Never a string in a `.ts`.
- Spot an inline prompt while working nearby? Extract it. That is the rule, not scope creep.
- Variables are `{{UPPER_SNAKE}}`, substituted in one pass by the service.
- The file's bytes ARE the prompt, trailing newline included. No normalization on read — what an
  operator sees in the editor is exactly what the model gets.
- A missing prompt id **throws**. Never return a placeholder: a degraded LLM call that looks like it
  worked is worse than a crash.
- `config` (numbers, keys) stays in `~/.ayin-cli/prompts.json`. Settings are not prompts.

---

## 4 · This repo is PUBLIC — never commit a fact about the machine it runs on

Every commit is world-readable forever, and a clone cannot be un-read.

**Never put in source or prose:** LAN/RFC1918 addresses · absolute personal paths (`/home/<name>/…`,
`/Users/<name>/…`) · employer or client names · hardware/host inventories · private hostnames or
ports · a private service topology stated as a *requirement* ("refuses to run without the backend").

Anything environment-specific is a **default in config** (`~/.ayin-cli`, an env var, a CLI flag) with
a **neutral built-in fallback** — loopback, empty list, empty string. Never a literal in source.
Prose counts: a comment naming a private host discloses exactly what code dialling it would.

Operator-specific notes belong in **`CLAUDE.local.md`**, which is gitignored and which agents read
alongside this file.

---

## 5 · Build for cruel reality (NON-NEGOTIABLE)

Doing what was asked is half the job. These three are always on.

1. **Survive the power cut.** Assume the machine dies mid-sentence. Anything longer than a breath
   **persists state and, on restart, detects what was in flight → restores → requeues, with no human
   in the loop.** The `ayin watch` daemon (poll-only + persistent queue + resume-on-boot) and the
   session store are the pattern — copy them; never fire-and-forget with in-memory-only state.

2. **One door to every resource.** A resource touched directly is a resource in a race. ayin reaches
   a model **only** through its configured endpoint — never a hardcoded model-server port, never a
   side-door bypass. If a direct call fails, that failure is the design working, not a bug to fix by
   re-exposing the port.

3. **Pre-mortem before "done".** **grep every other caller** of what you touched — you are changing a
   system, not a line. **Name the failure modes out loud:** interruption, scale (the *big* real input,
   not the demo one), concurrency, a dependency down or slow, hard limits. When unsure, spend a cheap
   fast model as a dedicated skeptic: hand it the diff plus the caller list and ask "how does this
   break in production?" Write the answer down and close the real ones. The bug you don't look for is
   the two-day bug.

Note for agents: blessed lies about width (`strWidth(emoji) === 1`, two cells in a real terminal),
which is why `tool/check-glyphs.mjs` runs as `prebuild`. **Paint the UI and read it** rather than
assuming it renders.

---

## Before declaring any task done

1. `npm run build` passes (this runs the glyph gate before and the prompt gate after `tsc`).
2. `npm run check:gates` and `npm run check:explore` pass.
3. The behaviour was **actually exercised** — a real run, not a compile.
4. `docs/` matches the new reality.
