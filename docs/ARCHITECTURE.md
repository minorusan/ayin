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
- **Auto-research grounding** (`agent.ts#runResearch`): near-deterministic — if the prompt contains
  `grounded`/`citing`/`citation`/`research`, ayin runs a `web_search` BEFORE the base LLM call and
  **pre-prompts the result into the turn** (a `<research-grounding>` block in the system context), so
  the answer is grounded + cited, **scientific methods first, then practical/household**, tailored to
  the user's stack. The search query is LLM-formulated from the prompt + the user's stack, read from
  the **`SYSTEM_INFO`** env var (a baked default describes the Unity/Flutter/Node-TS/Arduino + RTX-3090
  eGPU/laptops/Pi setup). Opt out with `AYIN_RESEARCH=0`.
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
- **`prompts.ts`** — reads `~/.ayin-cli/prompts.json` on every access (live edits apply
  immediately). Holds `config` (windowSize, maxToolRounds, …), the `system` prompt, and the
  `summarizer` prompt. The tool-call format is supplied by the active dialect, not hardcoded.
- **`prompt-server.ts`** — optional local web UI for editing those prompts.
- **`artifacts.ts`** — every tool output is saved under `~/.ayin-cli/artifacts/` and browsable
  in the TUI (`Ctrl+O`); chat shows a 2-line preview.
- **`history.ts`** — persistent prompt history.
- **`updater.ts` — self-update (`ayin update`)**. Registry resolution is explicit and never
  guessed: `--registry <url>` → `AYIN_UPDATE_REGISTRY` → npm's own configured registry. It compares
  the running version against the registry's `latest` (or `--tag`), then shells out to
  `npm install -g` — deliberately not clever, so an interrupted download leaves the working binary
  untouched (`--check` reports only, `--force` reinstalls the same version). It refuses early with
  a `sudo ayin update` hint when the global prefix isn't writable (it is `/usr` on the nuk), and
  warns when the running ayin is a **source checkout**, where a global install changes nothing and
  the real update is `git pull && npm run build`. `ayin version` prints the running version.
  Subcommands that print to stdout (`update`, `version`, `watch`, `rag`, `rag-mine`) are listed in
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
├── index.ts            entry; interactive vs headless (-p) vs `watch`/`rag`; overlays; input handling
├── watch.ts            repo watcher daemon: post-commit → CodeReview, post-merge → AYIN-REPORT-MERGE
│                       (what a pull brought in); 10-min working-tree pass → autostage meaningful /
│                       unstage junk (NO commit) + .git/COMMIT_EDITMSG + AYIN-REPORT-SMELLS; upserts a
│                       CLAUDE.md + GEMINI.md report pointer and the .gitignore local-cruft block;
│                       chains onto foreign hooks; 5-min hook + hygiene self-heal
├── rag.ts              grounded Q&A corpus generator (explore → synthesize → logs resource store)
├── resource-client.ts  backend resource door (POST /resource/<name>) + shared llm-authority dance
├── agent.ts            the agent loop (build → call → parse → execute → loop)
├── llm/
│   ├── manager.ts      active-model resolution + dialect selection; all LLM calls route here
│   ├── types.ts        ModelDialect interface
│   └── dialects/       xml.ts (shared base) · gemma.ts · qwen.ts
├── connection.ts       transport: the keli-shaped endpoint + OpenAI fallback; KELI_URL resolver
├── parser.ts           lenient tool-call parser (multi-format)
├── shell.ts            cross-platform shell: /bin/bash (POSIX) · Git Bash/cmd (Windows) + killTree
├── tools.ts            tool registry + the system prompt assembler
├── tools/              explore.ts · docs-search.ts · status.ts · signals.ts · web-search.ts (SearXNG→DDG)
├── permissions.ts      approval dialogs + allow-lists
├── summary.ts          rolling session summary
├── goal.ts             auto-determined session goal (anti-wander anchor; LLM-distilled, cursive)
├── git.ts              current-branch lookup for the status bar (reads .git/HEAD, 2s cache)
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
│   ├── ticker.ts       the one animation heartbeat (80ms; runs only while something animates)
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
- **`updater.ts`** — no hardcoded registry. The *passive* startup check is **opt-in** via
  `AYIN_UPDATE_REGISTRY`; unset (default) → it never contacts any registry. The explicit
  **`ayin update`** command may additionally fall through to npm's own configured registry
  (see "Self-update" below).
- **`package.json`** — dropped the `@egregor/*` dependencies; package name is `ayin` (neutral
  standalone; was `@maradel/ayin`). See `docs/TODO.md` for the path to a fully clean standalone.

What's genuinely new vs. the upstream doc: the **LLM manager + dialects** (model-agnostic
core), **`str_replace`**, **`explore`**, and **`docs_search`**.
