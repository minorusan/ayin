# ayin — architecture

A terminal coding agent: a single agentic loop that turns a natural-language task into
read/search/edit/run tool calls against your filesystem, driven by an LLM you host. This
doc describes how the pieces fit.

## High-level shape

```
        you ──► ayin (TUI or headless -p)
                  │
                  │  LLM manager  ── picks the dialect for the active model
                  ▼
                provider  ── ollama · direct (HTTP contract) · resource · openai
                  ▼
        whatever serves the model
                  │
        agent loop ──► tools ──► your filesystem / shell
        (read_file, grep, find_files, write_file, str_replace, bash, explore, …)
```

Everything runs locally. There is **no service discovery, no remote orchestration** — ayin
needs only Node, a POSIX shell, and one HTTP LLM endpoint.

## LLM connection (`connection.ts`)

The transport under the two *contract-shaped* providers (`direct`, `resource`). A deliberately tiny
HTTP contract, so almost anything can serve it:

```
POST /api/generate   { messages, temperature?, thinking?, images? }  ->  { content, reasoning? }
GET  /api/status     ->  { ok: true, model }
```

The endpoint is resolved by `llmBaseUrl()` in priority order: **`AYIN_LLM_URL`** env → persisted
`llmUrl` in `~/.ayin-cli/prompts.json` (`/set llm-url …`) → `http://localhost:9100`.

> **One name each, no aliases.** An install still exporting an older spelling gets the localhost
> default, which fails loudly against a remote endpoint instead of quietly resolving to the wrong one.
> Anything that sets the endpoint out of this repo's reach — a shell profile, a launchd plist, a
> systemd unit, a CI file — has to name `AYIN_LLM_URL`.

Transport details: retries on transient errors, a long timeout (coder models can think for minutes),
and image attach for vision turns. See [`SETUP.md`](../SETUP.md) for the ways to stand up an endpoint.

### Preflight — no model, no TUI (`src/preflight.ts`, `src/index.ts`)

`dist/index.js` is a GATE, not the app. It runs one check and only then `await import('./app.js')`.

The split is structural, not stylistic: `ui/screen.ts` builds the blessed screen at **module scope**, and
ESM evaluates every static import before any statement in the importing module — so a check written
inside the app cannot run before the terminal is taken, however early in the file it appears. A dynamic
import is the only ordering that holds. Keep `index.ts` free of features: code there runs with no log
sink and no UI, able to talk to the operator only through stdout.

- **Configured is free**: two config reads, no probe, no launch delay. The gate is invisible in normal use.
- **Unconfigured + interactive**: a plain-terminal menu (readline, before blessed exists). A local Ollama
  is *detected and offered* rather than asked for; every option is **verified** before it is stored
  (`/api/tags` for Ollama, `/api/status` for an endpoint, `models.list` for OpenAI), because storing an
  unreachable URL only moves the original failure one step later. Invalid input re-asks rather than
  failing — the loop exits when ayin works, or when the operator quits.
- **Unconfigured + non-interactive** (`-p`, `watch`, `explain`, no TTY): exits 1 with the same
  instructions. Blocking a CI job on a prompt nobody will answer is worse than failing it.
- **`version` / `update` / `--help`** bypass the gate entirely.

### OpenAI — the default a fresh clone can actually run

**Ayin never escalates to OpenAI on its own.** The older idea — notice the local endpoint is
struggling, quietly ask the hosted model — is gone: a provider that bills per token is chosen, never
fallen into, and "which model am I paying for" must never be a guess.

What replaced it is a plain default. Provider resolution (`llm/select.ts`) ends at OpenAI when
**nothing is configured anywhere** — no `AYIN_LLM_PROVIDER`, no `llmUrl`, no `AYIN_LLM_URL`, and no
resource surface at the localhost default. That is exactly the fresh-clone state, and it is the
difference between a repo someone can try and one that needs a GPU first: `direct` against a localhost
endpoint that isn't there fails on every prompt with a connection error, which reads as "ayin is
broken", while OpenAI needs only a key and says how to get one.

The dangerous neighbouring case is excluded deliberately: an endpoint that **is** configured but is
merely unreachable — a backend mid-reboot — still falls back to `direct`, provisionally, and re-probes.
Moving a session onto a billed provider because a local service was slow is a charge nobody agreed to.
Gated (`the paid provider is never reached by accident`).

- **`/openai sk-…`** stores the key. It is the `openai_auth` tool's slash command, so it is verified
  against OpenAI before anything is written, lands in `~/.ayin-cli/openai.env` at 0600, and — being
  `slash.secret` — never reaches the input history or the model's context. Bare `/openai` reports
  status. `/set openai-key` is refused and redirects here: it used to write an unverified secret into
  `prompts.json` beside prompt-tuning numbers.
- **`/model openai`** switches who answers; **`/model local`** switches back. Setting a credential and
  deciding to spend money are two decisions, and the old `/openai` merged them into one keystroke.
  The switch is refused outright when no key is configured — entering a provider that then throws on
  every prompt is a worse failure than refusing, because by then the operator has moved on.
- It runs on the **official `openai` SDK**, a runtime dependency, not hand-rolled HTTP — one definition
  of the base URL, auth header, retry policy and error shape. There used to be a second, hand-rolled
  path (an "emergency fallback" in `connection.ts` that fired when no local endpoint answered) and being
  a second definition is how it rotted: pinned `gpt-4.1`, honoured only the **first** tool call in a
  reply, and evaded the stale-model gate by living in another file. Removed 2026-08-14 along with the
  escalation it served; a gate now forbids any hand-rolled request to `api.openai.com`.
- The client is rebuilt when the key changes, keyed on the key itself — `/openai` can store a new one
  mid-session, and a client captured once would keep using the old key until restart.
- The key reaches the provider through the **provider runtime seam** (`providerCredential('openai')`),
  not by importing the credential module: `llm/providers/*` import nothing outside `llm/`, the same
  rule that keeps `tools/` self-contained. Core knows where secrets live; a provider only knows it
  needs one. The legacy `openAiKey` in `prompts.json` is still *read* there, so an existing install
  keeps working — an upgrade that silently forgets a stored key is indistinguishable from one that
  broke it.

## naamah — the renderer, and the one real submodule (`naamah/`)

`naama` authors a `.puml`; **naamah** turns it into one self-contained page you can pan, zoom and search.
It is a git submodule rather than vendored code or a dependency, and it is the only thing in the project
that earns that: a separate program with its own repo, which renders any `.puml` and for which ayin is
merely one caller. `tools/` and `providers/` were only ever directories of ayin, so splitting them into
repos would have bought nothing but a three-commit pointer dance; naamah was already separate before ayin
knew about it.

It is MIT, has **zero runtime dependencies**, and is declared over **HTTPS** — a stranger cloning the
public repo has no SSH key of yours, and an `ssh://` submodule URL would break every clone but the
author's.

