/**
 * sprint/render.ts — a SprintBoard as one self-contained HTML page.
 *
 * SIMPLE ON PURPOSE. This is not a Jira replacement and must not grow into one: columns, cards, and one
 * ticket open at a time. The question it answers is "what is on me, and what does that one say" — the two
 * things worth a browser rather than a terminal, because a description with steps to reproduce is
 * unreadable wrapped at 80 columns and a board is a shape, not a list.
 *
 * THE CARD IS A SUMMARY, THE DRAWER IS A FETCH. Cards carry what the sprint search already returned; the
 * description and comments arrive when a card is clicked (`/api/sprint/ticket/<KEY>`) and are cached for
 * the life of the page. Twenty detail fetches up front is a minute of waiting for nineteen tickets nobody
 * opened.
 *
 * THE COMMENT BOX IS CLOSED UNTIL ASKED FOR. `+ comment` reveals it; posting goes to Jira and the page
 * only shows the comment once the SERVER confirmed it exists there. An optimistic append is how an
 * operator closes a tab believing their words are on the ticket.
 *
 * Zero external assets — no CDN, no font, no image. The palette is the diff page's, so the two read as
 * siblings. Every value that reaches the DOM goes through `esc`: a ticket description is arbitrary text
 * from other people, including `</script>`.
 */

import type { SprintBoard } from './collect.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Cards are colour-coded by bucket, not by status: three colours a reader can hold, not eleven. */
const CATEGORY_CLASS: Record<string, string> = {
  'To Do': 'todo', 'In Progress': 'wip', Done: 'done',
};

/**
 * A card is a DIV with a button role, not a `<button>`.
 *
 * It has to hold its own copy button, and a button nested inside a button is invalid HTML — the parser
 * hoists the inner one out of the outer, which silently wrecks the card's layout rather than failing
 * anywhere visible. `role`/`tabindex` plus the Enter/Space handler in the client keep it reachable from
 * the keyboard, which is the only thing the element change would otherwise have cost.
 *
 * The copy button is omitted entirely when there is no site to link to — see `SprintBoard.browseBase`.
 */
function cardHtml(
  key: string, title: string, type: string, priority: string, updated: string, browseBase: string,
): string {
  const copy = browseBase
    ? `<button class="cp" data-url="${esc(`${browseBase}/${key}`)}" title="Copy the link to ${esc(key)}"`
      + ` aria-label="Copy the link to ${esc(key)}">link</button>`
    : '';
  return `<div class="card" role="button" tabindex="0" data-key="${esc(key)}">`
    + `<span class="krow"><span class="k">${esc(key)}</span>${copy}</span>`
    + `<span class="t">${esc(title)}</span>`
    + `<span class="meta">${esc(type)} · ${esc(priority)}${updated ? ` · ${esc(updated)}` : ''}</span>`
    + `</div>`;
}

