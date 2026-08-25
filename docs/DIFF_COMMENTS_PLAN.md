# Plan — in-diff comments, wired to the live agent session

**Status: BUILT 2026-08-18, with two deliberate deviations and one part not done.** `docs/DIFF.md` describes
what shipped; this document is kept for the reasoning and for §4, which is still the design to follow.

- **§2 transport — deviated.** POST up, **polling** down (1.2s), not SSE. The plan allowed polling as the
  fallback and said not to build both; this took the fallback without trying SSE first. Reconsider if the
  poll shows up in a profile — the state a page waits on changes at most twice per comment.
- **§4 reply routing — NOT BUILT, AND NO LONGER NEEDED (2026-08-25).** It existed to solve one problem:
  a turn produces one closing message, so comments folded into the same turn shared it. Comments are not
  folded into turns any more — each one spawns its own headless ayin (`src/diff/runner.ts`), so a closing
  message belongs to exactly one thread by construction. `<comment id="…">` markers, generous
  recognition, strict verification and the unrouted-reply area are all moot. Ids stay `c-<8 hex>`: no
  model has to echo one.
- **§5 versioned pages — deviated, and the plan's own goal is better served.** No `/page?v=<n>`: the route
  re-collects per request, so the URL is stable and the reload is `location.reload()`. The operator chose
  this shape explicitly ("let the daemon serve the page and we open the URL"), and it also removes the
  page-id from the comment store's key.
- Everything else landed as written, including the content-anchored re-location of §5 and every failure
  mode in the list at the end. The gate is `npm run check:comments` (the plan called it
  `check:diff-comments`).

**The mission in one sentence:** every line of the `/diff` page gets a `+comment` button; a comment becomes a
message to the *running* ayin session; the page shows pending → thinking → answered, and when the model has
replied (and possibly edited the code) the page reloads showing the new diff and the reply anchored to that
comment.

> **The middle clause changed in 2026-08-25.** A comment is no longer a message to the running session: it
> spawns its own headless run. Everything else in that sentence still holds, and `docs/DIFF.md` §4 is the
> description of what runs today.

---

## What exists today (verified, not assumed)

| | |
|---|---|
| `src/diff/collect.ts` (296 lines) | runs git, produces `DiffFile[]` with hunks and per-line change spans |
| `src/diff/render.ts` (287 lines) | pure function → one self-contained HTML string. `lineHtml(l: DiffLine)` renders one line |
| `src/diff/index.ts` (106 lines) | writes the page to `~/.ayin-cli/diffs/`, prunes >24h, opens via `openExternal` |
| `src/prompt-server.ts` | **the precedent**: an HTTP server already bound to `127.0.0.1:7773` for the prompt editor |
| `agent.ts#enqueueAgentMessage(msg)` | injects a message into the running session AND cancels active thinking so it lands on the next round |

The current page is deliberately **serverless**: *"a review page has no reason to open a port and a `file://`
URL works on a machine with no network."* That reasoning is sound and this feature is exactly the case that
overturns it — say so in the header comment when you change it, rather than silently contradicting it.

---

## The five decisions, and what I would choose

### 1. `file://` must become `http://127.0.0.1`

A page on `file://` cannot POST to a local server without tripping origin rules, and hacking around that with
`no-cors` gives you a request you cannot read the response of. **Serve the diff page from the same local
server that receives the comments.** One origin, no CORS, and the existing `prompt-server.ts` is the working
model for how ayin already does this.

Keep the file on disk as well: it is the artifact that survives the session, and a diff you can still read
after ayin exits is worth more than one that dies with the port.

### 2. Transport: SSE down, POST up

Not WebSockets. The page needs exactly two things — send a comment, and learn when its state changes — and
SSE plus POST does both with no framing library and no reconnect logic of your own. The resource layer
already speaks SSE (`/resource/llm/events`), so this matches the house style.

    POST /comment            { file, line, side, text }        → { id }
    GET  /events             SSE: { id, state, reply?, diffVersion? }
    GET  /                   the rendered page
    GET  /page?v=<n>         the re-rendered page after an edit

Polling is the fallback if SSE proves awkward under the operator's browser; do not build both.

### 3. Comments are PERSISTED, and that is not optional

