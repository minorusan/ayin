# ayin — TODO / path to a clean standalone

ayin is a public, MIT, model-agnostic terminal coding agent. The core (agent loop + 8 core tools,
LLM via the 2-endpoint keli contract `POST /api/generate` + `GET /api/status`, satisfiable by
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
  - `jira` (`src/jira.ts`), `codex` (`src/codex.ts`), `telegram` (`src/tg-auth.ts` + the telegram
    tooling), image preprocessing (`src/image.ts`, pulls `sharp`).
  - Move the heavy deps with them: **`telegram`** (gramjs) and **`sharp`** (native) currently sit in
    core `dependencies` though the core agent doesn't need them. (Telegram stays as a real resource,
    but as an *optional* module, not a core dep.)
  - Neutralize connector config paths (`~/.egregor/config.env`, `~/.egregor/telegram.session`) — make
    them ayin-native / configurable rather than egregor-scoped.
- Goal: `npm i ayin` pulls only blessed + undici; connectors are opt-in add-ons.

### Tests
- [ ] Unit tests (currently none). Highest value, pure + easy:
  - `parser.ts` + `llm/dialects/*` — tool-call parsing (the `<value>` unwrap bug this caught late).
  - `shell.ts` — platform shell selection.

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

### Misc
- [ ] Normalize git author identity (commits appear as both `Kliment` and `Klyment` Shchukin).
