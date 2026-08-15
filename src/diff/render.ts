/**
 * diff/render.ts — a DiffSet as one self-contained HTML page.
 *
 * The page is built around how a diff is actually read, which is not top to bottom:
 *
 *   1. TRIAGE — the sidebar lists every file with its +/− weight and status, so the reader decides
 *      what to look at before reading anything. A page that opens straight into hunk one asks them
 *      to form that judgement while already spending attention on code.
 *   2. FILTER — extension chips, with `.cs .asset .ts .js .py` on and everything else off. A Unity
 *      tree is mostly `.meta` and a Node tree is mostly lockfile; those are facts to confirm, not
 *      text to read.
 *   3. READ — unified hunks, with the changed SPAN of a modified line marked. Two flat bands of red
 *      and green make the reader re-derive what changed on every line, by eye, forever.
 *
 * The count line is load-bearing, not decoration. Filters that default to off can make a large diff
 * look small, and "your tree is fine" is the most expensive wrong conclusion this page could cause —
 * so the hidden count is always on screen, and one click shows everything.
 *
 * Zero external assets: no CDN, no font, no fetch. The page opens from a file:// URL on a machine
 * that may have no network, and a stylesheet that fails to load turns a review into a wall of text.
 * The palette is naamah's, so the two pages read as siblings.
 */

import type { DiffLine, DiffSet, FileDiff } from './collect.js';

/** On by default. Everything else in the tree starts hidden and is one click away. */
export const DEFAULT_EXTENSIONS = ['.cs', '.asset', '.ts', '.js', '.py'];

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Diff text is arbitrary source, including `</script>`. Every path into the page goes through esc. */
function lineHtml(l: DiffLine): string {
  if (!l.span) return esc(l.text) || '&nbsp;';
  const [a, b] = l.span;
  return `${esc(l.text.slice(0, a))}<mark>${esc(l.text.slice(a, b))}</mark>${esc(l.text.slice(b))}`;
}

const SIGN: Record<string, string> = { add: '+', del: '−', ctx: ' ' };

function fileBody(f: FileDiff): string {
  if (f.binary) return `<div class="note">binary · not shown</div>`;
  // The counts in the header are real; only the text was dropped. Saying which is the difference
  // between a reader who knows to open the file and one who thinks nothing changed in it.
  if (f.bodyOmitted) return `<div class="note">+${f.additions} −${f.deletions} — body not rendered (page line budget spent on tracked changes first)</div>`;
  if (!f.hunks.length) return `<div class="note">no textual change (mode or rename only)</div>`;
  const parts: string[] = [];
  for (const h of f.hunks) {
    parts.push(
      `<div class="hunk"><span class="at">${esc(h.header)}</span>`
      + (h.section ? `<span class="sect">${esc(h.section)}</span>` : '')
      + `</div>`,
    );
    for (const l of h.lines) {
      parts.push(
        `<div class="l ${l.kind}${l.wsOnly ? ' ws' : ''}">`
        + `<i class="n">${l.oldNo ?? ''}</i><i class="n">${l.newNo ?? ''}</i>`
        + `<i class="s">${SIGN[l.kind]}</i><code>${lineHtml(l)}</code></div>`,
      );
    }
  }
  if (f.truncated) parts.push(`<div class="note">truncated — too large to read here; open the file</div>`);
  return parts.join('');
}

function sidebarRow(f: FileDiff, i: number): string {
  const name = f.path.split('/').pop() ?? f.path;
  const dir = f.path.slice(0, f.path.length - name.length);
  return `<a class="row" href="#f${i}" data-i="${i}" data-ext="${esc(f.ext || '(none)')}">`
    + `<span class="st ${f.status}" title="${f.status}"></span>`
    + `<span class="nm"><b>${esc(name)}</b><em>${esc(dir)}</em></span>`
    + `<span class="ct"><b class="p">+${f.additions}</b><b class="m">−${f.deletions}</b></span></a>`;
}

