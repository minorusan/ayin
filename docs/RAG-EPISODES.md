# Episodic RAG from Claude transcripts — plan + Phase 0 handoff

**Idea (sound):** mine the free, already-generated Claude Code transcripts for a repo into
problem→fix **episodes**, keep only the ones that verifiably worked, reformulate them into the
*questions* a future dev would ask, embed + store, and retrieve them at task time. Two established
techniques: **episodic memory** + **hypothetical-question indexing** (embed the question a chunk
answers — user queries are questions, so they match far better than raw prose).

**The one rule that makes or breaks it:** index only **verified-success** episodes. Claude is often
confidently wrong (see the animator incident); an unfiltered transcript-RAG is a machine that
confidently repeats past mistakes. The verify signal is free + deterministic (git).

## Pipeline (phased — each verifiable before the next)

- **Phase 0 — harvest + verify → JSON (DONE, this commit).** `ayin rag-mine --repo <path>`
  (`src/rag/mine.ts`). Segments transcripts into episodes, filters out our own automated sessions
  (hound/`-p` reviews), and keeps only verified ones. **No model, no GPU, no risk.** Output:
  `~/.ayin-cli/rag/<repo>/episodes.json` to eyeball.
- **Phase 1 — distill + reformulate** (local model / eGPU). Each surviving episode →
  `{problem, solution, questions[2-4], symptoms/errors[], refs(commit+session+lines)}`. Scrub
  secrets here.
- **Phase 2 — embed + store** (BACKEND — reuse `backend/src/memory/rag.ts` + `ranking.ts` +
  nomic-embed + sqlite-vec; server owns embeddings/storage). Embed the *questions + symptoms*; new
  resource ops `rag.upsertEpisode` / `rag.searchEpisodes`.
- **Phase 3 — retrieve** (ayin). On task start in a watched repo: embed the request → search →
  inject top 2-3 as "past solved episodes (verify before trusting): …" **with citations**.

## What `rag-mine` does (Phase 0)

- **Episode** = one real user request → the assistant narration + tool activity until the next
  request. Two kinds:
  - **edit** — Claude changed files (Edit/Write/MultiEdit). Verified if a distinctive line it
    introduced still exists in the committed file (`git show HEAD:<file>`) → the change *stuck*.
  - **investigation** — Claude only read/grepped/analysed (no edits). Verified if the conclusion is
    substantive **and** ≥1 file it examined still exists (grounded + not stale).
- **Filters out automated sessions** (`looksAutomated`): the premortem-hound skeptic and `-p`
  review runs write their own transcripts — indexing them would be circular.

## Phase 0 findings (honest — READ THIS before Phase 1)

The plumbing is correct and deterministic, **but the corpus on this Mac is essentially empty:**
- **solitairesmash:** 12 sessions, **all of them the automated hound** (`"You are a blast-radius
  skeptic…"`). After filtering → **0** real episodes. Claude *investigates* smash; the human/Unity
  does the editing, so there are no Claude edit-episodes there.
- **maradel:** **no transcripts on disk** at `~/.claude/projects/-Users-…-maradel/` (this session
  isn't persisted there).
- The only rich edit-session (17 edits) is under `…/MAC-BACKUP-BEFORE-NUKE/` — a **non-git-repo
  cwd**, so the repo-scoped miner can't map it.

**Implication:** don't invest in Phases 1-3 until a real corpus exists. Run `rag-mine` **where
Claude actively edits a git repo** — most likely the **nuk** (maradel dev) — and let sessions
accumulate. The value scales with real interactive edit-sessions; the Mac's usage today is
automation (hound) + investigation, not problem-solving-with-edits.

## Auto-farm loop (WIRED)

Farming now happens automatically — no manual `rag-mine` runs:

1. **User-level Claude Stop hook** (`tool/claude-stop-farm.mjs`, installed into `~/.claude/settings.json`
   via `tool/install-stop-farm.mjs`) fires on *every* Claude stop, in *any* directory. It drops one
   marker into the watch queue — `{kind:"mine", transcript, cwd, session, ts}` — and nothing else
   (never blocks; skips non-git-repo cwds, stop-continuations, and our own hound/`-p` runs).
2. **The always-on `ayin watch` daemon** drains `mine` markers **without taking the GPU**
   (deterministic), mines that session's transcript, and dedup-merges the git-verified episodes into
   `~/.ayin-cli/rag/<repo>/episodes.json`. Survives relaunch (queue is persistent; one instance).

So on the nuk/backend it starts collecting the moment the daemon + Stop hook are installed there,
in whatever repo Claude works in. Verified end-to-end (synthetic repo+transcript → 1 episode farmed).
Install elsewhere: `node tool/install-stop-farm.mjs` (uninstall: `--remove`).

Not yet: embeddings/retrieval (Phase 2/3) — the store is still raw JSON to eyeball.

## Next steps

1. Run `ayin rag-mine --repo <maradel-on-the-nuk>` and eyeball — confirm real edit-episodes exist.
2. Decide corpus scope: edit episodes only, or also investigation episodes (useful for repos where
   Claude analyses more than it edits, like smash).
3. Phase 1 distill/reformulate (local model), scrubbing secrets.
4. Phase 2 on the backend (reuse the memory vector infra), Phase 3 retriever in ayin.
