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
2. Build messages: **system prompt** (persona + tool list + the dialect's tool-call format) +
   **rolling summary** + the **last N messages** (small, stable context).
3. Call the LLM (via the manager).
4. **Parse** the response for tool calls (`parser.ts`). A response may contain several calls
   (coder models often chain read → edit → run); they execute in order, each result fed back.
5. For each call: dedupe/loop-guard → **permission check** → execute → feed the result back as
   a `<tool_response>` turn → continue.
6. Plain text (no tool calls) → display → done.

Headless mode adds guardrails for unattended runs: a **CTA tracker** (don't exit until the
asked-for deliverable exists), a lightweight **judge** (is there enough evidence to answer?),
an internal **critic** (sanity-check substantial `write_file` output against gathered facts),
loop/duplicate detection, and a self-audit on hitting the round cap.

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
configured): `web_search`, `docs_search`, `codex`, `jira`, `fixme`. See the README table.

- **`str_replace`** is the preferred edit tool — a single-unique-match find/replace that
  touches only the targeted block. `write_file` is for new files / deliberate full rewrites
  (regenerating a large file from memory risks dropping content).
- **`explore`** is a sub-investigation with its own short LLM loop and clean context — good
  for "find/read X" questions; it translates depth into width. It is **language-agnostic**
  (identifier extraction + whole-tree grep with vendor/build dirs excluded — no assumed file
  extensions) and self-limiting: it bails after 3 consecutive empty search rounds, and when
  the model keeps re-searching at low confidence despite having gathered real data, it
  returns that data verbatim instead of burning all iterations (callers can pass
  \`thorough: 'true'\` — used by \`ayin rag\` — to let broad questions investigate longer before
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
- **Guards**: commits touching only `CodeReview-*.md`/`AssetDiff-*.md` are skipped (no
  review-of-review loop);
  vanished commits (rebase/gc) are ledgered as `gone`; LLM/backend failures retry with
  linear backoff up to 5 attempts, then are ledgered as `failed`.

## RAG corpus generator (`rag.ts`)

`ayin rag --repo <path> --questions "q1" ["q2" …]` — per question: a **thorough explore**
investigation (+ one gap-fill explore for the biggest missing piece), then synthesis into a
detailed grounded markdown answer. A **fabrication guard** verifies every code fence in the
answer against the investigation data (whitespace-collapsed line matching, ≥50% per fence);
a failing draft is re-synthesized once, and still-fabricated blocks are stripped with a
visible warning in the doc + `groundingWarnings` in the meta. After the initial questions,
5 close-to-domain follow-ups are generated per initial question and answered the same way
(the generated list is persisted on the parent doc's meta BEFORE answering — resume-safe).
Docs are saved through the backend logs resource (`rag.save`, per-repo store on the backend
host); already-stored questions are skipped on re-run, so resume = re-run the same command.
The LLM is held as the `ayin` authority for the whole run.

## TUI (`src/ui/`)

The interface is a tree of decoupled widgets behind the `ui.ts` façade (the exported function
API — `addMessage`, `setAgentStatus`, `setStatus`, … — is unchanged, so nothing outside the
tree knows about the internals). Design rules:

- **One geometry authority.** Widgets never touch each other's `bottom`/`height`. The screen
  is a bottom-up stack (status bar → input → hints → chat gets the rest) managed by
  `layout.ts#relayout()`; a widget that changes height calls `relayout()` and everything
  restacks. Adding a new bottom-docked element = one entry in the stack registration.
- **One keypress router** (`keys.ts`) and **one theme** (`theme.ts`).
- **Copy-paste contract** (`screen.ts`): no widget may ever enable blessed mouse tracking
  (`mouse: true`, `enableMouse`, `clickable`) — it hijacks terminal-native text selection,
  which is what keeps chat text copy-pastable. Scrolling is PgUp/PgDn by design.
- **Live LLM phase in the status bar** (`llm-events.ts` + `widgets/status.ts`): the TUI
  subscribes to the backend llm resource's SSE stream (`GET {keliUrl}/resource/llm/events`,
  auto-reconnect with backoff) and reduces its events to one segment — `⇆ swapping <model>`
  (amber) → `◌ preprocessing` (indigo) → `▶ responding <model>` (green) →
  `◆ postprocessing` (violet); idle hides the segment, and a dead stream blanks it rather
  than showing a stale phase. The ayin-layer postprocess (tool-call parsing in `agent.ts`)
  reports through the same segment as `postprocessing ayin`.
