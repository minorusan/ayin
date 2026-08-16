# `indulge` — the corpus, and why ayin is not a harness

A harness around a model is a weekend project. The loop is the easy part: parse a tool call, run it,
feed the result back. What separates one agent from another is not the loop — it is **what the model
knows when the loop starts.**

A frontier model working on your repo holds the whole session in context: every file it read at 10:00
is still there at 18:00, so it can notice that the thing failing now explains the thing that looked
odd this morning. A 16k-token local model cannot. It wakes up empty on every turn, re-derives what a
file is for by grepping from scratch, and forgets it again.

`indulge` is the answer to that asymmetry. It spends a night building **what a big-context model
would still be holding**, and hands it back one fact at a time, exactly when it is needed.

Everything below follows from three commitments.

---

## 1. A chunk is a proof, not a note

**Every answer carries citations, and every citation is verified before the chunk is stored** — the
path resolves inside the repo, the line range is within the file's real line count, and the blob sha
is computed from the bytes on disk at that moment. An answer whose proof does not resolve is recorded
`failed` and stored nowhere.

That severity is the whole design. A plausible-but-wrong chunk is worse than a missing one: at
retrieval time nothing distinguishes it from a correct one, so it gets injected into a prompt,
believed, and acted on. **A corpus you cannot trust is worse than no corpus**, because it launders
guesses into citations.

The same rule runs everywhere:

| Instead of | ayin does |
|---|---|
| trusting a model's file list | resolving every path against disk; refusing what does not exist |
| assuming a chunk is current | re-verifying the sha at read time and **labelling** what moved |
| storing an unproven answer | recording it `failed`, with the reason |
| silently truncating | announcing the cut, always |

Measured on a real repo: the model named 21 files, **7 existed**. Discovery kept the 7 and reported
the rest. That ratio is why the deterministic walk carries the work and the model only seeds it.

## 2. Depth is a claim about completeness

Discovery finds seeds with a model — "which files implement checkout?" is a question only something
that reads code can answer — then walks the reference graph **deterministically**. A model asked
"what else is related?" returns something plausible; a reference graph returns something checkable,
and stage 3's citations have to be real.

`--max-files` bounds how **deep** the walk goes, never how much of a level it sees. The cap is
checked at the depth boundary: the level in progress finishes, and the cap decides only whether to
start the next one. A half-walked level is not a depth, it is a coin flip.

Three bounds keep a real repo from swallowing itself, each one found by running it:

- **ambient names** — a type mentioned by more than 25 files stops being an edge in either
  direction. `ILogger` named by 300 files says nothing about which of them are *this* feature; the
  popularity is the proof that it does not discriminate.
- **fan-out** — one file may contribute at most 12 files per depth, so a hub cannot decide the corpus.
- **reachability** — in a namespaced language, a mention counts only if the target's namespace is one
  the source `using`s, or its own.

Before those: depth 2 pulled **393 files** for a 40-type feature. After: the feature and its
neighbourhood.

## 3. Retrieval is coarse-to-fine, and cosine ranks last

```
names  →  domains  →  cosine
```

**Names first** (`lexicon.ts`). Most real questions carry a handle — a file, a class, a method. An
exact symbol match is not "probably relevant", it is the thing that was asked about, and it costs no
model. Normalise for the index (`noteShape` / `NoteShape` / `note_shape` → one key), index **all**
trigrams so a typo in the first three characters still resolves, and use Levenshtein as a re-ranker
on candidates the trigrams already nominated — never as a scan.

Only a **strong** name match may restrict the field. Measured: *"how does it figure out where the
speech bubble **points**"* fuzzy-matched the symbol `pathPoints` and gated away the chunk that
actually answered it. An exact name is evidence; a fuzzy hit on an English word is a coincidence.

**Then domains.** A domain's vector is the **centroid of its chunks**, not the embedding of its name —
a domain is an arbitrary string the operator typed, and it may describe its contents poorly. Top-K,
never a threshold, so a badly-phrased query still retrieves something.

**Then cosine**, over what survived. Scoping first is not only cheaper, it is more accurate: a chunk
from an unrelated domain cannot win if it was never a candidate, which no amount of better scoring
achieves.

The embedding model is not a chat model — `nomic-embed-text` is ~270 MB against gemma's 15+ GB, runs
on CPU in milliseconds, and takes no GPU authority. **A vector is only comparable to vectors from the
same model**: mismatched dimensions crash (lucky), matching dimensions produce confident garbage
silently. So every vector records its model, and vectors never travel — chunks do.