`~/.ayin-cli/diffs/<pageId>/comments.jsonl`, one line per comment, appended. The power-cut rule applies with
full force here: a comment is the operator's writing, the model may take minutes to answer, and a browser
refresh or an ayin restart in between must not lose it. On boot, unanswered comments are readable and their
state is `pending` again — never silently dropped.

Ids: `c1`, `c2`, … per page. Short enough for a model to echo without typos, unique within the page, and
stable across reloads.

### 4. Routing the reply back — `<comment id=…>`

The operator's instinct is right, and the mechanism should be the one already proven in this codebase: the
**final marker** (`src/final-marker.ts`) is a single `$` the model emits, parsed by a module with no imports
and its own gate. Copy that shape exactly:

    src/diff/comment-marker.ts        parse + strip, no imports, own gate

The prompt asks for `<comment id="c3">…</comment>` around the part of the reply that answers that comment.
Then, and this is the part that decides whether the feature is trustworthy:

- **A reply with no marker is not an error.** Attach it to the single outstanding comment if there is exactly
  one; otherwise mark it unrouted and show it in the page's general area. Never guess between two.
- **A marker naming an unknown id is dropped, loudly.** Inventing an anchor is worse than having none.

This is the same lesson the final marker learned: models put the signal in a different place than you asked,
so recognise generously and verify strictly.

### 5. "The page reloads and I see updated code"

The reload is the easy half; the hard half is that the diff must be **re-collected**, because the model has
edited the tree. So:

1. model finishes → harness re-runs `collectDiff()`
2. re-render to a NEW page file, `diffVersion` incremented
3. SSE pushes `{ id, state: 'answered', reply, diffVersion }`
4. the JS reloads to `/page?v=<diffVersion>` and scrolls to the comment's anchor

⚠️ **Line numbers move.** A comment on line 211 of the old diff may be line 207 after an edit — a real fix
observed while designing this removed four comment lines above the change. Anchor a comment to
`{ file, side, lineContent, nearbyHash }`, not to a bare line number, and re-locate on re-render. When
re-location fails, say so on the comment ("the line this was on has changed") rather than silently pinning it
somewhere plausible and wrong.

---

## Build order

Each step ends somewhere demonstrable. Do not proceed past a step that cannot be shown working.

1. **Server + serve the existing page.** No comments yet. `ayin diff` opens `http://127.0.0.1:<port>` and looks
   exactly as it does today. Bind loopback only.
2. **`+comment` button and the form**, client side only, posting to a `/comment` endpoint that just persists
   and echoes an id. Reload the page and the comments are still there.
3. **Wire to the session.** `enqueueAgentMessage` with the formatted message. Watch it arrive in the TUI. No
   reply routing yet — this is the step that proves the two processes can talk.
4. **SSE states.** pending → thinking → answered, driven from the agent's existing lifecycle.
5. **Reply routing** via `<comment id=…>`, with the two failure rules from §4.
6. **Re-collect and reload**, with content-anchored re-location.

---

## The failure modes to design against, named now

- **Two ayin sessions, one port.** The second must not silently take over the first's comments. Bind, detect
  `EADDRINUSE`, and either attach to the running server or refuse with a clear message — `prompt-server.ts`
  already hit exactly this and its handling is the reference.
- **No session running.** `ayin diff` from a shell with no TUI has nowhere to send a comment. Say so in the
  page, disable the button, and keep the diff readable — do not accept a comment into a void.
- **The comment text is a PROMPT.** It reaches the model verbatim. That is the feature, and it is also an
  injection surface: bind to loopback, never `0.0.0.0`, and keep the page unreachable from the LAN. The same
  reasoning `prompt-server.ts` documents at its `listen` call.
- **A long reply, or none.** The model may take minutes or die. The page must show elapsed time and a state
  that is honest when nothing is coming back, rather than a spinner that means nothing.
- **The tree changed under the page.** The operator edits in their editor while the page is open. Re-collect
  on reload, and if the file no longer matches what the comment was anchored to, say so.

---

## What "done" means

- `npm run build` clean; `check:gates`, `check:diff` and a new `check:diff-comments` pass.
- A comment survives: browser refresh, ayin restart, and the model editing the file it points at.
- An unroutable reply is visible rather than lost, and a marker naming an unknown id is refused.
- `docs/DIFF.md` describes the new behaviour — a code change whose docs describe the old one is not done.
