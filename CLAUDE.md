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

A **provider** connects ayin to one. Pick one of:

**Local Ollama, natively (recommended).** ayin talks to `/api/chat` directly:

```bash
# 1. Install Ollama: https://ollama.com/download
# 2. Pull a coder model sized to the GPU (see the table below)
ollama pull qwen3-coder:30b

# 3. Run:
AYIN_LLM_PROVIDER=ollama AYIN_OLLAMA_MODEL=qwen3-coder:30b node dist/index.js
```

`/api/chat` accepts a `tools` array, so Ollama parses tool calls itself and ayin's prompt carries no
tool catalogue. Env: `AYIN_OLLAMA_URL`, `AYIN_OLLAMA_MODEL`, `AYIN_OLLAMA_CTX` (16384),
`AYIN_OLLAMA_THINK`.

**An endpoint serving the HTTP contract** — point `AYIN_LLM_URL` at it:

```
POST /api/generate   { messages, temperature?, thinking?, images? }  ->  { content, reasoning? }
GET  /api/status     ->  { ok: true, model }
```

`/api/status` is how ayin learns **which** model is answering, so it can select the matching
**dialect** (how that model formats tool calls). Tools are declared in the prompt here — the contract
has nowhere to put schemas. `examples/ollama-adapter.mjs` serves this shape over Ollama if you want a
shared endpoint rather than the native path.

**OpenAI** — `/openai` in the TUI, with `OPENAI_API_KEY` or `/openai key sk-…`. Never selected
automatically; it bills the operator.

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
check that the provider reports the model you think it does (`/api/status`, or `ollama ps`).

### 1.5 Then

- `node dist/index.js` for the TUI. `Ctrl+O` browse tool output, `Ctrl+S` summary, `Ctrl+C` quit.
- `/set llm-url <url>` persists the endpoint so you stop passing `AYIN_LLM_URL`.
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

**Materialization protects EDITS, not staleness.** A newly shipped id appears on the next boot. A
local copy the operator never touched (byte-equal to the `.shipped.json` record) is **refreshed** to
the new shipped text — otherwise a shipped prompt BUG is permanent for every existing install, which
is exactly what happened. A copy they DID edit is kept; a copy whose `{{VARS}}` no longer match the
shipped contract is **repaired** (shipped text installed, theirs kept beside it as `.bak-<stamp>`),
because the code can no longer feed it what it sends. Every refresh and repair is announced in the
session. `restoreDefaults()` is still the explicit blunt instrument. See docs/ARCHITECTURE.md
"How a prompt FIX reaches an install that already exists" — do not add a fourth path.

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

## 3a · Every character in a prompt costs a million dollars

Not as a budget metaphor — as a statement about **attention**. Chroma's context-rot study tested 18
frontier models and every one degrades as input grows, *on trivial tasks*: a single distractor
measurably hurts, four compound, and relevant text buried mid-context loses >30%. So a token you add
does not cost you a token. It costs a slice of the attention available to **every other token in the
prompt, including your hard constraints**. That is the price. Write like it.

ayin is a **coding agent, not a chat partner.** Its prompts are read by a model doing tool calls, and
every one of them is loaded on a turn the operator is waiting through.

**The metric is information density, not length.** These are different, and confusing them is its own
bug: a 400-character unambiguous instruction beats a 100-character ambiguous one, because the failure
costs a whole QA fix pass — two LLM calls plus another agent round. Cutting a sentence that prevents a
class of error is a bad trade *even though it is shorter*. Ask of every character: **does this change
what the model does?** If not, delete it.

**Delete on sight:**

| Cut | Why |
|---|---|
| Politeness — "please", "kindly", "if you could" | Zero task information. (Not because rudeness helps: the rude-prompt result is n=250 on one model with a 4pp spread and the authors caveat it. It is simply uninformative.) |
| Justification and rhetoric — "this matters because…", "it is important to…", "X is wrong, not merely terse" | You are not persuading it. State the constraint. |
| Examples that are not pinning an output FORMAT | Zero-shot matches or beats few-shot on instruction-tuned models, and an example that is not the actual input is structurally a **distractor** — the exact thing measured to degrade performance. A JSON shape is the one earned exception. |
| Restating the task in different words | Redundancy is dilution wearing a helpful face. |
| Hedges — "try to", "generally", "where appropriate" | An agent cannot act on a hedge. Decide, or leave it out. |

**Emphasis is a budget, not a flavour.** `MUST` / `NEVER` / ALL-CAPS are priority markers — an agent
triaging conflicting instructions genuinely needs to know which rules are build-breaking. Keep them.
But **when everything shouts, nothing does**: a prompt with six MUSTs and eighty-three shouted phrases
has no priority signal at all, only noise (`planDocument.txt` was exactly that). Rule of thumb: **at
most three emphasis markers per prompt**, reserved for constraints that are load-bearing or
build-breaking. Everything else is plain prose.

**Position is load-bearing.** Performance is U-shaped in position — the beginning and end of a prompt
are read, the middle is skimmed. Hard constraints go **first or last**, never buried mid-paragraph.

**The biggest waste is never your adjectives — it is what you interpolate.** Tightening prose in
`planGrounding.txt` saved ~300 characters. The `{{CATALOG}}` it wrapped was **10,196 characters of all
28 components, for a project that uses four** — ~24 distractors injected into every plan. Retrieve,
never dump: filter the payload to what the request is actually about and give the model a tool to
fetch the rest. Before tuning wording, **measure what the variables carry** —
`npm run audit:prompts` reports every prompt's size, and a `{{VAR}}` is not free just because it is
short in the file.

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
2. `npm run check:gates`, `npm run check:explore` and `npm run check:watch` pass.
3. The behaviour was **actually exercised** — a real run, not a compile.
4. `docs/` matches the new reality.