---

## Staleness: the corpus assists an agent that EDITS CODE

It goes stale during the very session it is helping. An unlabelled stale chunk is a confident lie
with a citation attached, and the citation makes it *more* believable.

Chunks are never dropped for being stale — one written on `dev` describing a file you have since
edited is usually still broadly true. They are **labelled**, and the label leads with the **branch**,
because `dev` and `release` carry meaning a sha never will:

```
[corpus] answered 2026-08-14 on dev — cited files unchanged
[corpus · STALE] answered 2026-08-14 on dev · src/Match.cs +12 −3 since · line refs as of then
[corpus · STALE] answered 2026-08-14 on dev · src/Match.cs has uncommitted changes
[corpus · DIVERGENT] answered 2026-08-14 on other-branch, not in your current history
```

Staleness is **chunk-level**, not per-citation: chunks describe interconnected things, so one moved
file undermines the claim, not part of it. The label still names which file moved.

---

## The two hooks — where project types plug in

ayin is language-agnostic by construction, which is right for the loop and wrong for knowledge. A
Unity repo and an Arduino sketch know things about themselves that no generic parser will derive, and
baking either into the core would make the core a liar about the other.

So there are exactly two extension points, and the split between them is a **cost decision**:

### `Indulger.onChunkCreated` — the expensive half, paid overnight

Runs during `ayin indulge`, where the operator has already accepted the cost. Anything expensive
belongs here. The Unity indulger scans every prefab, scene and asset for **GUID references** — the
only *exact* edge a Unity project has, because every reference between assets is by GUID and nothing
is inferred. It beats every heuristic in `discover.ts` precisely because it cannot be a coincidence.

Results land in `chunk.ext.<id>`, a namespaced bag beside a required core. Namespaced because two
packs will both want `references` and neither will know the other took it.

What lands there is a **snapshot**. `sourceSha` guards the `.cs`, not the prefabs referencing it — so
a count taken tonight says nothing about one added tomorrow, and it is stamped `asOf` so a reader
discounts rather than trusts it.

### `Attributor.attribute` — the cheap half, inside a tool call

Runs on a turn the operator is waiting through, so it must be a **lookup**, never a scan: read what
the chunk already carries, or derive something cheap from bytes already in hand.

**It states facts. It does not give advice.** That distinction is the entire reason it exists rather
than a longer system prompt. The agent once decided `DynamicInAppOperation.cs` was a ScriptableObject
— not an instruction failure, since every model knows what `.cs` means. It pattern-matched a *name*
that reads like a data asset and never checked the declaration. A sentence in a preamble 40k tokens
earlier does not reach that moment. This does:

```
[unity] C# source · class DynamicInAppOperation · plain class, no Unity base type
        — not a ScriptableObject, not a MonoBehaviour
[corpus] 0 chunk(s) about this file
```

Fifteen words, always true because they are derived from the bytes being read, sitting in the middle
of the thing being looked at rather than filed under general guidance.

The **session preamble** ("this is a Unity project…") is emitted **once per session and never
again**. Repeating it on every tool result is the preamble this mechanism replaces, injected more
often.

The **corpus count is always shown, including zero.** `corpus: 0` is the actionable signal — that
file has never been indulged, and the operator can decide to feed it rather than wonder why the
agent was dumb about it.

### Writing one

```
src/indulge/attributors/*.ts     built in, ships with ayin
src/indulge/indulgers/*.ts
~/.ayin-cli/attributors/*.mjs    yours; same id REPLACES the built-in
~/.ayin-cli/indulgers/*.mjs
```

Same relationship prompts have: built-ins ship, local files override by id. Drop a file in, no
rebuild. A local pack is code you wrote running inside a tool call, so the contract is blunt: **a
broken hook degrades the tool, it never breaks it.** Load errors are logged once and the pack is
skipped; a throwing hook is caught and its output dropped. `read_file` keeps reading files.

---

## Surviving the night

`indulge` runs for hours unattended, so every stage writes results the moment it has them and reads
its remaining work back from disk. A crash, a reboot or a `kill -9` costs at most the question in
flight.

- **append-only JSONL, flushed per record** — a power cut leaves a truthful partial whose last line
  may be torn, and every reader skips a line it cannot parse
