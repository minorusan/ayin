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

### Installing from a registry

If ayin is published to an npm registry (a private one is fine — that is how it's distributed on
the author's LAN), you can skip the checkout entirely:

```bash
npm i -g ayin --registry http://<registry-host>:4873
ayin                      # TUI
ayin version              # what you're running
ayin update               # fetch + install the newest build
ayin update --check       # report only, install nothing
```

`ayin update` resolves the registry from `--registry` → `AYIN_UPDATE_REGISTRY` →
`/set update-registry <url>` (persisted per machine) → npm's own configured registry, and shells out
to `npm i -g` so a half-finished download can never replace a working binary. If the global prefix
isn't writable it tells you to re-run with `sudo`. Running from a source checkout, it says so —
there, updating is `git pull && npm run build`. If a **`watch` daemon is running**, a successful
update restarts it for you (SIGTERM, wait for exit, relaunch `ayin watch`), so it doesn't keep
reviewing commits on the old build until someone notices.

> **`ayin` is a taken name on public npm, and that package is not this one.** `ayin update` therefore
> **refuses** to fall back to registry.npmjs.org: a machine whose npm defaulted to the public
> registry resolved `latest` to a stranger's `0.0.2`, and only the "local build is ahead" check
> stopped it — `--force` would have installed someone else's code over the agent. Point it at your
> own registry once with `/set update-registry http://<host>:4873`. Passing
> `--registry https://registry.npmjs.org/` explicitly is still honoured, with a warning.

The status bar carries `↑ vX available` when the registry has a newer build (checked at boot and
every 10 min). It only ever asks a **private** registry — `AYIN_UPDATE_REGISTRY`, or npm's own
configured registry when that isn't public npmjs — so a fresh checkout never phones home uninvited
and can't be told a stranger's `ayin` package is your update. `AYIN_UPDATE_CHECK=0` turns it off.

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
| `diagram` | **PlantUML diagram, validated in a loop** until it really parses | needs `plantuml` to verify + render |
| `status` | Check progress of backgrounded tools | — |
| `arduino_db` | Look up a common Arduino/electronics component (identify, what it does, wiring) | auto-approved, no network — keyword search over a shipped catalog |
| `web_search` | Web search | optional — needs a search backend (see SETUP) |
| `jira` | Structured Jira ops (current sprint, a ticket, epics, free-text search) via the Maradel backend | optional — a consumer, not a caller: needs the backend's `jira` resource configured (`maradel-jiraauth`), ayin holds no Jira credential itself |
| `send_push` | Push a notification to a phone | optional — needs a backend that forwards it |

The **core nine** (`read_file`, `grep`, `find_files`, `write_file`, `str_replace`, `bash`,
`explore`, `status`, `arduino_db`) need nothing but Node + a POSIX shell. The rest are optional
integrations you can ignore.

**`jira` is a consumer, not a caller** — ayin holds no Jira credential and never talks to the Jira REST
API itself. It calls the Maradel backend's `jira` resource (`POST {backend}/resource/jira {op, params}`,
the exact shape `/api/generate`'s own resource provider already uses for the `llm` resource) with one of
five structured ops — `currentSprint` / `ticket` / `comments` / `epics` / `search` — never a hand-written
JQL string. `search` takes free text and runs an agentic loop **on the backend** to build and validate the
query; everything else is pre-filtered, structured JSON. Set up or refresh the actual credential with
`maradel-jiraauth <token> [baseUrl] [email]` on the machine running the backend (validates against the
live API before writing, same discipline this project applies everywhere credentials are set).

Each tool's prompts (where it has any) ship as `.txt` files in its own namespace under
`prompts/`, so you can retune a tool's behaviour without touching its code — see
[Prompts](#prompts) below.

Every tool lives **inside this repo** — a static array in `src/tools.ts`, resolved by unique name, with
no plugin directory and no runtime discovery. Adding one means adding a `Tool` there and shipping a
build; the upside is that a release cannot half-work because a plugin was missing.

**Repeats are policed** (`tool-guard.ts`). A second identical call in one turn is skipped with the
result you already have; a third is **blocked for the rest of the turn** and named in the system prompt
so it can't scroll out of view; a call you *denied* is dead immediately. Polling is the one legitimate
repeat, so `status` keeps working — rate-limited, with an explicit "don't poll again for Ns", capped at
6 per turn. A blocked `bash` call is told its way out: `sleep 5; <command>` is a different call and runs.

## Plan mode — big requests get a plan first

**Put `/plan` anywhere in the prompt and it plans, at any size** — `/plan add OAuth login`, or
`/plan <text>` as its own slash command. Literal and unambiguous on purpose: an earlier version matched
natural-language phrases ("plan it", "deep investigate the codebase") and was retired, because plan mode
is the most expensive gate in the system and a fuzzy phrase match on it misfires unpredictably outside
one specific conversation. An explicit `/plan` cannot be vetoed by triage; you asked, so it plans.

Otherwise a prompt of 2000+ characters is triaged in one cheap call: is this actually cross-feature? If it is,
ayin surveys the project, explores the relevant code, and writes **`ayin-plan-<timestamp>.md`** —
reasoning, existing context, dependencies, **third-party API research**, **gaps** (each with how to
resolve it, never a guess), a files-to-change table, ordered steps, **log coverage and debugging**, and
risks.

**If the work touches somebody else's API, looking it up is mandatory.** The same triage call names the
services involved, and each is researched on the web *before the plan is written* — current base URL,
auth scheme, endpoints, rate limits, deprecations, with sources cited. This is the one thing a model must
never answer from memory: auth schemes get replaced and fields renamed after training, so recalled API
code looks perfectly reasonable, passes review, and fails only against the live service. If a lookup
fails, the plan marks those details **UNVERIFIED** and makes reading the vendor's docs step one. The QA
gate then enforces the other half: a change that talks to an external API and shows no sign the current
API was checked is failed. Only then does your
prompt reach the model, with the plan already in context.

The plan is on disk *before* implementation starts, so an interrupted machine leaves the thinking
behind rather than half a feature. `AYIN_PLAN=0` opts out; `planMinChars` / `planExploreCalls` tune it.

## QA gate — the completion report gets checked

When a turn changed files **and** ayin's closing message reads like "done, I've implemented X" — or
says the literal phrase **"Ready for QA"**, which ayin is told to include so a short, honest "Fixed."
doesn't slip past the gate just for being terse — that claim is reviewed before you have to trust it:

1. **Intent** is read from *your own prompts* this session (off the session record on disk), not from
   the agent's summary of them.
2. **Acceptance criteria** are written *before* the changed files are looked at — a reviewer shown the
   answer first invents criteria the answer passes. Standing bars apply by file kind: UI is never left
   looking like an MVP; a webview is actually reachable from another machine; one responsibility per
   module; a README exists and still matches; markdown uses the format's range; **an Arduino sketch is
   named the way the toolchain requires — `Blinker/Blinker.ino`, never flagged as odd for matching its
   own folder, since that match is what makes it build at all** — and wiring is shown with the diagram
   below, not narrated in prose.
3. **Probes** measure what reading can't: a real HTTP GET on loopback *and* on the LAN address, so
   "running but loopback-only" is caught — the failure that looks perfect on the machine that built it
   and is invisible from your phone. Plus README staleness, markdown richness, structural SRP signals.
4. **Verdict** — long investigation, short answer. Pass: one line. Fail: each issue names the file and
   the fix, ayin repairs them and is reviewed again, up to 3 passes, then reports honestly what it could
   not fix.

`AYIN_QA=0` opts out; `qaMaxPasses` / `qaMinAnswerChars` tune it. The reviewer's prompts (`qaCriteria`,
`qaReview`) live in `prompts.json` like every other prompt, so you can rewrite the bar yourself.

### Presenter pass — how the reply is shown, decided before QA checks whether it's right

Same trigger as the QA gate above, one step earlier: a single quick call asks whether this reply
**is** the thing you need to read verbatim (a warning, a rejection, an error, a question back to you —
shown exactly as written, never rewritten) or **reports on completed work** — in which case ayin builds
a short, consistent answer instead of whatever shape the model's prose happened to take this time:

```
> add a hello endpoint to the server

Added a GET /hello endpoint and documented it.

Changed:
- server.ts — added the GET /hello handler
- README.md — documented the new endpoint
```

QA then reviews *that* text — a denser, more complete "what changed" statement than the model's own
closing line, and strictly better evidence for the reviewer to check claims against. For now (while this
is new) the raw reply still prints too, right below, in de-emphasized cursive, so you can compare the
two; that aside goes away once Presenter is trusted. `AYIN_PRESENTER=0` disables it outright — TUI-only,
headless output is unaffected.

### You can always see when a gate is running

Both gates spend GPU time on work you didn't directly ask for, so neither is allowed to hide behind a
generic spinner. While one is active the thinking line names it and keeps the queue detail that tells
you *why* it's slow:

```
▍ ⠹ PLAN · researching the Stripe API (current docs, not recall) · ⏳ queued #2/3      1m12s
▍ ⠹ QA 1/3 · reviewing 4 artifacts against 7 criteria · ▸ generating on qwen3.6:27b     41s
```

and the status bar carries a `▣ PLAN` / `▣ QA 1/3` chip that stays lit through the parts with no model
call at all — probing ports, snapshotting git, writing the plan file. The transcript records the
decisions too: which features triage found, where the plan was written, and a verdict card for every QA
pass. Ctrl+C during a gate stops it like anything else.

### Diagrams — "I don't understand, explain better"

Say that, or anything like it, and ayin draws the picture *before* it answers:

```
❯ I don't understand how the fix queue works — explain better
Diagram: /home/you/project/i-don-t-understand-how-the-fix-queue-works.puml
◉ …walks you through the diagram it just wrote…
```

Two ways in. The `diagram` tool the model can call, and a **deterministic trigger** — the phrases
above (`diagram`, `visualise`, `puml`, `flowchart`, `explain better`, `don't understand`, `unclear`,
`confused`, `draw`…) run the diagram pass *before* the base call and pre-prompt its result, so the
answer is written around a picture that already exists. `AYIN_DIAGRAM=0` opts out.

It's a **loop, not a one-shot**, because models get PlantUML syntax wrong often enough that a
single-shot tool would mostly write broken files. Each round is validated by the real renderer
(`plantuml -syntax`, which reports `ERROR / <line> / <message>`), and the error is fed back verbatim
for repair — up to 4 rounds. So a returned diagram always parses; a failing one is saved as
`*.invalid.puml` with the error, rather than reported as success.

Output lands next to your work (`<subject-slug>.puml` + a rendered `.svg`), and is opened in VS Code
when the `code` CLI is on PATH — otherwise it's simply left in place and referenced by path.

- **Ask about wiring or a circuit and it renders as ASCII text, pasted straight into the reply,
  instead of an SVG.** There is no maintained library for this — `circuit-diagram` on npm is 10+ years
  stale, the well-known ASCII-circuit tools are Python desktop GUIs, and the Arduino "ASCII art" repos
  out there are static pre-drawn pinout images, not generators. `plantuml -ttxt` already does the job:
  ```
  ,---------------.  ,-------------.  ,---.  ,---.
  |Arduino Uno D13|  |220Ω Resistor|  |LED|  |GND|
  `-------+-------'  `------+------'  `-+-'  `-+-'
          |    D13 Signal   |            |       |
          |----------------->            |       |
          |                 |    Anode   |       |
          |                 |------------>       |
          |                 |            | Cathode
          |                 |            |------->
  ```
  and the QA gate enforces it: a change touching pins that only *narrates* the wiring, with no
  rendered diagram in the reply, is a failure it will send back for a fix.
- **Nothing leaves your machine.** PlantUML's public server would render in one HTTP call, but a
  diagram of your architecture is exactly what not to POST to a third party. Rendering is local;
  point `AYIN_PUML_SERVER` at your own PlantUML/Kroki instance if you want remote.
- Without `plantuml` installed the file is still written, checked structurally, and clearly labelled
  as unverified.
- **Install a current PlantUML, not your distro's.** Because the validator is ground truth, a stale
  renderer rejects source that is perfectly valid — Ubuntu 24.04 still ships 1.2020.2, which fails on
  `!theme`, newer C4/mindmap syntax and much else, so the repair loop burns its rounds "fixing" code
  that was never broken. Drop the release jar from
  [plantuml/plantuml](https://github.com/plantuml/plantuml/releases) somewhere like
  `/usr/local/lib/plantuml/plantuml.jar` with a one-line `exec java -Djava.awt.headless=true -jar …`
  wrapper earlier on `PATH`, or just point `AYIN_PUML_BIN` at it. Needs a JRE, plus Graphviz (`dot`)
  for class/component diagrams; sequence and mindmap diagrams render without it.
- `!include` / `!includeurl` are stripped from generated source — PlantUML resolves those at render
  time (reading local files, fetching URLs into the image), which is an exfiltration path for
  anything that can influence the model's output.

Env: `AYIN_PUML_BIN` · `AYIN_PUML_DIR` · `AYIN_PUML_RENDER` (`svg`|`png`|`0`) · `AYIN_PUML_OPEN`
(`auto`|`0`).

## `/arduino-explain` — teach me my own wiring

For a beginner with a starter kit, "the wiring is shown as ASCII in a chat reply" is not the same as
*understanding* it. `/arduino-explain` renders one self-contained HTML page per sketch in the current
project: a simplified board outline, a dashed "breadcrumb" wire (dot markers + a leg-label chip) from
each pin your code actually touches to a card carrying that component's symbol and a full beginner-level
explanation — how to spot the part in a pile of loose components, what it does, how it's driven from
code, and the one wiring gotcha that matters most — then opens it in VS Code if the `code` CLI is on
PATH.

Early-returns with a clear reason if the current directory isn't an Arduino project (no `.ino`/`.pde`
sketch, no `platformio.ini`/`sketch.yaml`). A README at the project root is fed in as extra context when
present, but its absence never blocks generation — a beginner's first sketch usually doesn't have one yet.

The explanations come from **`arduino_db`**, a shipped reference catalog of ~28 common starter-kit parts
(LEDs, buttons, servos, sensors, displays, drivers, ICs) with a keyword/alias search over it —
deliberately **not** a RAG pipeline; the catalog is small enough that a keyword scorer answers "what is
this and how do I wire it" exactly as well as a vector search would, with none of the moving parts. The
agent can also call `arduino_db` directly while writing or explaining Arduino code, same discipline as
looking up a third-party API instead of recalling it from memory.

Pin usage is extracted by regex (`pinMode`/`digitalWrite`/`digitalRead`/`analogWrite`/`analogRead`/
`attachInterrupt`, plus `.attach(pin)` for `Servo.h` — a servo sketch never calls `pinMode`/`digitalWrite`
on its own pin at all, so without that second pattern a servo-only project would report zero pins for
its one actual actuator), then ONE grounded LLM call maps the real pins to real `arduino_db` component
ids — never invents one outside the catalog; an unmatched pin still gets an honest "no catalog match"
card rather than being dropped.

**Passing Arduino QA on a turn that touched a sketch regenerates (overwrites) that sketch's
`.wiring.html` automatically** — a wiring change that just cleared QA but left a stale diagram behind
would defeat the point of a *teaching* tool. Not opened in an editor for you automatically there; only
the explicit `/arduino-explain` command does that.

## `/explain <feature>` — intention vs. reality, and where to be careful

Broader than `explore`: `explore` finds and reads code; `/explain` additionally pulls in the feature's
real git history and any Jira tickets referenced in its commit messages, then answers one specific
question — **what was this supposed to do, versus what actually exists, and what should I be careful
about** — not a neutral changelog. Command-only (like `/plan`), not agent-callable.

```
❯ /explain the llm resource
Explaining: the llm resource...
Report: /you/project/ayin-explain-the-llm-resource-20260731-081946.md (opened in editor)
Diagram: /you/project/the-architecture-of-the-llm-resource.puml (opened in editor)
```

Pipeline: `explore` investigates (its own agentic loop) → real file paths are extracted from its
answer and confirmed on disk → `git log --follow` per path, deduped, with a churn count and a
bugfix-commit flag (evidence, not a guess about fragility) → any `PROJECT-123`-shaped string in a
commit subject is a CANDIDATE only — a generic ticket-key shape is structurally identical to plenty of
ordinary text (a hardware part number like `KY-040` is the exact same shape), so candidates are
batch-validated against the real Jira API and only what actually resolves counts → one LLM call writes
five fixed sections (`Intention` / `What actually exists` / `How they map` / `Problem areas — be
careful here` / `Summary`) → an architecture diagram (`diagram`'s own validated PlantUML loop, reused
as-is). Both files open in VS Code.

A missing README or unconfigured Jira never blocks the report — the gaps are stated honestly
("no original intent could be recovered") rather than papered over.

## Repo watcher — automatic post-commit code review

```bash
ayin watch --repo /path/to/your/repo        # install the hook + run the daemon (foreground)
ayin watch --once                           # process any queued commits, then exit
```

`ayin watch` installs a `post-commit` hook in the target repo and runs a persistent daemon.
Every commit is queued (a JSON line in `~/.ayin-cli/watch/queue.jsonl`) and reviewed by the
LLM against a catalog of ~20 typical code-smell signals (long functions, swallowed errors,
race conditions, hardcoded secrets, injection risk, unbounded memory, …); each finding is
reported **with a confidence score**. The review lands as `reviews/<shortHash>/CodeReview.md`
under the repo root (or under `AYIN_REVIEW_DIR` if set) — commit metadata first, then the
findings, then a verdict. One folder per review: everything about that commit's review lives
together there, nothing loose in the repo root.

Reviews are LLM work, so the daemon takes the backend's **llm resource as the `ayin`
authority** for each review batch (the backend swaps to the coder model, and reverts when the
batch drains — the same dance as interactive ayin). If the resource is busy, reviews are
**deferred**, not run on the side; a backend without the resource layer falls back to
best-effort on the served model.

Built to survive interruption: the hook never blocks a commit and never needs the daemon up —
the queue accumulates, and on its next start the daemon processes the whole backlog (a
processed-ledger keeps reviews exactly-once; a crash mid-review just re-runs it). One daemon
serves any number of watched repos. Commits that only touch `reviews/**` are skipped, so
committing a review never triggers a review of the review.

To keep it running on macOS: `nohup ayin watch --repo <repo> &`, or wrap it in a launchd
agent with `KeepAlive` — the daemon is safe to kill and restart at any point.

`ayin watch` writes nothing to `.gitignore` and maintains no cruft list anywhere — what a repo
ignores is its owner's call, not ayin's. Beyond its own reports (under `reviews/`, or a root-level
periodic `AYIN-REPORT-SMELLS-*.md`) and a managed pointer block in `CLAUDE.md` **and** `GEMINI.md`
(`<!-- ayin:reports:begin -->`) listing pending reports, re-asserted by the same 5-min self-heal,
the only other thing it writes to a watched repo is the Claude Code hound hook below. Only that
fenced region of the agent files is touched — the rest of each file is yours — and it's written
only when its bytes actually change.

**Claude Code hound hook** — installed alongside the git hooks (self-healed the same way):
`.claude/hooks/ayin-hound.sh`, plus a Stop-hook entry merged into `.claude/settings.json`
(`AYIN_WATCH_HOUND=0` to skip installing it). At the end of a Claude Code turn, if there's a
staged diff, it runs **ayin itself** — read-only (`AYIN_READONLY=1`, so it can only grep/read,
never edit) — against that diff, and blocks the stop if ayin finds something: Claude reacts to
ayin, not the other way round. The engine is ayin, not `claude -p` — no LAN address to hardcode,
it just talks to whatever `KELI_URL` this ayin install already uses. In a Unity repo the check is
narrow: excessive comments, a missing/misused `CancellationToken`, single-responsibility
violations — gated on at least one staged `.cs` file. Every repo also gets a "this staged diff is
big and complete — commit it now" nudge, gated on the diff actually being large. The JSON merge
only ever touches the one Stop-hook group that names `ayin-hound.sh` — every other setting, every
other hook, is left exactly as it was; an existing `settings.json` that fails to parse is left
alone rather than risked.

**Unity repos** (`Assets/` + `ProjectSettings/`) get **two files per commit**, in the same
`reviews/<shortHash>/` folder: `CodeReview.md` (the LLM review) and `AssetDiff.md` — a
**deterministic asset diff** from the external `unity_asset_diff` tool: object-level changes
with full hierarchy paths (`MonoBehaviour at Path/To/Object · field old → new`) for
prefabs/scenes/assets. The review links to it and the reviewer is fed its content as ground
truth. Tool path: `~/tools/unity_asset_diff.py` or `AYIN_UNITY_DIFF`. Non-Unity repos never
spawn it and get only the review file.

The 10-min autostage pass also treats Unity core assets specially: `.cs`, `.anim`, `.controller`,
`.overrideController`, `.asset`, and `.prefab` are **always staged**, unconditionally — never left
to the model's judgement, and staged even if the model's plan fails to parse. A renamed animator
state or a prefab fix is real work, never debug scratch.

## Requirements

- **Node ≥ 18** (uses global `fetch` + `AbortSignal.timeout`; Node 20+ recommended).
- A **POSIX shell** at `/bin/bash` — present on macOS and Linux. On Windows, run ayin under
  **WSL** (the file tools shell out to `bash`/`grep`/`find`).
- An **LLM endpoint** (local Ollama via the bundled adapter, any compatible backend, or OpenAI).
  See [`SETUP.md`](SETUP.md).

## Prompts

**Every prompt ayin sends is a file you can edit.** Nothing is baked into the binary.

Each prompt ships as a `.txt` beside the code that uses it and is copied on first run into
`~/.ayin-cli/prompts/<namespace>/<id>.txt`. That local copy is the only one ayin ever reads,
and **an upgrade never overwrites it** — a new version only adds prompts you don't have yet.
Edit a file and the next call uses it: no rebuild, no restart.

```
~/.ayin-cli/prompts/
  ayin/      the core loop — system, summarizer, goal, headless guardrails
  watch/     the repo watcher's reviewers
  qa/        the QA gate's baseline criteria
  plan/      plan mode
  explore/   the explore tool's investigation loop
  diagram/   the diagram tool
```

Placeholders are `{{UPPER_SNAKE}}` and are filled in by ayin — leave unfamiliar ones alone.
Tools carry their own namespace, so a tool from another package brings its prompts with it and
you tune them the same way. The interactive TUI also serves a small web editor for them at
`http://localhost:7773` while it runs.

## Configuration

Runtime config lives in `~/.ayin-cli/prompts.json` (created on first run, re-read on every
access — changes take effect immediately). Prompt *text* is not in here; see above. Set values
from inside the TUI with `/set`:

```
/set keli-url http://localhost:9100     # the LLM endpoint ayin talks to
/set openai-key <your-api-key>          # optional OpenAI fallback
```

See [`SETUP.md`](SETUP.md) for the full list of tunables.

## Documentation

- [`SETUP.md`](SETUP.md) — install, connect an LLM (Ollama / backend / OpenAI), run.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the agent loop, the LLM manager &
  dialects, tools, parser, and how everything fits.

## License

[MIT](LICENSE).
