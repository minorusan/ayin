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

The endpoint is resolved by `llmBaseUrl()` in priority order: **`AYIN_MODEL_URL`** env → persisted
`llmUrl` in `~/.ayin-cli/prompts.json` (`/set llm-url …`) → `http://localhost:9100`.

> **One name each, no aliases.** An install still exporting an older spelling gets the localhost
> default, which fails loudly against a remote endpoint instead of quietly resolving to the wrong one.
> Anything that sets the endpoint out of this repo's reach — a shell profile, a launchd plist, a
> systemd unit, a CI file — has to name `AYIN_MODEL_URL`.

Transport details: retries on transient errors, a long timeout (coder models can think for minutes),
and image attach for vision turns. See [`SETUP.md`](../SETUP.md) for the ways to stand up an endpoint.

### Preflight — no model, no TUI (`src/preflight.ts`, `src/index.ts`)

`dist/index.js` is a GATE, not the app. It runs one check and only then `await import('./app.js')`.

The split is structural, not stylistic: `ui/screen.ts` builds the blessed screen at **module scope**, and
ESM evaluates every static import before any statement in the importing module — so a check written
inside the app cannot run before the terminal is taken, however early in the file it appears. A dynamic
import is the only ordering that holds. Keep `index.ts` free of features: code there runs with no log
sink and no UI, able to talk to the operator only through stdout.

- **Configured is not reachable, and the gate acts on REACHABLE.** `AYIN_MODEL_URL` exported in a shell
  profile passed a presence check on a laptop that was not on that LAN — so the TUI opened, took a
  prompt, and failed with a connection error: the same first-run failure, one step later. So a configured
  URL is *probed* (`/api/tags`, `/api/status`), because reachability is a property of now, not of when it
  was typed. An OpenAI **key** is accepted on presence alone — `/openai` verified it when it was stored,
  and re-verifying every launch spends a request to re-learn a known fact. Cheapest check first, every
  probe bounded by a short timeout, so a dead endpoint fails the gate rather than hanging it.
- **Unreachable but configured** offers **Retry** alongside the menu: a backend still booting must not
  force anyone to reconfigure anything.
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
**nothing is configured anywhere** — no `AYIN_LLM_PROVIDER`, no `llmUrl`, no `AYIN_MODEL_URL`, and no
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
- **The GitHub PAT** (`src/tools/credentials/github.ts`) — for reaching GitHub as the operator without
  a browser and without `gh auth login`, which is interactive and so useless headless. Read in a fixed
  order: `GITHUB_TOKEN` in the environment → `~/.ayin-cli/github.env` (0600, atomic, via the shared
  `envfile` helper) → `gh auth token` **last**. The CLI is a convenience for a workstation that already
  works, never a dependency: it is a subprocess that can hang (bounded to 4 s, probed once per process)
  and its answer belongs to whichever account someone logged in as, which need not be the one this run
  wants — a real case, since a stale `gh` login served an EXPIRED token while a good one sat in the
  file. Hence file-over-CLI. `verifyGithubToken()` checks a token against `/user` and reports the
  login, because a PAT that is merely PRESENT is worth nothing: the failure it prevents is a stored
  token that 401s later, mid-task, blamed on the code. `githubSummary()` reports source + a masked
  token, never bytes. One token, not several — ayin operates on the repo in front of it; point
  `GITHUB_TOKEN` at a different account if a run needs one. **No slash command** — setting it is a
  file or an env var, so nothing is owed to `src/help.ts`.
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

### Dart is a language the corpus can SEE (`entangle/languages/dart.ts`)

`languageFor()` looks like entangle's business and is not only entangle's: the corpus walk
(`indulge/discover.ts#walkSources`) uses it to decide which files exist, `targetsFor()` to decide what a
file declares, and `importEdges` to follow the reference graph. A language it does not know is a language
the corpus cannot see at all — measured on a real Flutter app, every domain scoped to `client/lib`
discovered **zero** files, and the build reported "matched nothing", which reads as "there is no such
feature".

`dart` is the third implementation: `pubspec.yaml` is the dependency unit (name + `dependencies` +
`dev_dependencies`, read without a YAML parser), a leading underscore is the whole visibility system,
`mixin` declares a surface, generated `*.g.dart` / `*.freezed.dart` are excluded because a question about
generated code answers nothing, and the builtin list carries the Flutter furniture (`Widget`,
`BuildContext`, `Future`) — a false stop on `Widget` would make the tool unusable in the one ecosystem
this file exists for. Verified against the real app: `_ChatPaneState` with 57 members, `abstract
ChatTransport` with 4, package refs, and a `.dart` relative import resolving to the file it names.

### A SCOPED domain seeds inside its scope

Two bugs the Flutter run exposed, both of which made a scoped domain meaningless:

- **`explore` searched the whole repo.** Every candidate was then refused for being out of scope, so
  `chat` scoped to `client/lib` got zero seeds from the search that exists to find them — it had named the
  backend's chat files. A scope is the operator saying where to look; the search now starts there.
- **The path-word top-up required the domain name CONCATENATED in a path** (`joined.length < 6` returned
  nothing for `chat`), and it returned ABSOLUTE paths where every other seed is repo-relative — so when it
  did fire, later reads resolved nowhere. Inside a scope it now matches the domain's words, ranked (whole
  name in the path, then most words matched, then shortest path). Unscoped it keeps the narrow
  concatenation rule, which was measured: word matching across a 3454-file tree returned 67 loose seeds
  for "reward service", and sixty-seven bad seeds cost a night of questions each.

Together these turn four Flutter domains that discovered the same 18 shortest-path files into `chat` → 35
files, `diary` → 15, `updates` → 5. Gate: `npm run check:dart`.

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

- **`dialects/glimmer.ts`** — Muse Glimmer's **ATEM** format, which shares nothing with the XML base:
  `<atem:function_calls><atem:invoke name="x"><atem:parameter name="k">v</atem:parameter></atem:invoke></atem:function_calls>`,
  turns routed by ` to=<recipient><|message|>` and closed with `<|eot|>`/`<|eom|>`, results framed as
  `<tool_output>`. Every token is taken from Ollama 0.32's reference implementation
  (`model/parsers/glimmer.go`, `model/renderers/glimmer.go`) rather than from an observed reply, and
  the instruction text is near-verbatim from the renderer because that is what the model was trained
  against.

  It is needed **only on the prompt-declared path**. `providers/ollama.ts` sends a `tools` array, so
  Ollama's own parser extracts the calls (`toolMode: 'native'`) and ayin never sees ATEM. The resource
  gateway forwards no tools array — and `glimmer.go` bails out of tool extraction on
  `len(p.tools) == 0` — so the markup survives into the reply text and something must read it.

- **`dialects/glm.ts`** — GLM 4.5/4.6/4.7: `<tool_call>NAME` on the opening line, then alternating
  `<arg_key>`/`<arg_value>` pairs, closed with `</tool_call>`. Taken from `zai-org/GLM-4.7-Flash`'s own
  `chat_template.jinja`, which also `tojson`s every argument — so the trained format carries
  `<arg_value>"src/thing.ts"</arg_value>`, quotes included. `decodeArgValue()` unwraps that, and the rule
  is deliberately per-parameter: non-string JSON always decodes, a quoted string decodes for structural
  parameters (`path`, `pattern`), and for VERBATIM parameters (`old_str`, `content`, `command`, …) only
  when it carries a JSON escape. Source text that legitimately begins and ends with a quote —
  `"use strict"` — must keep it: unquoting there does not fail loudly, it writes wrong bytes into a file.

  **`requiresNativeTools = true`, and for GLM it is not a preference.** `<tool_call>`/`<arg_key>`/
  `<arg_value>` are SPECIAL TOKENS in this family's vocabulary: the runtime strips them from the text it
  returns, and with no `tools` array there is no parser to collect them either, so a call is not mangled
  — it is DELETED. Measured through the gateway on `glm-4.7-flash:q4_K_M`: `evalTokens=13`,
  `thinkingChars=0`, `content=""` on three consecutive rounds, and the agent reported
  "Tool calls: 0 · nothing was read" for a task whose first step was to read one file. A fourth run
  leaked the *tail* of a call as text (`…</arg_value></tool_call>`) — the opening tokens consumed, the
  remainder not. Nothing in a prompt can fix a token removed before the text exists, so the schemas go
  to the runtime; the parse path above remains for the leaked-remnant and legacy cases.
  `truncated()` also excludes fenced code and requires a line-start opener, because `Dictionary<string,
  float>` in prose was being read as a cut-off call — a wasted retry round on every mention, in a C# repo.
  Gate: `npm run check:glm`.

**Adding a model family** = implement `ModelDialect` (or extend `XmlToolCallDialect`) and
register it in `manager.ts`'s `DIALECTS`. A few lines. Insert **before** `GemmaDialect`: `DEFAULT` is
derived from the last entry, so appending would silently change the fallback for every unmatched model.

#### Resolution is RETRIED until it lands

The dialect is how tool calls are formatted, so an unresolved model id is not a cosmetic default — it
is a model being taught another family's syntax on every round.

Resolution used to be attempted **once per process**, with the latch set *before* the attempt. One
missed `/api/status` — a backend still booting, an authority not yet held, a provider still
provisional — pinned `cachedModelId` to `''` and the dialect to the gemma DEFAULT for the whole
session, silently. Measured in a real bundle as `"model": "unknown", "dialect": "gemma"` against a
qwen3-coder endpoint; the operator's evidence was "the model emits `<function=`", which reads as a
model quirk and is not one — `<function=` is exactly what the qwen dialect expects, and gemma's
parser could not read it.

Now `ensureRefreshed()` stops when resolution **succeeds**, not when it is first attempted: it re-asks
on the LLM call path, every `MODEL_RETRY_MS` (5s), up to `MODEL_MAX_ATTEMPTS` (12) — and when it does
give up it logs `llm_model_unresolved` naming the fallback dialect, because a fallback that is silent
is the whole bug. `resetModelResolution()` clears the id whenever the **provider** changes, so the old
provider's dialect cannot survive a `/model` switch. `modelResolution()` exposes the state, and the
`/debug` manifest carries **`dialectSource`** — `matched the served model` / `chosen by the operator` /
`FALLBACK — model never resolved` — so a manifest can never again state "gemma" without saying why.

#### Native tools over the gateway (`resourceNativeTools`, OFF by default)

Ollama attaches a **parser** to each model, and they do not agree about what to do when the caller
declares no tools. `glimmer.go` and `qwen3-coder` bail out of tool extraction on `len(p.tools) == 0`,
leaving the markup in the text — which is what makes prompt-declared tools work. **`qwen3.5` (which
serves `qwen3.8`) has no such guard**: it consumes the opening `<function=NAME>` tag as it streams,
emits no call because it has nothing to match against, and returns orphaned `<parameter=…>` blocks
with the tool NAME already destroyed. Nothing downstream can recover a name deleted upstream, so no
dialect can fix it — measured as an agent that ran zero tools and then told the operator its "tool
calls are being discarded by the harness", which was true.

The cure is to stop pretending there are no tools. With the flag on, the resource provider declares
`tools: 'native'`, sends the schemas as `body.tools`, and the gateway (`POST /api/generate`) routes
them through `chatToolStep` so Ollama's own parser does the work and returns structured calls. Those
are rendered **back into the canonical `<function=…>` text** before leaving the provider — exactly as
`providers/openai.ts` does — because everything downstream reads text, and a second structured path
would be a second agent loop in all but name.

**Off by default on purpose.** Prompt-declared tools work today for every model whose parser has the
guard, and switching an install wholesale is a behaviour change rather than a bug fix. Turn it on with
`/set resource-native-tools true` or `AYIN_RESOURCE_NATIVE_TOOLS=1` — required for `qwen3.8`, optional
for the rest. Both halves are backwards compatible: a client that sends no `tools` gets `{content}`
byte for byte as before, and a gateway that ignores the field changes nothing.

#### The context window is REPORTED, never invented

Three numbers described one window and none of them agreed. The session meter said **65536** — a
hardcoded fallback in `tokens.ts`, reached whenever the endpoint does not serve `/api/estimate`,
which is almost always. The indulge budget said **16384** — `LOCAL_DEFAULT_TOKENS`, a default for the
*ollama* provider on a session using the *resource* provider. The active preset actually granted
**40000**, and the resource layer had been reporting it as `ctxSize` the whole time; nothing asked.

An operator therefore watched a bar promising four times the room they had, while the runtime
truncated the prompt in silence — and every budget derived from the window was sized for less than
half of it (27,033 chars of source where 66,000 fit; 4 answers batched per call where 12 fit, so
**3× the LLM calls** on a run measured in hours).

`ProviderStatus` now carries an optional `contextTokens`. The resource provider reads it from the
`llm status` op (one request, strictly more than the `{ok, model}` endpoint gave, falling back to that
endpoint so a backend without the op does not read as down); the ollama provider reports the `num_ctx`
it sets itself, where it is fact rather than estimate. `manager.ts` caches it from the same call that
learns the model — they change together, and reading them from two places is how they drift — and
exposes `activeContextTokens()`, which both `tokens.ts` and `indulge/budget.ts` now consume.

**Zero means unknown, and no consumer may substitute a number of its own.** The status bar renders an
unknown window as `12k/? tokens` rather than a percentage of an invented denominator: a meter that
invents its scale is worse than no meter, because it gets consulted.

#### Compression fires on the BUDGET, never on message age

The window was starved while it sat empty. Every `<tool_response>` older than the four most recent was
rewritten down to 2,000 characters, permanently, on every round — a rule that asked about MESSAGE AGE
and never about the window. Measured on one real session on a 65k model: the prompt climbed to 21.4k
tokens by round 5, dropped to 15.7k at round 6 as the first results aged out, and sat near 13.8k for ten
more rounds. Thirty-six tool calls' worth of evidence shredded with **42,000 tokens of headroom
unused**, after which the agent re-ran greps whose answers it had already been given and thrown away.

`compressOldest` now triggers on the budget: nothing is touched until the prompt passes 75% of it, and
then only the oldest results, only until the prompt is back under 60%. On a 65k window that threshold is
~47k tokens — above every interactive round this machine has produced, so in practice full history now
reaches the model and the function does nothing. The four most recent messages are a floor it never
touches; what actually decides how much history stays verbatim is the budget, which stops as soon as the
prompt fits.

Compression is still **written back** into the window, one-way. A message compressed this round must
arrive compressed next round or every token after it moves and the server re-prefills the whole prompt.
Demand-driven compression is *kinder* to that cache than the old rule, which re-compressed a
newly-aged message every round or two and churned the prefix each time.

The order is deliberate — compress, then let `trimToContext` evict. Losing the middle of an old result
is a smaller loss than losing the whole message, so eviction is the last resort and not the first thing
the budget reaches for. Gate: `npm run check:window` asserts that a window which FITS is not touched at
all (the starvation bug), and that one which does not is cut oldest-first, stops early, and spares the
tail.

#### The calls already made are in the prompt, always

Nothing carried them. `recordTool` and `transcribeTool` both write to disk — for the operator and the QA
gate — and are never read back to the model; `gatheredFacts` carries explore results only;
`guardDirective` carries the calls that were BLOCKED. The set of calls that ran and *worked* lived
nowhere but the history, and history is exactly what gets compressed and evicted. From the model's side
a result that scrolled out is indistinguishable from a call it never made.

So `buildMessages` rebuilds a ledger into the volatile block every round: one line per call — the call,
and enough of the outcome to know whether asking again could possibly help. It survives every
compression and eviction below it by not living in the history at all. The render is bounded to the 60
most recent with a seam naming what was omitted, because "what did I just try" is asked far more often
than "what did I try first", and a 300-call turn would otherwise put 13k tokens of its own bookkeeping
in front of the model — this fix in reverse.

#### The token estimate is MEASURED, not assumed

Every budget above divided characters by a flat `CHARS_PER_TOKEN = 3`, chosen pessimistically because
guessing low overruns the model and an overrun is a failed call rather than a worse answer. The
reasoning was right and the number was wrong by 40%: `promptChars` is known before a call and
`prompt_eval_count` comes back with the reply, so the true ratio was free all along. Measured here:
**4.27**. Every window the agent thought it had was a third smaller than the one it was spending.

`charsPerToken()` (llm/manager.ts) averages the last few accepted samples. Rejected, because each would
lie: sub-calls (a critic prompt is prose, a round is source), prompts under 2,000 characters (the chat
template dominates), and any ratio outside 2.5–5.5 — a vision call's image is not in `promptChars` at
all, so its ratio collapses toward zero and is thrown away rather than clamped. Three samples are
required before it is trusted, and it resets with the provider *and* the model, because a different
tokenizer is a different number.

#### What the prompt is MADE of — `prompt_coverage`

`llm_usage` reports the prompt's exact size (`prompt_eval_count`) after the call, which answers "how
big" and nothing about "of what". Every context question worth debugging is a composition question,
and none of it was visible: one real session climbed to 21.4k tokens by round 5, fell to 13.8k, and
stayed there for ten more rounds with **42,000 tokens of the window unused** — and emitted no log line
at all, because nothing logged a subtraction.

So `buildMessages` emits one `prompt_coverage` per round: `prefixEst`, `historyEst`, `volatileEst`,
the message count, how many were masked, `dropped` — characters destroyed in the window by the
masking, which writes its truncation back and is therefore permanent — and the headroom left. Joined
to the `llm_usage` for the same round, the exact total sits beside the breakdown; `round` is on both
for that reason.