- **Tool output cards** (`widgets/chat.ts#formatToolResultForChat`): `write_file` renders the
  diff card; every other tool gets a `│`-gutter preview block (6 lines for bash/grep, 4 for
  read_file, 2 default, 200-char line cap) with blessed tags **escaped via `{open}`/`{close}`**
  — raw `{`/`}` in bash/JSON output used to be parsed as markup and silently garbled.
- **ThinkingIndicator** (`widgets/thinking.ts`) is a small state machine: each `AgentState`
  (`thinking` · `tool` · `explaining` · `summarizing`) owns its frames, speed and color in
  `STATE_SPECS` — a new animation state is one entry there, no plumbing. The line renders as
  `▍ ⠹ label··  12s` (state-colored gutter, spinner, pulsing label, breathing ellipsis,
  elapsed). Drive it explicitly with `setAgentState(state, label)`; the legacy
  `setAgentStatus(text)` still works and infers the state from the text.

## Permissions (`permissions.ts`)

Read-only tools (`read_file`, `grep`, `find_files`, `explore`, `status`) are auto-allowed.
`write_file`, `str_replace`, and `bash` prompt for approval in interactive mode (allow once /
allow all / allow-all-with-prefix / deny). **Headless mode auto-approves** so unattended runs
can finish — see the warning in `SETUP.md`.

## Supporting modules

- **`summary.ts`** — a rolling session summary, updated each exchange via the LLM and injected
  into every call as compact context.
- **`prompts.ts`** — reads `~/.ayin-cli/prompts.json` on every access (live edits apply
  immediately). Holds `config` (windowSize, maxToolRounds, …), the `system` prompt, and the
  `summarizer` prompt. The tool-call format is supplied by the active dialect, not hardcoded.
- **`prompt-server.ts`** — optional local web UI for editing those prompts.
- **`artifacts.ts`** — every tool output is saved under `~/.ayin-cli/artifacts/` and browsable
  in the TUI (`Ctrl+O`); chat shows a 2-line preview.
- **`history.ts`** — persistent prompt history.
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
├── index.ts            entry; interactive vs headless (-p) vs `watch`/`rag`; overlays; input handling
├── watch.ts            repo watcher daemon: post-commit hook → queue → LLM code review
├── rag.ts              grounded Q&A corpus generator (explore → synthesize → logs resource store)
├── resource-client.ts  backend resource door (POST /resource/<name>) + shared llm-authority dance
├── agent.ts            the agent loop (build → call → parse → execute → loop)
├── llm/
│   ├── manager.ts      active-model resolution + dialect selection; all LLM calls route here
│   ├── types.ts        ModelDialect interface
│   └── dialects/       xml.ts (shared base) · gemma.ts · qwen.ts
├── connection.ts       transport: the keli-shaped endpoint + OpenAI fallback; KELI_URL resolver
├── parser.ts           lenient tool-call parser (multi-format)
├── tools.ts            tool registry + the system prompt assembler
├── tools/              explore.ts · docs-search.ts · status.ts · signals.ts
├── permissions.ts      approval dialogs + allow-lists
├── summary.ts          rolling session summary
├── prompts.ts          ~/.ayin-cli/prompts.json (read every access) + /set values
├── prompt-server.ts    optional web UI for prompts
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
│   ├── keys.ts         the one keypress router (global keys → input → chat scroll)
│   └── widgets/        chat.ts (ChatLog + diff cards) · thinking.ts (ThinkingIndicator —
│                       stateful animation) · input.ts (InputBar) · hints.ts (CmdHints +
│                       slash registry) · status.ts (StatusBar)
├── markdown.ts / dialog.ts / log.ts   render + overlay + logging helpers
├── image.ts            image downscale for vision turns
└── fixme.ts / jira.ts / codex.ts / tg-auth*.ts   optional integrations
```

## Decoupling from egregor (what was stripped)

The upstream `@egregor/ayin-cli` was wired into egregor's service mesh. The vendored,
standalone build removed all of it:

- **`connection.ts`** — no Sofer/Merkavah/Netzach. `connect()` just marks ready; the LLM call
  goes straight to the resolved HTTP endpoint; the remote-request path is a stub.
- **`tiferet-session.ts`** — a local per-run session id; no remote checkpoint sync.
- **`tokens.ts`** — no Netzach discovery; tries `${keliBaseUrl}/api/estimate`, else chars/4.
- **`updater.ts`** — no private registry. The update check is **opt-in** via
  `AYIN_UPDATE_REGISTRY`; unset (default) → it never contacts any registry.
- **`package.json`** — dropped the `@egregor/*` dependencies; renamed `@maradel/ayin`.

What's genuinely new vs. the upstream doc: the **LLM manager + dialects** (model-agnostic
core), **`str_replace`**, **`explore`**, and **`docs_search`**.