export function renderDiffPage(set: DiffSet): string {
  const exts = new Map<string, number>();
  for (const f of set.files) exts.set(f.ext || '(none)', (exts.get(f.ext || '(none)') ?? 0) + 1);
  const chips = [...exts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const totalAdd = set.files.reduce((n, f) => n + f.additions, 0);
  const totalDel = set.files.reduce((n, f) => n + f.deletions, 0);

  const chipHtml = chips.map(([ext, n]) => {
    const on = DEFAULT_EXTENSIONS.includes(ext);
    return `<button class="chip${on ? ' on' : ''}" data-ext="${esc(ext)}">${esc(ext)}<i>${n}</i></button>`;
  }).join('');

  const filesHtml = set.files.map((f, i) => {
    const heading = f.oldPath ? `${esc(f.oldPath)} → ${esc(f.path)}` : esc(f.path);
    return `<section class="file" id="f${i}" data-i="${i}" data-ext="${esc(f.ext || '(none)')}">`
      + `<header class="fh"><span class="st ${f.status}"></span>`
      + `<h2>${heading}</h2>`
      + `<span class="tags">${f.untracked ? '<i class="tag new">untracked</i>' : ''}`
      + `${f.binary ? '<i class="tag">binary</i>' : ''}</span>`
      + `<span class="ct"><b class="p">+${f.additions}</b><b class="m">−${f.deletions}</b></span>`
      + `<button class="fold" title="collapse">–</button></header>`
      + `<div class="body">${fileBody(f)}</div></section>`;
  }).join('');

  const notices: string[] = [];
  if (set.filesOmitted) notices.push(`${set.filesOmitted} further file(s) are not listed at all — this diff exceeds the page's file limit.`);
  if (set.bodiesOmitted) notices.push(`${set.bodiesOmitted} file(s) are listed with true counts but no body — the page line budget was spent on tracked changes first.`);
  const omitted = notices.length ? `<div class="warn">${notices.map(esc).join('<br>')}</div>` : '';

  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(set.branch)} · working tree · ayin diff</title>
<style>
:root{
  --bg:#0a0c12; --bg-glow:#131a2b; --surface:#141924; --surface-2:#1a2030; --surface-3:#212938;
  --line:#262e40; --line-soft:#1e2534; --ink:#e6ebf5; --ink-2:#a3aec4; --ink-3:#6b7689;
  --wire-hot:#8ba3ff; --pub:#3fb950; --priv:#f0666f; --prot:#d29922;
  --add-bg:#0e2a17; --add-mark:#2ea04366; --del-bg:#2d1216; --del-mark:#f8514966;
  --radius:13px;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --ui:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif;
}
[data-theme="light"]{
  --bg:#f4f6fb; --bg-glow:#e9eefa; --surface:#fff; --surface-2:#f6f8fc; --surface-3:#eef2f9;
  --line:#ccd6e4; --line-soft:#e0e7f1; --ink:#10151f; --ink-2:#4b5768; --ink-3:#77869a;
  --wire-hot:#3b6cf0; --pub:#15803d; --priv:#dc2626; --prot:#b45309;
  --add-bg:#e6ffed; --add-mark:#abf2bc; --del-bg:#ffeef0; --del-mark:#fdb8c0;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:var(--ui);-webkit-font-smoothing:antialiased}
body{display:grid;grid-template-columns:322px 1fr;grid-template-rows:auto 1fr;height:100vh;overflow:hidden;
  background:radial-gradient(ellipse 90% 60% at 50% -10%,var(--bg-glow),transparent 70%),var(--bg)}

/* ── top bar ── */
.top{grid-column:1/-1;display:flex;align-items:center;gap:14px;padding:12px 18px;
  border-bottom:1px solid var(--line);background:var(--surface);flex-wrap:wrap}
.top h1{margin:0;font-size:14px;font-weight:650;letter-spacing:.2px}
.top .sub{color:var(--ink-3);font-size:12px;font-family:var(--mono)}
.stat{margin-left:auto;display:flex;gap:10px;align-items:center;font-family:var(--mono);font-size:12px}
.p{color:var(--pub)} .m{color:var(--priv)}
.chips{grid-column:1/-1;display:flex;gap:7px;padding:9px 18px;flex-wrap:wrap;align-items:center;
  border-bottom:1px solid var(--line);background:var(--surface-2)}
.chip{font:500 11.5px/1 var(--mono);color:var(--ink-3);background:var(--surface-3);
  border:1px solid var(--line);border-radius:999px;padding:5px 9px;cursor:pointer;display:flex;gap:6px;align-items:center}
.chip i{font-style:normal;opacity:.55;font-size:10.5px}
.chip.on{color:var(--bg);background:var(--wire-hot);border-color:var(--wire-hot);font-weight:650}
[data-theme="light"] .chip.on{color:#fff}
.chip:hover{border-color:var(--wire-hot)}
.count{margin-left:auto;font:12px/1 var(--mono);color:var(--ink-2)}
.count b{color:var(--ink)}
.act{font:11.5px/1 var(--ui);color:var(--ink-2);background:none;border:1px solid var(--line);
  border-radius:8px;padding:6px 10px;cursor:pointer}
.act:hover{color:var(--ink);border-color:var(--wire-hot)}

/* ── sidebar ── */
aside{overflow-y:auto;border-right:1px solid var(--line);background:var(--surface);padding:8px}
.row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:9px;
  text-decoration:none;color:var(--ink-2);font-size:12.5px}
.row:hover{background:var(--surface-3);color:var(--ink)}
.row.active{background:var(--surface-3);color:var(--ink);box-shadow:inset 2px 0 0 var(--wire-hot)}
.nm{min-width:0;flex:1;display:flex;flex-direction:column;line-height:1.35}
.nm b{font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nm em{font-style:normal;font-size:10.5px;color:var(--ink-3);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ct{font-family:var(--mono);font-size:10.5px;display:flex;gap:5px;white-space:nowrap}
.st{width:7px;height:7px;border-radius:2px;flex:none}
.st.added{background:var(--pub)} .st.deleted{background:var(--priv)}
.st.modified{background:var(--prot)} .st.renamed{background:var(--wire-hot)}

/* ── files ── */
main{overflow-y:auto;padding:14px 18px 60vh;scroll-behavior:smooth}
.file{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);
  margin-bottom:14px;overflow:hidden}
.fh{display:flex;align-items:center;gap:9px;padding:9px 12px;background:var(--surface-2);
  border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
.fh h2{margin:0;font:600 12.5px/1.4 var(--mono);word-break:break-all;flex:1}
.tags{display:flex;gap:5px}
.tag{font:500 10px/1 var(--ui);font-style:normal;padding:3px 6px;border-radius:5px;
  background:var(--surface-3);color:var(--ink-3);border:1px solid var(--line)}
.tag.new{color:var(--pub);border-color:var(--pub)}
.fold{background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:15px;line-height:1;padding:2px 5px}
.fold:hover{color:var(--ink)}
.file.folded .body{display:none}
.body{overflow-x:auto}
.l{display:flex;font:12px/1.55 var(--mono);white-space:pre}
.l .n{font-style:normal;flex:none;width:46px;text-align:right;padding-right:9px;color:var(--ink-3);
  user-select:none;opacity:.65}
.l .s{font-style:normal;flex:none;width:16px;text-align:center;color:var(--ink-3);user-select:none}
.l code{padding-right:18px;flex:1}
.l.add{background:var(--add-bg)} .l.add .s{color:var(--pub)}
.l.del{background:var(--del-bg)} .l.del .s{color:var(--priv)}
.l.ws{opacity:.5}
mark{background:var(--add-mark);color:inherit;border-radius:3px;padding:1px 0}
.l.del mark{background:var(--del-mark)}
.hunk{display:flex;gap:12px;padding:5px 12px;background:var(--surface-3);
  border-top:1px solid var(--line-soft);border-bottom:1px solid var(--line-soft);
  font:11.5px/1.5 var(--mono);position:sticky;top:36px;z-index:1}
.at{color:var(--wire-hot);opacity:.8} .sect{color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.note{padding:11px 14px;color:var(--ink-3);font-size:12px;font-style:italic}
.warn{margin:0 0 14px;padding:11px 14px;border:1px solid var(--prot);border-radius:var(--radius);
  color:var(--prot);font-size:12.5px;background:var(--surface)}
.empty{color:var(--ink-3);padding:40px;text-align:center;font-size:13px}
kbd{font:10.5px/1 var(--mono);border:1px solid var(--line);border-bottom-width:2px;
  border-radius:4px;padding:3px 5px;color:var(--ink-3)}
</style></head><body>
<div class="top">
  <h1>${esc(set.branch)}</h1>
  <span class="sub">vs ${esc(set.against)} · ${esc(set.head)}</span>
  <span class="stat">
    <b class="p">+${totalAdd}</b><b class="m">−${totalDel}</b>
    <kbd>j</kbd><kbd>k</kbd> file <kbd>t</kbd> theme
    <button class="act" id="theme">light</button>
  </span>
</div>
<div class="chips">${chipHtml}
  <span class="count" id="count"></span>
  <button class="act" id="all">show all</button>
  <button class="act" id="none">defaults</button>
</div>
<aside id="side">${set.files.map(sidebarRow).join('')}</aside>
<main id="main">${omitted}${filesHtml || '<div class="empty">Working tree is clean.</div>'}</main>
<script>
(function(){
  var DEF = ${JSON.stringify(DEFAULT_EXTENSIONS)};
  var on = new Set(DEF);
  var files = [].slice.call(document.querySelectorAll('.file'));
  var rows  = [].slice.call(document.querySelectorAll('.row'));
  var chips = [].slice.call(document.querySelectorAll('.chip'));
  var cur = -1;

  function apply(){
    var shown = 0;
    files.forEach(function(f, i){
      var vis = on.has(f.dataset.ext);
      f.style.display = vis ? '' : 'none';
      rows[i].style.display = vis ? '' : 'none';
      if (vis) shown++;
    });
    chips.forEach(function(c){ c.classList.toggle('on', on.has(c.dataset.ext)); });
    var total = files.length, hidden = total - shown;
    // Always on screen. A filter that defaults to off can make a large diff look small, and
    // "the tree is fine" is the most expensive wrong conclusion this page could produce.
    document.getElementById('count').innerHTML =
      '<b>' + shown + '</b> of ' + total + ' files' + (hidden ? ' \\u00b7 ' + hidden + ' hidden' : '');
  }

  chips.forEach(function(c){
    c.onclick = function(){
      if (on.has(c.dataset.ext)) on.delete(c.dataset.ext); else on.add(c.dataset.ext);
      apply();
    };
  });
  document.getElementById('all').onclick = function(){
    chips.forEach(function(c){ on.add(c.dataset.ext); }); apply();
  };
  document.getElementById('none').onclick = function(){ on = new Set(DEF); apply(); };

  files.forEach(function(f){
    f.querySelector('.fold').onclick = function(){
      f.classList.toggle('folded');
      this.textContent = f.classList.contains('folded') ? '+' : '\\u2013';
    };
  });

  function focusFile(i){
    var vis = files.filter(function(f){ return f.style.display !== 'none'; });
    if (!vis.length) return;
    cur = Math.max(0, Math.min(i, vis.length - 1));
    var f = vis[cur];
    f.scrollIntoView({ block: 'start' });
    rows.forEach(function(r){ r.classList.remove('active'); });
    var r = rows[+f.dataset.i]; if (r) r.classList.add('active');
  }
  document.onkeydown = function(e){
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'j') { focusFile(cur + 1); e.preventDefault(); }
    else if (e.key === 'k') { focusFile(cur - 1); e.preventDefault(); }
    else if (e.key === 't') { document.getElementById('theme').click(); }
  };

  var t = document.getElementById('theme');
  t.onclick = function(){
    var dark = document.documentElement.dataset.theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    t.textContent = dark ? 'dark' : 'light';
  };

  apply();
})();
</script></body></html>`;
}
