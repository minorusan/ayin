# `/diff` — the working tree as something a person can actually read

```
/diff             the working tree against HEAD
/diff <rev>       against any rev — `/diff main` reviews a branch
ayin diff [<rev>] [--no-open]      the same page, from a shell
```

Staged, unstaged **and untracked** changes. Leaving untracked files out is the tempting
simplification and it is wrong: a new file is the part of a change most worth reviewing, and a page
that silently omits it teaches the reader to trust a picture missing its newest half.

**Two pages, one renderer.** With an ayin session open on the repo, that session SERVES the page and
the browser is pointed at its URL — which is what makes a line commentable (see below). With no
session listening, the page is written to `~/.ayin-cli/diffs/` and opened from `file://`: one
self-contained file, no CDN, no font, no fetch, because that page has to open on a machine with no
network, and a stylesheet that fails to load turns a review into a wall of text. The served page
writes that snapshot too — the live page dies with the session, and a review worth having is one you
can still read tomorrow. The palette is naamah's, so the pages read as siblings.

Zero external assets is a rule for both. The comment client is inlined into the served page and
**omitted entirely** from the static one: an offline document that ships a fetch loop pointing at a
port that is not there is dead code in the one artifact whose whole promise is self-containment.

---

## Built around how a diff is actually read

Not top to bottom. **Triage → filter → read**, and the page is laid out in that order.

### 1 · Triage — the sidebar

Every file with its `+`/`−` weight and a status dot (added · modified · deleted · renamed). The
reader decides what to look at *before* spending attention on any code. A page that opens straight
into hunk one asks them to form that judgement while already reading.

Sorted **tracked first, then by churn**. `j` / `k` step through files; the sidebar follows.

### 2 · Filter — the chips

`.cs` `.asset` `.ts` `.js` `.py` start **on**; every other extension in the tree starts **off**, one
click away. A Unity tree is mostly `.meta`, a Node tree is mostly lockfile — facts to confirm, not
text to read.

The chips are generated from what is actually in the diff, with a count on each, so the shape of the
change is visible before anything is opened.

> **The hidden count is load-bearing, not decoration.** Filters that default to off can make a large
> diff look small, and *"my tree is fine"* is the most expensive wrong conclusion this page could
> cause. `12 of 91 files · 79 hidden` is always on screen, **show all** is one click, and
> **defaults** puts it back.

### 3 · Read — the hunks

Unified, not side-by-side: it works at any width and does not double the eye's travel.

**The changed span of a modified line is marked.** This is the largest readability win after triage.
Two flat bands of red and green make the reader re-derive what changed on every line, forever. The
span snaps outward to whole tokens — a raw character diff of `100` → `250` shares the trailing `0`
and would mark `10` → `25`, cutting a number in half and making the eye undo the highlight before it
can read either value.

Only **equal-length** del/add runs are paired. Unequal runs mean lines were inserted or removed
rather than edited, and pairing them by index invents correspondences between lines that have nothing
to do with each other — worse than no highlight at all.

Also: whitespace-only changes are dimmed rather than hidden; the `@@` section heading (git's guess at
the enclosing function) is kept and sticks while you scroll the file; renames render as renames,
which is the single largest source of fake volume in a review page.

---

## 4 · Comment — the line, and the agent that owns the tree

Hover any line on the served page for a `+`. It opens a git-style box; what you write is sent to the
session that served the page and enters its chat **as an ordinary prompt** — same history, same `user`
bubble, same queueing rules as typing it. There is one input path in `app.ts` and comments go down it,
because a second entry point is a second copy of those decisions and the first thing to drift would be
the one nobody sees until it breaks.

The agent receives it with a marker naming where it came from:

    <comment-response diffPath='http://127.0.0.1:7773/diff?rev=HEAD' id="c-8685e95b">
    Assets/…/SpeedsCore.cs:142 (current side of the diff)
    + int x = (int)cfg.ratio;

    this truncates the float

`prompts/ayin/system.txt` teaches the agent what that means: read the file and MAKE THE EDIT, fix the
cause rather than the quoted line, and never build a diff page or open a browser — the harness does
that half, deliberately, because leaving the reload to the model makes it probabilistic.

**The thread on the page shows `pending` → `working` → `done`, with a clock.** A comment written while
the agent is mid-turn is folded into that turn rather than starting a second one, so it stays
`pending` until the turn absorbs it. Elapsed time ticks beside the state: "working…" alone looks the
same after four minutes as after four seconds, and the operator cannot otherwise tell a long edit from
a dead session. When the turn ends the page reloads **the same URL**, which re-collects from the new
working tree, and the agent's closing message appears under the comment.

