# ayin — architecture

A terminal coding agent: a single agentic loop that turns a natural-language task into
read/search/edit/run tool calls against your filesystem, driven by an LLM you host. This
doc describes how the pieces fit. (Lineage note: ayin began as egregor's `@egregor/ayin-cli`
and was decoupled into a standalone agent — see the last section for what was stripped.)

## High-level shape

```
        you ──► ayin (TUI or headless -p)
                  │
                  │  LLM manager  ── picks the dialect for the active model
                  ▼
        LLM endpoint  (Ollama via adapter · a keli-shaped backend · OpenAI)
                  │
        agent loop ──► tools ──► your filesystem / shell
        (read_file, grep, find_files, write_file, str_replace, bash, explore, …)
```

Everything runs locally. There is **no service discovery, no remote orchestration** — ayin
needs only Node, a POSIX shell, and one HTTP LLM endpoint.

## LLM connection (`connection.ts`)

ayin speaks a deliberately tiny HTTP contract so almost anything can serve it:

```
POST /api/generate   { messages, temperature?, thinking?, images? }  ->  { content, reasoning? }
GET  /api/status     ->  { ok: true, model }
```

The endpoint is resolved by `keliBaseUrl()` in priority order: **`KELI_URL`** env → persisted
`keliUrl` in `~/.ayin-cli/prompts.json` (`/set keli-url …`) → `http://localhost:9100`. If the
endpoint is unreachable and an OpenAI key is configured (`/set openai-key`), ayin falls back to
the OpenAI chat API and adapts its native tool-calls into ayin's XML form. Transport details:
retries on transient errors, a long timeout (coder models can think for minutes), and image
attach for vision turns. See [`SETUP.md`](../SETUP.md) for the three ways to stand up an endpoint.

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

Three gates wrap the loop, each on a **deterministic trigger** — no model decides whether they run:

| Gate | Fires when | Module |
|---|---|---|
| **Plan mode** | the incoming prompt is ≥ `planMinChars` **and** one triage call says it is cross-feature | `plan/` |
| **Tool guard** | every tool call, always | `tool-guard.ts` |
| **QA gate** | the turn changed files **and** the final message reads like a completion report | `qa/` |

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

## Plan mode (`src/plan/`)

A 2000-character request is usually several features wearing one paragraph. Handed straight to the
round loop, the model starts on whichever sentence it read last, meets the coupling in round nine, and
spends the rest of its budget repairing its own first guess.

**Two doors, both deterministic.**

| Door | Condition | Triage's verdict |
|---|---|---|
| **Size** | `prompt.length ≥ planMinChars` (2000) | decides — "not cross-feature" means no plan |
| **Explicit** | `PLAN_TRIGGER` matches, or `/plan <text>` | **cannot veto** — you asked |

Length alone would drag every long bug report into planning; triage alone would cost an LLM call on
every turn. Together: one extra cheap call, only for genuinely big prompts. The explicit door exists
because "plan the auth rewrite" is nine words — size is a *proxy* for "this needs thought", and a proxy
must never overrule the person who can simply say so. Triage still runs on an explicit ask (it is the
cheapest way to decompose the work and to name the APIs the research step needs); only its veto is
ignored. The plan's header records which door was used, so a plan read back a week later says why it
exists. `AYIN_PLAN=0` opts out entirely; `planMinChars: 0` closes the size door only.

`PLAN_TRIGGER` is anchored to verb phrases (`plan it`, `make a plan`, `deep investigate`, `deep dive`,
`study the codebase thoroughly`, `think it through first`), never bare `\bplan\b`. This is the
tightest of the three triggers on purpose: plan mode is the most expensive gate in the system, and
`plan` is a far commoner English word than `diagram` or `schema` ever were — "what's the plan?", "the
plan was to ship Friday". A false fire is minutes of a starved GPU on a plan nobody wanted.

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
   (cited, omitted only when no API is involved) · **gaps** · files-to-change table · steps · **log
   coverage and debugging** · risks.
5. The plan is pre-prompted into the turn as a `<plan>` block, the same mechanism as auto-research and
   auto-diagram, with instructions not to re-plan or re-explore what it already establishes.

