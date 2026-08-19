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

function cardHtml(key: string, title: string, type: string, priority: string, updated: string): string {
  return `<button class="card" data-key="${esc(key)}">`
    + `<span class="k">${esc(key)}</span>`
    + `<span class="t">${esc(title)}</span>`
    + `<span class="meta">${esc(type)} · ${esc(priority)}${updated ? ` · ${esc(updated)}` : ''}</span>`
    + `</button>`;
}

export function renderSprintPage(board: SprintBoard): string {
  const columns = board.columns.map((c) => `
    <section class="col ${CATEGORY_CLASS[c.category] ?? 'other'}">
      <header><span class="name">${esc(c.status)}</span><span class="n">${c.issues.length}</span></header>
      <div class="cards">${c.issues.map((i) => cardHtml(i.key, i.title, i.issueType, i.priority, i.updated)).join('')}</div>
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
.card:hover{border-color:var(--wire-hot)}
.card.on{border-color:var(--wire-hot);background:var(--surface-3)}
.card .k{font:600 11px/1 var(--mono);color:var(--wire-hot)}
.card .t{font-size:12.5px;line-height:1.35}
.card .meta{font:11px/1 var(--mono);color:var(--ink-3)}
.empty{padding:18px;color:var(--ink-2);font-size:13px}

/* ── the drawer: one ticket, opened over the board ── */
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
</div>
<div class="board">${columns}${empty}</div>

<aside class="drawer" id="drawer">
  <header><span class="key" id="d-key"></span><h2 id="d-title"></h2><button class="x" id="d-close">close</button></header>
  <div class="body">
    <div class="st" id="d-st"></div>
    <div class="desc" id="d-desc"></div>
    <h3>comments <span id="d-n"></span><button class="add" id="d-add" title="add a comment">+</button></h3>
    <div class="compose" id="d-compose">
      <textarea id="d-text" placeholder="This comment is posted to Jira as you."></textarea>
      <div class="row"><button class="post" id="d-post">post to Jira</button><span class="say" id="d-say"></span></div>
    </div>
    <div id="d-cmts"></div>
  </div>
</aside>

<script>
const $ = (id) => document.getElementById(id);
const cache = new Map();
let openKey = null;

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

document.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => open(c.dataset.key)));
$('d-close').addEventListener('click', () => {
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