- **status changes are appends** that merge last-wins, never in-place rewrites
- **a stale lock is adopted, not obeyed** — a dead holder's lock never needs a human to delete it
- **runs left `running` are closed `interrupted`**, and their data is what the next run resumes from
- `--status` for the morning check; `Ctrl+C` finishes the record in flight and stops

Verified by killing it: 1478 records survived a `kill -9`, read back in 7ms, zero duplicates.

## Portability

The corpus is keyed by the repo's **identity** — its normalised `origin` remote, else its root commit
— never its path, and every path inside a chunk is repo-relative. So a corpus built overnight on a
workstation is directly usable on a laptop:

```bash
scp -r bigbox:~/.ayin-cli/rag/<key> ~/.ayin-cli/rag/
ayin indulge --import <dir>     # verifies it is for THIS repo, reports what is already stale
```

Vectors do not travel — they are model-bound. Re-embed on the other machine; it costs minutes on CPU.

---

## The commands

```bash
ayin indulge --domains "reward service,streak"   # build (overnight)
ayin indulge --embed                             # vectorise (CPU, minutes)
ayin indulge --status                            # how far, still alive?
ayin indulge --report                            # the audit markdown
ayin indulge --import <dir>                      # a corpus built elsewhere
ayin indulge --dry-run                           # what it WOULD do; spends nothing
ayin indulge --deep                              # full explore per question (~8x slower)
```

And in the TUI: `/embed` for every prompt this session, `/embedthis <q>` for one, `/corpus off` to
disable injection entirely — because *"does retrieval help?"* is answered by running the same task
with it off, not by intuition.

---

## What this is not

It is not a search feature. It is the substitute for the context a small model does not have, built
with one rule running through every layer: **state the fact, never the guess** — verify the citation,
label the staleness, announce the cut, show the count even when it is zero.

That is the part nobody gets for free by wrapping a model in a loop.

---

## Auditing what is already stored — `--qa` and `--fix`

Every chunk was verified at WRITE time: citations resolve, lines in range, blob sha matched. That
proves the answer points at real code. It does not prove the answer is worth reading, and a corpus is
retrieved from for months.

```
ayin indulge --qa          rules first (free), then the model in batches
ayin indulge --qa-rules    the free half only — no model, instant
ayin indulge --fix         act on the verdicts, then re-embed what changed
```

### Two passes, and the split is the design

**Deterministic first, and free.** A question that is a JSON blob, an answer shorter than its own
question, an entry with no citations — decidable without a model. Spending a model call on those is
spending the audit's budget on the easy half. Measured on a real corpus: **2% of stored questions
were raw JSON replies**, every one caught here for nothing.

**The model second**, on what survives, in batches of **question + answer only — no source**. The
audit asks whether an answer is worth keeping, not whether it is true; truth was settled by the
citation gate. Sending the file again would multiply the audit's cost by the size of the code for a
judgement that does not need it.

### Rules the audit enforces

| | |
|---|---|
| rule | JSON-blob question · empty question or answer · essay-length question (>320 chars) · answer under 40 chars · no citations · answer restates the question |
| model | answer restates the question in other words · hedged rather than factual · describes something that will not be true next month · asks for an opinion or a refactor · generic enough to be true of any codebase |

The prompt says explicitly that **a short answer is not a bad answer** and rejecting a good entry
costs more than keeping a mediocre one, because a reject is re-answered at full price.

### Three properties worth knowing

**Nothing is deleted.** A verdict is written onto the chunk and is reversible. An audit that destroys
its evidence cannot be re-run with better criteria.

**The audit fails OPEN.** An unparseable reply rejects nothing. Failing closed would delete a batch of
good chunks because one reply came back malformed — and malformed replies are exactly what this
codebase keeps meeting.

**Only ids that were in the batch may be condemned.** A model that invents an id cannot reach a chunk
nobody showed it.

### `--fix` treats the two failures differently

A bad **question** cannot be answered better: the chunk is dropped and its question marked `failed`,
so nothing re-answers it at full price. A bad **answer** to a good question is re-queued — the
question returns to `pending` and the normal answer path redoes it, citation gate and all.

Embedding runs last and only over what is missing a vector, so a fix costs one embed per repaired
chunk rather than a re-embed of the corpus.

**Rejected chunks never reach a prompt** — filtered out of both `corpus_search` and the read-file
injection. Marking a chunk while still serving it would be theatre.