Two sections earn their place. **Dependencies** must state, for a new webview specifically, what serves
it, what builds it, *what interface it binds* and how it is reached from another machine — the survey
supplies those gaps, so "add a settings page" in a project with no HTTP server and no bundler is
identified as three tasks before anyone writes HTML. **Log coverage and debugging** names the project's
existing logger, env switch and introspection route by name, because a plan that ends at "implement the
feature" hands over a black box; if the survey found no facility, adding one becomes step 1.

The document is on disk **before** implementation starts, so a machine that dies mid-feature leaves the
thinking behind rather than only half the work.

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

## QA gate (`src/qa/`)

The agent's own last message is the least trustworthy thing it produces: written by the same model that
did the work, from the same context that made the mistakes, and rewarded for sounding complete.
"Done — I've implemented the panel and updated the docs" is a claim. This gate checks it before the
user has to.

**Trigger** (`qaShouldRun`, no LLM, one `git status` at most): files changed this turn **and** the final
message is big (≥ `qaMinAnswerChars`, default 400) or opens with a completion verb. Both halves matter —
without "files changed" it would fire on ordinary questions and burn GPU for nothing; without "looks
like a report" it would fire mid-conversation on a turn that never claimed to be done.

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
  documents today**), plus 3-6 intent criteria. Derived **once** per turn and reused, so the bar cannot
  move while the agent chases it.
- The **`api` bar** is the enforcement half of plan mode's research step. `probeThirdPartyApi` detects
  the integration from the code — external hosts, credential-shaped env vars, `Bearer`/OAuth/`/v1/`
  shapes, whether 429s are handled at all — and the criterion fails a change that shows no sign the
  current API was actually looked up. Recalled API knowledge is the failure that passes every review and
  breaks only against the live service.
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
an artifact of it. The port probe skips the port derived from `keliBaseUrl()`, so it can never poke the
model gateway.

**Config** (`prompts.json` → `config`): `qaMaxPasses`, `qaMinAnswerChars`, `pollMinIntervalMs`,
`pollMaxPerTurn`, `planMinChars`, `planExploreCalls`. **Prompts** (editable, same file): `qaCriteria`,
`qaReview`, `planTriage`, `planDocument`. **Env:** `AYIN_QA=0`, `AYIN_PLAN=0`, `AYIN_PLAN_DIR`,
`AYIN_QA_PORT`, `AYIN_QA_PORT_DENY`.

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
`str_replace`, `bash`, `explore`, `status`. **Optional integrations** (inert unless
configured): `diagram`, `web_search`, `codex`, `jira`, `fixme`. See the README table.

- **`str_replace`** is the preferred edit tool — a single-unique-match find/replace that
  touches only the targeted block. `write_file` is for new files / deliberate full rewrites
  (regenerating a large file from memory risks dropping content).
