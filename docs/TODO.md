# ayin — TODO / path to a clean standalone

ayin is a public, MIT, model-agnostic terminal coding agent. The core (agent loop + 8 core tools,
LLM via the 2-endpoint contract `POST /api/generate` + `GET /api/status`, satisfiable by
`examples/ollama-adapter.mjs`) is cleanly decoupled and runs against local Ollama. These are the
deferred items to make it a fully clean, shareable standalone project.

## Done
- [x] **Neutralize packaging** — package name `ayin` (was `@maradel/ayin`), neutral description,
  updater default package `ayin`. (Update check stays opt-in via `AYIN_UPDATE_REGISTRY` — never
  phones home by default.)

## TODO

### Tools → their own subrepo (connectors)
- [ ] Extract the **optional integrations/connectors** into a separate subrepo/package that ayin
  loads by config, instead of living in core:
  - `jira` (`src/jira.ts`), `send_push` (`src/tools/send-push.ts`), `telegram` (`src/tg-auth.ts` +
    the telegram tooling), image preprocessing (`src/image.ts`, pulls `sharp`).
  - `codex` and `fixme` were **deleted** rather than moved (2026-07-28). `codex` returns later as the
    reference case for an *escalation tool* — "hand this to a different/bigger model and await the
    answer" — which is a tool, unlike the provider that runs the loop itself (see the LLM provider
    note below).
  - Move the heavy deps with them: **`telegram`** (gramjs) and **`sharp`** (native) currently sit in
    core `dependencies` though the core agent doesn't need them. (Telegram stays as a real resource,
    but as an *optional* module, not a core dep.)
  - ~~Neutralize connector config paths~~ **DONE 1.0.211** — the only one left was the Telegram session
    file, now `~/.ayin-cli/telegram.session` with a one-time migration of the old location
    (`tg-auth.ts#migrateLegacySession`). Jira holds no credential here at all (it is a resource
    consumer), so nothing else was borrowing another program's directory.
- Goal: `npm i ayin` pulls only blessed + undici; connectors are opt-in add-ons.

### Tests
- [ ] Unit tests (currently none). Highest value, pure + easy:
  - `parser.ts` + `llm/dialects/*` — tool-call parsing (the `<value>` unwrap bug this caught late).
  - `shell.ts` — platform shell selection.

### LLM provider — a port, not a tool (design decided 2026-07-28)
Today the model manager **is** the private backend: `resourceOp('llm', …)` is spread across
`llm-status.ts`, `model-picker.ts`, `llm-events.ts`, `wait-narrator.ts`, `resource-client.ts`. A
stranger who clones ayin and runs plain Ollama gets no model manager, no model list, no queue/GPU
view, and a `/lock` that cannot work. **This is the blocker on ayin being publicly usable at all** —
it must land before the tools split.

- [ ] `src/llm/provider.ts` — `generate` + `status` REQUIRED; `models`, `acquire`, `setModel`, `gpu`,
  `queue`, `events` OPTIONAL. **Every consumer must degrade to *nothing* when a capability is
  absent** — never an error, a hung spinner, or a crash. That degradation is the crux, and is what
  makes the public build real rather than nominal.
- [ ] Two implementations: `providers/direct.ts` (public — the plain `/api/generate` + `/api/status`
  contract, which the bundled Ollama adapter already serves) and `providers/resource.ts` (the
  owner's authority/keepalive behaviour, **moved not rewritten** — the `/lock` keepalive re-adopts a
  rotated token and re-pins the model after a backend restart, and that must survive verbatim).
- [ ] Selection: config/env → probe → **fall back to `direct`**, never throwing.
- A first pass exists on branch `wip/llm-provider` — typechecks, **runtime-unverified**. Prove both
  paths before merging: direct against the bundled adapter or a stub, resource against a stub (not
  the live backend).

**Why a port and not a tool.** It was proposed as a tool — the signature matches, and the
public/private split is identical. It cannot be one: the loop's LLM call is what *produces* tool
calls, so making it a tool means the model must emit a tool call to make the call that lets it emit
tool calls. It would also add a distractor to the menu for exactly the weak models that suffer most
from a crowded tool list. **The provider is how ayin thinks; a tool is something ayin can choose to
do.** Escalation to a *different* model (the old `codex`) genuinely is a tool — same signature,
different thing.

### Retrieval — removed, redesign pending
All retrieval was **deleted** from ayin: the `ayin rag` corpus generator, the `rag-mine` episode
miner + its Claude Stop auto-farm hook, and the `docs_search` tool. Two reasons, both fatal:
- **Naive.** Explore-then-synthesize prose docs and transcript-mined episodes, with no chunking
  strategy, no embeddings, no retrieval, and no evaluation — a write-only pile.
- **Private dependency.** Every store routed through one operator's backend (`logs` resource,
  `~/.maradel/logs/rag/`) and `docs_search` dialed that backend's doc index. A public agent must
  not require a private host to function.

Whatever replaces it must be **addressed by URL** (`AYIN_RAG_URL`) with a neutral fallback, keep
the store a **portable directory**, and be designed against a retrieval benchmark rather than by
vibes. Do not restore any of the above.

**Planned shape (2026-07-28): `ayin-rag` as its own subrepo**, an independent CLI + daemon that ayin
depends on. Two indexes, and **tools RAG comes first** — the corpus is smaller, the tool catalogue is
already semi-structured, and the published wins are much larger there (tool definitions cost
15k–60k tokens/turn in typical MCP setups; retrieving instead of enumerating took one published
benchmark from 150k → 2k tokens and lifted tool-choice accuracy 49% → 74%). A weak local model
suffers a crowded tool menu far more than a frontier one does.

Design notes for whoever builds it:
- **Chunking:** cAST (arXiv 2506.15655) — tree-sitter parse, recursive split-then-merge, greedy
  sibling merge, size measured in non-whitespace characters. Largest reported gains are on TypeScript.
- **Enrichment beats splitter tuning:** prefix each chunk with its file path + enclosing signature,
  and index *hypothetical questions* per chunk (user queries are questions; code is not).
- **Retrieval:** hybrid BM25 + dense with a reranker. Single-method retrieval loses on every
  published code-retrieval benchmark.
- **Embeddings:** `nomic-embed-text` is a general prose model doing code retrieval it was not trained
  for. A code-specialized model (e.g. Qwen3-Embedding-4B, Matryoshka dims so 768 still fits) is the
  cheapest quality win available.
- **Two indexes, not one:** an LLM-written semantic/summary tree cannot ground an edit. Pair it with
  a verbatim cAST code index — same store, different `kind`.
- **Build the eval set BEFORE either index.** ~50 hand-written (query → expected chunk/tool) pairs
  per direction. Without it there is no way to tell cAST from naive splitting, or one embedding model
  from another — and "we can't tell" is precisely how the deleted implementation became a write-only
  pile. Do not skip this step to get to the interesting part faster.

### Misc
- [ ] Normalize git author identity (commits appear as both `Kliment` and `Klyment` Shchukin).
