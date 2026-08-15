# `/diff` — the working tree as something a person can actually read

```
/diff             the working tree against HEAD
/diff <rev>       against any rev — `/diff main` reviews a branch
ayin diff [<rev>] [--no-open]      the same page, from a shell
```

Staged, unstaged **and untracked** changes. Leaving untracked files out is the tempting
simplification and it is wrong: a new file is the part of a change most worth reviewing, and a page
that silently omits it teaches the reader to trust a picture missing its newest half.

The page is written to `~/.ayin-cli/diffs/` and opened with the desktop's default handler. It is one
self-contained file — no CDN, no font, no fetch — because it opens from `file://` on a machine that
may have no network, and a stylesheet that fails to load turns a review into a wall of text. The
palette is naamah's, so the two pages read as siblings.

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