**Rendering is optional, and both failure paths say which piece is missing.** A clone without
`--recursive` leaves `naamah/` empty; a machine without [plantuml](https://plantuml.com) cannot render a
`.puml` at all. In either case designs are still authored and still enforced — only the picture is absent,
and the message names the fix (`git submodule update --init`, or install plantuml) rather than reporting a
generic failure to go and diagnose. An agent that refused to work because a diagram could not be drawn
would be absurd.

One thing worth knowing about the pipeline: naamah reads its entity metadata out of the **rendered SVG**,
where a package survives only as its label string. That is why the machine-readable half of a design rides
in `' naamah:` comments — plantuml strips comments before rendering, so naamah never sees them, while the
label stays whatever a human wants to read.

## Entangle — the design is a constraint, not advice (`src/entangle/`)

Two loops. In the **design loop** the operator and the agent draw a diagram together and the agent is at
its best: reasoning, confirming, rejecting against real code. Nothing is enforced; nothing should be. The
operator then says the design is settled, the agent calls **`entangle(path)`** with the diagram it has
just been working on, and the **implementation loop** begins — where every write is checked against that
diagram mechanically, before it lands.

**Why a gate rather than an instruction.** Measured on a real Unity sprint (36 designed types → 38 built):
the model kept every stated PROHIBITION — not one forbidden assembly reference — and discarded the
PRESCRIPTIONS. Two specified integration points into existing code were never touched; a designed
five-type view layer vanished and six types in a different shape appeared; two interfaces were invented
purely to mediate calls the diagram had going direct, one turning a direct call into a two-way
dependency. The type *count* barely moved, which is why review caught none of it.

That asymmetry is not a competence gap. A prohibition on a named token is satisfied by not typing it —
free, local, verifiable without leaving the file. A prescription to USE WHAT EXISTS costs tool calls to
find, read and trust something else, and forbids solving the problem locally. Inventing an interface costs
one file and compiles first try. Cheap-and-wrong beats expensive-and-right every round, and no wording
changes that arithmetic. So entangle is **not** a prompt: it costs zero tokens, and a violating write
simply does not land.

### The rules

| Rule | Checks | When |
|---|---|---|
| `CLOSURE` | a type the design does not declare | every write |
| `MEMBER` | a **public** member the design does not list | every write |
| `DOMAIN` | a reference the file's own manifest forbids | every write |
| `ADOPTION` | a designed type nothing implemented | end of task |

**Private members are free.** That is the implementation freedom the operator explicitly wants — and
over-constraining it is counterproductive: a model that cannot declare anything hides structure in
tuples, dictionaries-as-objects and 200-line methods, which is worse and invisible to a surface diff.

**Identity, never cardinality.** 36 → 38 looks healthy and hid 15 surplus plus 9 missing.

**A stop, not a denial.** ayin's tool guard denies-and-continues, which is right for a loop guard and
exactly wrong here: tell a model "you cannot put that type there" and it renames it, relocates it, or
inlines it into a long method. The denial invites the workaround. A violation halts the turn and reports
**STOP · the gap · the options** — options being the *agent's* to propose, since it just did the work and
knows why it wanted the deviation, which no graph query can reconstruct. The determinism is in raising
the stop; the decision is the operator's.

**The design file is read-only while entangled.** Without that, the workaround moves up a level: the model
amends the diagram to legalise its own violation and the gate then certifies the drift.

**Bilateral, not frozen.** A first diagram is wrong, seams appear, and amending is a legitimate outcome —
the gate exists to make change *negotiated* rather than unilateral. Detection is per-write for a reason
beyond cost: at round 3 a gap has two honest resolutions, change the code or change the design, and both
are cheap because nothing depends on either yet. At round 40 twenty things consume the invention, the
design can no longer be moved to meet the code, and an adapter is the only move left. Late detection does
not merely cost more — it removes the design-change option, which is how an architecture becomes a
compatibility layer nobody chose.

### Language-agnostic by construction

The diagram is universal; enforcement is not. A C# dependency unit is an `.asmdef`, a JS one is a
`package.json`, Python's is something else again. So `check.ts` holds the rules and knows nothing about
any language, while a `SurfaceLanguage` answers two questions per language — what does this file declare,
and which domain does it belong to. Two implementations ship (`languages/csharp.ts`, `languages/typescript.ts`);
a third is one file plus one registry entry, with no change to the rules.

Declarations only — no bodies. Which is also the honest boundary of the guarantee: the skeleton is
enforced, the flesh is not. Semantics like *"the MAX of live multipliers, never the product"* live inside
method bodies and are invisible here; that is a separate judge-based pass, deliberately not part of this.

A file in a language with no implementation passes rather than being refused — the alternative is
blocking a `.md`. What must never happen is treating "cannot check" as "checked and fine" for a language
we *do* handle, which is why a malformed manifest yields no domain instead of an empty allow-list.

## One door to the model, and two hooks out (`src/tools/runtime.ts`, `src/tool-wiring.ts`)

**`llm/manager.ts` holds the only `provider.generate` call in ayin.** Everything that generates — the
agent loop, goal derivation, judges, summaries, plan mode, and every tool — passes through `llmChat`.
A gate asserts the count is exactly one outside `providers/`.

Tools used to be a second door: `explore`, `diagram` and `arduino_explain` imported `llmChat` from the
manager, and seven tools imported the logger. Each import is a hard edge from a tool to ayin's source
layout, and the reason `tools/` cannot become a package of its own. Both now arrive as **delegates**:

```
core ── ensureToolRuntime() ──► tools/runtime.ts ──► toolLlm().ask(messages)
        (tool-wiring.ts:            (the seam)          toolLog().info(event, fields)
         the one implementation)
```

**`tools/` imports nothing outside `tools/`** — a gate asserts it, because the property is one `../`
away from being lost. A tool does not know what a provider is, that dialects exist, or that a GPU is
being arbitrated. `runtime.ts` itself has no imports at all: it *declares* what it needs and core
satisfies it, which is why `ToolProcess` is a structural shape rather than node's `ChildProcess`.

| Was imported | Arrives as |
|---|---|
| `llm/manager` (3 tools) | `toolLlm().ask(messages)` |
| `log` (7 tools) | `toolLog().info/warn/error/debug` |
| `ui.addMessage` (2) | `toolReport(message)` |
| `shell.spawnShell/killTree` | `toolShell().spawn/kill` |
| `editor.openInEditor` (2) | `toolOpenInEditor(path)` → `Promise<boolean>` |
| `prompts.getConfigString` | `toolConfig(key)` |
| `prompts-service` (3 + a type) | `toolPrompts(namespace)` — the tool names WHAT, never where |
| `connection.llmBaseUrl` | `toolBackendUrl()` |
| `qa/probes` | **moved out** — see below |

`ToolLlm` deliberately takes no sampling options: nothing sets any today, and an
accepted-then-ignored `temperature` looks honoured for a year.

Prompt bundles resolve **on call**, never at module scope. `const p = toolPrompts('ns')` at the top of
a tool file would throw at *import* time when the runtime is not yet wired, turning a wiring mistake
into an unloadable module.

`qa/probes` was the odd one: `regenerateTouchedDiagrams` imported it, but that function was never a
tool — nothing in the catalogue calls it, and its three callers are the Presenter executor, the QA
executor's `prepare()` and the agent loop. Composing a probe with a tool run is core's job, so it moved
to `arduino-diagram-regen.ts`. The import had been upside down.

**Two seams load lazily, and that is load-bearing.** `ui.js` creates the blessed screen at module
scope, and `editor.js` reads `HEADLESS` from it — so importing either takes over the terminal. Wired
eagerly, merely importing `tool-wiring.ts` painted escape codes into whatever was running, which is how
a stray one-line probe script once hung for fourteen hours. `report` and `openInEditor` import their
module on first use; importing the wiring, a tool, or an executor is now silent.

**An unwired runtime throws.** A tool that silently skipped its model call, or dropped its log lines,
would look like it worked — the same rule the prompt bundle follows.

**Wiring is idempotent and every entry point does it.** Built in `tool-wiring.ts` and called from the
registry, `plan/`, `explain/`, the three arduino executors and `index.ts`. This is not belt-and-braces:
wired only inside the registry, the delegates existed only because something else in the process
happened to import the registry first. `-p` and the TUI load `agent.ts`, which does — so it worked.
`ayin explain` and `ayin watch` do not, and would have thrown on the first tool that logs. A gate now
fails any module that imports a tool implementation without wiring the runtime; it caught four such
modules that a two-level grep had missed.

### The two hooks, for side software

Both are subscribe-and-forget, and ayin never learns who is listening.

| Hook | Where | Receives |
|---|---|---|
| `addLogSink(fn)` | `log.ts` | every log entry, from ayin and tools alike |
| `addLlmSink(fn)` | `llm/manager.ts` | every model call: `model`, `promptChars`, `replyChars`, `ms`, `toolMode`, `error?` |

`addLlmSink` lives on the single generate path on purpose — a hook anywhere else would be a hook with
holes. It fires on failure too, because a failed generation is what a monitor most wants. A throwing
sink can never fail a generation that already succeeded, and a throwing *log* sink is dropped after
three failures rather than being allowed to throw on every entry for the rest of the session.

`promptChars`, not tokens: the number available without a tokenizer, and named so it cannot be mistaken
for one.

## LLM providers (`src/llm/provider.ts`, `providers/`, `select.ts`)

The port between ayin and whatever serves its model. `generate()` and `status()` are required;
everything else — `models`, `setModel`, `acquire`, `authority`, `telemetry`, `events` — is an
optional capability, and **an absent capability renders as nothing**: no error, no dead spinner, the
feature simply is not part of that installation.

| Provider | Speaks | Declares tools | Chosen by |
|---|---|---|---|
| `direct` | the HTTP contract above | prompt | the default; anything with an endpoint |
| `resource` | a backend exposing an llm **resource** + authority layer | prompt | probe, or `AYIN_LLM_PROVIDER=resource` |
| `ollama` | Ollama's `/api/chat` directly | **native** | `AYIN_LLM_PROVIDER=ollama` — explicit only |
| `openai` | the OpenAI chat API | **native** | `/openai` at runtime — never automatically |

**Who declares the tools** (`LlmProvider.tools`) is the one property that changes the prompt. Over a
text-in/text-out contract there is nowhere to put tool schemas, so ayin describes all 14 tools and the
call format in the system prompt and parses calls out of the reply — `'prompt'`. A provider talking to
a runtime directly hands over the schemas instead, the runtime renders them in its own chat template
and returns parsed calls, and ayin renders those back into the canonical text form so the loop and
`parser.ts` never learn the difference — `'native'`. In native mode ayin **must not** also carry a
catalogue: the model would read the same tools twice, in two formats, with two sets of instructions.
Measured — declaring 2 tools added 331 prompt tokens (~2K for the full set), spent entirely on
duplication, and one run's judgement visibly degraded.

Native mode also removes a failure the text contract cannot avoid. Qwen3-Coder is trained to wrap
calls in `<tool_call>…</tool_call>`; over the text contract that wrapper is a generation boundary —
measured three separate times, the model emitted it and generation stopped there, leaving a run with
zero tool calls. Declaring tools makes the runtime parse the syntax the model was actually trained on.

**`select.ts`** resolves, in order: runtime override (`/openai`) → explicit config → probe → `direct`.
An **inconclusive** probe (endpoint not answering, e.g. a backend still booting) picks `direct`
*provisionally* and re-probes at most every 30s, so recovery needs no restart; the upgrade is one-way
(`direct → resource`) because a held authority must not have the ground moved under it. `ollama` is
never chosen by probe: on a shared GPU, two writers is the race the authority layer exists to prevent,
so a box with no backend gets it **by asking**. `openai` is never chosen by anything but the operator,
because it bills them.

## LLM manager & dialects (`src/llm/`) — model-agnostic core

ayin is **model-agnostic**. The only thing that genuinely differs between open coder models
is *how tool calls are formatted and parsed*. That difference is isolated behind one seam so
the agent loop, the tools, and the transport never need to know which model is in use.

```
agent loop / tools
   │  llmChat / llmCall            (transport: messages → text)
   ▼
manager (manager.ts)  ── reads GET /api/status → {model}, picks the matching ModelDialect
   ▼
dialect  ── toolCallInstructions (→ system prompt) · parse(raw) · renderToolCall · renderToolResult
```

- **`types.ts`** — the `ModelDialect` interface: `matches(modelId)`, `toolCallInstructions()`,
  `parse(raw)`, `renderToolCall(call)`, `renderToolResult(body)`.
- **`dialects/xml.ts`** — a shared base for models that use ayin's XML tool-call convention
  (`<function=name><parameter=key>value</parameter></function>`, results framed in
  `<tool_response>…</tool_response>`).
- **`dialects/gemma.ts`**, **`dialects/qwen.ts`** — concrete dialects. They differ only in the
  exact wording that elicits the cleanest formatting; parsing is shared (the parser tolerates
  both the canonical Qwen form and Gemma's fused-tag variant).
- **`manager.ts`** — resolves the active model from `/api/status` (`refreshActiveModel()`,
  refreshed at startup in headless and lazily otherwise) and selects the first dialect whose
  `matches()` is true (default: gemma). Every LLM call in ayin routes through here.

**Adding a model family** = implement `ModelDialect` (or extend `XmlToolCallDialect`) and
register it in `manager.ts`'s `DIALECTS`. A few lines.

## Agent loop (`agent.ts`)

1. User input → added to the conversation window + rolling summary.
2. Build messages: **system prompt** (persona + **served-model identity** + tool list + the
   dialect's tool-call format) + **rolling summary** + the **last N messages** (small, stable
   context).
3. Call the LLM (via the manager).
4. **Parse** the response for tool calls (`parser.ts`). A response may contain several calls
   (coder models often chain read → edit → run); they execute in order, each result fed back.
5. For each call: dedupe/loop-guard → **permission check** → execute → feed the result back as
   a `<tool_response>` turn → continue.
6. Plain text (no tool calls) → display → done.

**Served-model identity (`buildMessages`).** The system prompt names the served model
(`activeModelId()`) and says explicitly that this is not Claude / ChatGPT / Gemini, and never to
guess a vendor. This is not cosmetic. The prompt used to say *who* ayin is and nothing about *what
it runs on*, and a distilled model primed by ~12k characters of agentic-harness prompt fills that
gap confidently and differently every time: the same build answered "I'm Claude, developed by
Anthropic" in one session and "Ayin, running on OpenAI's o3" in the next, while the **same model
with no system prompt correctly said "I am Qwen, by Alibaba"**. Isolated by escalating the prompt
one layer at a time — bare → one-line persona → full harness — the confabulation appears only with
the full harness. ayin knows the real answer, so it states it; verified end-to-end against the
backend's ownership log (it reported `gemma4:26b` on a run where ownership had gone to `guest`, so
gemma really was serving).

Headless mode adds guardrails for unattended runs: a **CTA tracker** (don't exit until the
asked-for deliverable exists), a lightweight **judge** (is there enough evidence to answer?),
an internal **critic** (sanity-check substantial `write_file` output against gathered facts),
and a self-audit on hitting the round cap.

**What counts as evidence.** Two records feed the judge and the critic. `explore` returns curated prose
and is kept whole in `gatheredFacts`, which is also injected into the prompt as "Facts gathered so far".
The direct tools — `read_file`, `grep`, `find_files` — land in `evidenceFacts`: one clipped line each
(400 chars, last 12), fed to the judge and critic but **not** to the prompt, whose window already holds
the real output. Both exist because only `explore` used to count: a turn that searched and read for
itself was told `progress: insufficient — No facts gathered yet` after ten calls that had already found
the faulty method and its caller, and the critic (armed at ≥ 2 facts) never ran for such a turn at all.
A miss (`0 matches`, an error) is deliberately not evidence — otherwise the judge is lied to in the
other direction.

**`AYIN_UNCHAINED=1` — the measurement switch.** Runs the loop without the judge and without the write
critic. Both were added to compensate for a weaker setup, and several of the failures they compensate
for turned out to be in the tools rather than the model, so whether they still earn their cost is an
experiment. Off unless the value is exactly `1`/`true` — a typo must not silently change how a measured
run behaves. Graded baseline to compare against, on a closed ticket with a known one-line fix: **26 tool
calls to the answer, 9 to the faulty line**, with three judge verdicts all reading "insufficient".
(Note `exploreCallCount` is only counted and printed — the `MAX_EXPLORE_CALLS` constant beside it was
never enforced and has been removed rather than left to imply a limit that did not exist.)

**Round budget (`getMaxRounds`).** Interactive uses `config.maxToolRounds` (15); headless gets a
long leash (1000) because a `-p` task is expected to finish the job. **`AYIN_MAX_ROUNDS` overrides
both** — for a caller that wants a short, forced-spend run rather than an open-ended one. The
`ayin watch` hound sets it: its job is to make a handful of greps and answer, and a 1000-round
leash on that shape produces deliberation, not evidence. Values below 1 or unparseable are ignored,
so a typo cannot wedge the loop at zero rounds.

Three gates wrap the loop, each on a **deterministic trigger** — no model decides whether they run.
Plan mode, the Presenter pass, and the QA gate are also each **OFF by default for the session** — a
bare toggle (`/plan`, `/present`, `/qa`) turns one on for the rest of the session; a one-shot force
(`/planthis`, `/presentthis`, `/qathis`) runs it for exactly one prompt regardless of the toggle. The
three toggles are fully independent — see "Off by default: toggle + one-shot force" below.

| Gate | Fires when (once its own toggle/force says "yes" this turn) | Module |
|---|---|---|
| **Plan mode** | the incoming prompt is ≥ `planMinChars` **and** one triage call says it is cross-feature | `plan/` |
| **Tool guard** | every tool call, always (not gated — this one has no toggle) | `tool-guard.ts` |
| **Presenter pass** | the turn changed files **and** the final message reads like a completion report | `presenter/` |
| **QA gate** | the turn changed files **and** the final message reads like a completion report | `qa/` |

### Off by default: toggle + one-shot force

Plan mode, Presenter, and QA all cost real GPU time the user didn't explicitly ask to spend on every
single turn, so none of them applies until the session opts in. Each gets the identical pair of knobs:

- **Bare toggle** — `/plan`, `/present`, `/qa` (no argument) flip that gate on/off for the rest of the
  session. `isPlanSessionEnabled()` / `isPresenterSessionEnabled()` / `isQaSessionEnabled()` report the
  current state.
- **One-shot force** — `/planthis <text>`, `/presentthis <text>`, `/qathis <text>` run that gate for
  exactly this one prompt, regardless of whether the session toggle is on or off, then strip the
  command word and fall through to the agent with `<text>` as the message.

The force flag is **consumed unconditionally, exactly once, every time it is checked** —
`shouldRunQaThisTurn()` / `shouldRunPresenterThisTurn()` (and plan mode's inline equivalent in
`runPlan`) clear the flag the instant they read it, whether or not anything ends up running downstream.
An unconsumed force flag surviving a no-op turn would otherwise silently fire on a *later, unrelated*
prompt — the same "action fires when you didn't expect it" class of bug the authority-expiry fix
elsewhere in this codebase exists to prevent.

The three toggles are **independent of each other** even though Presenter and QA share the identical
underlying shape check (`qaShouldRun` — see below): enabling Presenter without QA (nicer formatting,
no reviewer) or QA without Presenter (a reviewer, raw replies) are both legitimate combinations.
`agent.ts` computes `qaShouldRun(response)` once per turn, then calls `shouldRunQaThisTurn()` and
`shouldRunPresenterThisTurn()` **unconditionally** (never short-circuited behind the shape check) so
each one-shot force is always consumed, and only runs the pass whose own `doQa`/`doPresenter` (shape
**and** toggle-or-force) is true.

### Making a gate visible (`activity.ts`)

A gate spends the user's GPU on work they did not directly ask for, so it must never look like an
ordinary turn. That is harder than it sounds: **every** LLM call goes through
`narrateWait('thinking', …)` (see below), which repaints the thinking line every 2 s with its own text.
The gates' first implementation set a status label and watched it get overwritten two seconds later —
so a three-pass review, the slowest thing ayin does, was indistinguishable from a normal reply.

So "what ayin is doing right now" is **state, not a message**. `activity.ts` holds a small stack
(phases nest: a QA pass contains LLM calls) and drives both surfaces:

- the **thinking line**, because `narrateWait` now *leads* with the activity instead of overwriting it:
  `▍⠹ QA 1/3 · reviewing 4 artifacts · ▸ generating on qwen3.6:27b   38s`
- a **status-bar chip** (`▣ QA 1/3`), which stays lit through the gaps where no LLM call is running and
  nothing narrates at all — the probe phase, the git snapshot, writing the plan file. It sits first
  after the connection dot because it changes what the rest of the bar means: those tokens and that GPU
  load belong to a review, not to the answer you asked for.

A stack rather than a single value so pops don't fight (an inner phase ending restores the outer one),
exits are idempotent and remove their own entry rather than whatever is on top, and `clearActivity()`
runs at the start of every turn — a bar still claiming `▣ QA 2/3` after the answer landed would be
worse than no indicator. In the chat transcript the gates also speak for themselves: plan mode reports
its triage decision and the plan's path, and the QA gate prints a verdict card per pass.

## Executors (`src/executors/`) — plan / QA / present, per project type

The three gates were written against one implicit project shape: a Node/web repo with a
`package.json`, an HTTP server and a logger module. On any other kind of project that assumption does
not merely go quiet — **it actively misleads**. An Arduino sketch surveyed by the generic planner is
told it has *"NO logging facility found — the plan must add one"* (the answer is `Serial.begin`, not a
logger module) and *"bind the server to all interfaces or the page will be invisible"* (there is no
page). The gate was steering the work wrong.

So each gate is now **one base implementation plus a per-project-type implementation that overrides
only what genuinely differs**.

```
src/executors/
  types.ts            the three contracts + ProjectType + Deliverable + ProbeFact
  detect.ts           which project this is — recomputed on EVERY call
  registry.ts         reads every config.json, selects by project type
  deliverables.ts     glob-ish pattern → "is this file actually on disk"
  plan/base/          index.ts + config.json     ← exactly the old behaviour
  plan/arduino/       index.ts + config.json
  qa/base/            index.ts + config.json
  qa/arduino/         index.ts + config.json
  present/base/       index.ts + config.json
  present/arduino/    index.ts + config.json
```

### Declaration lives in data

Every executor ships a `config.json` **beside its implementation**, because "which projects is this
handler for" is a property of the handler and a reviewer should find the answer in the same folder as
the code:

```json
{ "id": "arduino", "kind": "qa", "projectTypes": ["arduino"], "priority": 100,
  "description": "Arduino QA — generates the wiring diagram BEFORE judging …" }
```

**The selection rule, in full:** among configs of the requested kind, keep those whose `projectTypes`
contains the detected type or `"*"`, take the highest `priority`, break ties by id. The base executors
declare `["*"]` at priority 0 — they serve everything nobody else claims and lose to any specific
handler. There is no other dispatch logic and no implicit ordering.

Adding support for a project type is **a new directory**, never an edit to a central switch. The
registry cross-checks configs against the import map and **throws on any mismatch in either
direction** — a declared handler nobody imported would silently never run, which looks exactly like
support. `tool/copy-executor-configs.mjs` (postbuild) copies the configs into `dist`, since `tsc`
copies nothing but `.ts`.

### Detection is recomputed every time (`detect.ts`)

**No cache, deliberately.** A session is not pinned to one directory — the operator `cd`s from a
sketch into a Unity project and keeps talking to the same agent. A type decided once at boot would
apply Arduino deliverables and an Arduino component catalog to C#, with nothing in the output saying
so. Detection is a few `existsSync` calls plus one bounded walk.

Two sources, in strict order:

1. **The tree** — files on disk. Always wins when it says anything at all.
2. **The request** — consulted *only* when the tree is silent, i.e. the greenfield case: an empty
   directory and *"create an Arduino project that…"*.

That second source closes a real, reproduced hole. Every Arduino behaviour used to hang off
`isArduinoProject(root)`, which needs an `.ino` to already exist. **On the one turn where component
grounding matters most — the turn that CREATES the sketch — no `.ino` exists**, so the planner was
handed `(not an Arduino project — omit the Arduino reference section)` and wrote pinouts from memory.
The request said "arduino" in its first sentence. The request is never allowed to *override* the tree,
only to speak when the tree has nothing to say.

### What each contract does

| Contract | Methods | What the Arduino implementation adds |
|---|---|---|
| `PlanExecutor` | `survey` · `grounding` · `deliverables` · `observability` · `scaffold` | board + FQBN + PWM map + sketch-naming rule instead of the webview/bundler survey; the component catalog as mandatory grounding; Serial Monitor and `arduino-cli compile` instead of logger modules; sketch + README + `.wiring.puml` + `.svg` as required deliverables |
| `QaExecutor` | `prepare` · `probe` · `criteria` | generates the wiring diagram **before** judging; runs a real `arduino-cli compile`; validates the generated PlantUML with the real renderer; asserts deliverables; catches `analogWrite` on a non-PWM pin |
| `PresentExecutor` | `artifacts` | regenerates the diagram and names the resulting paths; calls out any required deliverable still missing |

`scaffold()` is the deterministic half of "the project has a README". That has been a standing QA
criterion for a long time and was being enforced the expensive way — the agent finishes, the judge
notices the missing file, a whole fix pass is spent creating four lines of markdown. **A file that
must exist is a `writeFileSync`, not a criterion for a model to remember.** It never overwrites: an
existing README is the operator's, exactly as a materialized prompt is.

### Hard facts are not submitted to the judge

A `ProbeFact` may be marked **`hard`**, and a hard fact that fails **fails the gate outright** —
`qaGate` short-circuits before `reviewArtifacts` is ever called (`qa/index.ts#hardFailingFacts`). The
judge still decides everything that is a judgement; it simply has no discretion over things that are
not.

The reason is a measured miss: a `motor-transistor` README shipped with **no pin map at all**, the
`readme-substance` probe reported "names no pins", and the log still reads `QA FAIL 1/3` → agent fixes
something else → `QA PASS 2/3`. Handing a deterministic fact to a model and letting the model weigh it
is not enforcement — it is a request addressed to a different reader.

Reserved for facts that are **binary and unarguable**: a compiler's exit code, a required file's
existence, a README still carrying the scaffold's TODO markers. Never for anything with a defensible
exception — a hard gate over a judgement call is how a QA loop becomes unfalsifiable. The distinction
the design turns on: a compile that **could not run** (no `arduino-cli` on the machine) is `hard: false`,
because an unknown is not a defect; only a compiler that *ran and rejected* the sketch hard-fails.
`tool/check-gates.mjs` asserts all of this, including that case.

### `prepare()` runs before the judge, and that is the point

The `arduino-wiring-diagram` criterion asks whether the reply references a rendered `.wiring.puml`.
The diagram used to be generated by a hook that ran **after** a QA pass succeeded — so on pass 1 the
file did not exist, the judge could not find it, the criterion failed, and a full fix pass (two LLM
calls plus another agent round) was spent arriving where the next line of code was going to arrive
anyway. That single ordering mistake is the largest share of *"Arduino QA is slow and always fails"*.

`prepare()` is bounded by **mtime, not a flag**: regenerate only when the sketch is newer than the
diagram beside it. Pass 1 generates; pass 2 after a real edit regenerates; pass 2 after an unrelated
edit costs nothing. A flag would forget across a crash; the filesystem does not.

---

## Plan mode (`src/plan/`)

A 2000-character request is usually several features wearing one paragraph. Handed straight to the
round loop, the model starts on whichever sentence it read last, meets the coupling in round nine, and
spends the rest of its budget repairing its own first guess.

**Off by default for the session** — `/plan` (bare) toggles it on for the rest of the session;
`isPlanSessionEnabled()` reports the current state. Once the toggle is on, **two doors, both
deterministic**:

| Door | Condition | Triage's verdict |
|---|---|---|
| **Size** | `prompt.length ≥ planToggledMinChars` (60) | decides — "not cross-feature" means no plan |
| **Explicit** | `/planthis <text>` as its own slash command, stripped before the text reaches `runPlan` | **cannot veto** — you asked |

> The size floor used to be `planMinChars` (2000), and that was wrong once `/plan` became an opt-in
> session toggle. It made sense when plan mode was implicitly available every turn: a length proxy
> kept a triage call off ordinary conversation. But an operator who has typed `/plan` has already said
> "plan my work this session", and then watched a 150-character request — *"create an Arduino project
> that cycles an RGB LED green→yellow→red over 10 s, a button toggles it"* — sail past the gate with
> no plan and no explanation, purely for being short. **A request being short is not evidence that it
> is simple; it is evidence that it is well phrased.** With the toggle on, the floor is only high
> enough to keep "hi" and "yes" from spending a call, and triage makes the real decision.
> `planMinChars: 0` remains the operator's absolute off switch for the automatic door.

`/planthis` is the one door that works **even with the session toggle off** — a one-shot force for the
one time you want a plan without switching the feature on for good (see "Off by default: toggle +
one-shot force" above). It is consumed exactly once, whatever happens next.

Length alone would drag every long bug report into planning; triage alone would cost an LLM call on
every turn. Together: one extra cheap call, only for genuinely big prompts. The explicit door exists
because "plan the auth rewrite" is nine words — size is a *proxy* for "this needs thought", and a proxy
must never overrule the person who can simply say so. Triage still runs on an explicit ask (it is the
cheapest way to decompose the work and to name the APIs the research step needs); only its veto is
ignored. The plan's header records which door was used (`/planthis`, or size + triage), so a plan read
back a week later says why it exists. `AYIN_PLAN=0` is an absolute kill switch, beating the session
toggle *and* `/planthis`; `planMinChars: 0` disables just the size door once the toggle is on.

### Two outcomes, not one: a plan, or grounding alone

A triage veto is **not** honoured when the project type has domain reference material, because triage
answers "is this several features wearing one paragraph" and that is not the only reason to plan. A
single-feature Arduino request was vetoed with *"single-feature request (255 chars)"*, so the component
catalog, the PWM rule and the sketch-naming rule never reached the model — and it shipped a sketch that
could not compile. Grounding withheld exactly where it was needed, the same shape as the greenfield bug.

But overriding the veto with a **full plan** was the wrong instrument. Measured: "blink the built-in LED
once per second" went from 48s to 193s, ~145s of it generating a 5,185-character nine-section document
for a sketch with two calls in it. So `runPlan` has two outcomes:

| Trigger | Outcome | Cost |
|---|---|---|
| triage says complex, or `/planthis` | `kind: 'plan'` — the full document, written to disk | survey + research + explore + one long generation |
| triage says simple, project type has reference material | `kind: 'grounding'` — reference material only, no document, nothing written | **zero extra LLM calls** — the grounding block is a deterministic string |

`planContextBlock` switches on `kind`: a grounding result gets `plan/groundingContext.txt`, never the
`<plan>` wrapper, which would otherwise instruct the model to "follow the plan" and "work the steps in
order" for a file that does not exist. Scaffolding (the README) happens on both paths — a file that must
exist is a `writeFileSync` either way.

**`AYIN_PLAN=1` / `AYIN_QA=1` force the session toggles ON** — the mirror of the `=0` kill switches.
They exist because headless (`-p`) has no TUI, so there is no way to type `/plan` or `/qa`, which made
both gates **untestable in any automated harness** — including the Arduino benchmark, whose entire
subject is how well ayin plans and reviews. A feature that can only be exercised by a human pressing
keys cannot be regression-tested. Presenter has no such switch on purpose: it is a TUI-only feature
(`doPresenter = … && !HEADLESS`), and the artifact regeneration it performs is already done by the QA
executor's `prepare()`.

**The explicit door used to be a natural-language regex** (`plan it`, `make a plan`, `deep investigate`,
`deep dive`, …), anchored to verb phrases so it wouldn't fire on ordinary uses of a common word ("what's
the plan?", "the plan was to ship Friday"). Retired by operator decision: plan mode is the single most
expensive gate in the system, and a fuzzy phrase match on it is exactly the kind of thing that misfires
in ways nobody can predict from outside one specific conversation. It was replaced first by a bare
`/plan <text>` marker, then split again into the current toggle (`/plan`) + one-shot force
(`/planthis <text>`) pair once QA and Presenter needed the identical shape — one unambiguous command per
job, greppable, no regression suite needed to keep tracking how people phrase things in English.

**The plan, in order** — each step feeds the next:

1. **Survey** (`plan/survey.ts`, no LLM) — what this project is, what it can already serve, and how
   anything here can be *observed*. Bounded shell reads with vendor/build dirs excluded.
2. **Third-party API research — MANDATORY, not the model's choice** (`researchApis`). The triage call
   also returns `apis[]` (services, not libraries: "Stripe", not `stripe-node`), and every one of them
   is looked up on the web *before the plan is written*, `planApiSearches` (default 3) searches total.
   A third-party API is the one thing a model must never answer from memory: auth schemes get replaced,
   fields renamed, endpoints deprecated, versions sunset — all after training — and code written from
   recall looks entirely reasonable while failing against the live service. That is the most expensive
   kind of wrong, because it survives review and a read-through and breaks in production against a
   vendor you don't control. When a lookup fails, the plan says the details are **UNVERIFIED** and makes
   reading the vendor's current docs step one; it never fills the gap from recall.
3. **Explore** — `planExploreCalls` (default 2) fixed questions through the `explore` tool: what
   already exists around this subject, and which files would have to change. Questions are fixed
   rather than model-chosen because each call is its own agentic loop, i.e. real GPU time.
4. **Document** (`planDocument`) — written to `ayin-plan-<timestamp>.md` in the cwd (`AYIN_PLAN_DIR`
   overrides) with fixed sections: reasoning · context · **dependencies** · **third-party API research**
   (cited, omitted only when no API is involved) · **Arduino component reference** (omitted only when
   `isArduinoProject` says no) · **gaps** · files-to-change table · steps · **log coverage and
   debugging** · risks.
5. The plan is pre-prompted into the turn as a `<plan>` block, the same mechanism as auto-research and
   auto-diagram, with instructions not to re-plan or re-explore what it already establishes.

Two sections earn their place. **Dependencies** must state, for a new webview specifically, what serves
it, what builds it, *what interface it binds* and how it is reached from another machine — the survey
supplies those gaps, so "add a settings page" in a project with no HTTP server and no bundler is
identified as three tasks before anyone writes HTML. **Log coverage and debugging** names the project's
existing logger, env switch and introspection route by name, because a plan that ends at "implement the
feature" hands over a black box; if the survey found no facility, adding one becomes step 1.

**Arduino component reference gets the same "don't recall it" treatment as a third-party API — and for
the identical reason.** `isArduinoProject(survey.root)` (reused from `tools/arduino-explain.ts`) gates a
DETERMINISTIC dump (no LLM call — `arduino_db` is a plain keyword catalog, see the Tools section) of
every shipped component's `catalogLine` (id/name/category/identify) into the prompt. The plan is told to
match every component it names against this list rather than recalling a pinout or identification detail
from training, and to make looking up an uncovered part an early step instead of describing it from
memory. Wiring LEGS aren't dumped here (would bloat the prompt for every Arduino plan regardless of
relevance) — the plan instructs implementation to call the `arduino_db` tool itself for those once the
specific components are known.

The document is on disk **before** implementation starts, so a machine that dies mid-feature leaves the
thinking behind rather than only half the work.

## `/explain` (`src/explain/`)

Broader than `explore`: `explore` finds and reads code; `/explain <feature>` additionally pulls in the
feature's real git history and authorship, correlates any Jira tickets referenced in commit messages,
and tells its STORY in plain prose — the way you'd explain it out loud to a teammate who just joined —
not a neutral changelog and not a structured report. Callable two ways, both running the exact same
`runExplain` pipeline (one implementation, not one per path): the interactive `/explain <feature>`
command, and the headless **`ayin explain "<question>"`** CLI subcommand (`index.ts`'s `main()` —
`'explain'` is in `ui/headless.ts`'s `NO_TUI_COMMANDS` set so blessed never grabs the terminal for it,
same mechanism `watch`/`update`/`version` already use). Not agent-callable either way: the agent already
has `explore` for self-orientation mid-task; this is a user-directed deep dive.

**Pipeline** (deterministic gathering feeds ONE synthesis call, same "evidence before opinion" shape
`qa/` and `arduino-explain.ts` already use):

```
exploreExecute (reused verbatim — plan/index.ts's exact call shape, an agentic loop, real GPU time)
  → extractExistingPaths (pure: which of explore's mentioned paths are real files on disk)
  → gatherGitHistory + computeBugSignal (pure: git log --follow, deduped, churn/bugfix/authorship counted)
  → extractTicketCandidates → jiraTickets (self-validating — see below)
  → ONE llmChat call writes the narrative, in prose, no headings
```

One file, one `openInEditor` call. `runExplain` returns the narrative text itself (`ExplainOutcome.body`)
alongside the file path — the interactive command shows a short "Report: path" line in chat (the file,
opened in VS Code, is where the story actually lives), while the headless CLI prints `body` straight to
stdout, since there's no chat UI to open an editor into.

**NO DIAGRAM (for now).** An earlier version also drew an architecture diagram alongside the report,
reusing `tools/diagram.ts`'s validated PlantUML loop. Deliberately dropped per the operator: the report
now reads like a story, and a diagram is a separate concern to pick back up later — a scope decision,
not a regression. If it returns, it belongs back as an explicit opt-in, not bundled into every call.

- **Path resolution is root-relative, not cwd-relative — a real bug caught by testing against a
  subdirectory.** `exploreExecute` reads `process.cwd()` internally (same as `plan/index.ts`'s own
  usage — there is no per-call cwd override), so paths it mentions are naturally cwd-relative. But
  `git log` below runs with `cwd: projectRoot()` — a path resolved only against `cwd` (e.g.
  `src/resources/llm.ts` when ayin was launched from a `backend/` subdirectory) would silently mean
  the WRONG file the moment `cwd` and the repo root differ, and `git log` just reports no history
  instead of erroring — exactly the kind of wrong-but-quiet bug this codebase's own evidence-not-
  assumption discipline exists to catch. `runExplain` converts every path to be relative to the repo
  root (`relative(root, resolve(cwd, p))`) before it ever reaches `gatherGitHistory`. Caught by testing
  live against `the parent/backend/src/resources/llm.ts` from a launch directory of the backend
  (root is `the parent/`) — not by reading the code.
- **Ticket-key candidates are self-validated, never trusted by shape.** A generic `PROJECT-123` pattern
  is structurally identical to plenty of ordinary text a commit message might contain — hardware part
  numbers (`KY-040`) are the exact same shape, confirmed directly: `check-gates.mjs`'s fixture repo
  deliberately includes a `KY-040` mention alongside a real-looking `PP-101` key, and both are extracted
  as candidates by `extractTicketCandidates`. `jira.ts#jiraTickets` (a resource-client call, see the
  Tools section) batch-validates candidates against the real API and only what Jira actually resolves
  is treated as a real ticket — `buildJiraBlock` tells the writer explicitly never to attribute a
  feature to an unresolved candidate.
- **The synthesis prompt (`prompts/explain/synthesize.txt`) asks for flowing prose, NO markdown
  headings** — four beats covered in order, each flowing into the next: (1) what it is and who built it
  (the authorship evidence below, plus the earliest commit or a resolved ticket's date, or an honest
  "could not be recovered"), (2) lifecycle and bugs (churn/bugfix evidence, by name — never a
  manufactured "this had bugs" if the evidence shows none), (3) what it's made of (composition, grounded
  in explore's findings — real files/functions, not generic descriptions), (4) how it's wired up
  (initialization/registration, dependencies, config) — closing with the one thing worth knowing before
  touching it.
- **`gatherGitHistory`/`computeBugSignal` are deterministic, no LLM** (`src/explain/git-history.ts`) —
  `git log --follow` per path (survives renames), deduped by hash across paths, newest first; a
  separate per-path count feeds the churn signal (most-touched file first) independently of the
  merged/capped chronological list, so a real "how often was this touched" number is never distorted
  by the cap. Bugfix-looking commits are flagged by subject (`fix|bug|regression|crash|race|broken|
  revert|hotfix|workaround`) — evidence handed to the writer, not an opinion it has to invent.
  `computeBugSignal` also aggregates **`authorsByCommitCount`** — who actually committed to these files,
  most commits first — the deterministic fact behind "developed mainly by X" in the narrative; the
  writer is handed this instead of guessing authorship from skimming a raw commit list itself.
- **README/Jira absence never blocks the report** — same philosophy as `arduino-explain.ts`: a feature
  with no linkable ticket, or a repo with thin history, still gets a report; the gaps are stated
  honestly ("no original intent could be recovered") rather than papered over.
- **Verified against the real backend, not assumed**: run live against the parent backend's actual
  `llmResource` (`backend/src/resources/llm.ts`) from a `backend/` launch directory — correctly
  identified the real file (not a same-named decoy — ayin's own `acquireLlm`/`llm/authority.ts` was
  the wrong target the first attempt found, exactly the cwd bug above, before the root-relative fix
  landed), correctly reported no Jira ticket recoverable (Jira wasn't configured), and named real
  churn/bugfix evidence (a VRAM-reclamation regression, a model-warming latency fix) the reviewer could
  check against the actual commit history.
- A stale **materialized local prompt** trap bit verification here too, same as `diagram.ts`'s own
  documented history: editing `prompts/explain/synthesize.txt` AFTER its first live call does nothing
  until the already-materialized `~/.ayin-cli/prompts/explain/synthesize.txt` is removed (or `/reset`)
  — worth restating here since it is easy to mistake for "the prompt change didn't take" when it is
  actually "the edit never reached the model".

## Tool guard (`tool-guard.ts`)

The previous duplicate detector answered every repeat with the same warning and let the model try
again. A stuck model does not learn from a transient `<tool_response>`: it re-emits the identical call,
gets the identical warning, and the transcript fills with `[Loop detected: status called again with
same params]` five times over while two background tasks sit there running. **The warning was advice,
and advice is not a rule.**

So refusals **escalate and persist**:

| Attempt | Non-pollable tool | Pollable tool (`status`) |
|---|---|---|
| 1st | runs | runs |
| 2nd identical | skipped, told the result is already in context | runs + `[POLLING NOTICE]`, throttled under `pollMinIntervalMs` |
| 3rd identical | **BLOCKED for the turn** | runs, still throttled |
| past `pollMaxPerTurn` | — | **BLOCKED for the turn** |
| after a user **deny** | **BLOCKED immediately, for the turn** | same |

A block is written into the **system prompt** every round (`guardDirective()` → `<blocked-calls>`),
where the model cannot scroll past it — that persistence is the actual fix. Two deliberate exemptions
keep it from being a straitjacket: **polling is a legitimate repeat** (checking a backgrounded task IS
the same call with the same parameters, on purpose), and a blocked `bash` call is told its escape
hatch — `sleep 5; <command>` is a *different* call and runs, which is what "wait for the server to come
up" actually needs. State is per-turn: a new user turn is a new intention.

## Presenter pass (`src/presenter/`)

**Off by default for the session** — `/present` (bare) toggles it on for the rest of the session;
`/presentthis <text>` forces it for exactly one turn regardless of the toggle (see "Off by default:
toggle + one-shot force" above). `isPresenterSessionEnabled()` reports the current toggle state;
`shouldRunPresenterThisTurn()` is the pure per-turn check `agent.ts` calls — unconditionally, so a
`/presentthis` force is always consumed even on a turn Presenter ends up not running on.

Runs **before** the QA gate, on the identical deterministic shape check QA has always used
(`qaShouldRun`: files changed this turn + the reply reads like a completion report) — but that shape
check only decides *whether the turn has the right shape*; Presenter's own toggle/force decides whether
it actually runs *this session*. Where QA judges whether the work is *right*, Presenter decides how the
reply gets **shown**: is it itself the thing the user must read verbatim (a warning, a rejection, an
error, a question back to them), or does it report on completed work — in which case Presenter builds a
short, consistently-shaped answer instead of whatever prose shape the model happened to write this
time: a quoted line naming what was asked, one sentence of what this reply satisfies, and a bulleted
file-changed list.

**ONE quick LLM call does both the classification and the build** (`prompts/presenter/
classifyAndBuild.txt`) — no repair loop, no retry. A degraded or unparseable response just means "don't
present," which is always safe: the raw reply is still shown exactly as it was before Presenter existed.
`parsePresentation` is the same tolerant brace-scan shape as `qa/criteria.ts`'s intent parser and
`arduino-explain.ts`'s `parseConnections` — a model wraps JSON in prose/fences often enough that a
strict `JSON.parse` would reject good answers for a cosmetic reason.

- **Interactive-only.** Headless output is unchanged — scripts and the `ayin watch` daemon parse that
  output, and a TUI-shaped feature (a status-bar chip, a de-emphasized cursive aside) has no headless
  equivalent worth the behavior change there.
- **Visibility matches the QA gate's own contract**: `pushActivity('Presenting', …)` lights the same
  status-bar chip and wait-narrator line QA's `▣ QA 1/3` phases use (`activity.ts`), so the quick call
  never reads as a stall.
- **QA then reviews the PRESENTED text**, not the raw reply, whenever Presenter ran AND produced one —
  handed in as `qaGate`'s `answer` argument in place of `response`. A presentation is a denser, more
  complete "what changed" statement than the model's own closing line, so it is strictly better evidence
  for the reviewer to check claims against. If Presenter didn't run this turn (its own toggle/force said
  no) but QA did, QA reviews the raw reply exactly as it did before Presenter existed.
- **Testing-era behavior (temporary, per the operator):** the raw reply is still printed too, right
  below the presentation, de-emphasized in "cursive" — `toItalic()` (a Unicode Mathematical-Italic
  glyph transform; blessed has no real italic attribute) plus `escapeBlessedTags()`, the same pairing
  `chat.ts`'s own goal-line treatment uses. This lets the two be compared side by side while Presenter
  is new. Once trusted, this block is meant to come out in `agent.ts` and the presentation stands alone
  — a code change, not a design change, when that day comes.
- **Project-type artifacts.** What a presentation owes beyond the file list depends on the kind of
  project, so it is decided by the **present executor** for the detected type (`executors/present/`),
  not here — Presenter's own job is classify, then format. `formatPresentation` takes a **list** of
  artifact lines rather than one optional Arduino string, because a project type can owe more than one.
  The Arduino one regenerates the wiring diagram (a presentation pointing at a *stale* diagram is worse
  than one pointing at nothing) via the same `regenerateTouchedDiagrams` the QA executor's `prepare()`
  uses, and it names any required deliverable still missing rather than hiding it. The two gates trade
  skip sets in both directions — `qaPreparedUnits()` into Presenter, `arduinoRegenerated` back out — so
  whichever runs first tells the second what it already covered and one turn never spends its
  one-grounding-call-per-sketch budget twice.
- **Print ordering.** Interactive mode prints the raw reply immediately, unconditionally — UNLESS the
  shape check passes AND at least one of Presenter/QA will actually run this turn (`doQa || doPresenter`
  in `agent.ts`), in which case the print is deferred: whichever pass runs decides the primary visible
  text. If Presenter runs and produces a presentation, it becomes that text, with the raw reply appended
  right after in cursive; if Presenter doesn't run this turn (toggle off, no `/presentthis`, headless) but
  QA does, the raw reply prints as normal and QA reviews it directly.
- **Config:** `AYIN_PRESENTER=0` is a hard kill switch, independent of and beating the session toggle —
  Presenter is skipped outright and QA falls back to reviewing the raw reply.

## QA gate (`src/qa/`)

The agent's own last message is the least trustworthy thing it produces: written by the same model that
did the work, from the same context that made the mistakes, and rewarded for sounding complete.
"Done — I've implemented the panel and updated the docs" is a claim. This gate checks it before the
user has to.

**Off by default for the session** — `/qa` (bare) toggles it on for the rest of the session;
`/qathis <text>` forces it for exactly one reply regardless of the toggle (see "Off by default: toggle
+ one-shot force" above). `isQaSessionEnabled()` reports the current toggle state;
`shouldRunQaThisTurn()` is the pure per-turn check `agent.ts` calls unconditionally, so a `/qathis`
force is always consumed even on a turn QA ends up not running on. `qaShouldRun()` itself is untouched
by any of this — it stays a pure shape detector shared with Presenter (see above); the toggle/force
layer decides *whether the gate is even allowed to fire this session*, on top of the shape it fires on.

**Shape trigger** (`qaShouldRun`, no LLM, one `git status` at most): files changed this turn **and** one
of three things is true of the final message — it is big (≥ `qaMinAnswerChars`, default 400), it opens
with a completion verb, or it contains the literal phrase **"Ready for QA"**. "Files changed" always
matters — without it the gate would fire on ordinary questions and burn GPU for nothing — but a short,
honest closing message ("Done." / "Fixed the typo.") satisfies neither the length nor the wording
heuristic and was going unreviewed for no better reason than being terse. `system.txt` instructs the
model to end a completed turn with that exact phrase for precisely this case; same shape as plan mode's
explicit `/planthis` marker — one unambiguous phrase instead of a heuristic — and matched
case-insensitively anywhere in the message, not just its head.

**The loop** (max `qaMaxPasses`, default 3):

```
intent → criteria (once per turn) → probes → review → pass? done
                                                 ↘ fail? issues back to the agent,
                                                   which fixes and reports again
```

- **Intent** comes from the user's OWN prompts this session, read off the session record on disk
  (`recentPrompts()`), not the agent's summary of them — the paraphrase is exactly what drifts, and
  reading from disk means it still works after a `/resume`.
- **Criteria** (`qa/criteria.ts`) are derived **before the artifacts are seen** — a judge shown the
  answer first writes criteria the answer happens to satisfy, the same anchoring trap the critic avoids
  with its unanchored peer. Baseline bars are deterministic per changed file-kind (UI is never an MVP ·
  a webview is reachable from another machine · one responsibility per module · README exists and is
  maintained · markdown uses the format's range · **a third-party integration matches the API the vendor
  documents today** · **an Arduino sketch is named the way the toolchain requires, and wiring is shown
  with a diagram, not narrated**), plus 3-6 intent criteria. Derived **once** per turn and reused, so the
  bar cannot move while the agent chases it.
- The **`api` bar** is the enforcement half of plan mode's research step. `probeThirdPartyApi` detects
  the integration from the code — external hosts, credential-shaped env vars, `Bearer`/OAuth/`/v1/`
  shapes, whether 429s are handled at all — and the criterion fails a change that shows no sign the
  current API was actually looked up. Recalled API knowledge is the failure that passes every review and
  breaks only against the live service.
- **Project-type bars are chosen by the QA EXECUTOR, not by file shape.** `dimensionsOf` used to
  compute two extra Arduino dimensions from a probe; the Arduino bars are now requested **by id** from
  `executors/qa/arduino`, which selects them from its own deterministic facts — it knows whether a
  diagram was actually produced and whether a compiler actually ran, and `dimensionsOf` cannot. The
  criteria themselves still live in `prompts/qa/*.txt`; `baselineFor()` **throws** if an executor names
  an id the table does not have, because a bar nobody can see is a bar the change cannot fail. The five:
  - **`arduino-sketch-naming`** — a generic reviewer reads a correct fact as a mistake. A sketch's
    filename matching its containing folder is a **hard requirement of the Arduino toolchain** (the IDE
    and `arduino-cli` both refuse to build anything else); the reported false positive was a reviewer
    with no Arduino knowledge flagging `Blinker/Blinker.ino` as unexplained duplication. The bar states
    the rule so a match is never flagged and a genuine mismatch always is, by name.
  - **`arduino-compiles`** — `arduino-cli compile` is actually run against the project's target board
    (`arduino-toolchain.ts`), into a temp `--build-path` so the probe stays read-only. Every other
    Arduino check is either deterministic but shallow or deep but a model's opinion; this one is both
    deep and deterministic, and it answers in ~1.5 s with the compiler's own line number. **A gate that
    has a compiler available and asks a language model to eyeball the C++ instead is choosing the worse
    instrument and paying GPU time for it.** A skipped compile (no CLI, no core) is reported as an
    unknown, never as a pass.
  - **`arduino-wiring-diagram`** — the diagram is generated in `prepare()`, *before* the judge reads
    anything, so the evidence states as a fact whether the `.wiring.puml` exists and whether the real
    PlantUML renderer parses it. Fails on missing or invalid, and on a wall of prose where a rendered
    diagram was available.
  - **`arduino-deliverables`** — sketch, README and diagram, checked as files on disk.
  - **`arduino-quality`** — soft, non-blocking recommendations (named pin constants over magic numbers,
    `delay()` in `loop()` only when genuinely meant to block, `Serial.begin` baud consistency), raised
    only when clearly ignored, never invented work.
  - `.ino`/`.pde` were **missing from `CODE_EXT`** before all this — not cosmetic: an unclassified file
    gets `kind: 'other'`, and `qaChangedFiles()` **drops** anything of kind `'other'` from the review
    entirely. An Arduino sketch was invisible to the gate outright.
  - One more fact no reading can establish: **`analogWrite` on a pin with no hardware PWM**. It compiles
    perfectly, reviews perfectly, and produces a pin that is only ever fully on or fully off — an RGB
    LED with eight colours instead of sixteen million.
- **Change detection has a non-git fallback, and it is load-bearing.** `qaChangedFiles()` is
  tool-tracked writes ∪ `git status`, and the git half is what catches files written through `bash`.
  Outside a repo it returns null — so a turn that wrote everything with a heredoc reports **zero changed
  files**, and `qaShouldRun` declines with "nothing changed this turn". **The gate does not fail; it
  silently does not run**, which is strictly worse and completely invisible. Measured on the Arduino
  benchmark, whose projects live in fresh non-git directories: three of them shipped sketches that
  **could not compile**, past a naming bar and a compile probe that both existed and never got to look.
  `filesModifiedSince()` closes it with a bounded mtime scan since the turn began.
- **Probes** (`qa/probes.ts`, no LLM, read-only) supply the facts a reviewer cannot get by reading: a
  real HTTP GET on loopback **and** on this machine's LAN address (so *up but loopback-only* is its own
  verdict — a dev server bound to localhost looks perfect on the machine that built it and is invisible
  from the phone in your hand); README presence and staleness against changed-code mtimes; markdown
  richness counts; per-file structural SRP signals. It never starts a server: when the webview is down
  it says so, and the *fix pass* — which has `bash` and the permission machinery — launches it.
- The reviewer sees the **whole final message** (16 k chars, more than any real report) and is told it is
  *both* a claim and a deliverable. Two bugs lived here: the answer was clipped to 4 000 chars while
  30 000 chars of file content were allowed — so a long report naming the URL to open at character 5 000
  was invisible, and the gate then correctly reported the URL as missing — and the prompt framed the
  message purely as an untrustworthy claim, so anything the user asked to be **told** (a URL, a command,
  a port, an answer) was discounted for not being in the files. Now: information owed to the user counts
  as delivered when it is in the message; claims about work owed to the repo are still checked against
  the evidence.
- **Review** (`qa/review.ts`) → `{verdict, summary, issues[]}`. **Long investigation, short answer**:
  ≤2-sentence summary, every issue naming a file and a fix, because the next reader is the agent doing
  the repair. Failing is expensive on a shared GPU, so it must be earned — no style preference, nothing
  invisible in the artifacts or evidence, no scope the user never asked for.
- **Fail** → issues pushed back as a system turn and the round budget rewound; the agent fixes and
  reports again, and pass 2 reviews the repair.

Bounded by construction: `qaMaxPasses` hard-caps the loop, and an LLM failure yields `unknown`, which
never blocks the user — a QA gate that can hold a finished answer hostage would be a worse bug than the
ones it catches. Every verdict is appended to the session record as it happens.

Two exclusions worth knowing: the git snapshot uses `-unormal` (on a tree with stale backup
directories, `-uall` enumerates thousands of files, twice per turn) and only real files reach the judge,
because a collapsed untracked *directory* described as a file would be reported as "MISSING (deleted?)"
— a fact that is simply false. `ayin-plan-*.md` is excluded too: the plan is an input to the change, not
an artifact of it. The port probe skips the port derived from `llmBaseUrl()`, so it can never poke the
model gateway.

**Config** (`prompts.json` → `config`): `qaMaxPasses`, `qaMinAnswerChars`, `pollMinIntervalMs`,
`pollMaxPerTurn`, `planMinChars`, `planExploreCalls`. **Prompts** (editable `.txt` files, see the
Prompts section): `ayin/qaCriteria`, `ayin/qaReview`, `ayin/planTriage`, `ayin/planDocument`, the six
`qa/baseline*` criteria, and `plan/*`. **Env:** `AYIN_QA=0|1`, `AYIN_PLAN=0|1` (`0` kills, `1` forces
the session toggle on — the only way to exercise either gate headlessly), `AYIN_PLAN_DIR`,
`AYIN_QA_PORT`, `AYIN_QA_PORT_DENY`, `AYIN_ARDUINO_CLI`, `AYIN_ARDUINO_FQBN`.

## Tool-call format & parser (`parser.ts`)

ayin uses **text** tool-calls (no native function-calling API required):

```xml
<function=bash>
<parameter=command>
ls -la
</parameter>
</function>
```

Results are fed back as:

```xml
<tool_response>
total 48
drwxr-xr-x ...
</tool_response>
```

`parseResponseAll()` is intentionally lenient — it handles the canonical form, the HTML-attr
form (`<parameter name="x">`), Gemma's fused-tag variant, and JSON-in-`<tool_call>` — and
returns every call in order. That tolerance is what lets one parser serve multiple model
families.

## Tools (`tools.ts`, `tools/`)

Each tool is `{ name, description, parameters, execute }`; the model calls it by its unique
name. **Core** (no external deps): `read_file`, `grep`, `find_files`, `write_file`,
`str_replace`, `bash`, `explore`, `status`, `arduino_db`. **Optional integrations** (inert unless
configured): `diagram`, `web_search`, `jira`, `jira_auth`. See the README table.

### A tool may own a slash command (`Tool.slash`)

A tool declaring `slash: { command, param, usage }` is invoked **directly** by that command, bypassing
the model's choice of tool: `/jira what is still open on me?` runs the `jira` tool with
`question=<the rest of the line>`.

The model choosing the tool is the right default and stays the default. But a **connector** (below) is
not a step in a plan — it *is* the answer, and letting the outer loop pick it costs two full rounds
whose only content is relaying text into a tool the operator already named by typing the command.

- The **tool** declares the command, not a central list — the registry is a directory, so a list would
  reintroduce the shared file discovery removed, and an installed third-party tool could never appear
  in it. `/help` lists tool-owned commands from the registry.
- Two tools claiming one command is **refused**, like a duplicate tool name: load order is not an
  answer an operator can reason about.
- A slash param that is **not required** may be invoked bare — that is how `/jira-auth` alone reports
  status instead of printing usage.
- The turn is written into the agent's conversation window (`recordSlashTurn`), so a follow-up like
  "which of those is blocked?" reaches a model that actually saw the tickets.

### Connectors (`src/tools/connectors/`)

A connector is a tool whose `execute` is **its own agentic loop** against a service API. The operator
asks in plain words; the connector decides how much of the service it must read. The outer agent spends
no rounds on the service's mechanics and never composes a query language.

**`jira`** — scoped to the **authenticated user's current sprint**:

- Scope is a property of the **query** (`assignee = currentUser() AND sprint IN openSprints()`), not an
  instruction in a prompt. `open KEY` is refused unless KEY is in the fetched sprint set — a prompt
  saying "only your sprint" is a request; an unavailable answer is a fact.
- The sprint list is fetched **once, up front**: most questions about a sprint are answered by the list
  of tickets in it, so the common case is a single LLM call, and every later round shares one frame of
  reference. Only a question needing a description or comments costs another round.
- The inner protocol is **one line** (`open KEY` / `answer <text>`). A small local model asked for JSON
  mid-reasoning produces malformed JSON far more often than a wrong verb. An unmarked reply is taken as
  the answer rather than spending a round correcting protocol.
- **Cloud and Data Center are detected, not configured** — the search endpoint
  (`/rest/api/3/search/jql` vs `/rest/api/2/search`) and body format (ADF document tree vs plain text)
  are both discoverable on the first call. ADF is flattened to text before any model sees it.
- Descriptions and comments are **clipped head-and-tail** with the omission stated.

**`jira_auth`** — fills the credential file from whatever the operator pasted:

- **Deterministic first, model second.** A regex pass handles the ordinary paste; only a blob it cannot
  resolve reaches the LLM, so the common case cannot be hallucinated. The token has no reliable syntax,
  so it is found by **elimination** — the longest secret-shaped run that is not the email, the host, or
  a date.
- **Rotation is the common case.** A paste containing only a new token **merges** over the stored
  credential, because the token expires every few weeks and the site does not.
- **Never writes an unverified credential** — the file lands only after the token authenticates against
  the site. A stored-but-wrong credential fails later, elsewhere, as a 401 with no memory of where it
  came from.
- Credentials live in **`~/.ayin-cli/jira.env`** (`KEY=value`, chmod 0600, written atomically), not in
  `prompts.json`: this secret expires, so an operator edits it by hand, and a secret beside
  prompt-tuning numbers is one that gets pasted into a bug report by accident. **Env wins** over the
  file, for CI. `JIRA_EMAIL` present selects Basic (Cloud); absent selects Bearer (a Server/DC personal
  access token) — one question the operator's own credential already answers.
- `JIRA_TOKEN_EXPIRES` is the operator's own note, and is **advisory**: within 7 days every `jira`
  answer carries a warning line. The server remains the authority on whether a token works, so a wrong
  note never blocks a call that would have succeeded.

**`sentry`** — scoped to **unresolved issues in the operator's organization**, last 14 days, ranked by
frequency. Same loop shape as `jira`; three things are specific to it:

- **The org slug is part of the credential, not a setting.** Every read endpoint is
  `/organizations/{org}/…`, and a correctly-scoped token gets **403** from `/organizations/` — measured
  against a real token — so ayin cannot discover it. `/sentry-auth` parses it from the paste (a Sentry
  URL carries it as a subdomain or an `/organizations/<slug>/` path) and verification runs the **same
  issue query the connector uses**, so "verified" means "what you are about to do works". Verifying
  against `/organizations/` would reject exactly the narrowly-scoped tokens this is designed for.
- **A logged error is not a crash.** An SDK reporting logged errors (a Unity game's logger, say)
  produces events with no exception and no stacktrace at all — measured: 12 of the top issues in a real
  org had zero frames. For those the **breadcrumb trail** is the whole story, so `open` returns the last
  10 crumbs (the tail, nearest the failure) when there is no stack, and says which it is showing.
- **Events are reduced before any model sees them.** A single Sentry event can carry hundreds of frames
  plus every request header; `in_app` frames are kept ahead of library noise, and every omission is
  stated in the output rather than silently truncated.

### Both connector loops end in a forced answer

Bounded evidence, then a mandatory answer — enforced by the loop, not requested in the prompt:

- The last round, a **repeated** `open` (the tool-guard rule: a second identical call is a stall, not
  thoroughness), or **two** issues opened → the gathering phase ends.
- The answer-only round uses a **different prompt containing no protocol at all**. Telling the model
  `open` was unavailable did not stop it: the word was in the operator's own question ("open the top
  issue and tell me…") and it was **mirroring, not choosing** — measured as three rounds of `open` with
  the answer already in context. A prompt that mentions no commands has nothing to mirror.
- If it still will not summarise, the connector returns **what it read** rather than "could not settle
  on an answer" — the data is what the operator wanted, and discarding it because the model went quiet
  is the worst of both.

`/explain`'s ticket validation (`src/jira.ts`) goes through this connector too, so a fresh clone can
validate a `PROJECT-123`-shaped string in a commit message. It is **not** sprint-scoped — those keys
come out of git history and are usually old — but it is capped and self-validating: only keys that
resolve to a real issue come back. Unconfigured is an honest gap in the evidence, never an error.

- **`str_replace`** is the preferred edit tool — a single-unique-match find/replace that
  touches only the targeted block. `write_file` is for new files / deliberate full rewrites
  (regenerating a large file from memory risks dropping content). A miss is **diagnosed**, not merely
  reported: CRLF-vs-LF, whitespace-only difference (with the line the text starts on), or first-line
  match plus what the file actually says there. "old_str not found" is almost never a wrong location.

### The base tools tell the truth about their own limits

A tool that quietly returns less than it was asked for is worse than one that fails: the model treats
the fragment as the whole and reasons confidently from it. So every bound is stated in the result.

| Tool | Bound | What the result says |
|---|---|---|
| `read_file` | 800 lines/call | `(lines A-B of N)` + `(K more lines — continue with offset=B+1)`. `offset` is a **1-based line number**, so a `grep` hit pastes straight in. A binary file is named, not decoded. |
| `bash` | 120 s, 256 KB (`timeout_seconds`, max 900) | `TIMED OUT … this output is PARTIAL` and how to background it; `output truncated at 256 KB`. Before this a foreground server hung the turn forever — nothing cancels a tool in headless, where no human is watching. |
| `grep` | 50 matches (scaled by `context`) | `(N matches)` / `(N files)` / `(N lines incl. context)`, or `showing the first N — there are MORE`. A miss says the **pattern** missed, not that the code is absent. |
| `find_files` | 30 files | `(N files)` or `showing the first N`; hits are **ranked** (exact basename, prefix, shallowest path) rather than left in traversal order. |
- **`jira`** (`jira.ts`) — a thin CONSUMER of a backend's `jira` resource
  (`backend/src/resources/jira.ts`), not a Jira API caller. **This is a deliberate architectural
  collapse**: ayin used to hold its own credentials in a config file and call the Jira REST API
  directly (a second, independent implementation from the backend's own `connectors/jira.ts`); both
  now go through the one `jira` resource, the same "one door" shape already used for the `llm` resource
  — `POST {backend}/resource/jira {op, params}` (`resourceOp`, mirroring `llm/providers/resource.ts`'s
  exact fetch shape). ayin holds NO Jira credential of any kind. Ops: `currentSprint` / `ticket` /
  `tickets` (batch, self-validating) / `comments` / `epics` / `search` (free text — the backend runs
  an agentic JQL-writing loop, never handed to ayin's own model to guess at). `jiraTickets(keys)` is
  the batch op `/explain` calls for ticket-candidate validation.
  - **Credential setup moved to the backend**: the backend's own credential setup
    (`backend/src/status/jiraAuthCli.ts`) validates a candidate token against the live API BEFORE
    writing it to the backend's own env file — same discipline the removed `ayin jira` command used,
    just relocated to where the credential actually lives and is actually used. A restart of the
    backend is required to pick up a change (`config.jira` is read from the env file once at process
    start, systemd's `EnvironmentFile`), which the command says plainly rather than pretending live.
  - **Forgot to add `jira` to `NO_TUI_COMMANDS` while it briefly existed as `ayin jira`** — a real bug
    caught by testing, not review: without it, a non-`-p` invocation still constructs a real blessed
    screen at module-load time (`ui/screen.ts`'s `HEADLESS ? noopScreen() : blessed.screen(...)`,
    decided once and memoized before `main()` even runs), leaking teardown escape codes into plain
    stdout. Diagnosed by comparing byte-for-byte against `ayin update`/`ayin version` (both already in
    the set, both clean). The command itself no longer exists in ayin (see above), but the fix stayed
    relevant enough to note: any future top-level ayin subcommand needs the same registration.
- **Auto-research grounding** (`agent.ts#runResearch`): near-deterministic — if the prompt contains
  `grounded`/`citing`/`citation`/`research`, ayin runs a `web_search` BEFORE the base LLM call and
  **pre-prompts the result into the turn** (a `<research-grounding>` block in the system context), so
  the answer is grounded + cited, **scientific methods first, then practical/household**, tailored to
  the user's stack. The search query is LLM-formulated from the prompt + the user's stack, read from
  the **`SYSTEM_INFO`** env var. That ships **empty** — a stack is environment-specific, and the baked
  default that used to be here published one operator's hardware inventory to every install (public-repo
  rule, `CLAUDE.md` §4). Unset → the prompts interpolate `unspecified` and the answer is simply not
  stack-tailored. Opt out entirely with `AYIN_RESEARCH=0`.
- **`diagram`** (`tools/diagram.ts`) — a **validated** PlantUML generator with its own repair loop,
  plus the **auto-diagram trigger** (`agent.ts#runDiagram`), the same shape as auto-research: the
  phrases `diagram`/`visualise`/`puml`/`flowchart`/`explain better`/`don't understand`/`unclear`/
  `confused`/`draw` run the diagram pass BEFORE the base call and pre-prompt a `<diagram>` block, so
  the answer is written around a picture that already exists instead of promising one. `AYIN_DIAGRAM=0`
  opts out. The user's words go to the tool **verbatim** as the subject — no paraphrasing LLM call,
  because every call queues on one shared GPU slot and the loop may already cost 1-4 rounds.
  - **Why a loop:** models get PlantUML syntax wrong often enough that one-shot generation mostly
    writes broken files. Each round is validated by the real renderer — `plantuml -syntax` on stdin,
    which answers `ERROR / <line> / <message>` or `<TYPE> / (<n> participants)` — and the error is fed
    back verbatim for repair (max 4 rounds). **The validator is the ground truth**, so success is
    never reported for a file that won't render; a diagram that won't converge is saved as
    `*.invalid.puml` with the error in a comment.
  - **The renderer's version is therefore part of the contract.** Ground truth that is six years old
    rejects valid modern source, and the loop cannot tell "you wrote it wrong" from "my parser is
    too old" — it just spends its four rounds. Ubuntu 24.04's package is 1.2020.2 and fails on
    `!theme plain` (measured: `ERROR / 1 / Syntax Error?` on the distro build, `SEQUENCE` on 1.2026.6),
    so a current release jar shadowing the distro binary on `PATH` — or `AYIN_PUML_BIN` pointed at one —
    is the supported setup. The `-syntax` contract this parser depends on is unchanged between those
    versions (`ERROR/line/message` vs `TYPE/summary`, rc 200 vs 0), and startup stays ~0.15 s for
    `-version`, ~0.26 s for `-syntax`, ~0.4 s for an SVG render, well inside the tool's 15/25/60 s
    budgets. Graphviz (`dot`) is needed for class/component diagrams; sequence and mindmap render
    without it.
  - Writes `<slug>.puml` + a rendered `.svg` beside the work (`AYIN_PUML_DIR`, default cwd), opens it
    in VS Code when the `code` CLI exists, else leaves it and reports the path.
  - **Local only by design.** The public plantuml.com server would render in one HTTP call; a diagram
    of your architecture is exactly what not to POST to a third party. `AYIN_PUML_SERVER` is the
    opt-in for a self-hosted renderer. No `plantuml` at all → the file is still written and checked
    structurally, labelled `unverified`.
  - **`!include`/`!includeurl`/`!includesub` are stripped** from generated source: PlantUML resolves
    them at render time (local file reads, URL fetches into the image), which is an exfiltration path
    for anything that can influence model output.
  - Verified end-to-end against the real model: a first-try `SEQUENCE (6 participants)` (re-validated
    independently, SVG free of embedded error text), and the repair path forced with a stub validator
    — two rejections fed back, success on round 3.
  - **Arduino wiring does NOT live here.** An earlier version of this tool rendered wiring as validated
    ASCII text (`isWiringRequest`, a flat sequence-diagram shape). That mode is gone: ASCII boxes-and-
    arrows cannot show per-pin/per-leg detail or be dragged apart in an editor, and it duplicated
    `arduino-explain.ts`'s own ungrounded HTML renderer with a second, inconsistent format. Wiring is now
    exclusively the **`arduino_diagram`** tool below, grounded in the real sketch code and the
    `arduino_db` catalog and rendered as an editable PUML/SVG. `diagram` itself is back to pure
    architecture/concept diagrams (sequence/class/component/activity/state/**mindmap** — `mindmap` is the
    strongest pick for "explain this concept," the most common reason someone reaches for this tool).
- **`arduino_db`** (`tools/arduino-db.ts`, `tools/arduino-components-data.ts`) — a shipped reference
  catalog of ~28 common starter-kit components (LEDs, buttons, servos, sensors, displays, drivers, ICs)
  with a keyword/alias search over it. **Deliberately NOT a RAG pipeline** — no embeddings, no vector
  store, no chunking: the whole catalog is small enough to score in memory, and "what is this thing and
  how do I wire it" is answered exactly as well by a keyword scorer as by a vector search, for none of
  the moving parts. Each entry carries `identify` (how a beginner spots the loose part in a kit pile),
  `whatItDoes`, `howUsed` (functions/library, digital/analog/PWM/I2C, common gotchas), a `legs[]` array
  (one physical pin/leg → what it wires to → why), and `wiringNotes` (the single biggest gotcha).
  Authored by two independent Sonnet passes (inputs/sensors/passive · outputs/displays/comms, split so
  neither had to cover the other's ground) and reviewed for schema consistency before shipping.
  - **Scoring is two-tier, on purpose.** `id`/`name`/`alias`/`category` hits are "strong" matches; prose
    (`identify`/`whatItDoes`/`howUsed`/`wiringNotes`) hits only refine ranking among components a strong
    field already matched — they never qualify a component on their own. A first cut scored everything
    into one total, and `check-gates.mjs` caught it immediately: a nonsense query
    (`"zzz-not-a-real-part-xyz"`) still returned a hit, because "not" and "real" are ordinary English
    words that show up in nearly every entry's explanatory prose. Splitting the score fixed it.
  - The agent calls it directly (`query=`/`id=`/`list=1`) while writing or explaining Arduino code —
    it's the same "don't recall hardware facts from memory" discipline the `api` QA bar already enforces
    for third-party APIs, applied to component wiring instead. `arduino-diagram.ts` also calls
    `getArduinoComponent`/`ARDUINO_COMPONENTS` directly to ground its per-component rectangles and the
    grounding LLM call — same data, two consumers.
  - **`retrieveCatalog(query)` — prompts RETRIEVE the catalog, they do not dump it.** Every Arduino
    prompt used to interpolate all 28 entries at full detail: **10,196 characters, ~2,550 tokens, on
    every plan and every grounding call**, for a project that typically uses three or four of them. That
    is roughly two dozen irrelevant part descriptions sitting beside the four that matter — precisely
    the distractor load measured to degrade instruction-following, and worse the longer the input. The
    keyword scorer was already sitting in the same file; the code next to it ignored it. Now: full
    entries for what the query selects, a bare-id **index** for the rest (~20 chars each, so the model
    still knows what exists and can name one), and `arduino_db(id=…)` to fetch any of them in full.
    Measured on the RGB-LED-plus-button request, the grounding block went **11,849 → 3,757 characters
    (68% smaller)** with the two relevant components ranked first and second. Retrieval, an index, and a
    lookup — the shape a RAG system would use, for a corpus small enough that the retriever is a
    keyword scorer. `limit` is generous on purpose: missing a component the project really uses costs a
    wrong diagram, carrying one extra costs a few hundred characters, and those are not symmetric.
- **`arduino-explain`** (`tools/arduino-explain.ts`) is now **pure shared infrastructure** — extraction
  and grounding only, no rendering. It grew a redundant, format-inconsistent HTML wiring renderer once;
  that renderer is gone (see `arduino_diagram` below), and this file kept only the deterministic and
  grounded halves every wiring consumer needs:
  - **`findSketches`/`isArduinoProject`** walk the tree for `.ino`/`.pde` files or a `platformio.ini`/
    `sketch.yaml` marker (bounded depth, skips `node_modules`/`.git`/`dist`/`.pio`) — project-wide, unlike
    `qa/probes.ts`'s `probeArduinoProject`, which only looks at a turn's *changed* files.
  - **`extractPinUsage`** (pure, no LLM) regexes over `pinMode`/`digitalWrite`/`digitalRead`/
    `analogWrite`/`analogRead`/`attachInterrupt`, resolving named constants (`#define`/`const int`)
    declared in the same file back to their literal pin. **`.attach(pin)` (Servo.h) is matched
    separately** — a servo sketch never calls `pinMode`/`digitalWrite` on its own pin at all (the
    library owns pin configuration internally), so without this a sketch built entirely around a servo
    would report zero pins for its one actual actuator. Caught building the project's own test fixture
    (a button + servo + RGB LED sketch), not by reading the code. This is regex-level extraction, not a
    C++ parser — a library's OWN pin-configuration idiom beyond `.attach()` (a NeoPixel strip's
    constructor argument, an LCD's `begin()`) is a known gap, recorded in `the local tech-debt notes`.
  - **`groundWiring`** — ONE LLM call per sketch (never parallel across a multi-sketch project — the
    "one door" discipline applies to a single command exactly as it does to a habit), given the real
    pins, the sketch source, the README when present, and the full `arduino_db` catalog as the only
    valid `componentId` values. Validated + repaired the same shape as `diagram.ts`: JSON parse failure
    or a response naming no pin from the real pin list retries (max 3 rounds, `prompts/arduino/
    groundWiring.txt` + `groundRepair.txt`); an unrecognized `componentId` is coerced to `"unknown"`
    rather than retried, and an exhausted/unreachable model degrades to `[]` — **never invents a
    component the catalog doesn't have**, and never throws, so a down model still yields a diagram
    (every touched pin still gets a rectangle, honestly labeled "no catalog component matched").
  - **`readReadme`** (exported) and **README is grounding context when present, never a gate.** A
    beginner's first sketch usually has no README yet, and blocking a *teaching* tool on documentation
    that doesn't exist would defeat the tool.
- **`arduino_diagram`** (`tools/arduino-diagram.ts`) — "teach me my own wiring," as a **validated PlantUML
  diagram**, the same rendering discipline `diagram.ts` uses (`plantuml -syntax` then `-tsvg`, never
  reported successful for a file that won't render). The `/arduino-explain` command (name unchanged,
  output format is not) and the agent-callable `arduino_diagram` tool both call this. Replaces two prior
  overlapping, ungrounded systems in one change: `diagram.ts`'s old ASCII wiring mode (no per-pin/per-leg
  detail, not draggable) and this file's own former HTML/breadcrumb renderer (a second, inconsistent
  format for the same information).
  - **Shape**: one `rectangle "<board>" <<board>>` containing one nested pin-rectangle per board pin
    *actually used* by the sketch (plus a synthetic `GND`/`5V` pin when a component leg needs one); one
    `rectangle <<comp>>` per real component (grouped from `groundWiring`'s per-connection output via
    `groupByComponent`) containing one nested leg-rectangle per catalog `legs[]` entry, with a `note`
    carrying `whatItDoes`/`wiringNotes`; wires drawn as labeled arrows (`signal`/`ground`/`power`) between
    exact pin/leg rectangles. Nested rectangles are what make this **draggable in Inkscape/draw.io** —
    each stays a distinct SVG group, unlike a flattened picture.
  - **`matchLeg`** — `groundWiring`'s `leg` field is deliberately **free-form project phrasing** (the
    prompt asks for e.g. `"cathode"`, `"signal wire"`, never a restatement of the catalog's exact
    `legName`), so it cannot be looked up by exact string match against `arduino_db`'s `legs[]`. A first
    draft assumed exact match and silently dropped every wire whose leg text didn't match verbatim —
    caught in smoke-testing before shipping, not by a user report. Fixed with a normalize-then-score
    fallback: exact match first, else the catalog leg with the most overlapping words, else the first leg
    — a connection is **never silently dropped**.
  - **`board`** comes from the project (`sketch.yaml`'s `default_fqbn`, or `AYIN_ARDUINO_FQBN`, else
    `arduino:avr:uno`) unless a tool call names one. It selects the **PWM map**, not just the title — the
    diagram labels each pin with what it can actually do, and marks `analogWrite` on a pin with no
    hardware PWM. Pins shown are always just what the code touches, never a full physical pinout.
  - **`regenerateTouchedDiagrams`** is the ONE shared entry point, used by the present executor and by
    the QA executor's `prepare()`, so "Arduino work necessitates a current wiring diagram" has one
    implementation rather than two drifting copies. Its `skip` set is how the two gates stay off each
    other's toes; the QA executor additionally skips sketches whose diagram is already **newer** than
    the sketch, so a three-pass gate does not redraw an unchanged circuit three times.

  **The 2026-08 rework — every item observed in a rendered image, not reasoned about:**

  | Was | Now |
  |---|---|
  | **Series resistors missing entirely.** The catalog says, on the leg itself, that an LED anode connects to *"a PWM pin through a ~220 Ω resistor"*. The renderer drew `pin 9 → red anode`. A beginner following that diagram wires an LED straight to a GPIO pin and destroys one or both. **The catalog had the fact; the picture contradicted it.** | `seriesPartFor()` reads the value out of the catalog's own `connectsTo` prose — one source of truth, no lookup table — and the part is drawn as a real node in the wire: `PIN_9 → 220 Ω → red anode`. A stated range (`~150-220Ω` on the blue channel) stays a range. |
  | Every box captioned `«pin»` / `«comp»` / `«board»` — internal styling tags rendered as if they were information. | Styling is inline colour (`#back:…;line:…;text:…`), so there are no stereotypes to leak. `hide stereotype` as belt and braces. |
  | Notes hard-truncated mid-word at 100 characters: *"…get it wrong and none o…"*. The wiring note's second half is its useful half. | `wrapText()` — whole words, wrapped to a column, several lines tall, capped in height rather than amputated. |
  | Pins in Map-iteration order — `9, 10, 11, GND, 2`, with the ground pin between the signal pins. | Ordered as a human reads a header: digital ascending, then analog, then unresolved constants, then power and ground. |
  | PWM capability invisible. | Each pin labeled with the calls that drive it and whether the board can actually PWM it. |
  | Legend was four colour swatches. | A **parts list** (name + how to spot it, straight from the catalog) plus the key plus the board's PWM pins. |
  | Component legs all identical grey. | An RGB LED's three channels are red/green/blue; ground legs are dark. |

  - **`matchLeg`** — `groundWiring`'s `leg` field is deliberately **free-form project phrasing** (the
    prompt asks for e.g. `"cathode"`, `"signal wire"`, never a restatement of the catalog's exact
    `legName`), so it cannot be looked up by exact string match. A first draft assumed exact match and
    silently dropped every wire whose leg text didn't match verbatim. Fixed with normalize-then-score:
    exact match first, else the catalog leg with the most overlapping words, else the first leg — a
    connection is **never silently dropped**.
  - **Pin extraction sees more than `pinMode`.** Three gaps, all found by benchmark run 1 producing a
    real, useless artifact:
    - A pin passed to a **library constructor** (`DHT dht(DHT_PIN, DHT_TYPE)`) is configured inside the
      library, so the sketch never calls `pinMode` on it. A correct climate-display sketch produced a
      diagram containing **one rectangle** — the empty board — and no components at all: valid
      PlantUML, entirely useless. `LIBRARY_PIN_ARGS` is a **curated** map of type → pin argument
      positions, deliberately not a general "first integer argument" rule, because
      `LiquidCrystal_I2C lcd(0x27, 16, 2)` takes an address and a geometry and reading those as pins
      would put fictional wires in a diagram whose entire purpose is to be trustworthy.
    - **I2C's pins appear nowhere in the source.** They are fixed (A4/A5 on Uno/Nano), so an I2C display
      was absent from its own wiring diagram — and "SDA→A4, SCL→A5" is exactly what a beginner needs it
      to say. Added only when the sketch actually includes an I2C library.
    - `const int led = LED_BUILTIN;` resolved to nothing, so blink's diagram labelled the pin `led`
      rather than `13`. `CORE_PIN_MACROS` plus one transitive alias pass; only genuinely universal
      macros belong there, since a guess about a board-specific pin is the recalled hardware fact this
      whole subsystem refuses to make.
  - **`esc()`** neutralises Creole in free text. Doubled markup runs (`**`, `__`, `~~`, `//`) get
    PlantUML's `~` escape; single `_` mid-word does not, because identifiers are full of them
    (`RED_PIN`, `INPUT_PULLUP`) and escaping every one turns readable source into `RED~_PIN`. This
    function exists because of a real render bug: a `~` written to mark a PWM pin escaped the `**` that
    followed it and the label came out as the literal text `**9**`.
  - **`validatePuml` / `validatePumlFile`** are exported, because "the diagram exists" and "the diagram
    parses" are different facts and only the second means the file is any use. The QA executor reports
    the second. Validation runs **before** rendering: a render attempt on invalid source wastes a JVM
    start and leaves a stale SVG from a previous run looking current.
  - **Verified against real renders, not assumed.** The reworked renderer was run against the real
    target project (RGB LED on three PWM pins + a button on pin 2), rendered to PNG with the real
    `plantuml` binary and **looked at**. That is how the single-line `skinparam rectangle { … }` bug was
    found — valid-looking source that PlantUML rejects with an unhelpful *"Syntax Error? (Assumed
    diagram type: sequence)"*. The block form must span several lines; the flat form
    (`skinparam RectangleRoundCorner 10`) is what the generator emits now.
- **`web_search`** (`tools/web-search.ts`) — in-process, dependency-free, and **works on a fresh clone
  with no key and nothing to install**. Engines: **SearXNG** first *only when explicitly configured*
  (`AYIN_SEARXNG_URL` / `/set searxng-url`) → **DuckDuckGo** as the default, its `html` endpoint then
  `lite` → **DDG Instant Answer** last resort. Then rank + dedup → fetch top 4 pages → strip to readable
  text → merged markdown digest (the loop's model synthesizes). 15-min per-query cache.

  Two things are load-bearing. **A challenge is not an empty result.** DDG answers a scraper it dislikes
  with HTTP **202** and a challenge page, and 202 passes `res.ok` — read naively that is "no results",
  which tells the agent the web is empty and it moves on. Measured over 10 rapid requests: 7 real, 3
  challenged, clustering at the end as the limit engaged. So 202/429/403 is detected, retried on the
  other endpoint, reported as rate-limiting, and **never cached** — caching a blip would extend seconds
  of blocking into 15 minutes of the same non-answer with no request going out to notice it had lifted.
  Requests are paced 1.2s apart, which is what avoids the limit in the first place. **The two endpoints
  do not share markup**: `html` uses `class="result__a"` with double quotes, `lite` uses
  `class='result-link'` with the attributes in the opposite order and snippets closing `</td>`. One
  regex demanding class-then-href matches only the first, so the second endpoint parses to zero and
  looks like an outage. Both shapes are covered by `parseDdg`, with gate fixtures for each.

  SearXNG's base used to be **derived** from the LLM endpoint host on `:8888` when unset. That guessed
  one deployment's topology at every other user's expense: a clone dialling a port on its owner's model
  host on every search, and a full 12s timeout before the working engine when that host drops rather
  than refuses. It is explicit or absent now.
- **`explore`** is a sub-investigation with its own short LLM loop and clean context — good
  for "find/read X" questions; it translates depth into width. It is **language-agnostic**
  (identifier extraction + whole-tree grep with vendor/build dirs excluded — no assumed file
  extensions) and self-limiting in three independent ways: it bails after 3 consecutive empty search
  rounds; when the model keeps re-searching at low confidence despite having gathered real data, it
  returns that data verbatim instead of burning all iterations (callers can pass `thorough: 'true'` to
  let broad questions investigate longer before that guard may fire); and it never re-runs a command it
  has already tried this investigation.
  - **The command memory is FULL-HISTORY, not the capped one.** The per-step narrative log
    (reasoning + command + result) is capped at 4 entries to keep the prompt small, and up to
    `MAX_ITERATIONS` (12) rounds run — so from round 5 onward the model could no longer SEE what it ran
    in rounds 1-2 and duly suggested them again, a loop that was guaranteed BY CONSTRUCTION, not a
    quirk of any one model. `spent` (a `Map` keyed by normalised command text) remembers every command
    for the full investigation, separately from the capped narrative: an exact repeat is refused
    **before a shell is spawned** (`(already run at step N, … — refused, not re-run)`), and the prompt
    is told explicitly which commands are spent and what each one returned. Two consecutive rounds
    where every suggested command was already spent ends the investigation instead of running out the
    12-round budget on refusals. Verified against a real (fake) backend and a real shell in
    `tool/check-explore.mjs` — not a unit test of the memory in isolation, which would pass even if the
    wiring into the loop were wrong.
  - **This is a per-call investigation with no memory ACROSS calls** — it rediscovers the codebase
    every time it runs. A per-project retrieval layer (embed once, recall across sessions) is a
    separate, much larger project; it does not block this fix, since an investigation that stops
    looping within itself is worth having regardless of what it can remember between calls.

## Repo watcher (`watch.ts`)

`ayin watch --repo <path>` installs a `post-commit` hook and runs a foreground daemon;
bare `ayin watch` is the boot/launchd resume path (hooks already installed); `--once`
processes the backlog and exits.

The moving parts, designed to survive interruption at any point:

- **Hook** (`.git/hooks/post-commit`, marker-tagged, idempotent reinstall; a foreign hook is
  never overwritten) appends `{ts, repo, commit}` as one JSON line to
  `~/.ayin-cli/watch/queue.jsonl`. It never blocks the commit and never needs the daemon up.
- **Daemon** polls the queue every 2s (poll-only — no fs.watch, no sockets). An entry absent
  from the processed ledger (`processed.jsonl`) is backlog: commits made while the daemon was
  down, or in flight when the machine died, are picked up on the next start with no human in
  the loop. Reviews are idempotent (report rewritten), so a crash mid-review just re-runs.
  Singleton via pidfile (stale pids are taken over). One daemon serves all watched repos.
- **One door to the GPU**: before a review batch the daemon enqueues on the backend's llm
  resource as the `ayin` authority (`POST {llmUrl}/resource/llm`) — the backend swaps to the
  coder model on `ownership.gained` and reverts when the batch drains (detach; also released
  on SIGINT/SIGTERM so a kill mid-batch doesn't strand the grant until TTL). Resource busy →
  the batch is **deferred** to a later poll, never run by side-door. No resource layer on the
  backend → best-effort on the served model.
- **Review**: commit metadata + capped diff (120 KB, truncated at a hunk boundary) → one
  `llmChat` call scoring the diff against the `SMELL_SIGNALS` catalog (~20 typical smells);
  each finding carries a **confidence 0.30–1.0**. Output: `reviews/<shortHash>/CodeReview.md`
  under the repo root (or under `AYIN_REVIEW_DIR` if set) — metadata table, changed files,
  findings, verdict. One folder per review — everything about that commit's review lives
  together in it, nothing loose in the repo root.
- **Unity repos** (`Assets/` + `ProjectSettings/`): each commit also gets
  `reviews/<shortHash>/AssetDiff.md` — the deterministic `unity_asset_diff` (`commit^ → commit`,
  `--md`) object-level change map — beside `CodeReview.md` in the same folder; the review links
  to it and the reviewer receives its content. Tool at `~/tools/unity_asset_diff.py` or
  `AYIN_UNITY_DIFF`; missing tool → one-line note.
- **Merges** get the same treatment: `reviews/<shortHash>/MergeReport.md`.
- **Agent-file pointer**: after a report is written, a fenced `<!-- ayin:reports:begin -->` block
  in the repo-root **`CLAUDE.md` *and* `GEMINI.md`** lists the pending reports — everything under
  `reviews/` plus any root-level periodic smell report (newest 12), so the next Claude Code /
  Gemini CLI session reads them. Managed region only — the rest of each file is untouched; a
  missing file is created.
- **No repo hygiene.** `ayin watch` writes nothing to `.gitignore` and maintains no cruft-list
  block in `CLAUDE.md`/`GEMINI.md`. What a repo ignores is its owner's call — the only files
  ayin ever writes to a watched repo, beyond its own reports (under `reviews/`, or a root-level
  `AYIN-REPORT-SMELLS-*.md`) and the agent-file pointer block above, are the Claude Code hound
  hook described next.
- **Claude Code hound hook** (installed alongside the git hooks, self-healed the same way):
  `.claude/hooks/ayin-hound.mjs` + a Stop-hook entry upserted into `.claude/settings.json`
  (`AYIN_WATCH_HOUND=0` to skip installing it — existing installs are left as-is). The script is
  the shipped `assets/ayin-hound.mjs` copied in verbatim under a one-constant header carrying the
  reviewer prompt (which lives in the prompt store, never in the asset). It runs in **two stages**:

  **1 · Facts, computed by git, with no model at all.** Six mechanical checks whose answers are
  true by construction:
  | check | fires when | why it matters |
  |---|---|---|
  | `staged-foreign` | a staged **M/D/R** file no commit on this branch (since its merge-base with `origin/HEAD`/`main`/`master`/`develop`) ever touched | unrelated work swept into the index |
  | `meta-guid-changed` | a staged `.meta` whose **`guid:` line actually changed** | every asset referencing the old guid is unbound |
  | `serialized-field-removed` | a `[SerializeField]`/public field present at HEAD and gone in the index | its stored value is dropped from every prefab/scene/asset |
  | `enum-ordinal-shift` | the old member list is **not a prefix** of the new one (or an explicit value changed) | every serialized int now means a different member |
  | `interface-member-added` | an `interface I…` body gained a member | every implementer must implement it — and implementers are exactly what the diff cannot show |
  | `asmdef-reference-removed` | a `.asmdef`'s `references` array lost an entry | that assembly's scripts lose those types |

  Two of these are deliberately self-silencing, because a hound that barks every batch is a hound
  nobody hears: newly **added** files are exempt from the provenance check (they are almost always
  the session's own work), and the check is skipped entirely when *every* staged file is foreign —
  that means the branch simply hasn't committed in this area yet, and there is no outlier to point
  at. `.meta` files fire only on a changed `guid:`, never on a touch: Unity rewrites them constantly.

  **2 · Verification by ayin itself**, read-only (`AYIN_READONLY=1` → `grep`/`read_file`/`find_files`
  only, never edit; `bash` denied), capped by `AYIN_MAX_ROUNDS` so it spends its budget on greps
  instead of deliberating. Each fact carries the **exact ayin tool call** that answers it — `grep
  pattern="…" path="Assets"` — not a shell command, because the agent has no shell and refused
  `bash` calls burn the whole budget. Searches are scoped to `Assets/` in a Unity repo: `Library/`
  is gigabytes of generated cache that git ignores and `grep -r` does not. The engine is ayin, not
  `claude -p` — no LAN address to hardcode; it inherits whatever `AYIN_LLM_URL` this install uses.

  **The output contract is enforced in the script, not requested in the prompt.** A finding whose
  citation does not resolve to a real path in the repo is **dropped** (this is what makes an
  invented `DebugLogger.cs` worthless), `greps_run: 0` **forces** `UNVERIFIED`, and an `ISSUES`
  verdict with no surviving citation degrades to `UNVERIFIED`. Blocking a stop costs a whole extra
  turn, so it is reserved for a verified, cited finding (`decision: "block"`); deterministic flags,
  `UNVERIFIED` results and the commit nudge ride out as non-blocking
  `hookSpecificOutput.additionalContext`, which Claude reads without being stopped. A missing or
  unreachable model does **not** silence the hook — the git-computed facts are still true, and go
  out with the shell commands a human should run. Nothing staged, or no fact and a diff under 80
  lines → the hook exits silently without a model call at all.

  Loop-safe and cheap: `stop_hook_active` on the hook payload is honoured (a stop that is already
  the continuation of a block never blocks again), the recursion guard `AYIN_HOUND=1` is set on the
  child, and an atomic `mkdir` lock hashed per staged diff debounces repeats (swept after a day).
  `AYIN_HOUND_SELFTEST=1` stubs the model call; `--facts` prints the deterministic facts as JSON and
  `--dry` prints the prompt, both without spending a generation. The JSON merge into `settings.json`
  only ever touches the one Stop-hook group whose command names `ayin-hound.mjs` **or** the
  pre-1.0.224 `ayin-hound.sh` — so an upgrade replaces the old bash hound (and deletes its script)
  instead of running two per stop; every other key, every other Stop entry, every other hook event
  is left exactly as it was, and an unparseable existing file is left alone rather than risking a
  hand-edited config. Both the hook script and `settings.json` are written via `writeAtomic()`
  (temp file + rename) — a power cut mid-write can never leave a truncated `settings.json` for the
  next Claude Code turn to choke on (an unparseable file would otherwise be presumed hand-edited
  and left alone forever, exactly the case a self-inflicted truncation must not fall into).
- **Guards**: commits touching only `reviews/**` (or a root `AYIN-REPORT-*.md`) are skipped (no
  review-of-review loop); the agent files and everything under `reviews/` are excluded from the
  working-tree fingerprint, the review diff, and auto-staging — so ayin writing its own reports
  or pointer block never re-triggers a pass and never commits its own bookkeeping;
  vanished commits (rebase/gc) are ledgered as `gone`; LLM/backend failures retry with
  linear backoff up to 5 attempts, then are ledgered as `failed`.
- **Autostage pass** (every 10 min, only repos whose working tree changed): a deterministic gate
  (`NEVER_STAGE_RE` — `ProjectSettings/`, `UserSettings/`, `Packages/`, `.vscode/`, `.idea/`,
  `.vs/`, `hooks/`, `*.csproj/.sln/.user/.vsconfig/.txt` — plus `SECRET_RE` for `.env*`/keys/
  `id_rsa`/`id_ed25519`/anything named `*secret*`/`*credential*`, and ayin's own output paths)
  drops files before the model ever sees them. What's left goes to the LLM, told to
  `stage:true` real source (`.cs`, `.anim`/`.controller`/`.overrideController`/`.asset`, normal
  source/tests/docs) and `stage:false` debug scaffolding, stray logs, commented-out experiments,
  scratch files, editor cruft — defaulting to `false` when unsure. Its plan is re-filtered through
  the same gate before `git add` runs, plus a 2 MB size cap. Never commits — only stages/unstages
  and drafts `.git/COMMIT_EDITMSG`.
- **In a Unity repo the model does not decide staging at all** — an ALLOWLIST does
  (`unityStageReason`), and it is the whole policy. Exactly three kinds are staged:
  1. **animator controllers and clips** — `.anim`, `.controller`, `.overrideController`;
  2. **custom ScriptableObject assets** — a `.asset` under `Assets/` whose
     `m_Script: {fileID: 11500000, guid: …}` resolves to a `.cs` in this project (one cached
     `git grep` over `Assets/*.cs.meta` per distinct guid). A `.asset` that is baked data, a
     built-in type, package-owned, or outside `Assets/` is left alone;
  3. **`.cs` files that add no debug code** — the added lines (working tree vs HEAD; the whole file
     when untracked) are checked against `DEBUG_CODE_RE` — `Debug.Log`/`LogFormat`, `print(`,
     `Console.Write*`, `System.Diagnostics.Debug.Write*` — with `//` line comments stripped first,
     so a commented-out `// print(x)` is a smell for the report, not an invisible staging veto.
     `Debug.LogError`/`LogWarning`/`LogException` are deliberate error reporting and do not
     disqualify a file.

  Plus the `.meta` sidecar of anything staged above (`stageWithSidecar`) — a new asset committed
  without its `.meta` is a broken Unity commit. **Prefabs and scenes are never auto-staged**:
  opening a scene rewrites it, which made them the largest source of accidental churn in the index.
  Stage those deliberately, by hand.
- **Unstaging is limited to ayin's own work.** `worktree-state.json` carries a per-repo `staged`
  ledger of what ayin put in the index; a path is unstaged only if it is in that ledger and no
  longer qualifies. A developer's own `git add` is never reverted — unstaging deliberate work is a
  worse failure than leaving junk behind. The ledger is persisted, so a power cut between staging
  and the next pass cannot re-attribute ayin's staging to the developer.
- The status scan behind all of this (and the model's file list) uses `-uall`/`--untracked-files=all`
  — without it, git collapses a brand-new, never-before-seen directory to one summary line
  (`?? Assets/NewFeature/`) instead of the files inside it, so a new Unity feature folder added all
  at once (script + anim together — a common workflow) would silently match nothing.
- `npm run check:watch` (`tool/check-watch.mjs`) is the offline gate for both halves of what
  `ayin watch` writes into a repo: the hound's deterministic facts and this allowlist. No model, no
  network — it builds a throwaway Unity-ish repo in the temp dir and asserts each decision.

## Prompts (`prompts-service.ts`, `prompts.ts`, `prompts/`)

Prompt text never lives in source. Each package ships its prompts as `.txt` files beside its code —
ayin's own in `prompts/ayin/`, a tool's in `<tool-package>/prompts/` — and the operator's editable
copy lives at `~/.ayin-cli/prompts/<namespace>/<id>.txt`, which is the only thing read at call time.

`prompts.register(namespace, sourceDir)` copies any locally-missing id from SOURCE to LOCAL and
returns a `PromptBundle` bound to LOCAL. Copies are atomic (temp file + `rename`), so an interrupted
run leaves either the old prompt or the new one, never a truncated one. **Materialization never
overwrites** — a local file is the operator's; a newly shipped id appears on the next boot; an edited
one is untouched. `restoreDefaults()` is the only overwriting path and is explicit.

Tools receive their bundle by **injection**: the registry reads `tool.promptsSourceDir`, materializes,
then calls `tool.bindPrompts(bundle)`. `BaseTool#prompt(id, vars)` reads through it. A tool therefore
depends only on an interface ayin provides — not on the service singleton, not on `~/.ayin-cli` — which
is what allows tool packages to live in their own public or private repos. A tool with no bundle throws
a clear error rather than running on empty text.

Variables are `{{UPPER_SNAKE}}`. An unknown id throws. `config` (numeric knobs, the OpenAI key) stays
in `~/.ayin-cli/prompts.json` — settings are not prompts. Installs predating the file store are
migrated on first run: prompt entries move out of `prompts.json` into `.txt` files (operator edits
preserved), and the original is kept as `prompts.json.pre-filestore`. The `:7773` editor UI projects
the file store into one JSON document keyed `<namespace>/<id>` and fans saves back out to the files.

### Variable drift — the silent failure "never overwrite" creates

Materialization never overwriting is right for **wording**, which is the operator's. It is wrong for
`{{VAR}}` placeholders, which are the **interface between the code and the text**. When the code starts
passing `{{DELIVERABLES}}` and the local copy predates that variable, the code supplies the data, the
prompt never asks for it, and the model is simply never told. Nothing errors. Nothing logs. An entire
feature is silently absent.

That is not hypothetical — it was found by auditing, not by noticing. A local `planDocument.txt` several
versions behind meant a whole new plan section reached the model as nothing, and a local `system.txt`
was missing the **"Ready for QA"** line, so the QA gate's explicit trigger never fired at all.

So `register()` compares the variable SETS (never the text) and records a `PromptDrift`;
`promptDriftWarnings()` is printed at boot on every path, headless included. `restoreDefaults()`
remains the only overwriting path — the operator is told, loudly, and decides.

### Prompt economy — see CLAUDE.md §3a

Prompts here are read by a coding agent doing tool calls, on a turn the operator is waiting through.
A token you add costs a slice of the attention available to **every other token, including your hard
constraints** — 18 of 18 frontier models degrade as input grows, one distractor measurably hurts, and
mid-context material loses >30%. The rules (delete politeness, justification, non-format examples,
hedges; budget `MUST`/caps to ≤3 per prompt; constraints first or last) live in CLAUDE.md §3a.

**Measure the variables before tuning the wording.** `npm run audit:prompts` dumps every prompt with
its effective text, call sites, size and variable drift. The lesson that produced this section:
tightening the prose of `planGrounding.txt` saved ~800 characters; retrieving instead of dumping the
`{{CATALOG}}` it wrapped saved ~8,100.

## Retrieval

None. ayin finds code the agentic way — `grep`, `find_files`, `read_file` and `explore`. The
earlier retrieval surfaces (a grounded Q&A corpus generator, transcript-mined episodes, and a
`docs_search` tool over a specific backend's documentation index) were **removed**: each one
was naive retrieval and each one hard-wired ayin to one operator's private backend. A
redesigned retrieval layer is planned; until it lands, no code path in ayin embeds, indexes or
retrieves anything.

## TUI (`src/ui/`)

The interface is a tree of decoupled widgets behind the `ui.ts` façade (the exported function
API — `addMessage`, `setAgentStatus`, `setStatus`, … — is unchanged, so nothing outside the
tree knows about the internals). Design rules:

- **One geometry authority.** Widgets never touch each other's `bottom`/`height`. The screen
  is a bottom-up stack (status bar → input → hints → chat gets the rest) managed by
  `layout.ts#relayout()`; a widget that changes height calls `relayout()` and everything
  restacks. Adding a new bottom-docked element = one entry in the stack registration.
- **One keypress router** (`keys.ts`) and **one theme** (`theme.ts`).
- **Markdown renders everywhere prose can appear, not just the chat transcript** (`markdown.ts`).
  `renderMarkdown` (one logical line in → one styled line out, no rewrapping) served the scrolling chat
  box fine, but fixed-width contexts — the permission dialog's `body` (the agent's own "why it wants
  this" reasoning, which routinely carries full markdown), a QA card's body lines — showed that same
  prose completely raw (literal `**`/`###`/`*`), because wrapping ALREADY-tagged text risks splitting a
  `{tag}` mid-sequence and corrupting the whole render — so those call sites just never attempted it.
  `renderMarkdownWrapped(text, width, wrap)` fixes this the safe way: strip line-START markers (heading
  `#`/`##`/`###`, bullet `-`/`*` — harmless to strip before wrapping, since they only ever affect where
  a paragraph begins) → wrap the STILL-PLAIN paragraph text (inline markers like `**`/`` ` `` are
  ordinary characters to the wrapper) → apply `inlineFormat` (now exported) to each ALREADY-WRAPPED
  line independently, then bold the whole paragraph if it was a heading. `dialog.ts`'s `body` and
  `chat.ts#formatGateCardForChat`'s body lines both use this now. Known, accepted degradation: a bold/
  code span itself longer than one wrapped line loses its styling on the split line rather than
  corrupting the tag stream — correct for a side dialog, wrong for the main transcript, which is why
  `renderMarkdown` itself is untouched for that path. Also fixed in the same pass: `renderMarkdown`
  never escaped a literal `{`/`}` the MODEL wrote in ordinary prose (only inside fenced code blocks) —
  a latent tag-corruption risk now closed the same way `chat.ts`'s own `escapeBlessedTags` already
  protects tool-output previews.
- **Copy-paste contract, as amended** (`screen.ts`). The old rule was absolute: never enable mouse
  tracking, because it hijacks terminal-native text selection and copying transcript text matters more
  than a wheel. It was right about the tradeoff and wrong that the tradeoff is total — every terminal
  worth using lets **Shift+drag** bypass an application's mouse reporting and select natively. So the
  wheel is enabled in exactly one place (`keys.ts#installMouseRouter`) under two conditions that keep
  the rule's spirit: **wheel events only** (nothing is `mouse: true`, clickable, focusable or
  draggable, so a click still does whatever your terminal does with it) and **switchable**
  (`AYIN_MOUSE=0` restores keyboard-only exactly, for a terminal without the bypass).
- **Scrolling, in one place.** Wheel (3 lines/notch) · `PgUp`/`PgDn` (half page) · `Shift+↑`/`Shift+↓`
  (one line). Plain `↑`/`↓` are **prompt history** — but inside a multi-line buffer they move the
  cursor between lines first (`input.ts#moveCursorLine`), because pressing ↑ to fix the first line of a
  three-line prompt used to replace the whole thing with the previous prompt and lose what you wrote.
  History is reached only from the buffer's first or last line, exactly like a shell.
- **Nothing is truncated silently** (`widgets/chat.ts`). Every card obeys a line budget **and** a
  ~5k-char budget, because a line budget alone is not a budget: one minified JSON response is a single
  line of 400 KB and passes any `lines.length` check. The `write_file` diff card had no cap at all —
  rewriting a 3000-line file painted a 3000-line card and buried everything above it — and now shows
  head + tail with an honest middle marker, since a diff's end matters as often as its beginning. Every
  omission states how many lines and bytes were withheld and that the full output is still an artifact
  (`Ctrl+O`), so truncation never reads as data loss. The display budget is deliberately a *different*
  number from the model's own clip in `agent.ts`: "how much should a human read" and "how much should
  the model see" are different questions.
- **Gate cards** (`formatGateCardForChat`). A QA verdict and plan mode's notices use the same gutter and
  footer as a tool result, coloured by outcome. They were plain `system` lines, which gave a three-pass
  review of the user's work the same visual weight as `[Loop detected]` noise. The gate emits a
  structured `QaCard` (kind · title · body · footer) and the widget owns how it looks; headless flattens
  it to text, because blessed markup on stderr is noise.
- **One animation heartbeat** (`ticker.ts`): widgets subscribe for 80ms beats instead of
  owning intervals — every animation is phase-locked, one re-render per beat regardless of how
  many things move, and the clock stops itself when nothing is subscribed (idle = zero CPU).
  Per-animation speed is a tick divisor (`every`) in the widget's spec table.
- **Live LLM phase in the status bar** (`llm-events.ts` + `widgets/status.ts`): the TUI
  subscribes to the backend llm resource's SSE stream (`GET {llmUrl}/resource/llm/events`,
  auto-reconnect with backoff) and reduces its events to one **animated** segment, each phase
  with its own motion (a new phase = one `LLM_PHASE_LOOK` entry):
  `⇆/⇄ swapping <model>` (amber, arrows trading places) → `◔◑◕● preprocessing` (indigo,
  context filling) → `▸▹▹ responding <model>` (green, tokens flowing) → `◇◈◆ postprocessing`
  (violet, reply crystallizing). **Event blips** flash transiently and auto-clear:
  `✓ 1.8s` on request.finish, `✓ <model> ready` on swap.finish, blinking `⚠ context overflow
  risk` on oom.warning. Idle hides the segment; a dead stream blanks it rather than showing a
  stale phase. The ayin-layer postprocess (tool-call parsing in `agent.ts`) reports through
  the same segment as `postprocessing ayin`.
- **Speaker anchors** (`widgets/chat.ts#redraw`): the transcript is parseable by the left
  gutter alone — `▌ bold` = the user (indigo bar, every line of a multi-line prompt),
  `◉ text` = ayin speaking (ayin = "eye"; accent glyph on the first line, markdown body),
  indented `▸/│/╰` amber frames = tool cards (a dedicated `tool` message role, not `system`),
  `· dim` = system notices (the quietest thing on screen). The input prompt is the matching
  accent `❯`. User lines are tag-escaped like tool output (braces in prompts are literal).
- **Vertical rhythm + indent** (`widgets/chat.ts`: `GUTTER`, `TOOL_INDENT`, `startsToolCard`):
  spacing carries the structure, since everything one line apart read as one wall of text. A user
  prompt gets **two** blank lines (it starts a new exchange), an assistant turn and a system notice
  get one on a speaker change, and **each tool card gets one before its `▸` header**. The header —
  not the message boundary — is the separator because a card is *two* messages (call, then
  result+footer), so splitting on role would cut cards in half. Tool lines are indented
  `TOOL_INDENT` (4 cells, a tab step) vs the `GUTTER` (2) used for wrapped speaker text, so machine
  output reads as subordinate to the conversation instead of competing with it at the same margin.
- **Tool cards** (`widgets/chat.ts`): a call opens with a styled header
  (`formatToolCallForChat` → `▸ bash · cat package.json`), the result renders via
  `formatToolResultForChat` — `write_file` gets the diff card, every other tool a `│`-gutter
  preview block (6 lines for bash/grep, 4 for read_file, 2 default, 200-char line cap) with
  blessed tags **escaped via `{open}`/`{close}`** (raw `{`/`}` in bash/JSON output used to be
  parsed as markup and silently garbled) — and every card **closes with a timing footer**:
  `╰ ✓ 3.0s` (green) or `╰ ✗ 0.2s` (red) when the result is an error/timeout/non-zero exit.
  The bash tool appends `(exit code N)` to failing-with-output commands so both the model and
  the card can tell failure from success. Backgrounded completions get the same card + timing.
- **ThinkingIndicator** (`widgets/thinking.ts`) is a small state machine: each `AgentState`
  (`thinking` · `tool` · `explaining` · `summarizing`) owns its frames, speed and color in
  `STATE_SPECS` — a new animation state is one entry there, no plumbing. The line renders as
  `▍ ⠹ label··  12s` (state-colored gutter, spinner, pulsing label, breathing ellipsis,
  elapsed). Drive it explicitly with `setAgentState(state, label)`; the legacy
  `setAgentStatus(text)` still works and infers the state from the text.
- **Goal display — switchable** (`widgets/chat.ts`, `AYIN_GOAL_VIEW`): `both` (default) · `card` ·
  `watermark` · `line` · `off`. Treatments can be compared without a rebuild.
  - **`card`** — a bordered OBJECTIVE panel above the input. Width follows the longest wrapped row
    (so a short goal gets a short card), wraps to at most 3 rows, and the border arithmetic is
    asserted: body is `"│ " + w + " │"` = `w+4` cells, so the top fill is `w - TITLE.length - 1`.
    Verified aligned at 17/37/73 cells.
    ```
    ╭─ OBJECTIVE ───────────────────────╮
    │ Improve the status LLM window │
    ╰───────────────────────────────────╯
    ```
  - **`watermark`** — a faint `ᵍᵒᵃˡ …` line above **every assistant turn**, so the anchor is visible
    while *reading* the answer, not only while typing. One line, hard-truncated: it must never push
    the answer down the screen.
  - **The terminal tab** always carries it (`ayin · <goal>`, via `screen.title` → OSC), even when the
    view is `off` — with several sessions open the tab bar is the only way to tell them apart without
    switching. A shell that rewrites the title on every prompt will fight it.
- **Session goal** (`goal.ts` + `widgets/chat.ts`): a one-line, auto-determined **direction**
  for the session — the anti-wander anchor. On the first user message `refreshGoal()` makes one
  cheap LLM call (the `goal` prompt) that distils the user's intent into a stable one-liner;
  it's injected into the agent's system context every round (`Session goal (…do not wander…)`,
  above the volatile `Current task`), and shown at the **bottom of the chat — just above the
  thinking indicator and the input** (in the user's eyeline while typing / watching ayin think),
  in **cursive** and dim. blessed has no italic attribute (its attr model has no italic bit; a raw
  `\x1b[3m` is dropped by `attrCode`), so "cursive" is a Unicode Mathematical-Italic transform
  (`chat.ts#toItalic`) — real slant, no terminal italic support needed (caveat: copy-paste
  yields math-italic codepoints). Set/override with `/goal <text>`, clear with `/goal clear`;
  cleared on `/resume`. The pre-loop derivation is bounded (12s) so a stalled backend can't
  freeze turn 1 — a late result still lands via the goal subscription.
- **Git branch in the status bar** (`git.ts` + `widgets/status.ts`): when the cwd is inside a
  git repo, the path shows the current branch — `…/parent (main)`. Read straight from
  `.git/HEAD` (handles a `.git` *file* for submodules/worktrees; detached HEAD → short sha) and
  cached 2s so the per-tick status redraw doesn't hammer the fs.

- **`/lock` / `/unlock`** (`model-picker.ts#lockSession`) — hold this session's **priority band** until
  the client exits or stops responding. The enforcement IS the grant TTL, which is why it needs no
  server-side session tracking: the hold is taken with a **10-minute** ttl and refreshed every
  **2 minutes** while ayin is alive. Quit cleanly (or `/unlock`) → released at once; die, hang or lose
  the network → the grant lapses within 10 minutes and the backend reverts on its own. Nothing can be
  left locked by a process that no longer exists. Shown as **🔒** beside the model in the status bar.

  **A LOCK IS NOT A MODEL CHOICE (since 1.0.210).** It fires no swap, in any path. It used to have to:
  an endpoint with a per-owner model policy swapped the model when ayin gained the authority, so the
  lock compensated — pin the model, remember it, re-apply it on every regrant. That compensation was
  the source of three consecutive releases of bugs (1.0.207-1.0.209), and it meant **starting ayin
  changed what the shared GPU served for every other consumer on the machine**. Removed at the root:
  ayin never selects a model implicitly. It runs on whatever the endpoint is serving and switches only
  when a human types `/model` — one deliberate request, one door. `/set default-model` is gone with it
  (a stored preference nothing applies is worse than none), as is `lockSessionWithDefaultModel()`.
  **A lock also buys QUEUE PRIORITY.** ayin's `/api/generate` calls are LOW priority by design, so a
  locked session would still sit behind every habit. While locked, ayin sends its authority token
  plus `priority:"high"`; the backend grants HIGH only when that token matches the current holder, so
  priority is proven, never self-declared, and it drops back to LOW the instant the lock ends.
  Measured with the GPU busy: an unlocked request sent FIRST finished in 237.5s, a locked one sent
  1.2s LATER finished in 62.0s.
  **Interactive sessions AUTO-LOCK on boot** (`AYIN_AUTOLOCK=0` opts out). A human at a keyboard
  should not have to know a command to avoid starving: without it a session sits in LOW behind every
  habit, which produced `GPU: chatOnce 306s · 1 waiting` and then a client abort at 10m surfaced as
  `fetch failed`. Auto-lock takes **priority only** — it does not pin or load a model (1.0.210), so
  launching ayin is invisible to every other consumer of the shared GPU. Headless runs do NOT
  auto-lock — unattended work yields.
  **The lock survives the backend losing it.** The authority stack is in-memory, so a daemon restart
  erases every grant: the next keepalive returns a NEW grant rather than a refresh, which silently
  broke the priority the lock exists for: the token being sent was dead, so the session was quietly
  back in the LOW band. `acquireLlm`'s `onRegrant` rotates the token and says so in the transcript —
  **the token only**, since 1.0.210 (it used to re-pin a model here too, which is exactly the implicit
  selection ayin no longer does). `release()` recovers from a rotated token too: if the detach frees nothing and `ayin`
  still holds the resource, it re-acquires to learn the live token and hands THAT back, instead of
  leaking the grant until its TTL.
  **REAL USAGE now keeps the lock alive too — not just the keepalive timer.** Found live: a session
  deep in `/plan` (several long sequential agentic sub-loops, real minutes each) had the model swap out
  from under it mid-session, `gemma` loading over an active `qwen` session with no warning. Root cause:
  the backend's `/api/generate` route checked `holdsToken()` for queue priority (deliberately a
  **non-throwing, no-side-effect** read, so a client can't fake entitlement by merely asking) but
  NOTHING slid the grant's expiry except the client's own 2-minute keepalive — a purely in-memory,
  near-instant op that should never itself be the failure point, but a session that goes minutes
  between keepalive ticks (fully possible; the timer's own schedule, not activity, decided when it
  fired) had zero fallback if that one tick landed even slightly late. `AuthorityHolder#touch(token)`
  (backend `resources/authority.ts`) is `authorise()`'s expiry-sliding effect with `holdsToken()`'s
  safety (never throws, no-ops on a mismatch); `/api/generate` now calls it on every locked request, so
  active use — not a background timer nobody's watching — is what a live session actually depends on.
  Verified in an isolated `AuthorityHolder` instance (no contact with the live resource): a 10s-TTL
  grant, touched once at t=8s, was confirmed still held at t=12s — past what would have been its
  original, un-touched expiry.
  **`/set default-model <name>`** (`lockSessionWithDefaultModel`, `model-picker.ts`) makes auto-lock
  explicit instead of implicit: with nothing configured, boot pins whatever the backend's own
  `ownership.gained` policy happened to swap to (today's plain `lockSession()` behavior, unchanged).
  With a default set, boot explicitly requests THAT model and `awaitResident()`s it — not just
  "requested," actually resident in VRAM — before the session is reported locked, and the regrant
  handler re-pins THIS model (not whatever was active moments before the swap) if the backend ever
  drops and re-issues the grant.
- **Per-model context windows.** Every picker row is labelled with the window that model will
  ACTUALLY get (`27.8B · Q4_K_M · 16.2G · 24k ctx`), because one global `numCtx` is wrong on a 24 GB
  card: KV cost per token is architectural, not a function of size. Measured here — `gemma4:26b`
  (16.8G, 31 layers) fits 64k; `qwen3.6:27b` (16.2G, 64 layers) spills 14 layers to the CPU at 64k
  and fits at 24k. A MoE is not automatically safe either: its weights are all resident (30b-a3b is
  17.3G, the same class as dense), only its FLOPs per token are lower. The backend owns the presets
  (`config.ollama.modelCtx`, `AYIN_CTX_<MODEL>` override) and reports the resolved value per model.
- **Model picker + booking** (`/model` → `model-picker.ts`, catalog in `llm-status.ts`): the
  interactive counterpart to headless `AYIN_ACQUIRE_LLM=1`. Bare `/model` opens the **popup** —
  the same overlay the tool-permission prompt uses (`dialog.ts`) — listing chat models the backend
  has installed, polled live from the llm resource, each row annotated
  (`27.8B · Q4_K_M · 17.3G · shared/coder · ● active`) with the active one pre-selected;
  **Enter initiates the reload**, Esc changes nothing.
  - **Filtered by size** (`filterModelsForPicker`, `modelPickerMinSizeGiB`, default 15, `0` disables):
    the popup is for choosing a real coding model, not a domain-router sidecar or a 3B fallback — a
    picker dominated by utility models nobody would select from a TUI popup isn't a picker, it's
    noise. **The currently active model is NEVER hidden by this filter**, size or no size: a filter
    that could hide what is actually serving you would silently mis-highlight the popup (or highlight
    nothing) while claiming to show your options, and if a threshold this aggressive would leave
    NOTHING at all, it falls back to the unfiltered list rather than present an empty popup. A system
    line reports how many were hidden and how to see them (`modelPickerMinSizeGiB: 0`).
  `/model <name|qwen|gemma>` skips the popup
  (role words resolve to whatever the backend has in that role; anything else is a substring of an
  installed tag, longest match wins).
  Switching to a NON-shared model takes the llm resource as the `ayin` authority and calls the
  guarded `setModel` action with that token, **holding the booking for the whole session**;
  switching to the SHARED model is a **release**, not a set — the backend reverts to gemma when
  the stack empties. Released on `/quit` and SIGINT/SIGTERM (a hard kill lets the grant
  TTL-expire; the keepalive is unref'd). `busy` → another authority holds the GPU, try again.
  A swap costs 30-60s of VRAM churn, so the wait is explicit and bounded (poll `loadedModel`
  until resident, 180s budget) — it narrates progress and gives up with a message rather than
  hanging the TUI. The dialect re-resolves after the swap (`refreshActiveModel`). See "one door
  to every resource" — ayin never touches Ollama and never picks a model by itself.
- **The wait narrator** (`wait-narrator.ts`, wired into `llm/manager.ts` so EVERY call is covered —
  agent rounds, goal derivation, judges, summaries). The thinking line used to say a cheerful
  `Thinking··` for two minutes with no hint why. Now it reports the shared GPU's actual state,
  refreshed every 2s, with the elapsed clock intact (the state deliberately stays `thinking`,
  because the indicator restarts its clock on a state *change* and the number you want is how long
  you have really been waiting):
  ```
  ▍ ⠹ thinking · ⇆ loading qwen3.6:27b (gemma4:26b still resident)        1m04s
  ▍ ⠹ thinking · ⏳ GPU: chatOnce 47s · 5 waiting — ayin queues last       2m11s
  ▍ ⠹ thinking · ▸ GPU: chatOnce 12s                                        38s
  ```
  Facts only, never attribution — it reports what holds the card, not a guess about whose job it
  is, because from here that is unknowable and a confident wrong answer is worse than a plain one.
  The "ayin queues last (low priority)" clause appears only after 20s, when you've earned the
  explanation. Two cached read ops per 2s; skipped entirely in headless.
- **Swap announcement + honest model segment.** Launching ayin through the machine launcher *books
  the coder model*, so a ~17GB-out/~16GB-in swap is usually already in flight before the TUI paints
  — and the bar naming only the TARGET reads as "all good, qwen" while gemma is still the thing
  answering. The segment now says `⇆ gemma4:26b→qwen3.6:27b loading` during a swap, and the
  transition is announced once in the transcript when it starts and once when the model lands.
- **GPU queue in the status bar** — `⏳ chatOnce 6s +2` (amber past 1 waiter, red past 2): what
  holds the backend's shared LLM slot, for how long, and how many calls are behind it. This exists
  because a slow turn and a *queued* turn used to look identical. On that box **one slot serializes
  every model call** — chat, habits, embeddings, model swaps, Chatterbox TTS — ordered by priority
  then FIFO, and ayin's own calls are **LOW** priority (the backend's `/api/generate` is
  `withOllamaPriority("low")`), so a normal-priority habit call that arrives *later* still runs
  first. Measured on the live box: an ayin-class `chatOnce` that had waited 33s sat at **position
  120 of 120**, behind 119 normal-priority `embed` calls. A one-word answer took 4m27s with no model
  swap involved. Knowing this is the difference between "ayin is broken" and "ayin is last in line".
- **Model + GPU in the status bar** (`llm-status.ts` + `widgets/status.ts`): two always-on
  segments — `⬢ qwen3.6:27b` (accent = booked by us · `⬡` muted = the shared model · `⇆` amber =
  mid-swap) and `gpu 43% 19.2/24G 61°C` (colored by VRAM pressure: >75% amber, >90% red). Fed by
  a 5s poll of the llm resource's **read ops** (`{op:'models'}`, `{op:'gpu'}` — open, no authority
  needed), which is the only door to a loopback-only Ollama and to a GPU that may not even be on
  this machine. The poll is self-healing (any failure clears the segments and the next tick
  retries — never a stale value, never a thrown error into the TUI), never stacks overlapping
  requests, and its interval is unref'd. A backend that predates the `models` op degrades to the
  two role models via `{op:'status'}`. Under 100 columns the model tag and the GPU temperature
  are dropped so the bar still fits. **Tech debt** — see the local tech-debt notes.

## Update indicator (`updater.ts`)

The status bar carries `↑ vX available — ayin update` whenever the registry's `latest` is newer
than the running build: checked at boot and every 10 minutes. The registry is
`AYIN_UPDATE_REGISTRY`, else npm's own
configured registry **only when that is a private one** — a checkout pointed at public npmjs gets
no passive check, since `ayin` is a plausible public name and that would both phone home uninvited
and risk advertising a stranger's package as your update. `AYIN_UPDATE_CHECK=0` disables it.

**A successful `ayin update` restarts a running `watch` daemon.** `ayin watch` is a long-lived
background process nobody sits and watches — left alone after an update it would keep reviewing
commits on the OLD build until someone happened to notice. So once `npm install -g` succeeds,
`updater.ts` checks for a live daemon pidfile (`watchDaemonPid()`, exported from `watch.ts`) and,
if one is running: SIGTERM (the daemon's own handler cleans up its pidfile and releases any held
LLM authority — graceful; its queue survives the interruption regardless, per the poll-only +
persistent-queue design), waits up to 10s for it to actually exit, then relaunches bare `ayin
watch` from PATH — which now resolves to the build just installed, and picks its repo set back up
from `repos.json` (the same boot/resume path described above). Best-effort: no daemon running is a
no-op, and a missing `ayin` on PATH prints a fallback note instead of failing the update.

## Popup overlay (`dialog.ts`)

One popup implementation, shared by the tool-permission prompt and the model picker, so both look
and behave identically: a question, an optional dim subtitle, selectable rows with an optional
right-hand note, and a footer legend. ↑/↓ (or k/j) move, Enter picks, Esc cancels (`-1`), a row's
hotkey picks it directly. The **input bar is blurred while the popup is up** and refocused on
close, so keystrokes can't leak into the prompt buffer. Lists longer than 12 rows **scroll a
window** rather than growing off-screen (a 40-model catalog must not outgrow the terminal), and
colors come from `theme.ts` like every other widget.

## Permissions (`permissions.ts`)

Read-only tools (`read_file`, `grep`, `find_files`, `explore`, `status`) are auto-allowed.
`write_file`, `str_replace`, and `bash` prompt for approval in interactive mode (allow once /
allow all / allow-all-with-prefix / deny). **Headless mode auto-approves** so unattended runs
can finish — see the warning in `SETUP.md`.

## Supporting modules

- **`summary.ts`** — a rolling session summary, updated each exchange via the LLM and injected
  into every call as compact context.
- **`prompts.ts`** — registers ayin's own prompt namespace and exposes `getPrompt(id, vars)`. Holds
  `config` (windowSize, maxToolRounds, …) in `~/.ayin-cli/prompts.json`, read on every access so live
  edits apply immediately. Prompt TEXT is in `.txt` files, not here — see the Prompts section. The
  tool-call format is supplied by the active dialect, not hardcoded.
- **`prompts-service.ts`** — the SOURCE→LOCAL materializer and `PromptBundle` provider.
- **`prompt-server.ts`** — optional local web UI for editing those prompts.
- **`artifacts.ts`** — every tool output is saved under `~/.ayin-cli/artifacts/` and browsable
  in the TUI (`Ctrl+O`); chat shows a 2-line preview.
- **`history.ts`** — persistent prompt history.
- **`/transcribe` — the FULL, unclipped record** (`transcript.ts`, 1.0.213). A *second* record with the
  opposite trade-off to the session log below: **nothing is ever clipped.** Prompts, every model
  response **verbatim and pre-parse** (the raw text, before tool-call markup is stripped), every tool
  call with its **full parameters and full result**, the final answer. Off by default; on for a session
  with `/transcribe` (`/transcribe off` stops it), or for an unattended run with **`AYIN_TRANSCRIBE=1`**
  / `--transcribe` — which is the mode it was built for, since an enqueued task has nobody watching and
  the only way to answer "why did it do that" afterwards is a complete record written while it ran.

  Why it exists: the operating record clips every field to 4000 chars, and the part it throws away is
  usually the 12 KB of tool output the model actually reasoned from. Measured on the first real run —
  a `read_file` result stored at **9166 chars** that the operating record would have cut at 4000.

  **Two files, on purpose.** `~/.ayin-cli/transcripts/<id>.transcript.jsonl` is append-only, flushed per
  event — the durable spine, so a `kill -9` costs at most the event being written.
  `<id>.transcript.json` is the formatted (2-space) document a human or another agent reads, rebuilt
  from that spine on a 1.5 s debounce (re-stringifying a multi-megabyte transcript on every tool result
  would make debugging the thing that needs debugging), and always flushed on an answer and on exit.
  The exit flush is a `process.once('exit')` hook, not a `finally` — both headless paths call
  `process.exit()`, which skips `finally`, so the last debounce window would have been lost on exactly
  the unattended runs this serves. `rebuildFromSpine(id)` reconstructs the JSON if a crash lands between
  debounces. **These files are expected to be large. That is the point.**
- **`/wipe` — delete saved state, deliberately** (`wipe.ts`, 1.0.214). Nothing under `~/.ayin-cli` has
  ever pruned itself, so it only grows — measured on one machine: **3418 artifacts / 36 MB**, **824 log
  files / 32 MB**, 99 sessions. Most of it predates the current build, and stale debugging data is worse
  than none because you trust it.

  `/wipe` opens a scope menu showing what each currently costs, then a second dialog stating the exact
  file count and byte total, defaulting to **Cancel**. `/wipe all` · `/wipe artifacts` · `/wipe logs` ·
  `/wipe transcripts` skip only the menu. Scopes: this directory's sessions (default), every
  directory's sessions, artifacts, logs, transcripts.

  Four safety rules, enforced in `wipe.ts` rather than trusted to the caller: **plan-then-execute**
  (`planWipe()` only reads — the operator approves a number, not a verb); **never the live files** (the
  session being recorded, the transcript being written, and this process's own log are excluded from
  every scope, because deleting a file mid-append turns "clear old data" into "corrupt today's run");
  **pattern-matched, never recursive** (no `rm -rf` anywhere in the file — a stray `.dat` someone parked
  in `artifacts/` is left alone); and **transcripts are never in the default** — they are opt-in to
  create and the one record with no clipped copy elsewhere, so they go only when named. `executeWipe`
  measures freed bytes **per file as it deletes**, not from the plan, so a partial failure cannot report
  space it did not free.
- **The alert row — the bottom line of the screen** (`ui/widgets/alert.ts`, 1.0.213). Warnings and
  errors, and nothing else, in red, at the very bottom of the stack (below the status bar). Everything
  used to land in the chat log as a grey `system` message, so a real error scrolled away behind the next
  tool result at the moment you needed it; this row does not scroll. Two layers: a **sticky** notice (a
  standing condition — "this session is being transcribed") and a **transient** alert (an LLM error, a
  blocked tool) that takes the row for a ttl and then falls back to the sticky one. Height 0 when there
  is nothing to say, because a permanently lit red bar teaches you to ignore red bars. Same GLYPH RULE
  as the status bar — `▲`/`■` are BMP, non-emoji-presentation, width 1; `npm run check:glyphs` enforces it.
- **Sessions + `/resume`** (`session-store.ts` reads, `session-record.ts` writes). Every run appends
  one JSON line per prompt / tool call / answer to `~/.ayin-cli/sessions/<id>.jsonl`, each line
  carrying its `cwd`; `syncSession()` (called each turn by the agent) keeps a
  `<id>.checkpoint.json` sidecar with the rolling summary. `/resume` rebuilds context from both:
  summary from the sidecar, the last 20 turns replayed from the record. **Tool calls are excluded
  from the replay** — they're in the record to read, but replaying them would spend the context
  budget on output the model already acted on.
  - **What a restore actually restores** (all three, since two were missing): the **agent's
    `conversationWindow`** via `restoreConversation()` — the ONLY history `buildMessages` reads, and
    previously module-private with no way in, so a resumed session gave the model *nothing*; the
    **chat transcript**, repainted between `── resumed <id> · N turns replayed below ──` and
    `── end of restored history ──`, because otherwise the screen still showed the session you left;
    and the summary store. Related finding: `buildMessages` read `getSummary()` into a variable it
    never used, so the rolling summary had never reached the model at all (and `updateSummary` is
    disabled — "was hallucinating"). It is now injected when non-empty, which is what makes a
    restored summary worth anything.
  - **A PICKER, not a printed list.** `/resume` opens the shared `dialog.ts` overlay — ↑/↓, Enter
    restores, Esc changes nothing. Each row is two lines: the **goal** as the label (falling back to
    the first prompt) and the detail you actually weigh underneath —
    `12m ago · 8 turns · 19 tools · read_file×12 bash×4 · 2 files written · 3 artifacts · ~1.3k ctx · 40m long · a1b2c3d4`.
    A row labelled by goal is marked `(goal)` when its first prompt differed.
  - **The goal is checkpointed** (`syncSession(..., goal)`): the append-only record logs prompts,
    tools and answers and has no place for session state, so without this the picker could only show
    a session's first prompt — often a throwaway ("Hey! What model are you?") rather than what the
    session became.
  - **Two-phase listing.** A cheap bounded scan of every record decides what matches and how to sort;
    the per-event stats (`SessionRich`) run **only for the rows about to be shown** (`limit`), so a
    store with several multi-megabyte sessions doesn't pay for detail nobody sees. `rich: false`
    skips it entirely.
  - **Scoped to the directory.** `/resume` lists the sessions recorded in the cwd; `/resume all`
    widens it and shows each session's directory. Restoring one from elsewhere says so.
  - **`/resume <n>`** takes the list number, `/resume <id-prefix>` an id; an **ambiguous prefix is
    refused** rather than resolved to the wrong session.
  - **Not version-scoped.** It used to be (`sessions/cli/<VERSION>`), which made every release hide
    all prior sessions — the UI literally said "No sessions found for this version".
  - **Bounded reads:** listing is one chunked pass per record (newline count + first/last complete
    line), so a multi-megabyte session costs the same memory as a small one. A torn final line (power
    cut mid-append) is counted and skipped, never fatal.
  - History note: this module was a **stub** — `listSessions()` returned `[]`, `loadSessionCheckpoint()`
    returned `null`, `syncSession()` was empty — so `/resume` could never restore anything while the
    records piled up on disk. Verified after the rewrite: 15 assertions incl. per-dir scoping across
    three directories, an ambiguous-prefix refusal, a torn tail, an empty file, and a 14.9 MB /
    60,002-event record listed in 30 ms.
- **`updater.ts` — self-update (`ayin update`)**. Registry resolution is explicit and never
  guessed: `--registry <url>` → `AYIN_UPDATE_REGISTRY` → npm's own configured registry. It compares
  the running version against the registry's `latest` (or `--tag`), then shells out to
  `npm install -g` — deliberately not clever, so an interrupted download leaves the working binary
  untouched (`--check` reports only, `--force` reinstalls the same version). It refuses early with
  a `sudo ayin update` hint when the global prefix isn't writable (often `/usr`), and
  warns when the running ayin is a **source checkout**, where a global install changes nothing and
  the real update is `git pull && npm run build`. `ayin version` prints the running version.
  Subcommands that print to stdout (`update`, `version`, `watch`) are listed in
  `ui/headless.ts#NO_TUI_COMMANDS` so blessed never grabs the terminal out from under them.
- **`tokens.ts`** — context-meter estimate: tries `${llmBaseUrl}/api/estimate`, falls back to
  a chars/4 heuristic.
- **`session-store.ts`** — the READ side of the session store plus the checkpoint sidecar, scoped to
  the working directory. (It was once a stub that answered "no sessions" unconditionally, which is why
  `/resume` used to find nothing; it is a real store now — see the module header.)
- **`ui.ts` / `markdown.ts` / `dialog.ts` / `log.ts`** — blessed TUI, markdown→tags, overlays,
  file logger.

## File structure

```
src/
├── index.ts            entry; interactive vs headless (-p) vs `watch`; overlays; input handling
├── watch.ts            repo watcher daemon: post-commit/post-merge → reviews/<hash>/{CodeReview,
│                       AssetDiff,MergeReport}.md; 10-min working-tree pass → autostage meaningful /
│                       unstage junk (NO commit) + .git/COMMIT_EDITMSG + AYIN-REPORT-SMELLS; upserts a
│                       CLAUDE.md + GEMINI.md report pointer only — no .gitignore, no cruft list;
│                       chains onto foreign hooks; 5-min hook self-heal
├── resource-client.ts  backend resource door (POST /resource/<name>) + shared llm-authority dance
├── agent.ts            the agent loop (build → call → parse → execute → loop)
├── llm/
│   ├── manager.ts      active-model resolution + dialect selection; all LLM calls route here
│   ├── types.ts        ModelDialect interface
│   └── dialects/       xml.ts (shared base) · gemma.ts · qwen.ts
├── connection.ts       transport: the configured endpoint + OpenAI fallback; AYIN_LLM_URL resolver
├── parser.ts           lenient tool-call parser (multi-format)
├── shell.ts            cross-platform shell: /bin/bash (POSIX) · Git Bash/cmd (Windows) + killTree
├── tools.ts            tool registry (a static array — every tool ships inside this repo)
│                       + the system prompt assembler
├── tools/              explore.ts · status.ts · signals.ts · web-search.ts (DDG keyless; SearXNG if configured) ·
│                       diagram.ts (validated PlantUML) · send-push.ts ·
│                       arduino-{db,components-data,explain,diagram,toolchain}.ts
│                       (toolchain.ts is the one place that knows arduino-cli and PWM pin maps)
├── tool-guard.ts       per-turn repeat/deny/poll policy: warn → BLOCK → say so in the system prompt
├── activity.ts         the current named phase (PLAN / QA n/m) → thinking line + status-bar chip;
│                       read by wait-narrator so a gate is never repainted as plain "thinking"
├── executors/          plan / QA / present, specialised PER PROJECT TYPE:
│   ├── types.ts        the three contracts + ProjectType + Deliverable + ProbeFact
│   ├── detect.ts       which project this is — tree first, request only when the tree is silent;
│   │                   RECOMPUTED on every call (the working directory changes mid-session)
│   ├── registry.ts     reads every config.json, selects by project type + priority; throws on
│   │                   any config↔import mismatch — a declared handler that never runs looks
│   │                   exactly like support
│   ├── deliverables.ts glob-ish pattern → "is this file actually on disk"
│   ├── plan/{base,arduino}/     index.ts + config.json
│   ├── qa/{base,arduino}/       index.ts + config.json
│   └── present/{base,arduino}/  index.ts + config.json
├── plan/               plan mode for big cross-feature prompts:
│   ├── survey.ts       the GENERIC project survey (used by the base plan executor)
│   └── index.ts        size trigger + triage → detect → scaffold → survey → explore → grounding →
│                       ayin-plan-<ts>.md → pre-prompt
├── qa/                 post-completion QA gate:
│   ├── probes.ts       deterministic evidence: LAN reachability, README staleness, md richness, SRP
│   ├── criteria.ts     acceptance criteria from the user's own prompts, before artifacts are seen;
│   │                   baseline bars by file kind, plus the ids the QA executor asks for
│   ├── review.ts       one judged pass → {verdict, summary, issues[]}
│   └── index.ts        the trigger, the turn state, executor prepare→probe→criteria, the ≤3-pass
│                       fix loop, the verdict card
├── permissions.ts      approval dialogs + allow-lists
├── summary.ts          rolling session summary
├── goal.ts             auto-determined session goal (anti-wander anchor; LLM-distilled, cursive)
├── git.ts              current-branch lookup for the status bar (reads .git/HEAD, 2s cache)
├── prompts.ts          ayin's prompt namespace + config in ~/.ayin-cli/prompts.json + /set values
├── prompts-service.ts  prompt file store: source→local materialization, PromptBundle injection
├── prompt-server.ts    optional web UI for prompts
├── prompts/ayin/*.txt  (repo root) ayin's own prompt texts — source of truth, copied to local
├── prompts/qa/*.txt    (repo root) the QA gate's baseline criteria — the operator's standing bar
├── prompts/plan/*.txt  (repo root) plan mode's exploration questions, API-gap notices, <plan> block
├── artifacts.ts        save/browse tool outputs
├── history.ts          prompt history
├── tokens.ts           context-meter estimate
├── session-store.ts    local session store: list / resume / checkpoint (cwd-scoped)
├── transcript.ts       /transcribe — the FULL unclipped record (jsonl spine + formatted json)
├── wipe.ts             /wipe — plan-then-execute deletion of saved state; never the live files
├── ui.ts               compatibility façade → src/ui/ (all './ui.js' imports keep working)
├── ui/                 the TUI, decoupled:
│   ├── headless.ts     HEADLESS/THINKING_MODE detection + noop element factories
│   ├── theme.ts        every color + glyph in one place (widgets never hardcode)
│   ├── screen.ts       the one blessed screen — copy-paste contract: NO mouse tracking, ever
│   ├── layout.ts       bottom-up stack (alert→status→input→hints→chat); the only geometry authority
│   ├── ticker.ts       the one animation heartbeat (80ms; runs only while something animates)
│   ├── keys.ts         the one keypress router (global keys → input → chat scroll)
│   └── widgets/        chat.ts (ChatLog + diff cards) · thinking.ts (ThinkingIndicator —
│                       stateful animation) · input.ts (InputBar) · hints.ts (CmdHints +
│                       slash registry) · status.ts (StatusBar) · alert.ts (AlertRow — the
│                       bottom-most row: warnings + errors, red, 0 rows when silent)
├── markdown.ts / dialog.ts / log.ts   render + overlay + logging helpers
├── image.ts            image downscale for vision turns
└── jira.ts / tg-auth*.ts   optional integrations

tool/
├── check-glyphs.mjs    `prebuild` — blessed lies about emoji width; this fails the build on it
├── check-gates.mjs     `npm run check:gates` — the deterministic halves of the three gates, against
│                       dist. Binds real sockets (that is the point: it caught a pooled-keep-alive
│                       socket making a live server look dead), so it is NOT in prebuild. Run it
│                       whenever you touch qa/, plan/ or tool-guard.ts.
└── check-watch.mjs     `npm run check:watch` — what `ayin watch` writes into a repo, against a
                        throwaway Unity-ish git repo in the temp dir: the hound's six deterministic
                        facts (and the two cases where it must stay silent), its anti-fabrication
                        contract, and the autostage allowlist. No model, no network. Run it
                        whenever you touch watch.ts or assets/ayin-hound.mjs.
```

## What ayin deliberately does NOT have

Each of these is an absence on purpose, not a gap waiting to be filled. They are listed because the
absence is load-bearing: adding any of them back would break a property the agent depends on.

- **No service discovery.** `connection.ts` talks to exactly ONE configured endpoint (`AYIN_LLM_URL` →
  `/set llm-url` → loopback). Nothing is looked up, so a misconfigured endpoint fails loudly instead
  of quietly probing alternatives and adding a timeout to every refresh — which is also why
  `tokens.ts` only ever asks that same host for `/api/estimate` and otherwise estimates chars/4.
- **No remote session sync.** Sessions are local files under `~/.ayin-cli/sessions/` and nothing else.
  `sendRequest()` remains only as a throwing stub, so a caller that reaches for remote sync fails
  visibly rather than appearing to succeed.
- **No model of its own, and no implicit model selection.** ayin brings no weights and does not choose
  what is loaded: it reads the active model from `GET /api/status`, picks a matching dialect, and asks
  for a different model only when a human does (`/model`). See the `/lock` section.
- **No hardcoded package registry.** The *passive* startup update check is **opt-in** via
  `AYIN_UPDATE_REGISTRY`; unset (the default) → it never contacts any registry. The explicit
  **`ayin update`** command may additionally fall through to npm's own configured registry (see
  "Self-update" below), and refuses a registry it did not resolve deliberately.
- **No network sandbox.** `bash` can do whatever your shell can. Headless mode auto-approves writes
  and commands, so run it on a tree you can diff and revert.