- **Auto-research grounding** (`agent.ts#runResearch`): near-deterministic — if the prompt contains
  `grounded`/`citing`/`citation`/`research`, ayin runs a `web_search` BEFORE the base LLM call and
  **pre-prompts the result into the turn** (a `<research-grounding>` block in the system context), so
  the answer is grounded + cited, **scientific methods first, then practical/household**, tailored to
  the user's stack. The search query is LLM-formulated from the prompt + the user's stack, read from
  the **`SYSTEM_INFO`** env var (a baked default describes the Unity/Flutter/Node-TS/Arduino + RTX-3090
  eGPU/laptops/Pi setup). Opt out with `AYIN_RESEARCH=0`.
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
- **`web_search`** (`tools/web-search.ts`) mirrors maradel's pipeline (`backend/src/tasks/webSearch.ts`),
  in-process and dependency-free: **SearXNG** (keyless self-hosted metasearch, JSON API) PRIMARY →
  **DuckDuckGo HTML** fallback → **DDG Instant Answer** last resort; rank + dedup → fetch top 4 pages →
  strip to readable text → merged markdown digest (the loop's model synthesizes). 15-min per-query
  cache. The SearXNG base is `MARADEL_SEARXNG_URL` / `AYIN_SEARXNG_URL` / `/set searxng-url`, else
  **derived from the KELI backend host on `:8888`** (the shared container next to the backend). If it's
  unreachable, DDG covers it. (Replaced the old shell-out to `malkhut search`, which isn't installed.)
- **`explore`** is a sub-investigation with its own short LLM loop and clean context — good
  for "find/read X" questions; it translates depth into width. It is **language-agnostic**
  (identifier extraction + whole-tree grep with vendor/build dirs excluded — no assumed file
  extensions) and self-limiting: it bails after 3 consecutive empty search rounds, and when
  the model keeps re-searching at low confidence despite having gathered real data, it
  returns that data verbatim instead of burning all iterations (callers can pass
  \`thorough: 'true'\` to let broad questions investigate longer before
  that guard may fire). Vendor/build/backup dirs (\`node_modules\`, \`dist*\`, \`*.bak*\`, …) are
  excluded from its greps and from the guidance given to the model.

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
  resource as the `ayin` authority (`POST {keliUrl}/resource/llm`) — the backend swaps to the
  coder model on `ownership.gained` and reverts when the batch drains (detach; also released
  on SIGINT/SIGTERM so a kill mid-batch doesn't strand the grant until TTL). Resource busy →
  the batch is **deferred** to a later poll, never run by side-door. No resource layer on the
  backend → best-effort on the served model.
- **Review**: commit metadata + capped diff (120 KB, truncated at a hunk boundary) → one
  `llmChat` call scoring the diff against the `SMELL_SIGNALS` catalog (~20 typical smells);
  each finding carries a **confidence 0.30–1.0**. Output: `CodeReview-<shortHash>.md` in the
  repo root — metadata table, changed files, findings, verdict.
- **Unity repos** (`Assets/` + `ProjectSettings/`): each commit also gets `AssetDiff-<shortHash>.md` —
  the deterministic `unity_asset_diff` (`commit^ → commit`, `--md`) object-level change map — as a
  second file next to the review; the review links to it and the reviewer receives its content.
  Tool at `~/tools/unity_asset_diff.py` or `AYIN_UNITY_DIFF`; missing tool → one-line note.
- **Agent-file pointer**: after a report is written, a fenced `<!-- ayin:reports:begin -->` block
  in the repo-root **`CLAUDE.md` *and* `GEMINI.md`** lists the pending reports (newest 12), so the
  next Claude Code / Gemini CLI session reads them. Managed region only — the rest of each file is
  untouched; a missing file is created.
- **Repo hygiene** (installed with the hooks, re-asserted by the same 5-min self-heal): a fenced
  `# >>> ayin:local-cruft >>>` block in the repo's **`.gitignore`** listing local dev cruft that must
  never be committed (ayin's own reports, `system_specs.*`, `STUDY_PERF-*/`, `.claude/hooks/`, the
  local-only `Assets/LiveOpsHub` + `Assets/Plugins/AltTester` tooling folders), plus the same list —
  as an instruction — in an `<!-- ayin:hygiene:begin -->` block in `CLAUDE.md` and `GEMINI.md`, so an
  agent working the repo doesn't stage them either. Writes only when the bytes change (the self-heal
  is otherwise a no-op), so it never churns mtimes. `AYIN_WATCH_HYGIENE=0` disables it.
  *Note:* `.gitignore` only affects **untracked** files — cruft already tracked in a repo still needs
  a manual `git rm --cached`.
- **Guards**: commits touching only `CodeReview-*.md`/`AssetDiff-*.md` are skipped (no
  review-of-review loop); the agent files and `.gitignore` are excluded from the working-tree
  fingerprint, the review diff, and auto-staging — so ayin writing its own blocks never re-triggers
  a pass and never commits its own bookkeeping;
  vanished commits (rebase/gc) are ledgered as `gone`; LLM/backend failures retry with
  linear backoff up to 5 attempts, then are ledgered as `failed`.

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
  subscribes to the backend llm resource's SSE stream (`GET {keliUrl}/resource/llm/events`,
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
    │ Improve maradel status LLM window │
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
  git repo, the path shows the current branch — `…/maradel (main)`. Read straight from
  `.git/HEAD` (handles a `.git` *file* for submodules/worktrees; detached HEAD → short sha) and
  cached 2s so the per-tick status redraw doesn't hammer the fs.

- **`/lock` / `/unlock`** (`model-picker.ts#lockSession`) — hold this session's model until the
  client exits or stops responding. The enforcement IS the grant TTL, which is why it needs no
  server-side session tracking: the hold is taken with a **10-minute** ttl and refreshed every
  **2 minutes** while ayin is alive. Quit cleanly (or `/unlock`) → released at once; die, hang or lose
  the network → the grant lapses within 10 minutes and the backend reverts on its own. Nothing can be
  left locked by a process that no longer exists. Shown as **🔒** beside the model in the status bar.
  Because gaining the `ayin` authority applies the coder-model policy, the lock immediately re-pins
  whatever was ALREADY serving — locking must not change your model. That re-pin lands in the same
  second and `swapChatModel` coalesces onto the already-resident target, so no real load occurs (the
  bar can flash `🔒⇆ a→b` for one poll tick; verified against the daemon log that no `model.load.*`
  follows). Verified: 9 assertions — holder recorded, ~10m TTL not 30, model preserved, keepalive
  slides the expiry, unlock frees it.
  **A lock also buys QUEUE PRIORITY.** ayin's `/api/generate` calls are LOW priority by design, so a
  locked session would still sit behind every habit. While locked, ayin sends its authority token
  plus `priority:"high"`; the backend grants HIGH only when that token matches the current holder, so
  priority is proven, never self-declared, and it drops back to LOW the instant the lock ends.
  Measured with the GPU busy: an unlocked request sent FIRST finished in 237.5s, a locked one sent
  1.2s LATER finished in 62.0s.
  **Interactive sessions AUTO-LOCK on boot** (`AYIN_AUTOLOCK=0` opts out). A human at a keyboard
  should not have to know a command to avoid starving: without it a session sits in LOW behind every
  habit, which produced `GPU: chatOnce 306s · 1 waiting` and then a client abort at 10m surfaced as
  `fetch failed`. Auto-lock also pins the model, stopping the gemma↔qwen flapping another consumer's
  ownership change causes mid-session. Headless runs do NOT auto-lock — unattended work yields.
  **The lock survives the backend losing it.** The authority stack is in-memory, so a daemon restart
  erases every grant: the next keepalive returns a NEW grant rather than a refresh, which silently
  broke two things — the token being sent for priority was dead (session quietly back in the LOW
  band) and the backend re-applied its coder-model policy over the pinned model. `acquireLlm`'s
  `onRegrant` now rotates the token, the lock re-pins the model it was taken on and says so in the
  transcript. `release()` recovers from a rotated token too: if the detach frees nothing and `ayin`
  still holds the resource, it re-acquires to learn the live token and hands THAT back, instead of
  leaking the grant until its TTL.
- **Per-model context windows.** Every picker row is labelled with the window that model will
  ACTUALLY get (`27.8B · Q4_K_M · 16.2G · 24k ctx`), because one global `numCtx` is wrong on a 24 GB
  card: KV cost per token is architectural, not a function of size. Measured here — `gemma4:26b`
  (16.8G, 31 layers) fits 64k; `qwen3.6:27b` (16.2G, 64 layers) spills 14 layers to the CPU at 64k
  and fits at 24k. A MoE is not automatically safe either: its weights are all resident (30b-a3b is
  17.3G, the same class as dense), only its FLOPs per token are lower. The backend owns the presets
  (`config.ollama.modelCtx`, `MARADEL_CTX_<MODEL>` override) and reports the resolved value per model.
- **Model picker + booking** (`/model` → `model-picker.ts`, catalog in `llm-status.ts`): the
  interactive counterpart to headless `AYIN_ACQUIRE_LLM=1`. Bare `/model` opens the **popup** —
  the same overlay the tool-permission prompt uses (`dialog.ts`) — listing every chat model the
  backend has installed, polled live from the llm resource, each row annotated
  (`27.8B · Q4_K_M · 17.3G · shared/coder · ● active`) with the active one pre-selected;
  **Enter initiates the reload**, Esc changes nothing. `/model <name|qwen|gemma>` skips the popup
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
  are dropped so the bar still fits. **Tech debt** — see `docs/TechDebt.md`.

## `/fix` — ayin fixing itself (`fix.ts`)

`/fix <what should change about ayin>` writes a **fix request into ayin's own codebase**
(`fixes/fix-<id>.md`) and runs **headless Claude Code** (`claude --dangerously-skip-permissions -p`)
over it in the source checkout. The agent either implements the change — typecheck, build, docs,
patch-version bump, commit, `npm publish`, push if fast-forward — or writes
`fixes/rejection-<id>.md` explaining what it would need, and stops. Its brief says plainly that a
clean refusal is a good outcome and a wrong guess published to every machine is not, and that a
part-done change must be reverted before rejecting: **never leave the build broken**.

- **Survive the power cut.** The queue is a file (`~/.ayin-cli/fixes/state.json`, written
  atomically via write-then-rename), and the agent is spawned **detached** inside a bash wrapper
  that logs to `~/.ayin-cli/fixes/<id>.log`, writes an **exit marker** and clears the lock however
  it ends. Killing ayin, the terminal or the machine does not kill a fix in flight and does not
  lose a queued one. At every boot the supervisor reconciles: exit marker → finalize
  (`done`/`rejected`/`failed`); no marker and the pid is gone → **requeued automatically**. No
  human in the loop. *Verified by killing a run mid-flight with a stub agent: requeued, then
  completed on the next pass.*
- **One at a time.** Every fix mutates the same working tree, so a lockfile serializes them and
  extras queue in order; a lock older than 2h is treated as crashed so a dead run can't block the
  queue forever.
- **Ids** are `YYYYMMDD-HHMMSS` with a `-2`/`-3` suffix on collision — seconds alone are not unique,
  and two requests sharing an id would overwrite one another's file and inherit each other's
  rejection.
- **Command surface.** `/fix <prompt>` request · `/fix` the board (running, queued, rejections with
  their first reason line, else recent history) · `/fix show <id>` read a rejection · `/fix clear`
  acknowledge them (moves to `fixes/archive/`).
- **Status bar.** `⚒ fixing` (amber, blinking) while an agent works, `· fix queued +N` when waiting,
  and a bold red **`FIX REJECTED`** that stays until acknowledged — a refusal is silent otherwise
  and would just look like nothing happened. Rejections are counted from the repo, so one committed
  on another machine and pulled in still shows.
- Needs a **source checkout** (`AYIN_REPO`, else the module's own repo, else `~/maradel/ayin`,
  `~/ayin`) and the claude binary (`AYIN_CLAUDE_BIN`, default `~/.local/bin/claude`); an ayin
  installed from the registry has neither and says so rather than failing obscurely.

## Update indicator (`updater.ts`)

The status bar carries `↑ vX available — ayin update` whenever the registry's `latest` is newer
than the running build: checked at boot, every 10 minutes, and immediately after a `/fix` finishes
(which may have just published one). The registry is `AYIN_UPDATE_REGISTRY`, else npm's own
configured registry **only when that is a private one** — a checkout pointed at public npmjs gets
no passive check, since `ayin` is a plausible public name and that would both phone home uninvited
and risk advertising a stranger's package as your update. `AYIN_UPDATE_CHECK=0` disables it.

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
- **Sessions + `/resume`** (`tiferet-session.ts` reads, `session-record.ts` writes). Every run appends
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
  a `sudo ayin update` hint when the global prefix isn't writable (it is `/usr` on the nuk), and
  warns when the running ayin is a **source checkout**, where a global install changes nothing and
  the real update is `git pull && npm run build`. `ayin version` prints the running version.
  Subcommands that print to stdout (`update`, `version`, `watch`) are listed in
  `ui/headless.ts#NO_TUI_COMMANDS` so blessed never grabs the terminal out from under them.
- **`tokens.ts`** — context-meter estimate: tries `${keliBaseUrl}/api/estimate`, falls back to
  a chars/4 heuristic.
- **`tiferet-session.ts`** — in the standalone build this is a **local stub**: a per-run
  session id, no remote checkpoint sync (`/resume` finds nothing). Kept so the call sites don't
  need conditionals.
- **`ui.ts` / `markdown.ts` / `dialog.ts` / `log.ts`** — blessed TUI, markdown→tags, overlays,
  file logger.

## File structure

```
src/
├── index.ts            entry; interactive vs headless (-p) vs `watch`; overlays; input handling
├── watch.ts            repo watcher daemon: post-commit → CodeReview, post-merge → AYIN-REPORT-MERGE
│                       (what a pull brought in); 10-min working-tree pass → autostage meaningful /
│                       unstage junk (NO commit) + .git/COMMIT_EDITMSG + AYIN-REPORT-SMELLS; upserts a
│                       CLAUDE.md + GEMINI.md report pointer and the .gitignore local-cruft block;
│                       chains onto foreign hooks; 5-min hook + hygiene self-heal
├── resource-client.ts  backend resource door (POST /resource/<name>) + shared llm-authority dance
├── agent.ts            the agent loop (build → call → parse → execute → loop)
├── llm/
│   ├── manager.ts      active-model resolution + dialect selection; all LLM calls route here
│   ├── types.ts        ModelDialect interface
│   └── dialects/       xml.ts (shared base) · gemma.ts · qwen.ts
├── connection.ts       transport: the keli-shaped endpoint + OpenAI fallback; KELI_URL resolver
├── parser.ts           lenient tool-call parser (multi-format)
├── shell.ts            cross-platform shell: /bin/bash (POSIX) · Git Bash/cmd (Windows) + killTree
├── tools.ts            tool registry (a static array — every tool ships inside this repo)
│                       + the system prompt assembler
├── tools/              explore.ts · status.ts · signals.ts · web-search.ts (SearXNG→DDG) ·
│                       diagram.ts (validated PlantUML) · send-push.ts
├── tool-guard.ts       per-turn repeat/deny/poll policy: warn → BLOCK → say so in the system prompt
├── activity.ts         the current named phase (PLAN / QA n/m) → thinking line + status-bar chip;
│                       read by wait-narrator so a gate is never repainted as plain "thinking"
├── plan/               plan mode for big cross-feature prompts:
│   ├── survey.ts       deterministic project survey (what it is, can serve, how it's observed)
│   └── index.ts        size trigger + triage → survey → explore → ayin-plan-<ts>.md → pre-prompt
├── qa/                 post-completion QA gate:
│   ├── probes.ts       deterministic evidence: LAN reachability, README staleness, md richness, SRP
│   ├── criteria.ts     acceptance criteria from the user's own prompts, before artifacts are seen
│   ├── review.ts       one judged pass → {verdict, summary, issues[]}
│   └── index.ts        the trigger, the turn state, the ≤3-pass fix loop, the verdict card
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
├── tiferet-session.ts  local session stub (no remote sync)
├── ui.ts               compatibility façade → src/ui/ (all './ui.js' imports keep working)
├── ui/                 the TUI, decoupled:
│   ├── headless.ts     HEADLESS/THINKING_MODE detection + noop element factories
│   ├── theme.ts        every color + glyph in one place (widgets never hardcode)
│   ├── screen.ts       the one blessed screen — copy-paste contract: NO mouse tracking, ever
│   ├── layout.ts       bottom-up widget stack (status→input→hints→chat); the only geometry authority
│   ├── ticker.ts       the one animation heartbeat (80ms; runs only while something animates)
│   ├── keys.ts         the one keypress router (global keys → input → chat scroll)
│   └── widgets/        chat.ts (ChatLog + diff cards) · thinking.ts (ThinkingIndicator —
│                       stateful animation) · input.ts (InputBar) · hints.ts (CmdHints +
│                       slash registry) · status.ts (StatusBar)
├── markdown.ts / dialog.ts / log.ts   render + overlay + logging helpers
├── image.ts            image downscale for vision turns
└── fixme.ts / jira.ts / codex.ts / tg-auth*.ts   optional integrations

tool/
├── check-glyphs.mjs    `prebuild` — blessed lies about emoji width; this fails the build on it
└── check-gates.mjs     `npm run check:gates` — the deterministic halves of the three gates, against
                        dist. Binds real sockets (that is the point: it caught a pooled-keep-alive
                        socket making a live server look dead), so it is NOT in prebuild. Run it
                        whenever you touch qa/, plan/ or tool-guard.ts.
```

## Decoupling from egregor (what was stripped)

The upstream `@egregor/ayin-cli` was wired into egregor's service mesh. The vendored,
standalone build removed all of it:

- **`connection.ts`** — no Sofer/Merkavah/Netzach. `connect()` just marks ready; the LLM call
  goes straight to the resolved HTTP endpoint; the remote-request path is a stub.
- **`tiferet-session.ts`** — a local per-run session id; no remote checkpoint sync.
- **`tokens.ts`** — no Netzach discovery; tries `${keliBaseUrl}/api/estimate`, else chars/4.
- **`updater.ts`** — no hardcoded registry. The *passive* startup check is **opt-in** via
  `AYIN_UPDATE_REGISTRY`; unset (default) → it never contacts any registry. The explicit
  **`ayin update`** command may additionally fall through to npm's own configured registry
  (see "Self-update" below).
- **`package.json`** — dropped the `@egregor/*` dependencies; package name is `ayin` (neutral
  standalone; was `@maradel/ayin`). See `docs/TODO.md` for the path to a fully clean standalone.

What's genuinely new vs. the upstream doc: the **LLM manager + dialects** (model-agnostic
core), **`str_replace`**, and **`explore`**.