Token figures here are `chars ÷ 3` and labelled `est`, the same pessimistic arithmetic
`trimToContext` spends its budget with. Measured against the exact count on this hardware they run
~40% high (21,209 chars = 7,054 est vs 5,037 actual), which is why the estimate is never presented as
the answer when an exact number exists. Headroom is blank when the window is unknown — the rule above
applies here too.

### The `native` dialect — for APIs that carry the schema themselves

`DIALECTS` held only qwen and gemma, gemma being the fallback, so **an OpenAI model resolved to the
gemma dialect** and had gemma's XML tool-call instructions injected into its system prompt — while
`providers/openai.ts` was declaring the same tools *natively*. The model was told two contradictory
contracts at once and, being a good instruction follower, used the one written in prose: it replied
`<function=grep><parameter=pattern>…` inside a loop that had declared no tools and merely wanted JSON
back. That reply parsed as nothing and the iteration — billed per token — was discarded.

`NativeToolDialect` matches `gpt-*`, `o3`/`o4`, `chatgpt-*` and is registered **first**, so nothing
falls through to a text-tool-calling fallback. Its `toolCallInstructions()` returns **empty on
purpose**: the schema travels in the request, and describing it again in prose is not redundancy, it
is a second contract the model has no way to rank against the first.

`parse()` stays the lenient text parser, because the provider renders native `tool_calls` back into
ayin's canonical text (`renderToolCalls`) so the rest of the loop remains model-agnostic — and it
still catches a model that emits the text form anyway.

### When a model REFUSES native tools — `rejectsNativeTools`

Rendering native calls back into canonical `<function=…>` text is model-agnostic for ayin, but not for
the server. A turn round-trips **twice**: the runtime parses the model's output into structured calls,
the provider renders them back to text, and that text returns as an assistant message in the NEXT
request — where the runtime re-renders the whole conversation *in the model's own format*. A model
whose wire format is ATEM cannot parse the XML it is handed back, and answers
`500 parse Glimmer call to <tool>: malformed ATEM parameter` on the second round.

Native declaration exists for models whose **parser destroys the tool name** (a renderer missing the
`len(tools) == 0` guard consumes the opening tag and emits no name). A dialect that parses its own
model correctly gains nothing and must not pay this cost, so it sets `rejectsNativeTools` and
`reconcileToolMode()` downgrades the session to prompt-declared tools.

**One source of truth, and it took three attempts to get right.** `provider.tools` is what the provider
is *willing* to do, decided before the resident model is known; `toolMode()` is that claim reconciled
against the model actually loaded, and it can only ever be downgraded. Two earlier fixes failed because
the decision was read from two places:

- reconciling only *after* the model-id guard — the provider re-asserts `native` on every refresh, and
  `ayin -p` refreshes twice, so the second call restored it and the degrade never reapplied;
- reading `provider.tools` raw at the declaration site while the system prompt read the reconciled
  value — the prompt omitted the tool catalogue *and* the request still declared schemas, so the model
  had no tools from either path and answered from nothing.

`check:gates` now pins both halves: the expression must read `toolMode()`, and `provider.tools` must
not appear near it.

**The fix belongs here and nowhere else.** The first attempt put a `<function=…>` recovery inside
`explore.ts`, which would have left every other consumer — the agent loop, indulge, plan, QA — to
discover the same failure separately. One dialect serves all of them; that is what the abstraction is
for.

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

## sentinaile — a standing instruction, carried out on a schedule

    /sentinaile check the CI and tell me if anything broke, every 10 minutes
    /sentinaile                    what is armed
    /sentinaile stop               stop it

Three responsibilities, deliberately split, because collapsing any two of them produces a worse thing:

| | who | when |
|---|---|---|
| **plan** | one model call | once, at arming |
| **run** | a fresh `ayin -p` shell | each time it is due, then it exits |
| **supervise** | a detached poll loop owning no work | every 5s, from state on disk |

**Why a new shell per run rather than one long-lived agent.** A process that runs for days accumulates
context, holds a model authority nobody can see, and fails in ways that look like "the sentinel has
been quietly wrong since Tuesday". A process that lives for one task and exits fails as "that run
failed". It also keeps requestId attribution honest: each run is its own process with its own
correlation id, so the backend's GPU queue shows one entry per run and nothing shares a module-global
with the interactive session.

**The plan file is authoritative.** `sentinaile_plan.md` is written into the working directory and read
fresh by every run — edit step 3 and the next run does the new step 3, with no command re-issued and no
second planning call. A plan that were merely a rendering of state kept elsewhere would force an
operator who disagreed with one step to delete the sentinel and describe the whole thing again.

**Schedules are clamped, because they come from a model.** `every second` is a plausible reading of
"keep an eye on it", and a watch spawning an agent every second would take the GPU and the box with it.
`sanitizeSchedule` floors the interval, drops NaN and negatives, and treats `maxRuns: 0` as absent. A
plan with **zero steps is rejected outright** — "do nothing, forever" is precisely the runaway this
must not become.

**No catch-up.** A watch asleep six hours on a ten-minute schedule has "missed" 36 runs. It fires
**once** on waking and schedules the next from now: a six-hour-old check is stale, not 36 times more
valuable, and a stampede of 36 agent shells at boot helps nobody.

### Surviving the power cut

State is written to disk before the thing it describes happens, and the supervisor rebuilds itself from
that file — there is no in-memory schedule to lose. Two orderings matter and they pull in opposite
directions:

- against a **crash**, persist the counter BEFORE spawning: an interrupted launch costs one run that
  never happened, rather than replaying that run on every boot forever;
- against an ordinary **exception**, do everything fallible BEFORE the counter moves. Observed during
  development: `spawn` rejected a `createWriteStream` (its `fd` is null until the `open` event, and
  stdio is validated synchronously), the throw escaped, and `runsDone` climbed while nothing ran. The
  log descriptor is now opened with `openSync` first, and a failure there moves no counter.

A recorded pid is always verified with `kill(pid, 0)` rather than trusted: a pid file outliving its
process is the NORMAL state after a power cut, and a scheduler that reads a stale pid as "already
running" wedges itself permanently while looking perfectly healthy. The supervisor's poll timer is
**not** unref'd — it IS the program, and unref'ing it let node decide the loop was idle and `exit(0)`,
leaving a plan file and a state file describing a watch that would never fire.

Runs set `AYIN_ACQUIRE_LLM=0`: a scheduled run is background work and must queue behind a human at the
keyboard, not ahead of one. `check:sentinaile` asserts that, the persist-ordering, the pid verification
and the schedule arithmetic — all with an injected clock, so a six-hour outage is a number rather than
a six-hour test.

## explore — deterministic localization, no model

`grep` answers *"where does this string appear"*. `explore` answers *"what is connected to what"* —
and if it is not deriving a fact that is absent from the text, it is a slower duplicate of tools the
agent already has.

**The previous version was an LLM loop, and it was retired on measurement, not taste.** Six
invocations across a day of real use: **one** produced an answer, five gave up and dumped raw output
as a "digest". Twenty-seven of its twenty-eight shell commands returned real data — *the searching
worked; the judging failed*. In a three-model benchmark the two models that answered correctly both
scored `explore: 0` and used `grep`/`read_file` directly; the model that delegated to explore
returned nothing.

**There is no model in the tool now.** Not fewer calls — none. Three properties follow:

| property | how it is guaranteed |
|---|---|
| **Fast** | a full probe battery over a 462 MB repo measures ~0.4 s; one local 30B call is 15–20 s. A model call costs ~100 searches, so breadth is bought with more probes instead of more thinking. |
| **Deterministic** | same question, same repo, byte-identical answer. Asserted by `check:explore`. |
| **Cannot lie** | `format.ts` emits only: bytes re-read from a file at a stated line, a number the tool counted, or a label from the closed `Reason` set. There is no prose generator, so there is nothing to invent. The gate re-reads every quoted line and compares it to the file. |

Because it is sub-second and honest, it is meant to be called **repeatedly and narrowly** — the
answer points at the next question rather than trying to be exhaustive once. **"NOTHING FOUND" is a
real answer** and is reported as one, compactly, with the strategies that came back empty.

### The naamah design, read FIRST (`explore/design.ts`)

When the project has a naamah `.puml`, an explore result is led by it — above the findings, not under
them. Everything else explore produces is evidence about what the code IS; the design is the operator's
statement of what it is FOR: what each member MUST DO, and which domains may reference which. Read after
a list of file spans that is a footnote; read before them it is the frame the spans are read in. (The
loop bug in a real session was exactly this shape — the code said `Queue(IdleFilled, loop: true)` and
only the design said "plays Filling ONCE per newly lit slot, never looped".)

The document is found from `entangledTo()` first — a session that ran `/entangle` has already said which
document governs, and guessing past that answers a question the operator settled — then by a bounded,
shallow `find` for `*.puml` (depth 3, `Library`/`node_modules`/`Temp`/`.git` excluded). A candidate counts
as a design only if it declares **domains and types**, so an ordinary PlantUML sequence diagram someone
committed is never mistaken for a contract. Parsing goes through `naama`'s own `parsePuml` — a second
parser for that format would enforce something subtly different from what the operator drew. Results are
memoised per path by mtime.

**Retrieved, never dumped.** The block is FILTERED to the types the question is about (4 at most, with
their full members and intent — clipping that would throw away the only part worth having), because
interpolating a whole catalogue is the case `planGrounding` was measured on: 10,196 characters of 28
components for a project that used four, i.e. ~24 distractors in every prompt. When nothing matches, the
block shrinks to an INDEX — the domains plus the type names — since "there is a design and here is its
outline" is worth a few lines and the document is not. The **domains and their allowed references are
always included**, matched or not: they are short, and a reference out of a sealed domain compiles and is
still wrong.

### What the corpus already knows, appended (`explore/corpus.ts`)

A localization tells the agent WHERE; its very next question is what that code DOES — which an overnight
corpus has already answered, with citations. Making it fetch that separately costs a round, and the model
has to think of it, which mostly it did not. So an explore result carries a corpus block below it:

- **Semantic only.** A vector pass over the question, no keyword fallback — the localization above IS the
  keyword answer, and a second keyword match over the same terms is tokens without information. No vectors
  from the currently configured embedding model → no block, because "not embedded yet" is not "nothing
  known".
- **`functionality` only.** Of the five shipped categories the other four answer questions nobody asked at
  this moment: `git` is history, `dependencies` and `connections` restate the reference graph the walk just
  followed, `gotchas` warns about a change that has not been made. A `ticket` chunk (`indulge --jira`) is
  out too — a requirement is not a description of the code.
- **A similarity FLOOR (0.55), which `corpus_search` deliberately lacks.** The difference is who asked:
  there the agent typed a query and top-K beats a threshold, because a weak match it can judge beats
  "nothing matched". Here nothing asked, so a weak match is not a hint — it is a distractor injected into
  every explore result, which is the measured way to degrade the rest of the prompt.
- **Labelled, and below the findings.** `format.ts` guarantees every character it emits is a file byte, a
  counted number or a closed-set label; a corpus answer is model prose from another run. It says so, names
  the model and date, carries its citations, and never mixes into the findings above it.
- **Never fatal, never silent.** A failed or slow embedding call returns one line naming the reason (a
  timeout is reported as "slow or busy" — a fact about the machine), because a silent fallback once cost
  four rounds of debugging: the wrong answer read as a bad corpus rather than as a pass that never ran.
  Measured live while the card was busy: the 8s query budget expired and the block said exactly that.
- Recomputed on a cache HIT as well, so an `indulge --embed` that finished mid-session shows up on the next
  call instead of after a restart.

Gate: `npm run check:explore-corpus` — hermetic (throwaway corpus root, hand-written vectors, stubbed
embedding endpoint): category and reject filtering against an identical vector, the floor, the absent-block
cases, and both failure messages.

### The term is usually a suffix, not the whole name

English asks for "the time bonus"; the code calls it `GetTimeBonus()`. A definition probe anchored as
`\bTimeBonus` cannot match inside `GetTimeBonus` — `t` and `T` are both word characters, so there is
no boundary there — and the declaration is unreachable however many probes run. Measured on a real
repository, explore returned the time bonus's *call sites* and never its declaration, stopping one hop
short of the defect, which was in the method body.

So the definition probe accepts a leading accessor or verb (`get/set/on/handle/try/compute/calculate/
apply/update/add/remove/is/has/…`, either case) as well as the `_private` convention it already
allowed. `check:explore` pins this: a fixture declaring only `GetTimeBonus()` must be found from the
question "where is the time bonus calculated".

### Read-only by construction

Probes are `argv` **arrays** executed with `spawn(file, args)` — no shell, so `;`, `&&`, `$(…)` and
redirects are bytes in a pattern, not syntax. The runner refuses any binary outside
`grep`/`find`/`git`, any writing `git` subcommand, and `find -exec`/`-delete`. The old tool passed
model-authored *strings* to `sh -lc` behind a prefix allow-list that `grep foo . ; echo INJECTED`
walked straight through.

### Searching through the git index, not the filesystem

Probes are written as `grep -rnI …` and translated to the equivalent `git grep` whenever the root is a
git work tree. Not a micro-optimisation: the SAME call measured **0.4 s on Linux and 22 SECONDS on a
macOS checkout of the same repository** — BSD grep, cold APFS, a 462 MB tree. A tool that promises
sub-second and delivers twenty-two is not the same tool, and the agent that called it three times in
one turn spent a minute waiting.

`git grep` walks the index rather than the filesystem and runs parallel. Correctness first: the
translation was verified to return byte-identical hits on the real repository, `--untracked` is
included so a file the operator has not committed is still searched, and an unrecognised argv shape
runs unchanged rather than being guessed at. On Linux with a warm cache plain grep is marginally
faster; the switch is worth it because it is enormous where the machine is slow and negligible where
it is fast.

### Container bindings — the wiring that leaves no asset behind

A C# class reaches the running game three ways: a **GUID reference** from an asset, an **animation
event** calling it by name, and a **DI container binding**. Only the third leaves no trace anywhere in
the project files, so a service wired entirely by `Container.Bind<Foo>()` reported *"no asset
references this — plain C#, no scene wiring"*. True, and indistinguishable from dead code, which is
the worst kind of true.

`bindingsOf` resolves it deterministically: the type name (taken from the filename, the convention
this ecosystem follows) must appear inside the angle brackets of a binding call on one line. Matching
only `Bind<` — the form that comes to mind first — would have missed **447 of 937 bindings** in a real
codebase, because `BindInterfacesTo` (284) and `BindInterfacesAndSelfTo` (163) dominate. A class
merely CONSTRUCTED in an installer is not injected; a looser rule would call everything injected, and
a fact that applies to everything is not a fact.

### Per-project subclasses, because the glue differs

**Unity** — a script is bound to the game by a **GUID in its `.meta`**, referenced from `.prefab`,
`.unity`, **`.asset`** (ScriptableObjects, where configuration lives) and **`.anim`** (clips call
methods *by name string*; rename the method and nothing fails to compile). "Which prefabs use
ScoreKeeper?" is not a text search for `ScoreKeeper` — it is meta → guid → asset search. The
enclosing `.asmdef` is reported too, since it bounds what can reference what.

**TypeScript** — the same shape in a different alphabet: **string keys**. One backend carries 116
socket event names, 92 tool names, 88 resource ops, 41 habit names, plus `getPrompt('id')` →
`prompts/<ns>/<id>.txt`. Each is a literal joining two distant files with **no import between them**,
and renaming it breaks nothing at compile time. Plus registry membership — a tool exists because it
is in a list.

### Ranking

Mechanical, weights stated in `rank.ts`. One correction worth keeping: **tests rank high**. On a real
question the clearest statement of the rule in the entire repository was a test assertion —
`TotalScore == base * (int)ScoreMultiplierType.Double` — and no production line said it as plainly.
Tests are executable specifications and carry their own `spec` label.

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
  identified the real file (not a same-named decoy — a same-named module elsewhere was
  the wrong target the first attempt found, exactly the cwd bug above, before the root-relative fix
  landed), correctly reported no Jira ticket recoverable (Jira wasn't configured), and named real
  churn/bugfix evidence (a VRAM-reclamation regression, a model-warming latency fix) the reviewer could
  check against the actual commit history.
- A stale **materialized local prompt** trap bit verification here too, same as `diagram.ts`'s own
  documented history: editing `prompts/explain/synthesize.txt` AFTER its first live call does nothing
  until the already-materialized `~/.ayin-cli/prompts/explain/synthesize.txt` is removed (or `/reset`)
  — worth restating here since it is easy to mistake for "the prompt change didn't take" when it is
  actually "the edit never reached the model".

## Tool results are files, and the ledger names them (`artifacts.ts`)

Every tool result is written to `~/.ayin-cli/artifacts/<sessionId>/t<N>-<tool>.txt` as it is produced, and
the call ledger in the volatile block names the file next to the call — `grep(pattern=Widget) → 3 hits
[204 KB → t7-grep.txt]`, with the folder stated once above the list.

**Why the file has to be NAMED and not merely written.** Results were already saved (that is what Ctrl+O
browses), but nothing told the model they existed. The window compresses and evicts old observations —
which is what keeps a long turn affordable — so a result the model was handed twenty rounds ago is, from
its side, indistinguishable from a call it never made; measured as a 36-call turn re-grepping identifiers
whose answers it had already been given. The ledger already said *what ran*. The only thing missing was
*where the answer is*, and that is one line per call instead of 200 KB in the window.

**One folder per session**, because a flat shared directory cannot be pruned safely — two sessions writing
`grep-1755764812345.txt` into the same place have no way to tell whose is whose — and ids are short and
sequential (`t7`, not a timestamp) because they are written into the prompt every round and `t7` is a name
a model can hold and repeat back. The cache is opened inside `initSession`/`setSessionId` rather than by
each entry point, so `-p`, the TUI and the watch daemon all have it. **Pruned on boot by session count**
(20 kept, oldest folders first): tool output is the largest thing ayin writes, and whole folders go rather
than some of each session's files, so a surviving session keeps everything it had.

**The map survives the turn boundary.** `resetCallLedger()` clears the turn's detail — a new question
legitimately searches again — but it now folds each call's FILE into a session tail (12 entries, newest per
call) rendered under the current turn's list. Dropping it at the boundary meant "read the controller I
inspected two questions ago" had nowhere to point, and a 6-second inspect was re-run for a file already on
disk. Only what is needed to fetch the result is carried: the call and its file, never the gist, which
belonged to the turn that asked.