**And the operator can ask for that reload directly.** A refresh FAB in the bottom-right corner does
what the post-turn reload does — same URL, same re-collect — for the case the agent was never involved
in: an edit made in an editor, a `git add`, a stash. It reuses the anchor rather than adding a second
one: `rememberViewport()` stores the topmost on-screen file under the same key `restore()` reads, with
no line number, so `restore()` fails to match a row and falls back to the file. That fallback is the
correct behaviour here, not a compromise — after a refresh the line numbers are exactly what moved.
The button disarms itself on click, because a re-collect on a large tree is not instant and a
dead-looking button gets clicked twice, which is a second full collect for nothing. A `file://` page
has no server to re-collect from, so it carries no FAB — absent rather than broken, the same call this
page makes about comments.

Threads are appended to `~/.ayin-cli/diffs/comments-<repo>.jsonl` — one record per creation, one per
status change, current state is the fold. A comment is the operator's writing and the answer may take
minutes, so a browser refresh, a second session or a power cut must not lose it; an interrupted append
costs the last line, never the thread. A thread still waiting when the page reloads keeps its clock and
keeps polling. Comments left unanswered by a session that exited are failed **by name** at the next
boot rather than polled forever.

**Line numbers move**, and that is the point — the fix shifts every line below it. A comment is
anchored to `{file, side, lineNo, lineText}` and re-attaches only when all four still agree. When they
do not, the thread is shown at the top of its file with its original coordinates and a note that the
line has changed, because a comment silently re-pinned to whatever now occupies line 142 attributes
the operator's words to code they never read.

### What it is not, yet

One turn produces one closing message, so several comments folded into the same turn currently share
it, labelled as shared. Routing a specific paragraph back to a specific thread is
`docs/DIFF_COMMENTS_PLAN.md` §4 — the model wraps an answer in `<comment id="…">`, recognised
generously and verified strictly — and it is not built.

### The endpoint is small on purpose

    GET  /diff?rev=<rev>              the page, re-collected per request
    POST /api/diff/comment            { rev, file, side, lineNo, lineText, text } → { id, status }
    GET  /api/diff/comment/<id>       { status, response, error }

Same origin, so nothing about the port is baked into the HTML and there is no CORS to allow. The port
walks up from 7773 when it is taken: one server per session, published to
`~/.ayin-cli/daemon-<pid>.json`, so a page always talks to the session that owns its tree — and a
comment reaching a different repo's agent is not a mistake worth routing around.

**A POST here starts an agent turn, and the agent has a shell.** The bind is loopback-only, and every
mutating request is refused unless its `Origin` is this session and its `Host` is loopback: a page on
the internet cannot read a reply from 127.0.0.1, but it does not need to when the POST itself is the
effect.

---

## Limits, and why they are reported

Two caps, both **visible on the page**. A truncation the reader cannot see is indistinguishable from
a small diff.

| | |
|---|---|
| `MAX_LINES_PER_FILE` 2000 | a generated file's 40k-line change is a fact, not something to read |
| `MAX_TOTAL_LINES` 60000 | the whole-page budget |
| `MAX_FILES` 500 | past this it stops being a review and becomes a scroll |

**Tracked changes spend the page budget first**, and this rule is the reason the feature works.
Measured, not guessed: the first run against a real tree produced a **48 MB page** — 341k lines, 439
of them generated `.js` from build-output directories that were untracked but not ignored, and *none
of the actual source*. A per-file cap does nothing there; no single file was large, there were simply
hundreds. Sorting by size and truncating kept the noise and discarded every real change.

So: a file git already tracks is a change made on purpose, and an untracked one may be build output
nobody looked at. When something must be dropped, that decides which. Past the budget a file keeps
its row, its status and its **true** `+`/`−` counts — the sidebar and totals stay honest — and only
its body is dropped, with the page saying so.

Same tree after the rule: **2.8 MB**.

---

## Gate

`npm run check:diff` — no LLM, no network, no browser. It builds a git repo containing a
modification, a deletion, a rename, a binary, a path with a space and untracked files, and then:

- **checks every file's `+`/`−` against `git diff --numstat`.** This is the load-bearing one.
  Presentation bugs are annoying; a review page that under-reports a change is dangerous, because the
  reader concludes their tree is safe on evidence the tool invented.
- **checks escaping** with a file containing `</script><img src=x onerror=…>`. Diff text is arbitrary
  source, and this is the one failure here that is a security bug rather than a readability one.
- **reproduces the 48 MB shape** — many untracked generated files beside a few tracked changes — and
  asserts that every tracked file keeps its body, that omitted files still report true counts, and
  that the page stays inside a size a browser can open.
- asserts the span covers the whole token, that whitespace-only changes are flagged, that the default
  extension set is exactly the five, and that the hidden count is present.

`npm run check:comments` — the comment loop, over a real HTTP server against a real throwaway repo,
with a stub agent standing in for the TUI. It asserts the parts that only exist at the boundary: the
page's own javascript **parses** (nothing else here runs it), a foreign `Origin` is refused, a
wrongly-typed field fails loud naming the field, the marker and id reach the agent and the id survives
the round trip back out of the prompt text, the state moves `pending`→`working`→`done` as the page
sees it, and — the one that matters most — after the stub edits the file, **the same URL renders the
new code** with the thread and the reply still attached and the moved anchor shown as an orphan.