export function renderSprintPage(board: SprintBoard): string {
  const columns = board.columns.map((c) => `
    <section class="col ${CATEGORY_CLASS[c.category] ?? 'other'}">
      <header><span class="name">${esc(c.status)}</span><span class="n">${c.issues.length}</span></header>
      <div class="cards">${c.issues.map((i) => cardHtml(i.key, i.title, i.issueType, i.priority, i.updated, board.browseBase)).join('')}</div>
    </section>`).join('');

  const empty = board.total === 0
    ? `<div class="empty">Nothing is assigned to you in this sprint. That is the board, not an error.</div>`
    : '';

  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sprint · ${esc(board.me)}</title>
<style>
:root{
  --bg:#0a0c12; --bg-glow:#131a2b; --surface:#141924; --surface-2:#1a2030; --surface-3:#212938;
  --line:#262e40; --ink:#e6ebf5; --ink-2:#a3aec4; --ink-3:#6b7689;
  --wire-hot:#8ba3ff; --todo:#6b7689; --wip:#d29922; --done:#3fb950; --err:#f0666f;
  --radius:13px;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --ui:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif;
}
[data-theme="light"]{
  --bg:#f4f6fb; --bg-glow:#e9eefa; --surface:#fff; --surface-2:#f6f8fc; --surface-3:#eef2f9;
  --line:#ccd6e4; --ink:#10151f; --ink-2:#4b5768; --ink-3:#77869a;
  --wire-hot:#3b6cf0; --todo:#77869a; --wip:#b45309; --done:#15803d; --err:#dc2626;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:var(--ui);-webkit-font-smoothing:antialiased}
body{display:flex;flex-direction:column;height:100vh;overflow:hidden;
  background:radial-gradient(ellipse 90% 60% at 50% -10%,var(--bg-glow),transparent 70%),var(--bg)}
.top{display:flex;align-items:baseline;gap:14px;padding:12px 18px;border-bottom:1px solid var(--line);
  background:var(--surface);flex-wrap:wrap}
.top h1{margin:0;font-size:14px;font-weight:650}
.top .sub{color:var(--ink-3);font-size:12px;font-family:var(--mono)}
.top .n{margin-left:auto;font:12px/1 var(--mono);color:var(--ink-2)}
.board{flex:1;display:flex;gap:14px;padding:16px 18px;overflow-x:auto;align-items:flex-start}
.col{flex:0 0 288px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  display:flex;flex-direction:column;max-height:100%}
.col>header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.col .name{font:600 12px/1 var(--ui);letter-spacing:.2px}
.col .n{margin-left:auto;font:11px/1 var(--mono);color:var(--ink-3)}
.col.todo>header{box-shadow:inset 3px 0 0 var(--todo)}
.col.wip>header{box-shadow:inset 3px 0 0 var(--wip)}
.col.done>header{box-shadow:inset 3px 0 0 var(--done)}
.col.other>header{box-shadow:inset 3px 0 0 var(--wire-hot)}
.cards{padding:9px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
.card{text-align:left;display:flex;flex-direction:column;gap:5px;padding:10px;cursor:pointer;
  background:var(--surface-2);border:1px solid var(--line);border-radius:10px;color:var(--ink);font:inherit}
.card{text-align:left;width:100%;box-sizing:border-box}
.card:hover{border-color:var(--wire-hot)}
.card:focus-visible{outline:2px solid var(--wire-hot);outline-offset:1px}
.card.on{border-color:var(--wire-hot);background:var(--surface-3)}
.card .k{font:600 11px/1 var(--mono);color:var(--wire-hot)}
.card .t{font-size:12.5px;line-height:1.35}
.card .meta{font:11px/1 var(--mono);color:var(--ink-3)}
.empty{padding:18px;color:var(--ink-2);font-size:13px}

/* ── the drawer: one ticket, opened over the board ── */
/* ── copy-link button, on every card and in the drawer ── */
.krow{display:flex;align-items:center;gap:6px}
.cp{font:600 9.5px/1 var(--ui);letter-spacing:.05em;text-transform:uppercase;
  color:var(--ink-3);background:none;border:1px solid var(--line);border-radius:5px;
  padding:2px 5px;cursor:pointer;opacity:.4;transition:opacity .12s,color .12s}
/* ALWAYS VISIBLE, just quiet. Hover-reveal was the first attempt and it is the wrong trade here: a
   button nobody can see is a button nobody knows exists, and this board is scanned rather than
   explored. Low opacity keeps it out of the way of the key and title without hiding it. */
.card:hover .cp,.cp:focus-visible{opacity:1}
.cp:hover{color:var(--wire-hot);border-color:var(--wire-hot)}
.cp.done{color:var(--done);border-color:var(--done);opacity:1}
.drawer .cp{opacity:1}
/* ── the agent thread ── */
.chat{margin:0 0 10px}
.chat:empty::after{content:'No discussion yet.';color:var(--ink-3);font:11.5px/1.5 var(--ui);font-style:italic}
.turn{border:1px solid var(--line);border-radius:10px;padding:8px 11px;margin:0 0 8px;background:var(--surface-2)}
.turn.ayin{border-color:color-mix(in srgb, var(--wire-hot) 45%, var(--line))}
.turn>.who{display:flex;align-items:center;gap:8px;font:600 10px/1 var(--ui);letter-spacing:.09em;
  text-transform:uppercase;color:var(--ink-3);margin:0 0 6px}
.turn.ayin>.who{color:var(--wire-hot)}
/* WHAT THE RUN SAID ON THE WAY, not what it concluded. Smaller, quieter, no border of its own and a
   rail instead — five of these must read as one sequence of steps rather than five answers, and the
   answer under them must be the loudest thing in the thread. */
.turn.note{border:none;border-left:2px solid var(--line);border-radius:0;background:none;
  margin:0 0 6px 12px;padding:2px 0 2px 11px;position:relative}
.turn.note>.who{display:none}
.turn.note .md{font:11.5px/1.55 var(--ui);color:var(--ink-3)}
.turn.note::before{content:'';position:absolute;left:-4px;top:9px;width:5px;height:5px;border-radius:50%;
  background:var(--line)}
/* The answer: bigger than everything around it and FOLDABLE, because a long report otherwise buries
   the question after it. A <details> keeps the keyboard, the screen reader and find-in-page working. */
.turn.ayin .md{font-size:13.5px;line-height:1.62}
details.turn>summary{cursor:pointer;list-style:none}
details.turn>summary::-webkit-details-marker{display:none}
details.turn>summary::marker{content:''}
.turn .foldh{margin-left:auto;font:600 10px/1 var(--mono);color:var(--ink-3)}
details.turn:not([open])>summary .foldh::after{content:' \\25B8'}
details.turn[open]>summary .foldh::after{content:' \\25BE'}
details.turn>summary:hover .foldh{color:var(--wire-hot)}
.post.ask{background:var(--wire-hot);border-color:var(--wire-hot)}
/* ── live progress ── */
/* What it is DOING, not that it is doing something: a spinner and a four-minute wait look identical,
   which is the complaint this answers. */
.prog{display:flex;align-items:center;gap:8px;margin:8px 0 0;padding:7px 10px;
  background:var(--surface-2);border:1px solid var(--line);border-radius:9px;
  font:11.5px/1.4 var(--ui);color:var(--ink-2)}
.prog[hidden]{display:none}
.prog .dot{width:7px;height:7px;border-radius:50%;background:var(--wire-hot);flex:none;
  animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
.prog .what{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--mono);font-size:11px;color:var(--ink)}
.prog .el{font:600 11px/1 var(--mono);color:var(--ink-3);flex:none}
.prog.stalled .dot{background:var(--prot);animation:none}
h3 .hint{margin-left:auto;font:400 10.5px/1 var(--mono);color:var(--ink-3);text-transform:none;letter-spacing:0}
/* markdown inside a turn */
.turn .md>*:first-child{margin-top:0}
.turn .md>*:last-child{margin-bottom:0}
.turn .md p{margin:0 0 7px}
.turn .md h3,.turn .md h4{font:600 12px/1.4 var(--ui);color:var(--ink);margin:10px 0 5px}
.turn .md ul,.turn .md ol{margin:0 0 7px;padding-left:19px}
.turn .md code{font:11px/1.5 var(--mono);background:var(--surface-3);border-radius:4px;padding:1px 4px}
.turn .md pre{margin:0 0 7px;padding:8px 10px;background:var(--bg);border:1px solid var(--line);
  border-radius:7px;overflow-x:auto}
.turn .md pre code{background:none;padding:0}
.turn .md blockquote{margin:0 0 7px;padding:2px 0 2px 9px;border-left:2px solid var(--line);color:var(--ink-2)}
.turn .md a{color:var(--wire-hot)}

/* ── refresh FAB ── */
/* Same shape and behaviour as /diff's, deliberately: two pages served by the same session should not
   disagree about what a refresh button looks like. The board is re-collected per request, so this is
   a reload — and the drawer is deliberately NOT reopened, because a ticket's detail is a separate
   fetch and reviving it would fire one the operator did not ask for. */
.fab{position:fixed;right:22px;bottom:22px;width:44px;height:44px;z-index:60;
  display:grid;place-items:center;cursor:pointer;border-radius:50%;
  color:var(--ink-2);background:var(--surface-2);border:1px solid var(--line);
  box-shadow:0 4px 16px rgba(0,0,0,.28)}
.fab:hover{color:var(--wire-hot);border-color:var(--wire-hot)}
.fab svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;
  stroke-linecap:round;stroke-linejoin:round}
.fab.busy{pointer-events:none;color:var(--wire-hot)}
.fab.busy svg{animation:fabspin .8s linear infinite;transform-origin:50% 50%}
@keyframes fabspin{to{transform:rotate(360deg)}}
/* The red X, a clear gap above the refresh FAB — the same arrangement /diff uses, for the same reason:
   a mis-aimed click for refresh must land on empty space, not on the one control that deletes something.
   It deletes CONVERSATION only: no Jira comment, no code, no run log. */
.fab.wipe{bottom:78px;color:var(--priv);border-color:color-mix(in srgb, var(--priv) 45%, var(--line))}
.fab.wipe:hover{color:var(--priv);border-color:var(--priv);
  background:color-mix(in srgb, var(--priv) 12%, var(--surface-2))}
.fab.wipe.busy{color:var(--priv)}
/* The drawer fills the right edge, so the FAB sat ON TOP of its bottom-right corner. That was always
   true and never mattered until the progress row put the elapsed clock there. An open drawer covers
   the board anyway — refreshing behind it buys nothing — so the FAB steps aside rather than the row
   being padded around a button that is in the wrong place. */
.drawer.open ~ .fab{display:none}
.drawer{position:fixed;inset:0 0 0 auto;width:min(620px,100%);background:var(--surface);
  border-left:1px solid var(--line);display:none;flex-direction:column;box-shadow:-24px 0 60px #0006}
.drawer.open{display:flex}
.drawer>header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line)}
.drawer h2{margin:0;font:600 13px/1.3 var(--ui)}
.drawer .key{font:600 12px/1 var(--mono);color:var(--wire-hot)}
.x{margin-left:auto;background:none;border:1px solid var(--line);border-radius:8px;color:var(--ink-2);
  cursor:pointer;font:12px/1 var(--ui);padding:6px 9px}
.x:hover{border-color:var(--wire-hot);color:var(--ink)}
.body{padding:14px 16px;overflow-y:auto;flex:1}
.body .st{font:11px/1 var(--mono);color:var(--ink-3);margin-bottom:12px}
.desc{white-space:pre-wrap;font-size:13px;line-height:1.5;color:var(--ink)}
h3{font:600 11px/1 var(--ui);letter-spacing:.6px;text-transform:uppercase;color:var(--ink-3);
  margin:20px 0 10px;display:flex;align-items:center;gap:8px}
.add{background:none;border:1px solid var(--line);border-radius:8px;color:var(--ink-2);cursor:pointer;
  font:600 13px/1 var(--mono);padding:4px 9px}
.add:hover{border-color:var(--wire-hot);color:var(--ink)}
.cmt{border:1px solid var(--line);border-radius:10px;padding:9px 11px;margin-bottom:8px;background:var(--surface-2)}
.cmt .who{font:600 11px/1 var(--mono);color:var(--ink-2)}
.cmt .when{font:11px/1 var(--mono);color:var(--ink-3);margin-left:7px}
.cmt .b{white-space:pre-wrap;font-size:12.5px;line-height:1.45;margin-top:6px}
.compose{display:none;flex-direction:column;gap:8px;margin-bottom:12px}
.compose.open{display:flex}
textarea{width:100%;min-height:84px;resize:vertical;background:var(--surface-2);color:var(--ink);
  border:1px solid var(--line);border-radius:10px;padding:9px 11px;font:12.5px/1.45 var(--ui)}
textarea:focus{outline:none;border-color:var(--wire-hot)}
.row{display:flex;gap:8px;align-items:center}
.post{background:var(--wire-hot);border:none;border-radius:8px;color:#0a0c12;cursor:pointer;
  font:600 12px/1 var(--ui);padding:8px 13px}
.post[disabled]{opacity:.5;cursor:default}
.say{font:11.5px/1.3 var(--mono);color:var(--ink-3)}
.say.err{color:var(--err)}
.say.ok{color:var(--done)}
</style></head>
<body>
<div class="top">
  <h1>sprint · ${esc(board.me)}</h1>
  <span class="sub">${esc(board.scope)}</span>
  <span class="n">${board.total} ticket(s) · ${esc(board.generatedAt.slice(0, 16).replace('T', ' '))}</span>
  <span class="n say" id="topsay"></span>
</div>
<div class="board">${columns}${empty}</div>

<aside class="drawer" id="drawer">
  <header><span class="key" id="d-key"></span><button class="cp" id="d-copy" title="Copy the link to this ticket" aria-label="Copy the link to this ticket" hidden>link</button><h2 id="d-title"></h2><button class="x" id="d-close">close</button></header>
  <div class="body">
    <div class="st" id="d-st"></div>
    <div class="desc" id="d-desc"></div>
    <h3>comments <span id="d-n"></span><button class="add" id="d-add" title="add a comment">+</button></h3>
    <div class="compose" id="d-compose">
      <textarea id="d-text" placeholder="This comment is posted to Jira as you."></textarea>
      <div class="row"><button class="post" id="d-post">post to Jira</button><span class="say" id="d-say"></span></div>
    </div>
    <div id="d-cmts"></div>

    <h3>ask ayin<span class="hint" id="d-chat-path"></span></h3>
    <div class="chat" id="d-chat"></div>
    <div class="compose open">
      <textarea id="d-ask" placeholder="Ask about this ticket and the codebase. ayin searches, then answers here."></textarea>
      <div class="row"><button class="post ask" id="d-send">ask ayin</button><span class="say" id="d-asay"></span></div>
      <div class="prog" id="d-prog" hidden><span class="dot"></span><span class="what" id="d-what"></span><span class="el" id="d-el"></span></div>
    </div>
  </div>
</aside>

<button class="fab wipe" id="cclear" aria-label="Clear every ayin thread"
  title="Clear every ayin thread on every ticket — back to full defaults">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
</button>
<button class="fab" id="refresh" aria-label="Reload the board from Jira" title="Reload the board from Jira">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3.5V10h-6.5"/></svg>
</button>

<script>
const $ = (id) => document.getElementById(id);
const cache = new Map();
let openKey = null;

// ── the agent thread ───────────────────────────────────────────────────────────
// The file IS the thread, so this is a poll on a VERSION STAMP rather than a status machine: when the
// file grows, the agent has answered and the turns are re-rendered. Polling stops the moment the drawer
// closes or the stamp stops moving for long enough, because a page left open overnight must not keep
// asking.
let chatVer = null;
let chatTimer = null;
let chatIdle = 0;
/** The newest thing the run said, as plain text. Feeds the progress row. */
let lastNote = '';

// Three shapes, because a thread holds three different things: the question, the steps the run took, and
// the answer. The answer is a <details open> — bigger than the rest and foldable with no javascript, so a
// long report can be put away without losing it.
function paintChat(turns) {
  const box = $('d-chat');
  if (!box) return;
  lastNote = '';
  box.innerHTML = (turns || []).map((t) => {
    const when = t.when ? ' · ' + t.when.slice(0, 19).replace('T', ' ') : '';
    if (t.who === 'ayin') {
      return '<details class="turn ayin" open><summary class="who">ayin' + when
        + '<span class="foldh">fold</span></summary>'
        + '<div class="md">' + t.html + '</div></details>';
    }
    if (t.who === 'note') {
      // Kept for the progress row: the newest thing the run said is a better "what is happening" than
      // any spinner, and the row is where the elapsed clock lives.
      lastNote = t.html.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim();
      return '<div class="turn note"><span class="who">note' + when + '</span>'
        + '<div class="md">' + t.html + '</div></div>';
    }
    return '<div class="turn you"><span class="who">' + (t.who || 'note') + when + '</span>'
      + '<div class="md">' + t.html + '</div></div>';
  }).join('');
}

async function pollChat(key, force) {
  if (openKey !== key) return;
  try {
    const r = await fetch('/api/sprint/chat/' + encodeURIComponent(key));
    const j = await r.json();
    if (!r.ok) return;
    if (force || j.version !== chatVer) {
      const had = chatVer;
      chatVer = j.version;
      chatIdle = 0;
      paintChat(j.turns);
      // The answer landing is the file growing AFTER we asked. That is the only completion signal in
      // this design, and it is a real one — nothing marks a turn done because nothing needs to.
      const last = (j.turns || [])[(j.turns || []).length - 1];
      if (had !== null && last && last.who === 'ayin') stopProg();
    } else {
      chatIdle++;
    }
  } catch (e) { chatIdle++; }
}

function startChat(key) {
  stopChat();
  chatVer = null;
  chatIdle = 0;
  $('d-chat').innerHTML = '';
  $('d-asay').textContent = '';
  void pollChat(key, true);
  // Every 2s while something might be coming, then it gives up: 90 idle polls is three minutes of a
  // quiet file, which is longer than a search-and-answer turn takes and short enough not to poll a
  // forgotten tab forever. Asking again restarts it.
  chatTimer = setInterval(() => {
    if (openKey !== key || chatIdle > 90) { stopChat(); return; }
    void pollChat(key, false);
  }, 2000);
}

function stopChat() {
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
  stopProg();
}

{
  const send = $('d-send');
  if (send) send.addEventListener('click', async () => {
    const key = openKey;
    const text = $('d-ask').value.trim();
    if (!key || !text) return;
    send.disabled = true;
    $('d-asay').textContent = 'sending…';
    try {
      const r = await fetch('/api/sprint/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, text }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      $('d-ask').value = '';
      // The operator turn is already in the file; show it at once and let the poll bring the answer.
      $('d-asay').textContent = '';
      chatIdle = 0;
      await pollChat(key, true);
      startChat(key);
      startProg();
    } catch (e) {
      $('d-asay').textContent = String(e.message || e);
    } finally {
      send.disabled = false;
    }
  });
}

// ── live progress ──────────────────────────────────────────────────────────────
// Two facts, both honest and both cheap: WHAT the run is doing — the newest thing it SAID, which the
// chat poll already fetched — and HOW LONG it has been going. A bare spinner cannot tell four seconds
// from four minutes, which is the whole reason this exists.
//
// It used to read /api/agent/state, the serving session's own indicator. That stopped being the truth
// the moment a question became its OWN headless run: the session is idle while the run works, so the row
// said "queued" for the entire answer. The run's notes are the state now, and they cost no request.
let progTimer = null;
let askedAt = 0;

function fmtEl(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
}

function showProg(on) {
  const box = $('d-prog');
  if (box) box.hidden = !on;
  if (!on) { $('d-what').textContent = ''; $('d-el').textContent = ''; box && box.classList.remove('stalled'); }
}

function tickProg() {
  const box = $('d-prog');
  if (!box || box.hidden) return;
  $('d-el').textContent = fmtEl(Date.now() - askedAt);
  if (!lastNote) {
    // Nothing said yet. Say THAT rather than showing a confident spinner — the run has to start, load
    // its prompt and reach the model before it can have an opinion.
    $('d-what').textContent = 'the run has started and not said anything yet';
    box.classList.add('stalled');
    return;
  }
  box.classList.remove('stalled');
  $('d-what').textContent = lastNote.length > 160 ? lastNote.slice(0, 159) + '…' : lastNote;
}

function startProg() {
  stopProg();
  askedAt = Date.now();
  showProg(true);
  tickProg();
  progTimer = setInterval(tickProg, 1000);
}

function stopProg() {
  if (progTimer) { clearInterval(progTimer); progTimer = null; }
  showProg(false);
}

// ── refresh ────────────────────────────────────────────────────────────────────
// The route re-collects the sprint on every GET, so a reload IS the refresh — no cache to invalidate
// and no URL to move. Disarmed on click: a Jira round-trip is not instant and a dead-looking button
// gets pressed twice, which is a second sprint query for nothing.
{
  const fab = document.getElementById('refresh');
  if (fab) fab.onclick = () => { fab.classList.add('busy'); location.reload(); };
}

// ── clear every ayin thread ────────────────────────────────────────────────────
// Irreversible, so it confirms — and the dialog states the blast radius in both directions, because the
// two things this page can delete are very different: a Jira comment is public and permanent, and this
// is a local conversation. Nothing here touches Jira, the code, or the run logs.
function say(text) {
  const el = $('topsay');
  if (!el) return;
  el.textContent = text;
  // It reports an action, not a state — left on screen it would still be claiming something about a
  // board that has since been reloaded and re-asked.
  setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 6000);
}

{
  const cx = document.getElementById('cclear');
  if (cx) cx.onclick = async () => {
    if (!window.confirm('Clear every ayin thread\\n\\nEvery question you asked ayin about every ticket, '
      + 'and every answer, is deleted \\u2014 back to full defaults. Jira comments, your code and the run '
      + 'logs are NOT touched.\\n\\nThis cannot be undone. Continue?')) return;
    cx.classList.add('busy');
    try {
      const r = await fetch('/api/sprint/chat', { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      // The open drawer is showing a thread that no longer exists. Repaint it from the truth rather
      // than reloading the board, which would cost a Jira query to show the same cards.
      if (openKey) { chatVer = null; await pollChat(openKey, true); }
      // IN THE HEADER, not in the drawer. This FAB is only clickable while the drawer is CLOSED (the
      // drawer covers that corner and the FAB steps aside), so a message written into the drawer would
      // be a message nobody ever reads.
      say('cleared ' + j.cleared + ' thread(s)');
    } catch (e) {
      say('not cleared: ' + String(e.message || e));
    } finally {
      cx.classList.remove('busy');
    }
  };
}

const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function renderComments(list) {
  $('d-n').textContent = list.length ? '(' + list.length + ')' : '(none)';
  $('d-cmts').innerHTML = list.length
    ? list.map((c) => '<div class="cmt"><span class="who">' + esc(c.author) + '</span>'
        + '<span class="when">' + esc(c.created) + '</span>'
        + '<div class="b">' + esc(c.body) + '</div></div>').join('')
    : '';
}

async function open(key) {
  openKey = key;
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('on', c.dataset.key === key));
  $('drawer').classList.add('open');
  $('d-key').textContent = key;
  startChat(key);
  {
    // Reuse the card's own URL rather than rebuilding one here: the base lives on the board, and a
    // second place that concatenates it is a second place for it to be wrong.
    const src = document.querySelector('.card[data-key="' + key + '"] .cp[data-url]');
    const dc = $('d-copy');
    if (dc) {
      if (src) { dc.dataset.url = src.dataset.url; dc.hidden = false; }
      else { dc.hidden = true; }
    }
  }
  $('d-compose').classList.remove('open');
  $('d-say').textContent = '';
  $('d-say').className = 'say';
  const hit = cache.get(key);
  if (hit) { paint(hit); return; }
  $('d-title').textContent = 'reading ' + key + '…';
  $('d-desc').textContent = '';
  $('d-cmts').innerHTML = '';
  try {
    const r = await fetch('/api/sprint/ticket/' + encodeURIComponent(key));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    cache.set(key, j);
    if (openKey === key) paint(j);
  } catch (e) {
    // The failure is SHOWN. A drawer stuck on "reading…" is indistinguishable from a slow network.
    $('d-title').textContent = 'could not read ' + key;
    $('d-desc').textContent = String(e.message || e);
  }
}

function paint(t) {
  $('d-title').textContent = t.title;
  $('d-st').textContent = [t.status, t.issueType, t.priority, t.reporter ? 'filed by ' + t.reporter : ''].filter(Boolean).join(' · ');
  $('d-desc').textContent = t.description || '(no description)';
  renderComments(t.comments || []);
}

// ── copy a ticket link ─────────────────────────────────────────────────────────
// stopPropagation on both events, because the button lives INSIDE the card's own click target: without
// it, copying a link would also open the drawer and fire a detail fetch nobody asked for. The label
// confirms in place rather than via a toast — the button is where the eye already is.
function copyLink(btn, url) {
  if (!navigator.clipboard) { btn.textContent = 'no clipboard'; return; }
  navigator.clipboard.writeText(url).then(() => {
    btn.textContent = 'copied';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = 'link'; btn.classList.remove('done'); }, 1200);
  }).catch(() => { btn.textContent = 'failed'; setTimeout(() => { btn.textContent = 'link'; }, 1200); });
}

