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
  - `rag/mine.ts` — episode segmentation + verify + the automated-session filter.
  - `shell.ts` — platform shell selection.

### RAG — decouple into its own daemon (design pending; see RAG-EPISODES.md)
- [ ] Today RAG episode storage goes through the **maradel backend** (`resourceOp('logs',
  'rag.episodes.append')`, `~/.maradel/logs/rag/`), tying RAG to a maradel install.
- [ ] Make RAG a **separate daemon addressed by URL** (`AYIN_RAG_URL`): ayin (usable with any GPU)
  points at a shared RAG service on the LAN; the store is a **portable directory** (zip-and-share to
  a colleague); multiple ayin installs share one RAG. The seam is localized — `rag/store.ts` already
  routes through one function; swap the target from the `logs` resource to the RAG daemon.
- **Owner is rethinking the RAG design first** — do not start this refactor until that lands.

### Misc
- [ ] Normalize git author identity (commits appear as both `Kliment` and `Klyment` Shchukin).