## Tool guard (`tool-guard.ts`)

The previous duplicate detector answered every repeat with the same warning and let the model try
again. A stuck model does not learn from a transient `<tool_response>`: it re-emits the identical call,
gets the identical warning, and the transcript fills with `[Loop detected: status called again with
same params]` five times over while two background tasks sit there running. **The warning was advice,
and advice is not a rule.**

**A READ IS NEVER REFUSED.** That ladder was written for a model that is stuck and it was also stopping a
model that was working: the second identical read cost a whole round and came back with prose instead of
bytes, and the third was dead for the turn — so "read it again to check the fix", "re-grep after the build"
and "look at the file the ledger says I already read" all hit a wall whose suggested alternative ("use the
result already in your context") was the stale result. A repeated read costs milliseconds; a refused one
costs the fix. `REPEATABLE_READS` (`read_file`, `grep`, `find_files`, `list_dir`, `explore`,
`corpus_search`, `docs_search`, `prefab_inspect`, `animator_inspect`, `jira_ticket`, `ayin_help`) therefore
always run, with a note that counts the repeat and gets blunter at 6 and 9, and are never written into the
blocked list at all. `jira`, `sentry` and `web_search` are deliberately excluded despite reading: the first
two are agentic loops that can comment on a ticket, and all three cost money or quota per call.

Everything with a side effect keeps the ladder:

| Attempt | Read-only tool | Side-effecting tool | Pollable tool (`status`) |
|---|---|---|---|
| 1st | runs | runs | runs |
| 2nd identical | runs + "identical call 2, here is where the cached result is" | skipped, told the result is already in context | runs + `[POLLING NOTICE]`, throttled under `pollMinIntervalMs` |
| 3rd identical | runs + note | **BLOCKED for the turn** | runs, still throttled |
| 9th identical | runs + "answer or change approach" | — | — |
| past `pollMaxPerTurn` | — | — | **BLOCKED for the turn** |
| after a user **deny** | **BLOCKED immediately, for the turn** | same | same |

The note is worded to send the model to the FILE, not to the cache: told the cache held the result, the
first live run of this policy read `t3-read_file.txt` — a snapshot of what that call returned — when what
it wanted was the current state. The cache is for a result that scrolled out of context; the call is for
what is true now.

A block is written into the **system prompt** every round (`guardDirective()` → `<blocked-calls>`),
where the model cannot scroll past it — that persistence is the actual fix. Two deliberate exemptions
keep it from being a straitjacket: **polling is a legitimate repeat** (checking a backgrounded task IS
the same call with the same parameters, on purpose), and a blocked `bash` call is told its escape
hatch — `sleep 5; <command>` is a *different* call and runs, which is what "wait for the server to come
up" actually needs. State is per-turn: a new user turn is a new intention.

**A repeat is judged against the world, not only against the transcript.** The escalation above is
written for a model that is stuck, and it was also blocking a model that was working: read a file, fix
it, read it again to check — the third read is identical, and it was refused with "the answer will not
change by asking again". The answer had changed, and the alternative the refusal offered ("use the
result already in your context") was the STALE result. So before the block is applied, two signals can
lift it:

- the **witness** — `mtime:size` of the file the call names. Exact, and it catches a change made by
  anything: another tool, a build, git, the operator in their editor.
- the **epoch** — a counter bumped after **any** tool that is not `TREE_SAFE` succeeds, `bash` included,
  because a shell command can write anything and pretending otherwise left a re-grep blocked after a
  build. This covers the calls whose target is not one file: a grep over a directory, a find.

Either one resets that call's ladder to the first attempt and **deletes a standing block**, so the next
round's system prompt no longer names it. Each bump is attributed to the CALL that caused it and lifts
blocks only on *other* calls — without that, `npm test` would excuse its own repeat and the
identical-command loop would reopen; with it, `npm test` after an edit runs and `npm test` twice in a row
still does not. A user **deny** is never lifted by either: that was a decision about permission, not about
freshness.

`TREE_SAFE` lives in `tool-guard.ts` and is imported by `explore/cache.ts`, which had its own copy — and
that copy was missing `prefab_inspect` and `animator_inspect`, so every Unity inspection wiped a cache it
could not have invalidated. Two lists answering "what is read-only" diverge, and the divergence shows up
as a stale cache pointing at line numbers that moved.

**Two other mechanisms fire on repeats** and are easy to mistake for this one. `agent.ts` skips a call that
appears **twice in a single model response** (they cannot return different answers) — and now says so in
the window rather than dropping it silently, because a call that vanishes is indistinguishable next round
from a tool that hung. And the per-tool **loop nudge** fires every 12th use of one tool in a turn (was 8: a
wide search over a big tree legitimately runs eight times), stated as a count rather than as a verdict on
the model's intent.

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

### What a presentation hands over (`presenter/handoff.ts`)

A presented turn does not just describe the work — it **stages it and opens it**. `/present` means "show
me the work", and the next thing an operator does with shown work is look at what changed and decide what
goes in the commit.

The policy is not new: it is `diff/stage.ts#autoStage`, the same one the watch daemon uses — C# staged line
by line with **live debug output held back**, `.meta` following the asset it belongs to, a `.asset` only
when it is a ScriptableObject of a script in this project, prefabs and animator files whole, nothing over
the size cap. A second copy of those rules would drift from the daemon's and the two would then disagree
about what a commit should contain. What was **held back is printed**: the operator is about to commit and
the part left behind is still in their tree, so silence there would be ayin quietly deciding what belongs
in a commit. Files staged are then opened in one editor invocation (`code a b c`, capped at 12 tabs —
three launches race for which window wins), and only if `editor.ts` allows it: headless, the daemon and
`AYIN_EDITOR_OPEN=never` open nothing, which is why that decision lives in the one file that knows how to
hand a file to an editor.

`isUnityRepo` was corrected in the same change and now requires **`Assets/` AND `ProjectSettings/`**.
`Assets/` alone matched this very repository — macOS and Windows filesystems are case-insensitive, so
`existsSync('Assets')` is true for a plain `assets/` folder, and a TypeScript project was being handed the
Unity staging policy. `watch.ts` had already worked that out in a private copy; there is now one
definition, which is the argument for there having been one all along.

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
- **Unity is a `factsOnly` project type: the gate is ONE compile check and nothing else**
  (`executors/qa/unity`). Before it existed a Unity project fell to `qa/base`, whose only contributed
  fact is `readme-substance` — marked `hard`, so it fails the gate without the judge. Measured on a real
  Unity repo: a 56-byte root README produced *"README.md is only 54 chars — too short to carry a parts
  list and a pin map"*, Arduino wording from the Arduino scaffold check, on all three passes of every
  qualifying turn, whatever the work was — while the judge was handed generic code/docs criteria and no
  compile result at all. So the executor declares `factsOnly: true` in its config and `runQaGate` stops
  after the facts: no criteria derived, no evidence gathered, no judge (two LLM calls per pass saved).
  Compilation is the floor — an answer about code that does not compile is not worth reviewing — and
  everything else the generic path asked was either wrong for the type or unmeasurable without launching
  the editor.

  **Five deterministic facts, and the compile is only one of them** (`executors/qa/unity/shape.ts`). Each
  is decidable from the repo's own files, which is why the agent is told a CONSEQUENCE rather than asked to
  consider a possibility. The four `certain` ones are `hard` — the gate fails on them without a judge:
  - **`unity-asmdef-reference`** — a file compiles into exactly one assembly (nearest ancestor `.asmdef`,
    else the predefined `Assembly-CSharp`) and a type it names is declared in exactly one assembly, found
    by scanning declarations. If the second is neither the first nor in the first's `references`, that is
    CS0246 by construction. Unity's wrinkle is honoured: `autoReferenced` makes an assembly visible to the
    PREDEFINED assemblies only, never to another asmdef, so the rule differs by which side the file is on.
  - **`unity-editor-api`** — `using UnityEditor` in a file whose assembly is not `includePlatforms:
    ["Editor"]`. It compiles in the editor and fails the PLAYER build, which is the expensive way to find
    out.
  - **`unity-root-namespace`** — the `.asmdef` declares `rootNamespace`; a file whose namespace is neither
    it nor a child of it contradicts the assembly's own statement. (Namespace-matches-folder is NOT
    asserted — Unity does not require it. It is compared against what the sibling files declare and
    reported as a soft fact.)
  - **`unity-serialize-field`** — `[SerializeField]`/public on a type Unity cannot store: `Dictionary<,>`,
    an interface without `[SerializeReference]`, `object`, `System.Type`, a delegate. Unity stores nothing
    and reports nothing; the field is empty at runtime. Closed set, so membership is a fact.
  - **`unity-serialized-layout`** (soft, PASSES) — a serialized field was ADDED to a MonoBehaviour or
    ScriptableObject, and N existing prefabs/scenes/assets carry that script (counted by the GUID in its
    `.meta`). Those store fields BY NAME, so each takes the default for the new one. What was added comes
    from `git diff -U0`, so "a field was added this turn" is measured rather than remembered. This is a
    consequence to state and often a migration to write — not a mistake to block.

  **Three compile paths, tried in this order** — the first one needs no editor launch at all, which is why it is
  first (`executors/qa/unity/compile.ts`):
  - **the GENERATED PROJECT** (`.sln`/`.csproj`). The editor has already written down everything a
    compiler needs — the source list, the reference DLLs with absolute paths, the defines, the language
    version — so compiling from those is reading its homework instead of making it redo the work: seconds,
    no project lock, and it works WHILE THE EDITOR IS OPEN. `dotnet`/`msbuild` builds the solution if
    either is installed; otherwise Roslyn **as shipped inside the Unity install** (`Tools/Roslyn/csc.dll`
    with the editor's own .NET runtime), which is what makes this work on a Mac that has Unity and no .NET
    SDK. Only the assemblies whose `<Compile Include>` list contains a changed file are built — a large
    Unity repo has dozens of generated projects and the turn touched two files in one of them. A response
    file is used because a Unity assembly is routinely a thousand sources and hundreds of references, far
    past any argv limit. What each missing piece produces: no generated files → this path is skipped;
    HintPaths that do not resolve here (they are absolute and belong to the machine that generated them)
    → NOT VERIFIED naming the paths and saying to open the project in Unity once; a `.csproj` whose shape
    was not understood → NOT VERIFIED, never "no sources, must be fine". `npm run unity:compile [path]`
    runs exactly this from a shell and prints which branch it took.
  - **the remaining two paths, because on a working machine the editor is usually open:**
  - **editor CLOSED** → `Unity -batchmode -quit -nographics -projectPath …`, then read the log.
    `error CS…` lines are the verdict, NOT the exit code: Unity exits non-zero for a licence problem or a
    missing module too, so a non-zero exit with no CS errors is reported as unverified *with* the exit
    code and the log tail. Editor discovery is `testrun/run.ts` `unityBinary` — on macOS
    `/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity`, version from
    `ProjectSettings/ProjectVersion.txt`, overridable with `/set unity-path`.
  - **editor OPEN** → read what it already built. Unity writes `Library/ScriptAssemblies/<Assembly>.dll`
    only on a SUCCESSFUL compile and leaves the previous DLL in place on a failure, so a DLL newer than
    every source under its asmdef is positive proof for that assembly. Batch mode here would be wrong
    twice over: it cannot take `Temp/UnityLockfile`, and killing the operator's editor to answer a QA
    question is not something a read-only probe may do.

  **Unverified is never a failure**: no install, a batch run past `unityCompileTimeoutMs` (default 20 min),
  or an assembly the editor has not rebuilt yet each yield a non-`hard` fact naming the case and what
  would make it answerable. A gate that blocks a finished answer on "I could not check" is a worse bug
  than the ones it catches. Gate: `npm run check:qa-unity` (synthetic Unity projects on disk; spawning a
  real editor and the macOS Hub path are named there as NOT covered rather than faked).

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

### Every message carries its token cost — the server's count, never an estimate

Ollama returns `prompt_eval_count` and `eval_count` on every reply; OpenAI returns `usage`. ayin parsed
all of it away at four places, and the gateway it actually talks to (`POST /api/generate`) answered
`{content}` alone, so nothing downstream could say what a turn cost. It now flows: transport (`onUsage`,
a callback for the same reason `onToolCalls` is one — the contract stays messages → text) → provider
(`GenerateResult.usage`) → `manager.recordUsage` → a hook the UI subscribes to (nothing under `llm/` may
import the screen).

- **A reply is labelled with the call that produced it** — `8.9k in · 41 out`, the whole prompt the model
  read and what it generated.
- **A tool result is labelled with what it added to the prompt** — `+2.1k tok into the prompt`, measured
  one round later as `in(n) − in(n−1) − out(n−1)`. Between two rounds the prompt gains exactly the model's
  previous reply (known exactly) and what ayin appended, so subtracting the reply leaves the price of the
  tool result **in the tokenizer of the model that read it**, without shipping a tokenizer or spending a
  second call to count. A shrunk prompt (trimmed or compacted window) prints nothing: the subtraction no
  longer describes an addition, and a wrong number is worse than none.
- **The label waits for the message it belongs to.** Usage arrives when `generate` resolves, which is
  before the reply is parsed and printed — the first version walked backwards from the end, found the
  previous round's tool card, and left every answer unpriced. Visible the first time it was painted in a
  real terminal, which is why it is painted.
- **A sub-call prices nothing.** A connector's inner loop, the critic, explore, a QA pass — their prompts
  are their own, not this turn's plus a tool result, and they print no message for a label to land on.
  Only a round (`setLlmPurpose('round N · …')`) advances the baseline or shows a price; the rest is in the
  log.
- **Absent means absent.** A provider or endpoint that reports nothing produces no line — "not reported"
  has to stay distinguishable from zero, and characters ÷ 4 would be a guess wearing a precise costume.

Gate: `npm run check:cost` — the arithmetic as a pure function (`computeUsage`), plus the four providers
and the placement rules.

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
name. **Core** (no external deps): `read_file`, `list_dir`, `grep`, `find_files`, `write_file`,
`str_replace`, `rename`, `bash`, `explore`, `status`, `arduino_db`. **Optional integrations** (inert unless
configured): `diagram`, `web_search`, `jira`, `jira_ticket`, `jira_auth`. See the README table.

### The I/O surface is sized from the TRANSCRIPTS, not from taste

`bash` went from 5% of all tool calls to **20%** — measured across 483 recorded sessions and 5158 calls —
and **573 of its 826 recent calls (69%) were work a tool could have done**: `ls` 177, `grep -r` 149,
`cd X && …` 126, `find` 76, `mkdir -p` 58, `cat`/`head`/`tail` 65, `wc -l` 19. A second agent's transcript
said it louder: 55% of its shell commands contained `grep`, **97% of those piped** (1195 into another grep,
1081 into `head`), with a flag histogram of `-n` 910 · `-vE` 816 · `-c` 297 · `-o` 234 · `-l` 44.

The lesson is not "the model is lazy". **A tool that cannot express what a shell one-liner expresses does
not get used — it gets worked around, and the workaround is unbounded output through a general shell.** So
each of those numbers became a parameter:

- **`list_dir` is new** — there was no tool for the single most common shell command in the corpus. Names,
  dir/file, size and *how long ago each changed* (the mtime is what "which of these did the run touch"
  needs), directories first, bounded, and it says when it truncated. `recursive=true` goes one level in and
  never into `node_modules`/`Library`/`dist`.
- **`grep` gains `exclude` (the second grep of a pipe), `invert`, `count`, `only_matching` and
  `max_matches` (the `| head -N`)** — and its description now says RECURSIVE, which is why 149 calls went
  to the shell for something this tool already did. Counting drops the `path:0` lines grep prints, because
  a zero is not an answer.
- **`bash` gains `cwd`** — 126 calls were a `cd X && …` prefix, and a bare `cd X` accomplishes nothing at
  all because the shell exits. A missing `cwd` is REFUSED rather than falling back to the session root: a
  build run in the wrong tree looks like success.
- **`read_file` gains `tail`** and now reports the line count and size on EVERY read — a `wc -l` is never
  its own call, and "show me the end of the log" no longer costs a read to learn the length plus a second
  read from a computed offset.
- **`find_files` gains `max_depth`, `modified_since` ("2h", "3d") and `exclude`** — the three reasons a
  shell `find` was still needed.

Left in `bash` deliberately: `docker`, `arduino-cli`, `dotnet`, `npm`, `which` — that is what a shell is
for. Gate: `npm run check:io`, which asserts each parameter against the number that produced it.

### `rename` — the language-split tool (`src/tools/rename/`)

A rename is not an edit, it is N edits that must all land: the declaration, every reference, and in some
languages the FILE NAME and a serialization annotation. `str_replace` renames what the agent has read and
misses the call in the file it never opened; `sed` matches inside `FooBar`, inside strings and inside
comments. So it is its own tool, with the same shape every language split in this repo uses — an abstract
`RenameLanguage` (base.ts) holding the scanning, and one subclass per language registered in a `LANGUAGES`
array, exactly like `entangle`'s `SurfaceLanguage`.

**The base owns what must not be got wrong twice.** Word boundaries (`Foo` must not touch `FooBar`), a
string/comment scanner (a `"` inside a comment is not a string), back-to-front application so earlier
edits cannot shift later offsets, and one write per file so a crash leaves whole files. Strings and
comments are left alone AND REPORTED: a name in a string is often a registry key or a reflection lookup,
and that is precisely the reference a rename breaks with no compiler error anywhere.

**Subclasses own the traps.** `csharp.ts`: a MonoBehaviour class is renamed WITH its file, because Unity
binds a component by file name and says nothing when they disagree — and its `.meta` moves with it,
contents untouched, since the GUID inside is what every prefab and scene points at. A renamed SERIALIZED
field gets `[UnityEngine.Serialization.FormerlySerializedAs("old")]`, because the old name is the key the
value is stored under in every asset; without it Unity finds nothing and silently substitutes the default,
losing whatever a designer set. Verbatim strings (`@"..."`) get their own scanner — treating `\` as an
escape there swallows the terminator and hides real references behind one giant "string".
`typescript.ts`: object shorthand `{ Foo }` is a KEY as well as a value, so it is expanded before the
generic pass (`beforeRewrite`) and restored after (`afterRewrite`) — the value follows the symbol, the key
does not. Import/export clauses are excluded from that expansion, because `import { Foo }` binds a name
and `import { Foo: To }` is not TypeScript at all.

**Refusals come first**, before anything is written: a keyword, an invalid identifier, renaming to itself,
or a new name already declared in that file (a merge, not a rename — and it compiles). `dry_run` produces
the whole plan and writes nothing. Gate: `npm run check:rename` — 39 assertions against real trees in the
temp dir, each one a way to corrupt a repo silently.

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

**`jira`** — the operator's **current sprint** as context, plus **any ticket by key**:

- The sprint list is a property of the **query** (`assignee = currentUser() AND sprint IN openSprints()`),
  fetched **once, up front**: most questions about a sprint are answered by the list of tickets in it, so
  the common case is a single LLM call and every later round shares one frame of reference.
- **A ticket key in the question is an ADDRESS, and is read before the board is.** `PROJ-1234` anywhere in
  the question is fetched directly — one GET on the issue — whatever the sprint holds, and `open KEY` is
  never refused for being off the board. The sprint used to be the gate: keys were matched against what
  the board returned, an off-board key was refused with the board's contents, and an EMPTY board returned
  "nothing assigned to you" while holding a question that named a specific ticket. The tickets a coding
  agent needs are mostly closed, someone else's, or two releases old. Jira decides whether a key
  resolves; a 404 is the answer.
- **A bare number still needs the board**, and only for disambiguation: `13804` names a ticket but not a
  project, so it resolves only when exactly one sprint key ends in it. Inventing the prefix would fetch a
  different ticket that exists — a wrong answer shaped exactly like a right one.
- The sprint failing to load is **not fatal** once a named ticket is in hand; the board is context, never
  permission.
- The inner protocol is **one line** (`open KEY` / `answer <text>`). A small local model asked for JSON
  mid-reasoning produces malformed JSON far more often than a wrong verb. An unmarked reply is taken as
  the answer rather than spending a round correcting protocol.
- **Cloud and Data Center are detected, not configured** — the endpoint version and the body format (ADF
  document tree vs plain text) are both discoverable on the first call. ADF is flattened to text before
  any model sees it. **Search and issue-by-key learn their flavour SEPARATELY** (`/rest/api/3/search/jql`
  vs `/rest/api/2/search`; `/rest/api/{3,2}/issue/{key}`): one flag for both meant a by-key fetch read a
  value only a search could set — so the first call of a headless run guessed Cloud and, on Data Center,
  404'd with a message that read as "no such ticket". The search-learned flavour is now only a hint about
  which to try first, never written back.
- Descriptions and comments are **clipped head-and-tail** with the omission stated.

**`jira_ticket`** — the same ticket, with **no model and no loop**: one parameter (`key`), one GET,
description + comments + status. It exists because `jira` is `slashOnly` (its `execute` is an agentic
loop, which an agent must not pay for mid-turn) and nothing replaced it, so a headless run could not read
the ticket its own task named — it worked from the operator's paraphrase or shelled out to `curl`.
Reading a ticket whose key you already have needs no reasoning. A bare number is **refused**, naming the
missing prefix. Gate: `npm run check:jira`.

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

### A mistyped command never runs anything (`help.ts#suggestNames`)

A bare word that was not a subcommand used to be waved through as "not our business", so `ayin unty prefab
Assets/Widget.prefab` **started a session and discarded the rest of the line** — the operator watched the
TUI boot with no idea what had become of what they asked for. Now the first argument must be a known
subcommand or a flag: anything else exits 2, names itself, and suggests the nearest real command.

The suggestions come from the help list, which makes it the database of what was probably meant as well as
of what exists — a command that is not in it cannot be suggested, and one that is cannot be missed. Exact
match first (a name typed correctly is not a suggestion), then an edit distance that scales with the word
(one edit for a short name, three for a long one) plus a prefix rule, because `pref` means `prefab` however
far the tail is. The same helper answers an unknown slash command in the TUI (`/prefabb` → "did you mean
/prefab?") and the `unity` namespace's own subcommands. `help.ts` keeps its own small edit-distance
function on purpose: `tools/lib.ts` has one, and importing it would drag the tool registry into a module
that must load before anything is wired.

## Commands and tricks are ONE list (`help.ts`)

`src/help.ts` is the single source for every command, key binding, shell subcommand and trick, with
three consumers: `/help` (all of it, grouped), the typing hint panel (`ui/widgets/hints.ts`, the `/…`
entries by prefix) and the goal line (one random `tip` per launch).

It exists because there were already three lists — the `case '/…'` labels in `app.ts` that decide
what *runs*, the hint panel's own array that decides what is *offered*, and a hand-written run of
`addMessage` calls in `/help` — and nothing kept them in step. `/diff` shipped with no hint entry;
`!`, the shell passthrough, was in none of them. **A command the operator cannot discover may as well
not have been built.**

`check:help` asserts the drift in both directions: every `case` has an entry, and every entry is
actually handled (a documented no-op is worse than an undocumented feature). Aliases and tool-owned
commands are the two declared exceptions.

**The launch tip.** Before a goal is set, the goal line is dead space, so it carries one tip —
chosen once per process, in the row a goal will occupy the moment there is one. Stable for the life
of the run, because that line repaints on every render and a tip that re-rolled mid-sentence would be
unreadable. It appears on the default `both` view via a fallback: the OBJECTIVE card is empty with no
goal, and without that fallback the tip would be invisible to everyone who has not set
`AYIN_GOAL_VIEW`. It never enters the card itself — a tip in a bordered panel is shouting.

## `/testrun` — see [`TESTRUN.md`](TESTRUN.md)

`/testrun <domains>` runs the C#/Unity tests covering a domain. Selection is fully deterministic —
the corpus already records a domain on every chunk, a file's assembly is its nearest ancestor
`.asmdef`, and a test assembly covers it for one of three reasons (`contains`, `references`,
`named`). Running uses `Library/ScriptAssemblies` when current and Unity batch mode when not.

Three things worth knowing here, argued in [`TESTRUN.md`](TESTRUN.md):

- **Transitive references are excluded.** The first real run selected 25 of 26 test assemblies for
  one file, because everything lives in one `Core` assembly every test references. An assembly
  referenced by ≥30% of tests is **ambient** and proves nothing — the same rule `indulge` applies to
  a type mentioned by 25+ files.
- **Staleness refuses.** A DLL older than its sources tests code that no longer exists; a green light
  over that is the one output worth refusing to produce.
- **`NOT RUN` is never a pass.** An engine-coupled assembly that cannot load is reported and counted
  separately, outside the totals.

New delegate: **`ToolServices.confirm`** — the operator counterpart to `llm.ask`, so a tool can ask
before touching something outside the repo. It returns `null` when there is nobody to ask (headless,
`watch`, a scheduled run), and **null is a refusal, never a default yes**.

Gate: `npm run check:testrun`.

## `/diff` — see [`DIFF.md`](DIFF.md)

`/diff` (and `ayin diff`) renders the working tree — staged, unstaged **and untracked** — as one
self-contained HTML page and opens it. Laid out in the order a diff is actually read: **triage**
(sidebar with per-file weight and status), **filter** (extension chips, `.cs .asset .ts .js .py` on
and everything else one click away), **read** (unified hunks with the changed token marked).

Two things that are load-bearing rather than cosmetic, both argued in [`DIFF.md`](DIFF.md):

- **The hidden-file count is always on screen.** Filters that default to off can make a large diff
  look small, and "my tree is fine" is the most expensive wrong conclusion this page could cause.
- **Tracked changes spend the page's line budget first.** The first run against a real tree produced
  a 48 MB page of generated `.js` from untracked build directories and none of the source; sorting by
  size and truncating kept the noise. A tracked file is a change made on purpose — when something has
  to be dropped, that decides which. Omitted files keep their row and their true counts.

- **The extension filter is remembered, in a cookie.** `ayin_diff_exts`, root path on the session's own
  loopback origin, written from `apply()` — the one funnel every change passes through. A saved set wins
  over the shipped defaults, but only when it parses to something: an empty or corrupt cookie falls back
  to the defaults rather than rendering a page with everything hidden, which would read as an empty
  diff. Values are shape-checked on write AND on read, so a hand-edited cookie cannot leave the page in
  a filter state no chip matches. An extension appearing later that is not in the saved set starts
  hidden — that is what remembering a filter means — and the always-on hidden-file count is what keeps
  that honest. The `defaults` button overwrites what was remembered, since the one control that exists
  to undo a filter must not be the only thing unable to.

  Two bugs here were invisible to every "is the code present" check and only fell out of EXECUTING the
  emitted helpers, which is now what the gate does. `[].slice.call(on)` returns `[]` for a Set — that
  idiom is used elsewhere in this file for NodeLists, which are array-like — so every apply wrote an
  empty cookie. And because the script is built from a template literal, a single backslash is eaten
  before any regex exists: the escaped parens collapsed into a capture group matching the bare word
  `none`, so the extensionless bucket silently failed to persist while every other extension worked.

- **File-type icons: shape is the type, colour is the status.** The row had one mark — a coloured
  square for added/modified/deleted — and left the type to be read out of the extension. On a Unity
  tree that is the wrong thing to make someone parse: measured on a real project the top extensions
  are 12,484 `.meta`, 3,101 `.cs`, 2,682 `.png`, 978 `.prefab`, 828 `.anim`, 695 `.asset`. Shape is
  the stronger channel so it goes to what is being scanned for; colour keeps the meaning it already
  had, so nothing is re-learned and no second mark is added to the row. Fourteen families grouped by
  what a file is FOR (`.anim` and `.controller` share a glyph; `.mat` and `.shader` share another),
  with a plain document as the honest fallback rather than a fifteenth invented shape.

  **One `<symbol>` sprite, every row a `<use>`** — a 500-file diff would otherwise carry 500 copies of
  the path data, and this page already has a hard line budget it spends on diff text.

  Three shapes were reworked after looking at them rendered rather than reasoning about them: the
  script family was braces that drew as `()` and collided with C#'s `<>` at 15px (now `>_`), the scene
  was a framed horizon in the same silhouette family as the image frame (now stacked layers), and the
  animation glyph was a motion arc whose arrowhead never rendered as one (now a keyframe on a track).

- **Staged and unstaged are TWO diffs, not one labelled diff.** `collectDiff` runs
  `git diff --cached <rev>` and a bare `git diff` and tags each `FileDiff` with `staged`. A change is
  not staged or unstaged — the individual hunks are, which is why `git status` reports two columns. So
  a partially-staged file yields **two entries**, one per side, each carrying only its own hunks. The
  cheap alternative (one `git diff HEAD` plus the file's index column) would show staged and unstaged
  hunks under one heading, a diff that exists in neither place. The sidebar splits at that boundary,
  with per-section counts **recomputed from the filter** — a header reading "Staged 2" above one
  visible row is the same lie the hidden-file count exists to prevent, and it happened: a
  `.controller` hidden by the default chips left count and list disagreeing.
- **Per-file `stage`/`unstage`, and a project-type `Stage` pass** (`src/diff/stage.ts`, served pages
  only — staging is a git write). One button per card, not two: a change is on exactly one side, so
  the only move that means anything is the one that crosses. `POST /api/diff/stage|unstage` run
  `git add` / `git restore --staged` on the session's own repo — the same loopback envelope as the
  comment route and a *smaller* authority than it, since a comment becomes an agent turn that can run
  shell commands while these move the index and nothing else. The path is still validated: traversal,
  absolute and flag-shaped (`--cached`) paths are refused before they reach git.

  `POST /api/diff/autostage` is the project-type pass, and it is **deliberately a second policy**
  rather than a change to `unityStageReason`. The daemon's allowlist states two things worth keeping —
  a prefab is never auto-staged, and *"there is no model judgement in this decision, by design"* —
  both correct for a background process staging while nobody watches, neither correct for a button an
  operator pressed. The cost is two policies to keep in step; the alternative was changing background
  behaviour on every watched repo to serve a foreground click. In a Unity repo it stages
  `.anim`/`.controller` and `.prefab` whole; an `.asset` only under `Assets/` **and** only when its
  `m_Script` guid resolves to a `.cs` in this project (that guid check is what excludes third-party
  and package assets; the `Assets/` test is what excludes `ProjectSettings`/`EditorSettings`, which are
  not third-party but the project's own base config); a `.meta` only when the asset it describes was
  staged. Everything else is skipped **with a reason on the card** — a file that silently failed to
  stage is the complaint the whole feature answers. A non-Unity repo returns `policy: 'none'` and
  stages nothing rather than inventing an allowlist.

  **`.cs` is staged LINE BY LINE.** A model classifies the added lines (`stageDebugLines.txt`,
  `declareTools: false` — it wants JSON, not work), then the clean lines are rebuilt into a patch and
  `git apply --cached` puts them in the index while the debug lines stay in the working tree as the
  file's remaining unstaged change. Hunk headers are **recomputed**, never copied: dropping a `+` line
  changes the new-side count, and a stale `@@` is a patch git refuses at best and misapplies at worst.
  A classification that fails holds nothing back and says so — the operator asked for their work to be
  staged, and a model that could not answer is not a reason to silently drop it. An **untracked** `.cs`
  is staged whole or not at all: partially staging a brand-new file would put a version in the index
  that never existed on disk.

  A one-character bug worth remembering: `git status --porcelain` puts the index status in column 1, so
  an unstaged change begins with a **space**. Trimming that output ate the space off the FIRST line
  only, which then read as already-staged with the path shifted by one — the animator controller
  vanished from the pass while its six siblings were judged correctly. Position-dependent and silent.
  `check:diff` pins it.
- **Discard: the only irreversible controls on the page.** A red trashcan FAB runs
  `git reset --hard && git clean -fd`, and every file card carries its own. Both are served-only and
  both confirm — but the confirmation is **informed**: a `GET /api/diff/discard` returns the files that
  would die and the dialog NAMES them, because "discard 4 files" is a number people click past while
  four filenames are a decision. Untracked files are called out separately, since those are *deleted*
  and git has no object and no reflog entry to recover them from.

  `-fd` and not `-fdx`: **ignored files survive**. `.claude/`, `reviews/` and ayin's own report files
  are untouched, which is both the git default and the behaviour that does not delete the operator's
  tooling along with their work.

  Per-file discard is **four commands, not one**, because firing one at every state silently fails on
  two: an untracked file is `clean -fd --`, a staged-added file is `rm -f --` (there is nothing in HEAD
  to restore it from), and a modified or deleted file is
  `restore --staged --worktree --source=HEAD --` (a bare `checkout --` would leave the staged half
  behind). An ignored path is refused — it is not in the diff, so a button here cannot mean it.

  **And each extension chip carries its own bin**, which discards every changed file of that type —
  the widest of the three blast radii here, so the same informed confirmation applies and names the
  files. It runs `discardOne` per file rather than one command with a pathspec, because the four states
  each need a different command and a pathspec spanning them would silently do nothing for two.
  `(none)` is a real bucket matching extensionless files and **not** a wildcard: a bucket that matched
  everything would make one click discard the tree. Containment is what `check:diff` asserts — discard
  `.cs` and `.ts`, `.prefab` and the extensionless file are all verified untouched.

  A chip is now a `<span role="button">` for the same reason a file card is: it holds a button, and a
  button inside a button is invalid HTML. Enter and Space are wired in the client, and the bin's click
  is stopped from bubbling so discarding a type does not also toggle the filter it is shown under.

  A clean tree is **refused** rather than presented as a scary dialog that does nothing. The red FAB
  sits a clear gap above the refresh FAB rather than beside it, so a mis-aimed click for refresh lands
  on empty space instead of the one control that cannot be undone.

  Worth noting against `permissions.ts`: its `ALWAYS_CONFIRM_GIT` list exists for operations that
  *"discard work that was never committed"* and is `push|pull|checkout` — `reset --hard` and `clean -fd`
  match that rationale and are absent from it. These routes do not pass through `checkPermission` at
  all (nor do stage/unstage): they are direct writes from a button an operator pressed on a page their
  own session served, and the confirmation is the gate.

- **The refresh FAB rides the property that already existed.** The served route re-collects the working
  tree on EVERY `GET /diff`, so "rebuild against fresh state" is `location.reload()` — no path to
  publish, no cache to invalidate, and the URL never moves. All the button has to do is keep the
  reader's place, which the post-fix reload already solved: `rememberViewport()` writes the topmost
  on-screen file to the SAME `sessionStorage` anchor `restore()` reads, with no line, so `restore()`
  misses the row and falls back to the file — the honest anchor when the tree just changed under it.
  One anchor, not a second mechanism to keep in step. Clicking disarms the button (`pointer-events:none`)
  because a re-collect on a large tree is not instant and a dead-looking button gets clicked twice.
  **A `file://` page gets no FAB at all** — a static snapshot has no server to rebuild from and cannot
  reach `git`, so the affordance is absent rather than present and broken, the same call the page makes
  about comments.

- **The commit message is drafted from three sources and shown in the page** (`src/commit-draft.ts`).
  The expensive half is LAST: changed files come from git, ticket keys from one regex over the branch
  name, the local Claude Code transcript, the last few commit subjects and the diff's added lines — and
  every key is then CONFIRMED by `jiraTickets()`. Only if Jira resolves at least one does a model get
  asked to write anything, so an unconfigured Jira, a branch with no key, or a session that never
  mentioned one all cost nothing. A ticket SHAPE is not a ticket: the regex is the one
  `explain/git-history.ts` owns, reused rather than duplicated, and its doc already argues that
  `PROJECT-123` is structurally identical to a part number or a version string.

  **Measured on a real repo, and it changed the design.** Three of the four candidate sources found
  nothing — the branch was `feature/<name>/<area>`, the session turns never named a key, the diff
  carried none — and the commit subjects found everything, because the team's convention puts keys in
  the subject. Scoping subjects to the branch's own commits sounded right and was WORSE: 100 own
  commits yielded 14 keys, most of them finished work. A small RECENCY window yielded exactly the
  tickets the uncommitted change belonged to. What is in flight is near HEAD, not near the fork point.

  The local transcript (`~/.claude/projects/<slug>/*.jsonl`) is read for `type: 'user'` records only,
  filtered to this `gitBranch` and excluding `isSidechain`/`isMeta` — a subagent's prompts are ayin's
  own scaffolding, and another branch's session is another feature's reasoning. The diff says what
  changed; it cannot say why or what is still missing, and the operator already said both out loud
  while doing the work.

  **One slot, and it is git's.** The draft is written to `.git/COMMIT_EDITMSG`, which `git commit` and
  every git client already prefill from, so it arrives where the operator was going to type anyway. The
  page RE-READS that file per request — no cached copy to go stale — and an absent draft is stated
  ("No draft yet") rather than rendered as an empty panel. The daemon's worktree pass writes its plain
  message first and this overwrites it only when it has something better, so the plain one is the floor
  whenever the ticket gate declines. `POST /api/diff/draft` is the same pipeline on demand, and when it
  declines it answers with WHY plus the candidates it saw — an operator who pressed a button and got
  nothing needs the reason, not a shrug.

- **The panel is two editable fields, and Commit takes what is in them.** Subject and description are
  separated and labelled rather than inferred from a blob of text, split at the FIRST BLANK LINE — git's
  own boundary, because splitting on the first newline would swallow a wrapped subject into the body.
  The subject carries a `n/50` counter that turns the counter AND the field red past the limit; nothing
  is truncated, because cutting someone off mid-word is worse than showing them the overflow. `rephrase`
  asks the model to refit the SUBJECT ONLY against the staged diff — never the description, which is
  where the operator's own words accumulate. `Commit` posts the field contents, not the file: they are
  editable, and committing the file would silently discard an edit. It is offered only when a draft
  exists, and only on a served page.

  **The index buttons are a green plus and a quiet minus**, not the words they replaced: a file header
  carries three controls and they should read as one row of equal-weight actions. Opposite shapes AND
  opposite colours, because a staged and an unstaged card sit next to each other in the same list — the
  plus is the vibrant green because staging is what anyone actually reaches for, the minus is muted
  because it undoes rather than invites. Both keep an `aria-label`, since the label is no longer the
  button text.

  **Commit opens a READ-ONLY preview** rather than firing on a `confirm()`. A confirm shows a sentence
  and hides the thing being decided; the sheet shows the decision — exactly which files the index holds
  with their counts, the subject as it will be written with its `n/50`, and the description. Nothing in
  it is editable: the fields behind it are where text changes, and a second editable copy is a second
  place for them to disagree about what is about to be committed. It is built from the PAGE, not a
  route — the staged set is already rendered and the message is already in the fields, so asking the
  server would introduce a version of the truth that can differ from what the operator is looking at.
  Reasons a commit cannot happen are stated next to the button instead of discovered after pressing it.
  Escape and the backdrop close it; the sheet does not.

  **Everything is `--cached`.** `git commit` takes the index, so a message describing unstaged edits
  describes a commit that will not happen — and on a Unity tree the unstaged half is usually generated
  assets deliberately left out. Nothing staged is a decline, not an empty message.

  **A leftover message is not a draft**, and this was a real bug. `git commit -m` writes its message
  into `COMMIT_EDITMSG`, so "the file is non-empty" says nothing — the previous commit's message got
  committed a second time. Ayin now stamps `.git/ayin-commit-draft.head` with the HEAD its draft
  describes; when HEAD moves the draft is stale and the panel says "no draft yet". A HEAD stamp rather
  than a hash of the text, so an operator's own edit is never thrown away as "not a draft".

  **`check:diff` compiles the page's own JavaScript.** `tsc` checks the module that BUILDS the page,
  never the string it emits — and inside a template literal `\n` is an escape, so one under-escaped
  sequence put a raw line break inside a JS string literal and killed the entire script: filters,
  comments, Stage, the FAB, all of it, while the page still rendered and every other assertion passed.
  A `new Function` on the emitted script catches that class outright.

- **Agent replies render as markdown** (`src/web-markdown.ts`). The reply widget is the one place on
  these pages showing prose a MODEL wrote about a codebase, and it was escaped and shown raw — literal
  `###`, `**`, backticks. `markdown.ts` already converts markdown but to BLESSED TAGS for a terminal,
  which in a browser is literal text; two renderers for one syntax is the cost of two very different
  targets.

  **Escape first, format second, always.** That prose routinely carries `<`, `>`, `&` and whole HTML
  fragments quoted out of source. Formatting first would have its own tags escaped into text; escaping
  after would corrupt them with a stray `&`. So the input is escaped once at the top and every rule
  operates on already-safe text. One consequence worth knowing: the blockquote rule matches `&gt;`,
  because by the time it runs the marker is already an entity — it is the only block marker escaping
  touches, and it silently stopped matching until that was found.

  Code spans are parked as `<n>` placeholders before emphasis runs, so asterisks inside a span stay
  code. That form is safe rather than merely unlikely: `esc()` has already turned every `<` in the text
  into `&lt;`, so a placeholder cannot be forged by the input. The first version used a bare
  space-digit-space and **did** collide — a paragraph with one code span and the words "0 files" had the
  digit in the prose replaced by the span.

  No tables, no images, no HTML passthrough. Passthrough is the single feature that would turn a
  model's prose into a way to inject markup into a page the operator trusts.

Gate: `npm run check:diff` — checks every count against `git diff --numstat`, escaping against a
file containing `</script>`, and which of the two page modes carries the refresh FAB.

## `/sprint` — the board in a browser (`src/sprint/`)

Every card carries a **copy-link button** next to its key, and so does the open drawer: it writes
`https://<site>/browse/<KEY>` to the clipboard, which is the form a colleague can paste anywhere. The
base comes from `SprintBoard.browseBase`, filled from the CREDENTIAL at collect time — a renderer that
read credentials could not be handed a board collected elsewhere. **No configured site means no copy
buttons at all**, because one that copies `https://undefined/browse/KEY` is worse than none.

Two consequences worth stating. The card was a `<button>` and is now a **div with `role="button"`**:
it has to contain a button, and a button inside a button is invalid HTML — the parser hoists the inner
out of the outer and wrecks the layout silently rather than failing anywhere visible. The keyboard path
a real button gave for free is now explicit (Enter and Space open a card). And the copy click calls
`stopPropagation`, because the button sits inside the card's own click target: without it, copying a
link would also open the drawer and fire a detail fetch nobody asked for.

The button is **always visible, just quiet** (40% opacity, full on hover). Hover-reveal was the first
attempt and it is the wrong trade on a board that is scanned rather than explored: a button nobody can
see is a button nobody knows exists.

**Ask ayin about a ticket** (`src/sprint/chat.ts`). One markdown file per ticket at
`~/.ayin-cli/sprint/chat/<KEY>.md`, and **that file IS the thread**. Sending appends the operator's turn
and hands the agent the ticket, the earlier turns AS TEXT (`threadBefore`, tail-clipped to 4000 chars)
and the question. It searches the codebase and answers; **`app.ts` appends that closing message to the
thread when the turn ends** (`settleTicketThreads`).

**BOTH TURNS ARE WRITTEN BY CODE**, and `chat.ts` is the only writer. The first design gave the agent
the PATH and asked it to append — its write was the reply. It failed exactly where a model fails: it
invented the timestamp, anchored a `str_replace` on the operator's turn and inserted its answer ABOVE
the message that asked for it, then re-pasted an earlier answer alongside it. So the path is no longer
in the prompt at all — a path the model never sees is a file it cannot corrupt — and `appendTurn` owns
the heading, the clock and the position, stripping a `## ayin · …` heading off a reply that arrives
wearing one.

The key travels with the prompt (`ChatSubmit(key, prompt)`) and is held until the turn ends. The
pending/absorbed split is the diff store's, for the same reason: a message sent while the agent works is
folded into the running turn, and settling one that was NOT absorbed would answer it with a reply to
somebody else's question — it stays in `queuedThreads` until `onQueuedMessagesDrained` says a turn took
it. Several tickets in one turn each get the closing message with a line saying it covered all of them.
A turn that dies appends the error, so the thread never ends on an unanswered question.

Still deliberately NOT the diff comment store: no status machine and no reply payload, because a diff
moves under the discussion and a ticket does not. The page polls a `size-mtime` version stamp and
re-renders when the file grew. Polling stops when the drawer closes, and gives up after three minutes of
a quiet file so a forgotten tab does not poll forever.

While a turn is in flight the drawer shows a **progress row** (`src/agent-activity.ts`,
`GET /api/agent/state`): what the agent is doing and how long it has been doing it —
`tool · Running grep(ScoringId, Assets/Scripts) … 1m 24s`. The state is the one the TUI indicator
already paints; `setAgentState` records it into a HOLDER (one current value, no history) before it
paints, so a headless `-p` run reports too. `since` moves on a STATE change and holds across a label
change, because a tool label updates several times inside one thinking phase and resetting the clock
each time would make a long wait look like a series of short ones.

The row stops on the signal the thread already has — the newest turn being `ayin` — and on the drawer
closing. No second completion mechanism, so there is nothing for the two to disagree about. `idle`
while the page is still waiting is reported as **queued**, not as a confident spinner: the turn is
behind something else in the session, or it finished without writing, and both are worth saying. The
refresh FAB is hidden while the drawer is open — it is fixed to the same corner the elapsed clock
lands in.

The thread lives **outside the repo**: a discussion about a ticket is not a change to the project, and
writing it into the working tree would put it in the next diff, the next commit, and eventually
someone's review. The key is validated before it becomes a filename — it arrives from a browser, and a
path built from an unchecked string is the one bug here that would matter.

Turns are split on the heading `appendTurn` writes (`## you · <ts>` / `## ayin · <ts>`) and rendered
server-side with the same `renderWebMarkdown` the diff replies use, so there is no second renderer in
the browser for the escaping to be wrong in. Prose with no heading is still shown as a turn — the parse
outlives the design that made it possible, and an answer that lost its heading must still be visible.

It sits beside the existing Jira `+` rather than replacing it — two destinations for two different
intents. Worth knowing that a read-only Jira credential makes the Jira half fail while this half works,
since this one never touches the API.

A **refresh FAB** sits bottom-right, deliberately the same shape and behaviour as `/diff`'s: the route
re-collects the sprint per request, so refresh is `location.reload()`, and the button disarms on click
because a Jira round-trip is not instant. The drawer is NOT reopened afterwards — a ticket's detail is
a separate fetch, and reviving it would fire one nobody asked for.

`/sprint` serves the operator's current Jira sprint as a simplified kanban page on the session's own
loopback server: one column per status the SITE reports, one card per ticket, one ticket open at a time.

- **Columns are the workflow's, not a list in the code.** Statuses are invented per project ("Ready For
  QA", "Ready For Merge"), so the columns are whatever the sprint returned, ordered by Jira's own
  three-bucket `statusCategory` (To Do → In Progress → Done, unknown last). A hardcoded column set drops
  the statuses it never heard of, and the ticket disappears from the board while still being in the sprint.
- **The card is a summary; the drawer is a fetch.** Cards carry only what the sprint search already
  returned. Clicking one fetches `/api/sprint/ticket/<KEY>` for the description and comments. Twenty
  detail fetches up front is a minute of waiting for the nineteen nobody opened.
- **`+` posts a comment to Jira**, as the operator, through `addComment()` — the connector's one write.
  The body format follows the site's learned flavour (ADF document on v3, plain string on v2); the wrong
  one is a 400, not a degraded comment. The page appends the comment only after the SERVER confirmed it
  exists on the ticket — an optimistic append is how an operator closes a tab believing their words were
  posted.
- **A comment is refused unless its key was ON THE SERVED BOARD.** The route keeps the keys the last
  `/sprint` render held, so a page cannot be talked into commenting on an arbitrary ticket. Loopback bind
  plus the cross-origin refusal that already guards the prompt editor are the other two limits.
- **No static form.** Unlike `/diff`, there is no `file://` fallback: the cards fetch and the comment box
  writes, both through routes only a listening session has. A page with two dead affordances is worse than
  one sentence saying why there is no page. The route re-reads the sprint per request, so a reload is how
  you see what changed.

Gate: `npm run check:sprint` — hermetic (stubbed `fetch`, env credential): column order and that no status
is dropped, escaping of a title containing `</script>`, the `+` affordance, both refusals, and the ADF vs
plain-string body per flavour.

## Unity assets as a map, not as YAML (`src/prefab/`)

`prefab_inspect` reads a `.prefab`, `.unity` scene or `.asset` and returns what the file DESCRIBES: the
GameObject hierarchy, each object's components under their real class names, every property, and every
asset reference resolved from its guid. `/prefab <path>` is the same reader with the tree rendering, shown
in a scrollable overlay. `prefab_edit` changes one property of it. Gate: `npm run check:prefab`, hermetic —
it builds a five-file Unity project in a temp directory, so a clone with no Unity project passes.

**Why a reader at all.** A prefab names nothing it depends on. Every edge in it is a 32-hex guid whose only
definition is a `.meta` file elsewhere in the project, and the hierarchy is not written down — it is implied
by `m_Father`/`m_Children` fileIDs across documents in arbitrary order. So an agent that reads the text gets
the numbers and not the wiring, which is the half a Unity bug usually lives in. A 16,000-line prefab becomes a tree in ~70 ms of parsing.

**The parser (`yaml.ts`) exists to locate, not to model.** Every node carries its line span, because an edit
must replace those bytes and leave the rest alone. Two shapes in Unity's dialect fail SILENTLY and both were
bugs here first: a sequence's dashes sit at the PARENT key's indent (`m_Component:` then `- component:` in the
same column), so a single-mode parser reads the next sibling key as another list item; and a long flow map
WRAPS mid-value (`{fileID: 8074…, guid: b88e…,\n    type: 3}`), so a line-per-key reader gets a truncated
reference — which then resolves to nothing and reads as "this prefab has no dependencies".

**Resolution has no index, deliberately** (`refs.ts`). A cached guid→path map is faster on the second call
and wrong the first time someone moves an asset in Unity with a session open — the corpus retrieval in this
same repo is the cautionary case. Instead one grep resolves ALL of a prefab's guids at once
(`grep -E 'g1|g2|…' --include=*.meta`), chunked so no scan can hit the probe runner's line cap and return a
partial answer as if it were complete. A second batched scan answers "what IS it": a `.asset` is a
ScriptableObject whose class lives in its own `m_Script` guid, which is what turns `guid: 3d9f…` into
`SkeletonDataAsset named Hero_SkeletonData.asset at Assets/Art/Spine/`. Two scans, whatever the prefab size.

Three details that were each a wrong answer before they were a rule. `PRUNE` excludes `Library/`, so package
assets — TextMeshPro, uGUI — resolved to nothing: the leftovers get a second pass over
`Library/PackageCache` and `Packages`, run with that directory as cwd, because the probe runner translates
`grep` into `git grep` on a work tree and that translation drops path arguments. A TMP font serializes its
atlas first and puts its own `m_Script` two megabytes in, so the class is looked for in a bounded 4 MB prefix
rather than the first few kilobytes. And sub-assets share their file's guid — a font's material is a
different fileID in the same `.asset` — so the fileID is decoded too, arithmetically when Unity used
`classId * 100000` and by reading the target's document header when it used a hash.

**The edit is byte-level** (`edit.ts`). Parse to locate, replace exactly the lines the value occupied: a
prefab edited here differs by one line, which is also the proof nothing else moved. Re-serializing instead
would drop every key the parser does not model and hand Unity's merge tool a conflict on a file nobody
meaningfully changed. Assets are named, not hexed (`asset=OtherFont.asset`), and three things are REFUSED
rather than guessed: an ambiguous asset name or object name, a property that is a map rather than a leaf, and
a reference whose resolved CLASS does not match the field's current one — same extension is not the same
type, and `asset=GameConfig.asset` into `m_FontAsset` is a field Unity reads as null. That last
refusal names the way through (`value={fileID: …, guid: …, type: …}`) so a base-class field is not a dead end.
`m_Pivot.x` is rewritten inside its flow map, since a vector is one value and the most-edited thing in any
prefab. Properties only: nothing structural, no components or objects added or removed.

**`/prefab` is a document, so it opens in an overlay** rather than as a chat message that scrolls the
conversation away. Two optional fields on `ToolSlash` carry that: `overlay` (the answer is a page) and
`defaults` (parameters pinned for the slash path only — the operator gets `format=tree`, the agent calling
the same tool gets JSON). Both are declared BY THE TOOL, because the alternative is a name check in the
dispatcher, which is the shared list directory discovery exists to remove.

## `chore` — what you added last week and nobody calls (`src/chore/`)

`chore` (agent tool), `/chore [commits]` (also opens a page), `ayin chore [--commits N] [--all] [--html]`.
Gate: `npm run check:chore`, hermetic — it builds a real repository with real commits in a temp directory,
because every claim this makes is a claim about history.

**Why the scope is recent commits.** A dead-code scan over a whole repository returns hundreds of items,
most of them public API, test helpers or serialized fields, and nobody reads that list twice. The narrower
question has an owner: *of the members added in the last N commits, which are used by nothing?* That set is
small, fresh enough that the author still remembers why, and each item carries its introducing commit — so
it is a decision, not an archaeology assignment.

Three deterministic steps, no model. `git log -n N --name-only` gives the touched files; `git show
--unified=0` per commit gives the ADDED lines, filtered by narrow per-language declaration patterns (a
pattern that also matched calls would report every added call site as dead code, which teaches the reader
to distrust the report); then every candidate is **re-checked against HEAD**. That last step is what makes
it trustworthy: a member added in commit 7 and deleted in commit 9 is history, and is dropped with a count.

**"Unused" is not "dead", and it says so.** The declaration is read from HEAD *with the lines above it*,
because C# puts attributes on their own line — the first run against a real project reported four NUnit
tests as dead code. Reflection-invoked members (`[Test]`, `[MenuItem]`, `[RuntimeInitializeOnLoadMethod]`,
`[SerializeField]`, DI) are excluded and counted rather than listed; they have no callers by design.
Everything surviving carries its caveats (`override`, `virtual`, `public`, `partial`, a test path) and a
confidence: `likely` only when nothing at all excuses it. **Assets are searched too**, because a Unity
field is named from a prefab and a method can be named from an animation clip — invisible to a search of
C# alone.

**One pass, not one per candidate.** `git grep -nowI -E 'a|b|c'` prints `file:line:match`, so a single walk
attributes every hit to the name that produced it — the same trick the guid resolver uses. Measured on a
real Unity project: 204s of per-candidate plain grep → 96s batched → **17s** once `git grep` replaced it,
which also skips `Library/` for free because it is gitignored. The declaration is discounted by matching
its LINE, not by subtracting one from its file — which was wrong the moment a member was used in the file
that declares it.

The page (`~/.ayin-cli/chore/chore-<repo>.html`) is written outside the repository, like every other
artifact: a report about the tree is not a change to it. `--all` includes the used and the
reflection-invoked, for auditing the scan itself. Exit status is 0 whether or not anything was found — this
is a report, and a non-zero exit would break any pipeline that runs it routinely.

## `ayin unity …` — the Unity toolkit from a shell (`src/unity/cli.ts`)

    ayin unity prefab <file>              the hierarchy, its components, every guid resolved
    ayin unity animator <file.controller> states, transitions, exit time, clip overlap
    ayin unity prefab_edit <file> --property P (--value V | --asset NAME) [--object O] [--component C]
    ayin unity test <Asm1,Asm2>           run those test assemblies · -v for the full report
    ayin unity test --assemblies          what can be run, and which are PlayMode

`ayin --help unity` is the verbose page; `/unity-test A,B` is the same run inside a session. Gate:
`npm run check:unity`, hermetic — a small Unity project (asmdefs, a prefab, a controller) in a temp dir.

**One namespace, not three subcommands.** These answer one operator's question in one sitting — what is
this prefab wired to, change that wiring, did the tests still pass — and three top-level entries would put
Unity vocabulary in front of everyone who never opens Unity.

**Nothing new underneath.** `prefab`/`animator`/`prefab_edit` run the same modules the agent's tools do,
and `test` executes through `runSelection` — the same path `/testrun` takes, so a run from the shell and a
run from the TUI cannot disagree about what passed. The one thing this adds is **selection by assembly
name**: `/testrun` picks assemblies from a corpus domain, which is right when you know the feature and not
the assembly, and wrong when you know exactly which assembly you just touched. A name that does not match
is REFUSED with the near-misses listed — resolving it to "close enough" would run the wrong tests and pass.

**Curt by default**: `ok · 42 passed · 3 skipped · prebuilt DLLs`, or nothing but the failed tests and
their first message line. `-v` prints `formatReport`. Exit 1 on any failure or any assembly that did not
run — an assembly that could not run is never folded into a pass. `--assemblies` lists every test assembly
with **PlayMode or EditMode** (from `includePlatforms`) and whether its DLL is current, stale or missing.

Registering a subcommand means two lists besides the dispatch, and both were found the hard way here.
`SUBCOMMANDS` in `index.ts`, or the flag validator rejects the namespace's own flags on sight
(`ayin: unknown option --assemblies`). And `NO_TUI_COMMANDS` in `ui/headless.ts`, or it prints its answer
and THEN opens an alternate screen to tear it down — clearing the terminal it just wrote to.

## An AnimatorController as a graph (`src/animator/`)

`animator_inspect` reads a `.controller` and returns its states and transitions as JSON. Read-only — a
controller edit is a graph edit across three documents and Unity's own ids, and nothing here writes. Gate:
`npm run check:animator`, hermetic, with clip lengths chosen so every number can be checked by hand.

It exists for two questions the file cannot answer as written. **Does this transition wait for the clip?**
`m_HasExitTime: 0` means it fires the moment its conditions hold, cutting the clip mid-play — one digit,
thirty lines from the state it belongs to, and the usual cause of "the animation is skipping". **Do the
clips overlap?** A transition duration greater than zero is a cross-fade, both clips playing at once — and
the duration is in NORMALIZED time unless `m_HasFixedDuration` is set, so `0.25` means a quarter of the
source clip, whose length lives in the `.anim`. Both are reported in seconds with the arithmetic done, and
conditions are spelled rather than enumerated (`m_ConditionMode: 1` on a trigger is "is set").

`findings` is what only the assembled graph shows: a state nothing enters (it can never play), a state
nothing leaves and no Any-State transition to rescue it, a transition with neither conditions nor exit time
(it fires the frame the state is entered), a muted transition, a motion guid nothing defines, and a
cross-fade that runs past the end of its own clip. That last one is suppressed for a zero-length clip: a
single-frame pose has no timeline to run past, and reporting it turned an ordinary fade on a real controller
into a finding.

The parser, guid resolution and project-root walk are the prefab reader's — a `.controller` is the same
dialect, and a second copy of that parser is a second place for Unity's wrapped flow maps to be wrong.

## `ayin_help` — the agent reads its own manual

Everything the operator can type — `!cmd`, `/diff`, `/qa`, `/sprint`, `ayin indulge` — is a capability of
the system the agent works inside, and the agent had no way to learn any of it: asked how to review a
change it invented a command. `ayin_help` returns the same bytes `ayin --help` prints (`plainPage()`
in-process, no second node boot, no escape codes), or one command in full with `topic`. It is a tool rather
than prompt text because the catalogue is ~6 KB — as prompt text it would be paid on every turn to serve
the rare turn that needs it. Asserted in `npm run check:helppage`: byte-identical to the CLI page.

## `ayin launch` — see [`LAUNCH.md`](LAUNCH.md)

`ayin launch` opens a terminal window at the front file-manager directory and runs ayin in it. It is
not a mode and not something to type: running `ayin` in a terminal already uses that terminal's
directory. It exists for the hotkey case, where there is **no terminal** to inherit a cwd from.

Two decisions worth knowing here, both argued in full in [`LAUNCH.md`](LAUNCH.md):

- **ayin does not listen for the hotkey.** A global modifier double-tap needs an OS-level input tap
  that sees every keystroke on the machine. The machine already has a daemon with that permission —
  the trigger is theirs, the action is ours. It is kept out of `watch` for the same reason: that
  daemon is per-repo and poll-only, a hotkey listener is machine-scoped.
- **The shell is bash everywhere, the window is not portable.** The launch script has a bash shebang
  (Windows resolves it through Git Bash, as `shell.ts` already does), while the opener is the
  `terminalCommand` config template with `{{SCRIPT}}` — every platform default is a guess about
  someone else's terminal.

Gate: `npm run check:launch`.

## Repo watcher (`watch.ts`)

`ayin unwatch` is the inverse and the only way out: it removes the hooks from the repo (a CHAINED
block comes out of a host hook byte-for-byte; a hook that is entirely ours is deleted; anything
unrecognised is reported and left alone), removes the hound script and only our own entry from
`.claude/settings.json`, and **deregisters the repo** — which is the step that actually ends it, since
while a repo stays registered the daemon's self-heal reinstalls every hook within five minutes.
`--all` for every watched repo, `--stop` to stop the daemon without touching any hooks. When nothing
remains registered the daemon is stopped too. The queue and past reports are kept.
`tool/check-unwatch.mjs` guards the boundary — the risk here is removing too MUCH.

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
  (`AYIN_WATCH_HOUND=0` to skip installing it — existing installs are left as-is). The script is the
  shipped `assets/ayin-hound.mjs` copied in verbatim under a two-constant header carrying the nudge
  text (`prompts/watch/houndUndesigned.txt`, never in the asset) and the kill-switch path.

  It asks **one question, with no model at all**: does every C# type ADDED in this working tree appear
  on the design?

  | | |
  |---|---|
  | **working tree** | `git status --porcelain --untracked-files=all`, *not* `git diff --cached`. An agent that just wrote six new files has staged none of them, so an index-only hound saw nothing at the moment it mattered. `--untracked-files=all` because the default collapses a new directory to its name and misses every file under it. |
  | **added** | untracked, or index status `A`. A rename or copy is **not** an add — the type already existed and was answered then. A file merely **edited** is never re-asked. |
  | **not authored** | paths under `obj/ bin/ Library/ Temp/ Build/ Builds/ node_modules/` and `*.designer.cs`/`*.g.cs`/`*.generated.cs` are skipped: generator output is not a design decision, and Unity's `Library/` alone holds thousands of `.cs`. |
  | **the design** | any `.puml` in the tree that **declares at least one type** — the format `naama` writes, `entangle` reads and `naamah weave` renders. Falls back to a rendered naamah page's `<script id="graph">` payload only when no `.puml` declared anything, which keeps the common case to a handful of small files instead of sniffing every HTML in the repo. Declaring a type is what makes a file a *design* rather than an extension match: a sequence diagram or a coverage report contributes no names and does not make the tree look designed. |
  | **the answer** | a set difference between two regex scans. The C# declaration regex is deliberately the same shape as `src/entangle/languages/csharp.ts`, and the puml one mirrors `parsePuml` in `src/naama/index.ts` — the only puml parser ayin ships. Nothing to hallucinate, nothing to time out, no round budget to spend. |

  **It never blocks.** A finding rides out as non-blocking `hookSpecificOutput.additionalContext`:
  "you added a type that is not on the diagram" is a thing to tell the agent, not a thing to cost it
  a turn for. Four independent early exits keep it silent — no added `.cs`, no design in the tree,
  every new type already on it, or a repeat of a finding already delivered. An atomic `mkdir` lock
  hashed over the *finding itself* (undesigned types + design sources) debounces repeats and is swept
  after a day; fixing the design changes the key, so the next turn is judged fresh. Caps: 80 added
  `.cs` scanned, 40 designs read, 12MB per design file, 12 types named in one nudge — anything
  dropped is reported in the nudge rather than silently omitted. `--facts` prints the whole
  deterministic verdict as JSON without emitting a hook response.

  **What this replaced, so it is not rebuilt.** The previous hound ran six mechanical git checks over
  the staged index (`staged-foreign`, `meta-guid-changed`, `serialized-field-removed`,
  `enum-ordinal-shift`, `interface-member-added`, `asmdef-reference-removed`) and then paid `ayin -p`
  up to 240s, read-only, to verify them — with the output contract (citation must resolve, `greps_run:
  0` forces `UNVERIFIED`) enforced in the script. The contract worked. The checks did not: five of the
  six were gated on Unity file extensions (`.cs`, `.meta`, `.asmdef`), and the sixth disabled itself
  whenever HEAD equalled its base ref, which is every commit-to-main workflow. Measured on ayin's own
  repo — 0 `.cs`, 222 `.ts`, 261 interfaces — the facts list was therefore *structurally always
  empty*, and the only reachable behaviour was one model call producing a commit-message suggestion.
  A premortem hound that could not premortem. The lesson kept: **a hook that fires at the end of every
  turn is judged entirely on its false positives**, which is why every branch of the silence above is
  a separate assertion in `check:watch`.

  Loop-safe: `stop_hook_active` on the hook payload is honoured, and reading fd 0 is skipped when it
  is a TTY so a manual `--facts` run cannot block forever. The JSON merge into `settings.json`
  only ever touches the one Stop-hook group whose command names `ayin-hound.mjs` **or** the
  pre-1.0.224 `ayin-hound.sh` — so an upgrade replaces the old bash hound (and deletes its script)
  instead of running two per stop; every other key, every other Stop entry, every other hook event
  is left exactly as it was, and an unparseable existing file is left alone rather than risking a
  hand-edited config. Both the hook script and `settings.json` are written via `writeAtomic()`
  (temp file + rename) — a power cut mid-write can never leave a truncated `settings.json` for the
  next Claude Code turn to choke on (an unparseable file would otherwise be presumed hand-edited
  and left alone forever, exactly the case a self-inflicted truncation must not fall into).
- **Unity Accelerator, kept pointed at** (`src/unity-accelerator.ts`): on install and on every
  self-heal, a watched Unity project's `ProjectSettings/EditorSettings.asset` has
  `m_CacheServerMode: 1` and `m_CacheServerEndpoint` asserted — a two-line edit, by line, never a YAML
  round-trip (Unity's `.asset` dialect carries tags and ordering it depends on; re-serializing it is
  how a settings file comes back subtly different and Unity rewrites half of it).

  Three properties are load-bearing. **The endpoint is CONFIG with an empty default** —
  `acceleratorEndpoint`, or `AYIN_ACCELERATOR` — and empty means disabled: no probe, no read, no write.
  A LAN address in source would be a fact about one machine compiled into a public repo (§4) and wrong
  for every other machine besides. **It is written only while the box ANSWERS**, checked by a TCP
  connect with a short timeout: Unity pointed at a dead cache server does not fail fast, it waits on
  every import, so asserting an unreachable endpoint is worse than leaving it unset. **And it never
  reverts** — when the box stops answering the setting is left alone, because this file is tracked and
  an automatic revert would mean a daemon adding and removing a line in version control as a laptop
  moves between networks.

  **Known cost, chosen deliberately.** `EditorSettings.asset` is tracked and shared, so once this
  writes, the file is dirty until committed — and if it IS committed, every teammate and every CI
  runner inherits an endpoint that does not resolve for them. The machine-local alternative is Unity's
  own user preference, which `m_CacheServerMode: 0` already defers to; that trade was raised and the
  project-settings slot was chosen. Note this argues with the `/diff` Stage policy, which deliberately
  skips `ProjectSettings/` as project base config — one writes the file, the other refuses to stage it.

- **The kill switch — `ayin kill dog`** (`src/kill-dog.ts`, `src/hound-off.ts`): `~/.ayin-cli/hound.off`.
  While that file exists the hook exits 0 on its FIRST line — before git, before any file is read —
  `ayin watch` installs no hound, and the daemon's self-heal stops re-adding one
  (`houndInstallAllowed()` is a function, not a constant: the daemon lives for days and the switch is
  thrown from another process). The command also removes ayin's own hound from every registered repo
  and from the repo it is standing in, using the SAME `HOUND_MARKERS` identity `unwatch` uses.
  Why a switch and not an uninstall: `unwatch` can only end a hound ayin installed and registered, so
  a Stop hook someone added by hand — the actual cause of "unwatch did not stop the dog" — is outside
  its reach. A foreign hound is REPORTED, never edited; the report prints the one line
  (`[ -f "$HOME/.ayin-cli/hound.off" ] && exit 0`) that makes any bash hound honour the same switch.
  A file rather than a config key because the deciding code is a standalone copy in another repo, run
  by another program, which can import nothing from ayin. `--off` revives, `--status` reports.
  `AYIN_WATCH_HOUND=0` remains the per-process opt-out.
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

## Retrieval — see [`INDULGE.md`](INDULGE.md)

> **[`docs/INDULGE.md`](INDULGE.md) is the source of truth for the corpus** — its guarantees, the
> coarse-to-fine retrieval order, staleness, portability, and the two project-type hooks. This
> section is a summary; that document is the argument for why ayin is not a harness around a model.

**Nothing is retrieved yet.** ayin still finds code the agentic way — `grep`, `find_files`,
`read_file` and `explore`. The earlier retrieval surfaces (a grounded Q&A corpus generator,
transcript-mined episodes, and a `docs_search` tool over a specific backend's documentation index)
were **removed**: each one was naive retrieval and each one hard-wired ayin to one operator's
private backend. No code path embeds, indexes or retrieves anything.

The replacement is being built in three phases. **Phase 1 — `indulge`, the corpus — is partially
landed and RUNNABLE.** `ayin indulge` builds a corpus end to end, gated by
`npm run check:indulge` (94 assertions). Phase 2 (embeddings) and Phase 3 (injection sites) are not
designed yet — Phase 1's chunks get read and judged by hand first, because a RAG is worth exactly
what its chunks are worth.

### `indulge` — the per-repo corpus (`src/indulge/`)

    ayin indulge --repoPath <path> --domains "rendering,checkout-flow"

The eventual shape: a **domain** is an arbitrary string the operator types. It maps to nothing
structural and **may match nothing in the repo** — in which case indulge records `matched: 0` and
stops. It never invents a file list to have something to work with; a corpus containing invented
files is worse than no corpus, because it is confidently wrong at retrieval time.

Three stages, each writing its results to disk as it produces them: **discover** the files a domain
touches, **generate** the questions worth answering about them (model-generated, not templated),
and **answer** each one as a full explore-style investigation. Every answer carries citations that
are verified — path, line range and blob sha — **before** its chunk is written; a chunk whose proof
does not resolve is recorded `failed` and never stored.

**It is an overnight job, and that sets every design decision in the store.** The operator starts it
in the evening and closes the laptop, so a crash, a reboot or a `kill -9` at 02:00 must cost at most
the one question in flight — never the hours before it:

| Property | How |
|---|---|
| Nothing lives only in memory | JSONL, appended and flushed per record (`appendFileSync` opens, writes, closes) |
| A torn line never costs the corpus | Every reader skips a line that will not parse — the normal aftermath of a power cut mid-append |
| Status changes never rewrite a file | `pending → answered` is a second line with the same `id`; readers merge in order, last wins |
| Whole-file documents are atomic | `manifest.json` / `progress.json` go through `writeAtomic` (temp + rename) |
| A restart knows what was in flight | Runs left `running` are closed as `interrupted`; their data stays and is what the next run resumes from |
| A stale lock needs no human | A lock whose pid is dead (same host) or whose heartbeat stopped (any host) is **adopted**, not obeyed. A live one is refused by name |
| Re-runs expand, never restart | `questionId` and `chunkId` are content-derived and stable; a known id is skipped. `sourceSha` is the invalidation key — unchanged file, no re-answer |

Storage is **outside the work tree**, in `~/.ayin-cli/rag/<repo-key>/` (`AYIN_RAG_DIR` overrides it).
Chunks quote method bodies, and a work repo belongs to an employer: one `git add -A` in the wrong
directory would publish the corpus.

**The corpus is PORTABLE — build it overnight on a big box, use it on a laptop.** Every path inside a
chunk is repo-relative POSIX, and `<repo-key>` is derived from the repo's IDENTITY rather than its
location: the normalised `origin` remote (`github.com/owner/repo`), else the **root commit** (identical
in every clone, immune to renames and re-hosting — but it changes if history is rewritten, which is
why the remote comes first), else the absolute path for a directory that is not a git repo, which is
not portable and says so. The slug comes from the identity too, so a repo cloned into a
differently-named folder still resolves to the same corpus. `manifest.identity` records which was
used, so a directory name is explicable rather than a mystery hash.

    scp -r nuk:~/.ayin-cli/rag/<key> ~/.ayin-cli/rag/     # or:
    ayin indulge --import <dir>

`--import` refuses a corpus built for a *different* repo — dropping one project's answers onto another
fills retrieval with authoritative-looking chunks citing files this tree does not have — and reports
how many are already stale against this checkout. It refuses to merge into an existing corpus silently.

Keying on the path was the earlier design, chosen so two checkouts of one repo stayed separate.
That predated the staleness layer; now every chunk is labelled per-file against the tree in front of
it, so sharing is safe and immobility was pure cost. A corpus built before this is **adopted** on
first open (renamed to the identity key) rather than orphaned — it cost a night of GPU.
`chunk.repoPath` is deprecated and no longer written: it was an absolute path, unread by anything,
that put the building machine's home directory in every chunk.

```
~/.ayin-cli/rag/<repo-key>/
  manifest.json      repoPath + one row per run (domains, headSha, totals, status)
  files.jsonl        stage 1 — one line per discovered file
  questions.jsonl    stage 2 — one line per question, PLUS one line per status change
  chunks/<id>.json   stage 3 — one answered, citation-verified question
  progress.json      heartbeat — stage, done/total, current item
  run.lock           the running process, so two indulges cannot share one corpus
```

Duplicate-checking is O(1) per append against an in-process id cache seeded from disk. This is not a
micro-optimisation: re-parsing the JSONL per append is quadratic, and measured at 175ms for 500
questions but 51s for 8000 — a repo whose files × entities × 5 categories reach five figures would
have spent the night on bookkeeping instead of answers.

> Full rationale in [`INDULGE.md`](INDULGE.md).

#### Stage 1 — discovery (`discover.ts`)

The model picks the **seeds** (only something that reads code can answer "which files implement
checkout?"), and every path it names is resolved against the filesystem before it is kept: a path
that escapes the repo, does not exist, or is a directory is refused. Refused paths are counted as
`hallucinated` and reported, never stored. `exploreExecute` gained a `cwd` param for this — indulge
investigates the repo at `--repoPath`, and passing it per call is what keeps that from becoming a
`process.chdir()`.

From the seeds the walk is **deterministic**, because stage 3's citations have to be real. Three
edge kinds, strongest first:

| Edge | Built from | Why |
|---|---|---|
| import | relative `import`/`require` specifiers, resolved to files that exist | Names the file directly. `./x.js` → `x.ts` is handled — under NodeNext every TS file imports its sibling that way |
| imported-by | the same edges reversed | "who calls this" is half of what a corpus is asked |
| mention | identifiers intersected with the declared-type table (`surfaceOf`), **gated by reachability** | The only signal in C#. A mention counts only if the target's namespace is one the source `using`s, or its own |

Mention edges are filtered through the language's own `isBuiltinType`, and a name declared in more
than three files is dropped as ambiguous. Both guards are measured, not theoretical: `session-record.ts`
declares `type Event`, and without the filter every file mentioning the DOM/Node `Event` was linked
to it — a plausible edge that is simply false. `referencesOf` is deliberately *not* used for edges;
it answers entangle's question (which manifest unit does this cross), and a bare specifier names a
package rather than a file.

**`--max-files` bounds how DEEP the walk goes, not how much of a level it sees.** The cap is checked
at the depth boundary: the level in progress finishes, and the cap decides only whether to start the
next one. Cutting mid-depth returns an arbitrary subset of one hop chosen by iteration order —
measured on a real run as "depth 1" giving 27 of however many direct neighbours existed. Depth is a
claim about completeness; a half-walked level is not a depth, it is a coin flip. A single enormous
level is still bounded by `DEPTH_OVERRUN` (4× the cap), and that case says INCOMPLETE out loud.

**Popularity disqualifies a name.** A type mentioned by more than `MAX_MENTIONERS` (25) files is
*ambient* and stops being an edge in either direction — `ILogger` named by 300 files says nothing
about which of them belong to this feature; the popularity IS the proof that it does not
discriminate. And each file gets a `MAX_FANOUT_PER_FILE` (12) budget per depth, a structural bound so
one hub cannot decide the corpus. Measured: on a namespace-free Unity-shaped repo of 206 files where
201 name one ambient type, discovery returns 5 — the seed, the type it really uses, and the three
files that really use that.

The namespace gate below does nothing in a codebase with **no namespaces**, which is most Unity C#;
these two caps are what hold there.

**A shared name is not a dependency.** Measured on a real 3454-file Unity repo: C# has no relative
imports, so `0 import edge(s) resolved` and every hop fell through to mentions — with 5270 declared
types, depth 2 pulled in 337 files for a 40-type feature and hit the cap. A mention edge now requires
`reachable()`: the target's namespace must be one the source declares with `using`, or its own
(same-namespace types need none). On a fixture where 40 unrelated files name the same type from
another namespace, discovery returns 3 files instead of 43.

**A seed must be SOURCE.** A real run seeded on `Core.csproj`, a test `.csproj`, and — best of all —
ayin's own `AYIN-REPORT-*.md` output file, and the csprojs each produced four questions. Those exist,
so the path check passed them; a question about a generated project manifest is a spent
investigation. Seeds now require `languageFor()` to handle the file, and skipped paths are reported.
Citations stay unrestricted — a citation may point at anything that exists.

**Unity sidecars never enter the corpus.** A `.meta` exists beside every file, so a model asked for
"the files that implement X" lists `RewardService.cs.meta` and the path check passes — a question
about a GUID costs a real investigation and answers nothing. `NOISE_EXTENSIONS` refuses those plus
binary assets, even when a model names them explicitly.

`bin/` is **not** in the skip list. It is MSBuild output in .NET but the CLI entry point in a Node
package, and skipping it dropped a real source file that imported the seed. `obj/` stays skipped —
MSBuild generates `.cs` there, which would be indexed as if hand-written.

Verified on ayin's own source: seeded with `session-record.ts`, depth 1 returned exactly the four
files that import it plus the one it imports — the same set `grep -rl` returns, with no extras.

#### Stage 2 — question generation (`questions.ts`)

Questions are **model-generated, not templated**: a fixed list asked of every project produces a
corpus of answers nobody needed. One call per **(target, category)**, where a target is the file
itself or one entity in it (declared type, public method, public property — a private helper is not
what tomorrow asks about). Per category rather than one call for all five, because asking for five
kinds of thing at once returns five shallow examples of the easiest kind; each category's focus is
one tunable line in `prompts/indulge/category*.txt`, wrapped by `questionFrame.txt`.

**Depth decides priority, in both stages.** A seed IS the feature; a neighbour is context. Questions
are budgeted by depth (a seed gets the full per-target allowance, depth 1 half of it and fewer
entities, deeper still one), and answers are ordered **depth first, then file**. Both were measured
on a real repo: peripheral interfaces reached at depth 1 produced 40 questions each against the
seed's 12, and with `--max-questions 15` an alphabetical answer order spent every one of them on a
depth-1 neighbour while the seed got none. On a capped run the order IS the corpus.

`NONE` is a real answer that must survive as zero questions — a file with nothing worth asking
should produce nothing rather than four questions invented to fill a quota. The source shown to the
model is clipped at 12k characters and **the clip is announced in the prompt**, so it never writes
questions about code it was not given.

**Resume granularity is the (file, entity, category) triple.** If the store already holds a question
for one, the model is not asked again — a resumed run makes zero calls for work already done. A
generation that FAILS (model down) writes nothing and leaves its triple un-done, so the next run
retries it rather than recording it as complete. `shouldStop` is checked between calls, so a
shutdown lands between records. Caps per target and per file keep one verbose generation from
ballooning the night's work.

The `ask` seam is injectable, which is what lets the gate prove resume, caps, dedup and the
failure path — the parts that decide whether a night is lost or repeated — without a GPU.

#### Stage 3 — answering, and proving it (`answer.ts`)

**No proof, no chunk.** Every answer carries citations, and every citation is verified against the
filesystem *before* the chunk is written: the path resolves **inside** the repo, the line range is
within the file's real line count, and the blob sha is computed from the bytes on disk rather than
taken from the model. Unresolvable citations are dropped and counted (`rejectedCitations`); if none
survive, the question is recorded `failed` and stored nowhere.

That severity is the point. A plausible-but-wrong chunk is worse than a missing one, because at
retrieval time nothing distinguishes it from a correct one — it gets injected into a prompt,
believed, and acted on.

Two paths:

- **`git`** — the facts come from `git log` / `rev-list` / `shortlog`, never from a model, because an
  approximated commit sha is a lie with a plausible shape. The model only selects and phrases over
  that output **plus the current source**, and every sha it writes is re-checked with `rev-parse
  --verify`. Both refinements were measured: answering deterministically returned a commit listing to
  *"which commit explains **why** `noteShape` uses a bounding-box heuristic?"*, which is a non-answer;
  and given history alone the model correctly refused, noting it had not been shown the code. The
  reason a thing looks the way it does is usually in the file.
- **everything else** — the code itself, in **one call**. Stage 1 already walked the reference graph
  and recorded every neighbour and *why* it is one, so `files.jsonl` answers "which files matter"
  before the question is asked; running a 12-iteration explore loop to rediscover it cost 5–10 model
  calls per question. Measured on the same three questions: **131s each via explore, 17s direct** —
  7.7×, with 0 failed and 0 rejected citations either way. Citations get *better*, not worse: the
  model cites line numbers from the numbered file in front of it rather than from remembered grep
  output.

  Context is `q.file` plus its graph neighbours in both directions (files whose reason names it, and
  the file it was reached *from*), capped at `MAX_CONTEXT_CHARS` (50k ≈ 12–13k tokens, against the
  measured `AYIN_OLLAMA_CTX` default of 16384). Anything dropped is **announced** — a silently
  clipped file makes the model cite lines that were never shown.

  **Sources go first, question last**, and questions are answered grouped by file, so consecutive
  questions about one file share a byte-identical prefix and the server's KV cache pays prefill once
  per file instead of once per question.

  `--deep` restores the explore path when thoroughness matters more than the night.

#### The command

    ayin indulge --domains "rendering,checkout" [--repoPath <path>]
    ayin indulge --status      what it is doing now, how far along, and whether it is still alive
    ayin indulge --report      write the audit markdown and stop
    ayin indulge --dry-run     discover only — file list + question estimate, spends nothing
    ayin indulge --restart     discard the corpus and rebuild (the default is RESUME)

Every run writes a **session record** (`~/.ayin-cli/sessions/<id>.jsonl`) — the invocation, each
stage's counts, and a closing line naming chunks/unproven/pending and the report path. Without it the
command established no session id, so `session-record.ts` silently no-opped and an eight-hour
unattended run left no account anywhere a reader would think to look. That matters most when the run
happened on a different machine: the record is what comes back.

`indulge` is in `NO_TUI_COMMANDS`: it runs for hours under `nohup`, so blessed must never grab the
terminal. **Resume is the default** — every stage reads its remaining work from disk, so re-running
after a kill continues rather than restarts. SIGINT/SIGTERM are cooperative: the flag is set, the
record in flight finishes, the manifest closes honestly, and a second signal exits at once.
Generation is enqueued through the **llm authority** as a background consumer, so an overnight sweep
never starves a human at the keyboard; no resource layer simply means the provider is reached
directly. A domain matching nothing exits 0 having written only a manifest.

Verified through the CLI on naamah: a no-match domain wrote no file list; a real build produced 2
chunks with 0 rejected citations; a re-run generated **0** new questions, answered only what was
left, and reached 4 chunks with 0 pending.

Sequential for now — the GPU serialises generation anyway, so concurrency would only hide file and
git I/O while complicating progress and resume. Recorded in `TechDebt.md` as the knob to add if a
real night proves I/O-bound.

Verified against real code (naamah, gemma4): 3 answered, 0 failed, **0 rejected citations**, 110s.
Spot-checked by hand — a claim about recursive descent cited `extract.mjs:43-47`, whose line 46 is
exactly `else yield* groups(inner);`, and a git answer pointed at `115-121`, the comment that does
explain the heuristic.

#### Retrieval — how the corpus reaches the agent

Two halves, deliberately asymmetric.

**Push — `read_file`.** Reading a file appends what the corpus already answered *about that file*.
It is an exact path lookup (`entity.file`, `files[]`, every citation), **not** a similarity search:
no embedding, no threshold to tune, and it cannot surface a plausible-but-unrelated chunk, which is
the failure mode every score eventually produces. Ranked by **overlap with the lines actually on screen**, not by recency — measured wrong: reading
lines 115-118 surfaced a chunk about lines 277-287 first, while the chunk citing 115-136 came second.
The most recent answer about a file is not the one about the part you are looking at. A narrow read
(≤60 lines) carries ONE chunk, a whole-file read two: a four-line peek used to come back with 2.7 KB
of notes attached, eight times the size of the code it annotated.

Chunks carry `domains: string[]`, not one domain. A file discovered under two domains belongs to
both, and a single label made it invisible from the other — which matters because domains are the
coarse index retrieval searches first. Corpora written before this still read via their single
`domain`. It lands in
the tool RESULT, so it inherits the window's observation masking (it compresses to a stub on its own
after a few messages) and never churns the KV-cached prefix.

**Pull — `corpus_search`.** Everything else, on demand, so an open-ended lookup costs attention only
when the agent asks. Two passes, coarse to fine.

*Cheap pass first (`lexicon.ts`).* Most real questions carry a **handle** — a file, a class, a method.
An exact symbol match is not "probably relevant", it is the thing that was asked about, and it costs
no model. Chunks carrying a matched name become the candidate set; the rest are out of the race
rather than merely out-ranked. Three mechanics: **normalise for the index** (`noteShape`,
`NoteShape`, `note_shape` → one key — edit distance tolerates those differences, but only between
strings it is asked to compare, and bucketing decides which pairs ever meet); **all trigrams, not the
leading three** (`ntoeShape` buckets under `nto` and would never meet `not` — this is what pg_trgm
exists to solve); and **Levenshtein last, on candidates only**, since edit distance is a re-ranker,
never a scan.

Symbols come from `entity.name`, file paths, **and the question/answer text** — measured: on a real
corpus every chunk had `entity: null`, so the index held nothing but file paths and `noteShape`
matched nothing. Backticked spans are the strongest source (the model marks code that way
consistently); camelCase/PascalCase words are the second. Plain prose contributes nothing, because an
index of every word is the same as no index.

*Then the corpus pass* over that candidate set (question ×3, path ×2, answer ×1 today; cosine once
Phase 2 lands). A named hit adds a flat boost above any amount of word overlap — it is a different
KIND of evidence.

Both label staleness through `assessChunk` — a pulled chunk is exactly as dangerous as a pushed one —
and both end with a line stating these are notes from an earlier pass, not the code. `/corpus off`
disables injection (search still works), because *"does retrieval help?"* is answered by running the
same task with it off, not by intuition.

Not injected: **grep** (many hits per call, in tight loops, weak per-hit relevance) and **explore**
(its whole value is that it goes and checks — feeding it pre-baked conclusions is the one place a
stale chunk does the most damage; it can call `corpus_search` itself instead).

#### Phase 2 — vectors (`embed.ts`)

    ayin indulge --embed        # CPU, no GPU, no authority taken

An embedding model is **not** a chat model: `nomic-embed-text` is ~270 MB against gemma's 15+ GB,
generates nothing, streams nothing, and returns one 768-float array per input in milliseconds on CPU.
It does not compete for the card and evicts nothing, which is why this stage takes no LLM authority.

**Where embeddings are asked for is ONE DOOR by default.** `embedUrl()` resolves
`AYIN_EMBED_URL` → the `embedUrl` config key → `llmBaseUrl()`, and unset means the same endpoint
everything else uses. It used to fall back to `127.0.0.1:11434`, reaching around whatever serves the
model to poke Ollama's own port: on a machine talking to a remote endpoint there is nothing there, so
`--embed` failed with `fetch failed` while generation had worked all night — the failure was the
design working. The env var and the config key are the two EXPLICIT escape hatches, for the real case
of a small embedder on the local machine while generation goes to a bigger box; neither is a fallback
the code reaches for on its own. `embedProvider()` is inferred from the model name (`text-embedding-*`
→ OpenAI, else the endpoint) rather than configured separately, because one setting that can be wrong
beats two that can contradict — and the OpenAI path BILLS the operator, so which one is in play is
worth knowing. Batch size follows from the API, not the model: OpenAI's `input` takes an array (96),
a local `/api/embeddings` takes one prompt (1).

Two rules make vectors safe to keep. **A vector is only comparable to vectors from the same model** —
not "worse results", meaningless ones; mismatched dimensions crash (lucky), matching dimensions
produce confident garbage silently, so every record carries the model NAME and a foreign-model vector
is counted and ignored rather than reused. And **vectors are derived data; chunks are the asset** —
`chunks/` is portable and model-agnostic, `vectors.jsonl` is neither, so a corpus copied to another
machine is re-embedded there (minutes on a CPU) rather than shipping numbers that machine cannot read.

Search is coarse-to-fine, and cosine is the LAST stage:

1. **names** (`lexicon.ts`) — only a *strong* match (≥0.9) restricts the candidate set. Measured: "how
   does it figure out where the speech bubble **points**" fuzzy-matched the symbol `pathPoints` and
   gated away the chunk that actually answered it. An exact name is evidence; a fuzzy hit on an
   English word is a coincidence, so weak hits boost instead of filtering.
2. **domains** — a domain's vector is the **centroid** of its chunks, not the embedding of its name; a
   domain is an arbitrary operator string and `liveops` may describe its contents poorly or not at
   all. Top-K domains, never a threshold, so a badly-phrased query still retrieves something.
3. **cosine** over what survived.

Verified on a real corpus: *"why might the box come out the wrong size"* returns the `tailApex`
bounding-box chunk while sharing almost no words with it. If nothing is embedded or the endpoint is
down, `corpus_search` silently falls back to the keyword path — the header says `[semantic]` or
`[keyword]` so which one answered is never a guess.

#### Phase 3 — the prompt sites

| | |
|---|---|
| **first prompt of a session** | automatic — it states the task, which is the one moment a prompt is reliably worth embedding |
| `/embed` · `/embed off` | every prompt this session |
| `/embedthis <question>` | one prompt only |

A prompt is a much worse retrieval key than a file path: a large share of turns are `continue`,
`yes`, `now the other one`, and embedding those returns noise with a confident score. The operator
knows their intent; a cosine value guesses at it — so this is opt-in, with the first prompt as the
exception. Prompts under three words are skipped outright.

The block rides in the **volatile per-turn message** inside `<corpus>`, never the system prefix: it
changes every turn by definition, and the prefix must stay byte-identical for the KV cache. Lifetime
is the TURN — set before the loop, cleared after — so it survives every round (where the plan forms)
without pinning one turn's lookup into the next, where the task has usually moved on.

Shape follows `/plan` and `/qa` (bare toggle, `…this` one-shot) rather than inventing a third
convention for the same idea. **Phase 3** injects retrieved
chunks at named prompt sites. Neither is designed yet — Phase 1's chunks get read and judged by hand
first, because a RAG is worth exactly what its chunks are worth.

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

- **No session lock.** ayin holds nothing. It generates through whatever endpoint it is pointed at and
  takes no authority, no priority band and no model booking — earlier versions had `/lock`, `/unlock`
  and an auto-lock on boot, and all of it is gone.

  It was removed because the cost landed on the operator rather than the machine: a held authority
  refused OTHER work on the same box — a corpus search could not embed its query while an interactive
  session held the grant, and degraded silently to keyword matching, which reads as a bad corpus
  rather than a blocked request. A priority band is only worth having if the thing it starves is
  someone else's; here it was the same person's.

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
│   └── dialects/       xml.ts (shared base) · gemma.ts · qwen.ts · glimmer.ts (ATEM) · native.ts
├── connection.ts       transport: the configured endpoint + OpenAI fallback; AYIN_MODEL_URL resolver
├── parser.ts           lenient tool-call parser (multi-format)
├── shell.ts            cross-platform shell: /bin/bash (POSIX) · Git Bash/cmd (Windows) + killTree
├── tools.ts            tool registry (a static array — every tool ships inside this repo)
│                       + the system prompt assembler
├── tools/              explore.ts · status.ts · signals.ts · web-search.ts (DDG keyless; SearXNG if configured) ·
│                       diagram.ts (validated PlantUML) · send-push.ts ·
│                       arduino-{db,components-data,explain,diagram,toolchain}.ts
│                       (toolchain.ts is the one place that knows arduino-cli and PWM pin maps)
├── tool-guard.ts       per-turn repeat/deny/poll policy: warn → BLOCK → say so in the system prompt
├── deferral.ts         "the fix is to locate X" is not an answer — one nudge, no LLM
├── edit-truth.ts       per-turn edit ledger: a REPORTED change with nothing written, and repeated
│                       misses on one file. Unconditional (QA is opt-in and declines here)
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
├── indulge/            per-repo RAG corpus (Phase 1 — store + discovery so far, no command yet):
│   ├── store.ts        ~/.ayin-cli/rag/<repo-key>/ — append-only JSONL flushed per record, atomic
│   │                   manifest/progress, run lock that adopts a dead holder, stable content ids.
│   │                   Everything that makes an overnight run survive a power cut lives here
│   ├── discover.ts     stage 1: model-picked seeds, every path verified against the filesystem,
│   │                   then a deterministic import/imported-by/mention walk to depth 3
│   ├── questions.ts    stage 2: one call per (file|entity, category); resume keyed on that triple,
│   │                   caps per target and file, `ask` injectable so the gate needs no GPU
│   ├── answer.ts       stage 3: explore-style investigation → answer + CITE lines, every citation
│   │                   verified against disk before the chunk is written; no proof, no chunk
│   ├── report.ts       the audit deliverable: one markdown grouping chunks by file and category,
│   │                   RE-verifying every citation as it writes and marking stale ones
│   └── index.ts        `ayin indulge` — argv, the stage pipeline, progress heartbeat, cooperative
│                       SIGINT, and the llm authority held as a background consumer
├── modes.ts            /verbose (brevity is the DEFAULT, this opts out) and /logcover, persisted
│                       in prompts.json and injected as prompt text
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
                        throwaway Unity-ish git repo in the temp dir: every branch of the hound's one
                        question — the four ways it must stay silent, the nudge it emits, the
                        rendered-page fallback — and the autostage allowlist. No model, no network.
                        Run it whenever you touch watch.ts or assets/ayin-hound.mjs.
```

## `--full`, and why a mistyped flag now fails (`src/full-mode.ts`)

`ayin --full` turns on the three switches an operator most often wants together — the boot debug
bundle (`--debug`), the QA session toggle (`AYIN_QA=1`) and the permission gate stepped around
(`--dangerously-skip-permissions`). Each is read by a DIFFERENT module at import time, so the flag has
to be resolvable from argv alone with no dependencies: otherwise `permissions.ts` would import a module
that imports it back. One definition, in one file, because three copies of `argv.includes('--full')`
are three places for the meaning to drift and the one that drifts is the permission gate.

**Session-scoped by construction.** Nothing is written to disk — the flag lives in the command line and
argv does not survive a restart. That property is the point for the permission gate: `permissions.ts`
argues that a gate which silently stayed off after a restart is one nobody remembers turning off, and
the first they learn of it is the thing it would have stopped. A flag typed per launch makes the
operator re-state the intent every time.

**It does not buy the push/pull/checkout guard.** That check runs above every permission rule and
returns `deny` under any skip flag rather than allowing, because those actions are unrecoverable and
public. Verified live: under `--full`, `git push origin main` and `git checkout main` are both denied
while `ls -la` is allowed. There is no flag that turns that off.

**A mistyped flag now exits 2.** Nothing validated argv, so `ayin --ful` launched an ordinary session
with none of the switches on and said nothing — indistinguishable from a working flag until the thing
it was supposed to enable failed to happen. The check is scoped to a BARE LAUNCH and returns
immediately when `argv[2]` names a subcommand: every subcommand parses its own arguments
(`indulge --domains`, `diff --no-open`, `watch --repo`), so a whitelist applied to those would reject
flags that are valid one frame down. Flags that consume the next argument skip it, so `-p "--looks-like-a-flag"`
is a prompt and not an error.

Gate: `npm run check:cli` — the three call sites are asserted STATICALLY (importing them builds a
blessed screen at module scope, which made a spawned probe flaky for reasons unrelated to the flag),
and the rejection is asserted by launching the real binary, where the exit code is the whole answer.

## What ayin deliberately does NOT have

Each of these is an absence on purpose, not a gap waiting to be filled. They are listed because the
absence is load-bearing: adding any of them back would break a property the agent depends on.

- **No service discovery.** `connection.ts` talks to exactly ONE configured endpoint (`AYIN_MODEL_URL` →
  `/set llm-url` → loopback). Nothing is looked up, so a misconfigured endpoint fails loudly instead
  of quietly probing alternatives and adding a timeout to every refresh — which is also why
  `tokens.ts` only ever asks that same host for `/api/estimate` and otherwise estimates chars/4.
- **No remote session sync.** Sessions are local files under `~/.ayin-cli/sessions/` and nothing else.
  `sendRequest()` remains only as a throwing stub, so a caller that reaches for remote sync fails
  visibly rather than appearing to succeed.
- **No model of its own, and no implicit model selection.** ayin brings no weights and does not choose
  what is loaded: it reads the active model from `GET /api/status`, picks a matching dialect, and asks
  for a different model only when a human does (`/model`).
- **No hardcoded package registry.** The *passive* startup update check is **opt-in** via
  `AYIN_UPDATE_REGISTRY`; unset (the default) → it never contacts any registry. The explicit
  **`ayin update`** command may additionally fall through to npm's own configured registry (see
  "Self-update" below), and refuses a registry it did not resolve deliberately.
- **No network sandbox.** `bash` can do whatever your shell can. Headless mode auto-approves writes
  and commands, so run it on a tree you can diff and revert.

## The live mirror — a run that explains itself from outside

`/debug` writes a bundle, and it can only run in an ayin that still answers. The one moment the bundle
is needed is the one moment it cannot be produced: a wedged session takes the keystroke, queues it
behind the turn that is stuck, and writes nothing. A bundle collected from a SECOND terminal holds a
session seconds old and nothing about the hang.

`ayin --debug` narrows that gap from the other side: the flag runs the same `/debug` at BOOT, once
`initSession` has answered, so the bundle path exists and is on screen before there is anything to
diagnose (`app.ts`, `runInteractive`). It is the same stable directory, so `/debug` later refreshes it
rather than creating a second one to quote. What it cannot do is describe a hang that has not happened
yet — the model is usually still `unknown` and the dialect provisional in a boot bundle, which the
manifest states rather than guesses at. Hence, still:

So `live-mirror.ts` writes the evidence continuously, before anyone asks for it, to a path something
else can read — `/private/tmp/ayin-debug/live` on macOS, `$TMPDIR/ayin-debug/live` elsewhere
(`AYIN_LIVE_DIR` overrides). Two files:

- `status.json` — pid, session, cwd, version, the log file's path, and **`phase` with `phaseForMs`**:
  what the agent says it is doing and how long it has been saying it. Plus `llm` (`issued` /
  `returned` / `failed`, with the URL and elapsed) and `tool` (the tool in flight). An `issued` LLM
  state with an old timestamp is a stalled request; an old `tool` is a connector waiting on an API.
  From outside, those two look identical — and both look like a spinner.
- `log.ndjson` — every log entry, arriving through the logger's sink API so nothing touches the hot
  path, truncated at 4 MB keeping the tail.

Written atomically: the status file lands via temp + `rename`, and concurrent updates are coalesced
behind one writer. Without that, two updates in the same tick produced a JSON file with a fragment of
the previous version welded to its tail — unparseable, from a file whose only job is to be read by
something else at a moment nobody controls. Its own smoke test caught it.

Providers report `llm` through the provider runtime seam (`providerLlmState`), never by importing core
— the same rule that keeps `llm/providers/` extractable, enforced by `check:gates`.

## How a prompt FIX reaches an install that already exists

The rule that a local prompt is the operator's, full stop, is right for WORDING and was wrong for
everything else. Under it, a shipped prompt BUG was permanent: `~/.ayin-cli/prompts/<ns>/<id>.txt`
outranks the repo forever, so a fix landed in git, shipped in the package, and never ran on a single
machine that had used the feature before. Measured: a protocol line whose format and explanation
shared a line made the model echo the explanation back inside its command and cost an extra model call
per run — fixed in the repo, still running unfixed on the machine that reported it.

Three states now, decided per id at boot (`registerShippedPrompts()`, every shipped namespace, not
lazily on first use — boot is when it is worth knowing):

| Local copy | What happens |
|---|---|
| byte-equal to what we last shipped (`.shipped.json` sidecar) | **refreshed** to the new shipped text — the operator never touched it, so there is nothing to protect |
| edited, and its `{{VARS}}` still match the shipped contract | **kept**. Theirs. |
| edited, and its `{{VARS}}` no longer match | **repaired**: the shipped text is installed and their copy is kept beside it as `<id>.txt.bak-<stamp>`. The service's own words for this state are "broken, not customised" — the code cannot feed the text what it now sends, so running it is strictly worse. Their version is never deleted; the edits may be worth re-applying. |

`.shipped.json` in each local namespace dir maps id → sha256 of the bytes shipped at the time it was
written. No record means "unknown", which falls through to the drift check rather than overwriting.

Every refresh and repair is ANNOUNCED in the session. A prompt replaced silently is the same class of
problem as one never replaced: text the operator cannot reason about.