document.querySelectorAll('.cp[data-url]').forEach((b) => {
  b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); copyLink(b, b.dataset.url); });
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
});

{
  const dc = $('d-copy');
  if (dc) dc.addEventListener('click', () => { if (dc.dataset.url) copyLink(dc, dc.dataset.url); });
}

// The card is a div with role=button (it has to hold the copy button), so Enter and Space are ours to
// handle — a real <button> gave that for free.
document.querySelectorAll('.card').forEach((c) => {
  c.addEventListener('click', () => open(c.dataset.key));
  c.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    open(c.dataset.key);
  });
});
$('d-close').addEventListener('click', () => {
  stopChat();   // a closed drawer must not keep polling a file nobody is looking at
  $('drawer').classList.remove('open');
  openKey = null;
  document.querySelectorAll('.card').forEach((c) => c.classList.remove('on'));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('d-close').click(); });

$('d-add').addEventListener('click', () => {
  $('d-compose').classList.toggle('open');
  if ($('d-compose').classList.contains('open')) $('d-text').focus();
});

$('d-post').addEventListener('click', async () => {
  const text = $('d-text').value.trim();
  const say = $('d-say');
  if (!text || !openKey) { say.className = 'say err'; say.textContent = 'nothing to post'; return; }
  $('d-post').disabled = true;
  say.className = 'say';
  say.textContent = 'posting to ' + openKey + '…';
  try {
    const r = await fetch('/api/sprint/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: openKey, text }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    // Only now: the server confirmed the comment exists on the ticket.
    const t = cache.get(openKey);
    if (t) { t.comments = (t.comments || []).concat([j.comment]); renderComments(t.comments); }
    $('d-text').value = '';
    $('d-compose').classList.remove('open');
    say.className = 'say ok';
    say.textContent = 'posted to ' + openKey;
  } catch (e) {
    say.className = 'say err';
    say.textContent = String(e.message || e);
  } finally {
    $('d-post').disabled = false;
  }
});
</script>
</body></html>
`;
}
