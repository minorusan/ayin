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
import type { DiffComment } from './comments.js';

/**
 * Comments exist only on the SERVED page. A `file://` page has no session to send one to, so the
 * affordance is absent there rather than present and broken — see diff/server.ts for why the page is
 * a route at all.
 */
export interface RenderOptions {
  interactive?: boolean;
  /**
   * The drafted commit message, read from `.git/COMMIT_EDITMSG` by the CALLER.
   *
   * Passed in rather than read here: this module renders, and a renderer that reaches into `.git`
   * cannot be handed a set collected from somewhere else. Absent means no draft exists yet, which is
   * a state the panel says out loud instead of hiding.
   */
  commitDraft?: string | null;
  /** The rev this page compares against, echoed back on every comment so a reload re-renders it. */
  rev?: string;
  comments?: DiffComment[];
}

interface Resolved {
  interactive: boolean;
  commitDraft: string | null;
  rev: string;
  /** file → `side:lineNo` → the thread on that line, oldest first. */
  byFile: Map<string, Map<string, DiffComment[]>>;
  /** Ids actually placed against a line, so the rest can be shown as orphans instead of vanishing. */
  placed: Set<string>;
}

function resolve(opts: RenderOptions): Resolved {
  const byFile = new Map<string, Map<string, DiffComment[]>>();
  for (const c of opts.comments ?? []) {
    let byLine = byFile.get(c.file);
    if (!byLine) { byLine = new Map(); byFile.set(c.file, byLine); }
    const key = `${c.side}:${c.lineNo}`;
    const list = byLine.get(key);
    if (list) list.push(c); else byLine.set(key, [c]);
  }
  return {
    interactive: opts.interactive === true, rev: opts.rev || 'HEAD', byFile, placed: new Set(),
    commitDraft: opts.commitDraft ?? null,
  };
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'pending…', working: 'working…', done: 'done', failed: 'failed',
};

/**
 * One thread. `data-cid`/`data-status` are what let a RELOAD resume: a comment still working when the
 * page reloaded must keep showing its spinner and keep polling, or the operator is left staring at a
 * thread that looks abandoned while the agent is still editing.
 */
function threadHtml(list: DiffComment[]): string {
  const items = list.map((c) => {
    // ELAPSED, NOT JUST A STATE. "working…" on its own is the spinner that means nothing: after four
    // minutes it looks exactly like it did after four seconds, and the operator cannot tell a long
    // edit from a dead session. The client ticks this while the state is not terminal.
    const since = c.startedAt || c.createdAt;
    const age = c.status === 'pending' || c.status === 'working'
      ? `<span class="age" data-since="${esc(since)}"></span>` : '';
    const badge = `${age}<span class="badge ${c.status}">${STATUS_LABEL[c.status] ?? esc(c.status)}</span>`;
    const reply = c.status === 'done' && c.response
      ? `<div class="cmt reply"><div class="cmt-h"><span class="who">ayin</span></div>`
        + `<div class="cmt-b">${esc(c.response)}</div></div>`
      : '';
    const failed = c.status === 'failed' && c.error
      ? `<div class="cmt reply err"><div class="cmt-b">${esc(c.error)}</div></div>`
      : '';
    return `<div class="cmt" data-cid="${esc(c.id)}" data-status="${esc(c.status)}">`
      + `<div class="cmt-h"><span class="who">you</span>${badge}</div>`
      + `<div class="cmt-b">${esc(c.text)}</div></div>${reply}${failed}`;
  }).join('');
  return `<div class="thread">${items}</div>`;
}

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

function fileBody(f: FileDiff, o: Resolved): string {
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
      // A comment names a SIDE and a number: the removed line and the line that replaced it are two
      // different things to have an opinion about, and `142` alone does not say which.
      const side = l.newNo !== null ? 'new' : 'old';
      const lineNo = l.newNo ?? l.oldNo;
      const canComment = o.interactive && lineNo !== null;
      parts.push(
        `<div class="l ${l.kind}${l.wsOnly ? ' ws' : ''}"`
        + (lineNo !== null ? ` data-line="${lineNo}" data-side="${side}"` : '')
        + `>`
        + `<i class="n">${l.oldNo ?? ''}</i><i class="n">${l.newNo ?? ''}</i>`
        + (canComment ? `<button class="cbtn" title="comment on this line" aria-label="comment on this line">+</button>` : '')
        + `<i class="s">${SIGN[l.kind]}</i><code>${lineHtml(l)}</code></div>`,
      );
      // The thread goes here only if the anchor still holds — same side, same number, same TEXT. After
      // a fix every number below the edit has moved, and a thread pinned to whatever now occupies 142
      // would attribute the operator's words to a line they never read.
      const list = lineNo === null ? undefined : o.byFile.get(f.path)?.get(`${side}:${lineNo}`);
      if (list) {
        const here = list.filter((c) => c.lineText === l.text);
        if (here.length) {
          for (const c of here) o.placed.add(c.id);
          parts.push(threadHtml(here));
        }
      }
    }
  }
  if (f.truncated) parts.push(`<div class="note">truncated — too large to read here; open the file</div>`);

  // Threads whose line no longer exists as it was. Shown with their original coordinates at the top of
  // the file, because the alternative is a comment that silently disappeared the moment it worked.
  const orphans: DiffComment[] = [];
  for (const list of o.byFile.get(f.path)?.values() ?? []) {
    for (const c of list) if (!o.placed.has(c.id)) orphans.push(c);
  }
  if (orphans.length) {
    const blocks = orphans.map((c) =>
      `<div class="orphan"><div class="oh">${esc(c.file)}:${c.lineNo} · ${c.side === 'old' ? 'removed' : 'current'} side`
      + ` · this line has changed since the comment was written</div>${threadHtml([c])}</div>`).join('');
    parts.unshift(blocks);
  }
  return parts.join('');
}

/**
 * FILE-TYPE ICONS: shape carries the type, colour keeps carrying git status.
 *
 * The row already had one mark — a coloured square for added/modified/deleted — and the type was left
 * to the reader parsing the extension out of the filename. In a Unity tree that is the wrong thing to
 * make someone read: measured on a real project, the top extensions are 12,484 `.meta`, 3,101 `.cs`,
 * 2,682 `.png`, 978 `.prefab`, 828 `.anim`, 695 `.asset`. A sidebar of those is a wall of near-identical
 * rows distinguished only by a word ending.
 *
 * TWO CHANNELS, TWO FACTS, ONE GLYPH. Shape is the stronger channel and it goes to the thing being
 * scanned for (`where are the prefabs`); colour stays on status, which is what it already meant, so
 * nothing has to be re-learned and no second mark is added to the row. A `.cs` added and a `.cs`
 * modified are the same silhouette in different colours; a `.cs` and a `.prefab` both modified are the
 * same colour in different silhouettes.
 *
 * ONE SPRITE, NOT ONE COPY PER ROW. The paths live in `<symbol>` elements emitted once and every row is
 * a `<use>`. A 500-file diff would otherwise carry 500 copies of the path data, and this page already
 * has a hard line budget it spends on actual diff text.
 *
 * Families are grouped by WHAT THE FILE IS FOR, not by extension, so `.anim` and `.controller` share a
 * glyph and `.mat` and `.shader` share another. Fourteen shapes is near the limit of what stays
 * learnable; anything not matched falls back to a plain document rather than inventing a fifteenth.
 */
const ICONS: Array<{ id: string; exts: string[]; path: string }> = [
  // `< >` — C#. The angle brackets read as "source" without spelling out a language.
  { id: 'code', exts: ['.cs'], path: '<path d="M9 5 4 8l5 3"/><path d="M13 5l5 3-5 3"/>' },
  // `{ }` — the web/script family, deliberately a different bracket from C#.
  // `>_` — a prompt. The first attempt was braces, which rendered as `()` and read as the same
  // two-facing-brackets silhouette as C#'s `<>` at 15px; these are the two most common code types in
  // any tree ayin looks at, so they must not converge.
  { id: 'braces', exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], path: '<path d="M5 6l4 4-4 4"/><path d="M11 16h7"/>' },
  // an isometric cube — a prefab IS an object.
  { id: 'cube', exts: ['.prefab'], path: '<path d="M11.5 3.2 18 6.6v6.8l-6.5 3.4L5 13.4V6.6z"/><path d="M5 6.6l6.5 3.4 6.5-3.4M11.5 10v6.8"/>' },
  // a framed horizon — a scene is a world you look into.
  // stacked layers — a scene is a composition of things. It was a framed horizon, which is the same
  // silhouette family as the image frame and confusable with it in a list of both.
  { id: 'scene', exts: ['.unity', '.scene'], path: '<path d="M11.5 3.5 19 7.5l-7.5 4L4 7.5z"/><path d="M4 11.5l7.5 4 7.5-4"/><path d="M4 15.5l7.5 4 7.5-4"/>' },
  // stacked discs — a ScriptableObject is data at rest.
  { id: 'data', exts: ['.asset', '.assetbundle', '.bundle'], path: '<ellipse cx="11.5" cy="6.5" rx="7" ry="2.8"/><path d="M4.5 6.5v5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5"/><path d="M4.5 11.5v4c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-4"/>' },
  // a motion arc with a head — animation and the controllers that drive it.
  // keyframes on a track — what an .anim actually is. The first attempt was a motion arc whose
  // arrowhead did not read as one, leaving a stray hook.
  { id: 'anim', exts: ['.anim', '.controller', '.overridecontroller', '.playable'], path: '<path d="M3 11.5h5.5M14.5 11.5h5.5"/><path d="M11.5 5.5 17 11.5l-5.5 6L6 11.5z" fill="currentColor" stroke="none"/>' },
  // a frame with a sun — an image.
  { id: 'image', exts: ['.png', '.jpg', '.jpeg', '.tga', '.psd', '.exr', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg'], path: '<rect x="3.5" y="4.5" width="16" height="14" rx="2"/><circle cx="8" cy="9" r="1.6"/><path d="M3.5 16l5-4.5 4 3.5 3-2.5 3.5 3"/>' },
  // waveform bars — audio.
  { id: 'audio', exts: ['.wav', '.mp3', '.ogg', '.aiff', '.aif', '.flac', '.m4a'], path: '<path d="M5 10v4M8.5 7v10M12 5v14M15.5 8v8M19 11v2"/>' },
  // a lit sphere — materials and shaders.
  { id: 'shade', exts: ['.mat', '.shader', '.shadergraph', '.cginc', '.hlsl', '.glsl', '.shadervariants'], path: '<circle cx="11.5" cy="11.5" r="7.5"/><path d="M6.5 15.5a7.5 7.5 0 0 1 9-9"/>' },
  // a tag on a string — a .meta is a sidecar that only exists to name something else.
  { id: 'meta', exts: ['.meta'], path: '<path d="M12.5 3.5H18a1.5 1.5 0 0 1 1.5 1.5v5.5L11 19.5 3.5 12z"/><circle cx="15.5" cy="7.5" r="1.2"/>' },
  // sliders — configuration and manifests.
  { id: 'config', exts: ['.json', '.xml', '.yaml', '.yml', '.asmdef', '.asmref', '.csproj', '.sln', '.ini', '.cfg', '.toml', '.plist', '.props'], path: '<path d="M4 7h9M17 7h2M4 12h4M12 12h7M4 17h11M18 17h1"/><circle cx="15" cy="7" r="1.8"/><circle cx="10" cy="12" r="1.8"/><circle cx="16.5" cy="17" r="1.8"/>' },
  // ruled lines — prose.
  { id: 'doc', exts: ['.md', '.txt', '.rst', '.adoc'], path: '<path d="M6.5 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M13 3.5V8h4.5M8 12h7M8 15.5h7"/>' },
  // a chip — a compiled blob nobody reviews line by line.
  { id: 'bin', exts: ['.dll', '.so', '.dylib', '.a', '.lib', '.bin', '.exe', '.pdb', '.aar', '.jar', '.zip', '.unitypackage'], path: '<rect x="6" y="6" width="11" height="11" rx="1.5"/><path d="M9 3.5V6M14 3.5V6M9 17v2.5M14 17v2.5M3.5 9H6M3.5 14H6M17 9h2.5M17 14h2.5"/>' },
  // a plain page — the honest answer for anything unmatched.
  { id: 'file', exts: [], path: '<path d="M6.5 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M13 3.5V8h4.5"/>' },
];

const ICON_BY_EXT = new Map<string, string>();
for (const ic of ICONS) for (const e of ic.exts) ICON_BY_EXT.set(e, ic.id);

/** The sprite, emitted once. `currentColor` is what lets one symbol be four status colours. */
function iconSprite(): string {
  const symbols = ICONS.map((ic) =>
    `<symbol id="i-${ic.id}" viewBox="0 0 23 23" fill="none" stroke="currentColor"`
    + ` stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ic.path}</symbol>`).join('');
  return `<svg class="sprite" aria-hidden="true" width="0" height="0">${symbols}</svg>`;
}

/** Type glyph for a path, coloured by git status. `title` names both, for a reader who hovers. */
function typeIcon(f: FileDiff): string {
  const id = ICON_BY_EXT.get(f.ext.toLowerCase()) ?? 'file';
  return `<svg class="ic ${f.status}" aria-hidden="true" title="${esc(f.ext || 'no extension')} · ${f.status}">`
    + `<use href="#i-${id}"/></svg>`;
}

function sidebarRow(f: FileDiff, i: number): string {
  const name = f.path.split('/').pop() ?? f.path;
  const dir = f.path.slice(0, f.path.length - name.length);
  return `<a class="row" href="#f${i}" data-i="${i}" data-ext="${esc(f.ext || '(none)')}">`
    + typeIcon(f)
    + `<span class="nm"><b>${esc(name)}</b><em>${esc(dir)}</em></span>`
    + `<span class="ct"><b class="p">+${f.additions}</b><b class="m">−${f.deletions}</b></span></a>`;
}

/**
 * The sidebar, split at the index boundary.
 *
 * Two sections, each carrying its own count, because "what a commit would take right now" and "what
 * it would leave behind" are the two questions this list is read to answer. Rows keep their GLOBAL
 * index so `#f<i>`, `data-i` and the j/k walk stay one flat sequence across both sections — the split
 * is presentational, and a second numbering would desynchronise the sidebar from the main column.
 *
 * A section with nothing in it says so rather than vanishing: an absent "Staged" heading reads as a
 * page that does not know about staging, while an empty one reads as an empty index, which is the
 * fact the operator wanted.
 */
function sidebarSections(files: FileDiff[]): string {
  const rows = files.map((f, i) => ({ f, i }));
  const part = (staged: boolean, label: string) => {
    const mine = rows.filter((r) => r.f.staged === staged);
    const add = mine.reduce((n, r) => n + r.f.additions, 0);
    const del = mine.reduce((n, r) => n + r.f.deletions, 0);
    return `<div class="sect" data-staged="${staged}">`
      + `<div class="shead">${label}<i>${mine.length}</i>`
      + (mine.length ? `<span class="ct"><b class="p">+${add}</b><b class="m">−${del}</b></span>` : '')
      + `</div>`
      + mine.map((r) => sidebarRow(r.f, r.i)).join('')
      // Always present, hidden while rows are visible. The client re-words it: a section can be empty
      // because nothing is on that side of the index, or because the extension filter hid all of it,
      // and those are different facts.
      + `<div class="sempty"${mine.length ? ' style="display:none"' : ''}>`
      + `${staged ? 'nothing staged' : 'nothing left unstaged'}</div>`
      + `</div>`;
  };
  return part(true, 'Staged') + part(false, 'Unstaged');
}

/**
 * The comment client, emitted ONLY into a served page.
 *
 * A `file://` page that carried this would ship a fetch loop pointing at a route that is not there —
 * dead code in a document whose whole promise is that it is self-contained and offline. The affordance
 * and the code behind it are absent together, which is also what makes the static page's "comments are
 * off" line true rather than decorative.
 */
/**
 * The commit-message panel, at the top of the change it describes.
 *
 * The text is git's own: `.git/COMMIT_EDITMSG` is what `git commit` prefills from, so the draft the
 * page shows is byte-identical to what the operator will find in their editor. Nothing is cached here
 * and there is no second copy to go stale — the caller re-reads the file on every request, the same
 * way the diff itself is re-collected.
 *
 * An ABSENT draft is stated, not hidden. "No draft yet" plus the reason is actionable; an empty panel
 * reads as a broken feature.
 */
function commitPanel(o: Resolved): string {
  const draft = (o.commitDraft || '').trim();
  // Split at the FIRST blank line, git's own boundary: everything before it is the subject line,
  // everything after is the description. Splitting on the first newline instead would swallow a
  // wrapped subject into the body and silently change what gets committed.
  const nl = draft.indexOf('\n');
  const subject = nl === -1 ? draft : draft.slice(0, nl);
  const body = nl === -1 ? '' : draft.slice(nl).replace(/^\n+/, '');

  if (!o.interactive) {
    // A file:// page has no route to commit or redraft through, so it stays a rendering of the file.
    return `<section class="commit">`
      + `<header class="chead">Commit message<span class="sub">from <code>.git/COMMIT_EDITMSG</code></span></header>`
      + (draft
        ? `<pre class="cmsg">${esc(draft)}</pre>`
        : '<div class="cnone">No draft yet — <code>.git/COMMIT_EDITMSG</code> holds no message ayin wrote for this HEAD.</div>')
      + `</section>`;
  }

  return `<section class="commit">
  <header class="chead">Commit message<span class="sub">from <code>.git/COMMIT_EDITMSG</code> · edit either field, Commit takes what is in them</span>
    <span class="cacts"><button class="act" id="cmsgcopy">copy</button>
    <button class="act" id="draft" title="Redraft both fields from the staged diff, this repo's Claude session and its tickets">Draft</button>
    <button class="act commit" id="docommit" title="Commit the staged changes with the text in these fields">Commit</button></span>
  </header>
  <div class="cfield">
    <div class="clabel">Subject
      <button class="act tiny" id="rephrase" title="Ask ayin to rephrase the subject against the staged diff, inside the limit">rephrase</button>
      <span class="clen" id="clen"></span>
    </div>
    <input id="csubj" class="csubj" value="${esc(subject)}" spellcheck="false"
      placeholder="type(scope): KEY-1,KEY-2 - one sentence">
  </div>
  <div class="cfield">
    <div class="clabel">Description</div>
    <textarea id="cbody" class="cbody" spellcheck="false" rows="7"
      placeholder="One paragraph per ticket, then Also: for what belongs to no ticket.">${esc(body)}</textarea>
  </div>
  <div class="cwhy" id="cwhy">${draft ? '' : 'No draft yet — press <b>Draft</b> to build one from the staged diff, or just type your own.'}</div></section>`;
}

/**
 * The per-file index button — served pages ONLY, because staging is a git WRITE.
 *
 * One button, not two: a change is on exactly one side of the index, so the only move that means
 * anything is the one that crosses it. Offering both would make half of every card a no-op.
 */
function stageBtn(f: FileDiff): string {
  const act = f.staged ? 'unstage' : 'stage';
  return `<button class="ix" data-act="${act}" data-path="${esc(f.path)}"`
    + ` title="${f.staged ? 'Remove from the index' : 'Add to the index'}">${act}</button>`;
}

/**
 * The refresh FAB — served pages ONLY.
 *
 * A `file://` page has nothing to rebuild from: the static file is a snapshot, and `git` is not
 * reachable from a document. So the button is ABSENT there rather than present and dead, which is the
 * same call the page already makes about the comment affordance.
 */
function refreshFab(): string {
  return '<button class="fab" id="refresh" aria-label="Rebuild against the current working tree"'
    + ' title="Rebuild against the current working tree">'
    + '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3.5V10h-6.5"/>'
    + '</svg></button>';
}

function commentClient(o: Resolved): string {
  return `
  // ── line comments ──────────────────────────────────────────────────────────
  // Same-origin by construction: this page was served by the session that owns the repo, so a bare
  // '/api/…' reaches that session and nothing else. Nothing about the port or the host is baked in.
  var REV = ${JSON.stringify(o.rev)};
  var POLL_MS = 1200;
  var ANCHOR = 'ayin-diff-anchor';

  function rowOf(el){ while (el && !el.classList.contains('l')) el = el.parentNode; return el; }
  function fileOf(el){ while (el && !el.classList.contains('file')) el = el.parentNode; return el; }

  /** Where the reader was, so a reload after a fix does not throw them back to the top of the page. */
  function remember(row){
    var f = fileOf(row);
    if (!f || !row.dataset.line) return;
    try {
      sessionStorage.setItem(ANCHOR, JSON.stringify({
        path: f.dataset.path, side: row.dataset.side, line: row.dataset.line,
      }));
    } catch (e) { /* private mode: losing the scroll position is not worth failing the reload over */ }
  }

  function restore(){
    var raw = null;
    try { raw = sessionStorage.getItem(ANCHOR); sessionStorage.removeItem(ANCHOR); } catch (e) { return; }
    if (!raw) return;
    var a; try { a = JSON.parse(raw); } catch (e) { return; }
    var f = document.querySelector('.file[data-path="' + (a.path || '').replace(/"/g, '\\"') + '"]');
    if (!f) return;
    // The line number moved with the fix; the file is the honest anchor. Land on the exact row when it
    // is still there, on the file when it is not.
    var row = f.querySelector('.l[data-side="' + a.side + '"][data-line="' + a.line + '"]');
    (row || f).scrollIntoView({ block: 'center' });
  }

  /**
   * Where the reader is RIGHT NOW — the topmost file still on screen — so a manual refresh lands
   * where they were instead of at the top of the diff.
   *
   * Writes the SAME key restore() already reads, with no line: restore() fails to match a row and
   * falls back to the file, which is the honest anchor anyway when the tree has just changed under it.
   * One anchor, one restore, no second mechanism to keep in step.
   */
  function rememberViewport(){
    var fs = document.querySelectorAll('.file'), best = null, bestTop = Infinity;
    for (var i = 0; i < fs.length; i++) {
      var r = fs[i].getBoundingClientRect();
      if (r.bottom < 0) continue;                       // scrolled past
      if (r.top < bestTop) { bestTop = r.top; best = fs[i]; }
    }
    if (!best) return;
    try {
      sessionStorage.setItem(ANCHOR, JSON.stringify({ path: best.dataset.path, side: 'new', line: '' }));
    } catch (e) { /* private mode: losing the position is not worth failing the refresh over */ }
  }

  // ── the index ──────────────────────────────────────────────────────────────
  // Every one of these ends in a reload, because the staged/unstaged split IS the page's structure:
  // moving a file across the index boundary moves it between the two sidebar sections and changes
  // which hunks belong to which side. Patching that in place would mean re-deriving both diffs in the
  // browser from data it does not have. The route re-collects anyway, so a reload is both correct and
  // the cheapest thing to write.
  function post(url, body){
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); });
  }

  [].slice.call(document.querySelectorAll('.ix')).forEach(function(btn){
    btn.onclick = function(e){
      e.preventDefault(); e.stopPropagation();       // the header is also the fold toggle
      var act = btn.dataset.act, path = btn.dataset.path;
      rememberViewport();
      btn.classList.add('busy');
      btn.textContent = act === 'stage' ? 'staging…' : 'unstaging…';
      post('/api/diff/' + act, { path: path }).then(function(r){
        if (r.ok) { location.reload(); return; }
        // A failed write must SAY so on the card. Reloading would show an unchanged page and read as
        // a button that does nothing, which is the same bug wearing a different face.
        btn.classList.remove('busy');
        btn.textContent = act;
        showWhy(btn, false, (r.j && r.j.error) || 'failed');
      }).catch(function(err){
        btn.classList.remove('busy'); btn.textContent = act;
        showWhy(btn, false, String(err));
      });
    };
  });

  /** Put a reason under a file card, and keep it there. */
  function showWhy(el, staged, text){
    var card = fileOf(el);
    if (!card) return;
    var box = card.querySelector('.why');
    if (!box) { box = document.createElement('div'); box.className = 'why'; card.appendChild(box); }
    box.className = 'why' + (staged ? '' : ' skip');
    box.innerHTML = '<b>' + (staged ? 'staged' : 'not staged') + '</b> — ' + esc(text);
  }

  function esc(t){ return String(t).replace(/[&<>]/g, function(c){ return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); }

  // ── the commit draft ───────────────────────────────────────────────────────
  // The panel is git's file rendered; pressing Draft re-runs the pipeline and reloads so the panel
  // shows what git now holds rather than what the response said. Reporting the DECLINE is the point:
  // the pipeline refuses on purpose when no ticket was confirmed, and "nothing happened" with no
  // reason is indistinguishable from a broken button.
  var dbtn = document.getElementById('draft');
  var cwhy = document.getElementById('cwhy');
  if (dbtn) dbtn.onclick = function(){
    dbtn.classList.add('busy');
    dbtn.textContent = 'drafting\u2026';
    if (cwhy) cwhy.textContent = '';
    post('/api/diff/draft', {}).then(function(r){
      dbtn.classList.remove('busy');
      dbtn.textContent = 'Draft';
      if (!r.ok) { if (cwhy) cwhy.innerHTML = '<b>failed</b> \u2014 ' + esc((r.j && r.j.error) || 'unknown'); return; }
      if (r.j.drafted) { rememberViewport(); location.reload(); return; }
      var t = (r.j.tickets || []).map(function(x){ return x.key; }).join(', ');
      if (cwhy) cwhy.innerHTML = '<b>no draft</b> \u2014 ' + esc(r.j.why || 'declined')
        + (r.j.candidates && r.j.candidates.length ? ' \u00b7 candidates seen: ' + esc(r.j.candidates.join(', ')) : '')
        + (t ? ' \u00b7 confirmed: ' + esc(t) : '')
        + ' \u00b7 ' + (r.j.sessionTurns || 0) + ' session turn(s) read';
    }).catch(function(err){
      dbtn.classList.remove('busy'); dbtn.textContent = 'Draft';
      if (cwhy) cwhy.innerHTML = '<b>failed</b> \u2014 ' + esc(String(err));
    });
  };

  // ── the commit fields ──────────────────────────────────────────────────────
  // 50 is git's own subject convention. The counter and the field both go red past it rather than the
  // input refusing more text: truncating someone mid-word is worse than showing them the overflow and
  // letting them decide. Nothing here blocks a commit — the limit is advice made visible.
  var SUBJ_MAX = 50;
  var csubj = document.getElementById('csubj');
  var cbody = document.getElementById('cbody');
  var clen = document.getElementById('clen');
  var cwhy = document.getElementById('cwhy');

  function gauge(){
    if (!csubj || !clen) return;
    var n = csubj.value.length;
    clen.textContent = n + '/' + SUBJ_MAX;
    clen.classList.toggle('over', n > SUBJ_MAX);
    csubj.classList.toggle('over', n > SUBJ_MAX);
  }
  if (csubj) { csubj.oninput = gauge; gauge(); }

  // ── rephrase: the subject only ──────────────────────────────────────────────
  // Scoped to the subject on purpose. The description is where the operator's own words end up, and a
  // button that silently rewrote those while they were editing would be the worst kind of helpful.
  var reph = document.getElementById('rephrase');
  if (reph) reph.onclick = function(){
    reph.classList.add('busy');
    reph.textContent = 'rephrasing\u2026';
    if (cwhy) cwhy.textContent = '';
    post('/api/diff/rephrase', { subject: csubj ? csubj.value : '' }).then(function(r){
      reph.classList.remove('busy');
      reph.textContent = 'rephrase';
      if (r.ok && r.j.subject) {
        if (csubj) { csubj.value = r.j.subject; gauge(); }
        if (cwhy && r.j.note) cwhy.innerHTML = esc(r.j.note);
        return;
      }
      if (cwhy) cwhy.innerHTML = '<b>not rephrased</b> \u2014 ' + esc((r.j && (r.j.why || r.j.error)) || 'failed');
    }).catch(function(err){
      reph.classList.remove('busy'); reph.textContent = 'rephrase';
      if (cwhy) cwhy.innerHTML = '<b>not rephrased</b> \u2014 ' + esc(String(err));
    });
  };

  // ── commit ─────────────────────────────────────────────────────────────────
  // WHAT IS IN THE FIELDS, not what is on disk. The operator may have rewritten either one, and
  // committing the file instead of the form would silently discard their edit. It asks once, because a
  // mis-click is recoverable but not free, and reports the sha plus the exact undo.
  var dcommit = document.getElementById('docommit');
  if (dcommit) dcommit.onclick = function(){
    var subject = csubj ? csubj.value.trim() : '';
    var bodyText = cbody ? cbody.value.trim() : '';
    if (!subject) { if (cwhy) cwhy.innerHTML = '<b>not committed</b> \u2014 the subject is empty'; return; }
    if (!window.confirm('Commit the staged changes with this message?')) return;
    dcommit.classList.add('busy');
    dcommit.textContent = 'committing\u2026';
    post('/api/diff/commit', { subject: subject, body: bodyText }).then(function(r){
      dcommit.classList.remove('busy');
      dcommit.textContent = 'Commit';
      if (r.ok && r.j.ok) {
        if (cwhy) cwhy.innerHTML = '<b>committed</b> \u2014 ' + esc(r.j.why)
          + ' \u00b7 undo with <code>git reset --soft HEAD~1</code>';
        rememberViewport();
        setTimeout(function(){ location.reload(); }, 1800);
        return;
      }
      if (cwhy) cwhy.innerHTML = '<b>not committed</b> \u2014 ' + esc((r.j && (r.j.why || r.j.error)) || 'failed');
    }).catch(function(err){
      dcommit.classList.remove('busy'); dcommit.textContent = 'Commit';
      if (cwhy) cwhy.innerHTML = '<b>not committed</b> \u2014 ' + esc(String(err));
    });
  };

  var ccopy = document.getElementById('cmsgcopy');
  if (ccopy) ccopy.onclick = function(){
    var full = (csubj ? csubj.value : '') + (cbody && cbody.value.trim() ? '\\n\\n' + cbody.value.trim() : '');
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(full + '\\n').then(function(){
      ccopy.textContent = 'copied';
      setTimeout(function(){ ccopy.textContent = 'copy'; }, 1200);
    }).catch(function(){ ccopy.textContent = 'copy failed'; });
  };

  // ── the project-type Stage pass ────────────────────────────────────────────
  // It can spend a model call per changed .cs, so it reports per file and does NOT reload until the
  // operator has seen what it decided. Every skip carries its reason; that is the point of the button.
  var auto = document.getElementById('autostage');
  if (auto) auto.onclick = function(){
    auto.classList.add('busy');
    auto.textContent = 'staging…';
    post('/api/diff/autostage', {}).then(function(r){
      auto.classList.remove('busy');
      auto.textContent = 'Stage';
      if (!r.ok) { auto.textContent = 'Stage — failed'; return; }
      if (r.j.policy === 'none') { auto.textContent = 'Stage — no policy for this project type'; return; }
      var outs = r.j.outcomes || [];
      var staged = 0;
      outs.forEach(function(o){
        if (o.staged) staged++;
        var card = document.querySelector('.file[data-path="' + o.path.replace(/"/g, '\\"') + '"]');
        if (card) showWhy(card.querySelector('.fh'), o.staged,
          o.why + (o.heldBack ? ' (' + o.heldBack + ' line(s) held back)' : ''));
      });
      auto.textContent = 'Stage — ' + staged + '/' + outs.length;
      rememberViewport();
      // Long enough to read a line, then re-collect so the two sections tell the truth again.
      setTimeout(function(){ location.reload(); }, 2500);
    }).catch(function(){ auto.classList.remove('busy'); auto.textContent = 'Stage — failed'; });
  };

  // ── refresh ────────────────────────────────────────────────────────────────
  // The route re-collects the working tree on EVERY GET, so "rebuild against fresh state" is exactly
  // a reload: no path to publish, no cache to invalidate, and the URL never moves. Only the reader's
  // position has to survive, which the anchor above already handles.
  var fab = document.getElementById('refresh');
  if (fab) fab.onclick = function(){
    rememberViewport();
    fab.classList.add('busy');
    location.reload();
  };

  function badgeOf(cmt){ return cmt.querySelector('.badge'); }

  /**
   * pending → working → done. The page owns none of these transitions: it asks, and reloads when the
   * answer is 'done', because by then the file on disk is not the file this page was rendered from.
   */
  function poll(cmt){
    var id = cmt.dataset.cid;
    if (!id) return;
    var timer = setInterval(function(){
      fetch('/api/diff/comment/' + encodeURIComponent(id)).then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function(j){
        if (j.status === cmt.dataset.status) return;
        cmt.dataset.status = j.status;
        var b = badgeOf(cmt);
        if (b) { b.className = 'badge ' + j.status; b.textContent = LABEL[j.status] || j.status; }
        if (j.status === 'done') { clearInterval(timer); location.reload(); }
        else if (j.status === 'working') {
          // The clock restarts when the work does: time spent queued behind another turn is not time
          // spent on this comment, and reading it as such makes a busy session look like a stuck one.
          var age = cmt.querySelector('.age');
          if (age) age.dataset.since = new Date().toISOString();
        }
        else if (j.status === 'failed') {
          clearInterval(timer);
          var err = document.createElement('div');
          err.className = 'cmt reply err';
          err.innerHTML = '<div class="cmt-b"></div>';
          err.querySelector('.cmt-b').textContent = j.error || 'the turn failed';
          cmt.parentNode.insertBefore(err, cmt.nextSibling);
        }
      }).catch(function(e){
        // The session exited, or the machine slept. Stop pretending to wait and say so — a spinner
        // that never resolves is the failure mode this whole status field exists to avoid.
        clearInterval(timer);
        var b = badgeOf(cmt);
        if (b) { b.className = 'badge failed'; b.textContent = 'lost the session'; }
      });
    }, POLL_MS);
  }

  var LABEL = { pending: 'pending\u2026', working: 'working\u2026', done: 'done', failed: 'failed' };

  // One ticker for every waiting thread. An honest "4m 12s" is the difference between a slow edit and
  // a session that died, and the page cannot tell those apart for the operator any other way.
  function ago(iso){
    var secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 60) return secs + 's';
    var m = Math.floor(secs / 60);
    return m < 60 ? m + 'm ' + (secs % 60) + 's' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  setInterval(function(){
    [].slice.call(document.querySelectorAll('.age[data-since]')).forEach(function(el){
      el.textContent = ago(el.dataset.since);
    });
  }, 1000);

  function optimistic(row, text, id){
    var t = document.createElement('div');
    t.className = 'thread';
    var cmt = document.createElement('div');
    cmt.className = 'cmt';
    cmt.dataset.cid = id;
    cmt.dataset.status = 'pending';
    cmt.innerHTML = '<div class="cmt-h"><span class="who">you</span>'
      + '<span class="age" data-since="' + new Date().toISOString() + '">0s</span>'
      + '<span class="badge pending">' + LABEL.pending + '</span></div><div class="cmt-b"></div>';
    cmt.querySelector('.cmt-b').textContent = text;
    t.appendChild(cmt);
    row.parentNode.insertBefore(t, row.nextSibling);
    poll(cmt);
  }

  function openForm(row){
    if (row.nextSibling && row.nextSibling.classList && row.nextSibling.classList.contains('cform')) {
      row.nextSibling.remove();
      return;
    }
    var f = fileOf(row);
    if (!f) return;
    var form = document.createElement('div');
    form.className = 'cform';
    form.innerHTML = '<textarea placeholder="what should change on this line?"></textarea>'
      + '<div class="fa"><button class="send">Send</button><button class="cancel">Cancel</button>'
      + '<span class="hint">\u2318/Ctrl+Enter sends \u00b7 Esc closes</span></div>';
    row.parentNode.insertBefore(form, row.nextSibling);
    var ta = form.querySelector('textarea');
    var send = form.querySelector('.send');
    ta.focus();

    function submit(){
      var text = ta.value.trim();
      if (!text) return;
      send.disabled = true;
      send.textContent = 'sending\u2026';
      var code = row.querySelector('code');
      fetch('/api/diff/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rev: REV,
          file: f.dataset.path,
          side: row.dataset.side,
          lineNo: parseInt(row.dataset.line, 10),
          lineText: code ? code.textContent : '',
          text: text,
        }),
      }).then(function(r){
        return r.json().then(function(j){ if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
      }).then(function(j){
        remember(row);
        form.remove();
        optimistic(row, text, j.id);
      }).catch(function(e){
        // The comment was NOT sent. Say that in the form the operator is still looking at, and keep
        // their text — a silent failure here loses what they wrote.
        send.disabled = false;
        send.textContent = 'Send';
        var h = form.querySelector('.hint');
        h.textContent = 'not sent: ' + e.message;
        h.style.color = 'var(--priv)';
      });
    }

    send.onclick = submit;
    form.querySelector('.cancel').onclick = function(){ form.remove(); };
    ta.onkeydown = function(e){
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); form.remove(); }
    };
  }

  document.getElementById('main').addEventListener('click', function(e){
    if (!e.target.classList || !e.target.classList.contains('cbtn')) return;
    var row = rowOf(e.target);
    if (row) openForm(row);
  });

  // A thread that was still working when the page reloaded keeps its spinner and keeps asking. This is
  // what makes the reload-on-done loop safe to run more than once.
  [].slice.call(document.querySelectorAll('.cmt[data-status="pending"],.cmt[data-status="working"]'))
    .forEach(poll);

  restore();
`;
}

export function renderDiffPage(set: DiffSet, opts: RenderOptions = {}): string {
  const o = resolve(opts);
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
    return `<section class="file" id="f${i}" data-i="${i}" data-ext="${esc(f.ext || '(none)')}" data-path="${esc(f.path)}" data-staged="${f.staged}">`
      + `<header class="fh">${typeIcon(f)}`
      + `<h2>${heading}</h2>`
      + `<span class="tags">${f.untracked ? '<i class="tag new">untracked</i>' : ''}`
      + `${f.binary ? '<i class="tag">binary</i>' : ''}</span>`
      + `<span class="ct"><b class="p">+${f.additions}</b><b class="m">−${f.deletions}</b></span>`
      + (o.interactive ? stageBtn(f) : '')
      + `<button class="fold" title="collapse">–</button></header>`
      + `<div class="body">${fileBody(f, o)}</div></section>`;
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

/* ── commit message panel ── */
.commit{background:var(--surface);border:1px solid var(--line);border-radius:12px;
  margin:0 0 14px;overflow:hidden}
.chead{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--surface-2);
  border-bottom:1px solid var(--line);font:600 11.5px/1 var(--ui);color:var(--ink)}
.chead .sub{font-weight:400;color:var(--ink-3)}
.chead .cacts{margin-left:auto;display:flex;gap:6px}
.cmsg{margin:0;padding:12px;font:12.5px/1.6 var(--mono);color:var(--ink);
  white-space:pre-wrap;word-break:break-word}
/* Two FIELDS, labelled, so subject and description are never guessed at from layout alone. */
.cfield{padding:10px 12px 0}
.cfield:last-of-type{padding-bottom:12px}
.clabel{display:flex;align-items:center;gap:8px;
  font:600 10px/1 var(--ui);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);
  margin:0 0 6px}
.act.tiny{padding:3px 7px;font-size:10px}
/* The counter is the whole point of the limit: n/50, and it goes RED the moment it is exceeded so an
   over-long subject is visible before the commit, not after someone rejects the message. */
.clen{margin-left:auto;font:600 10.5px/1 var(--mono);color:var(--ink-3)}
.clen.over{color:var(--priv)}
.csubj,.cbody{width:100%;box-sizing:border-box;background:var(--bg);color:var(--ink);
  border:1px solid var(--line);border-radius:8px;padding:9px 10px;
  font:12.5px/1.55 var(--mono);resize:vertical}
.csubj:focus,.cbody:focus{outline:none;border-color:var(--wire-hot)}
/* Overflow is painted on the field too, not only in the counter — the field is where the eye is. */
.csubj.over{border-color:var(--priv);color:var(--priv)}
.cnone{padding:12px;font:11.5px/1.6 var(--ui);color:var(--ink-3)}
.cnone code,.chead code{font:11px/1 var(--mono);color:var(--ink-2)}
.cwhy{font:11px/1.5 var(--ui);color:var(--ink-2);padding:0 12px 10px}
.cwhy:empty{display:none}
.cwhy b{color:var(--ink)}

/* ── the index: sidebar sections, per-file buttons, Stage ── */
.sect{margin-bottom:10px}
.shead{display:flex;align-items:center;gap:6px;padding:6px 6px 5px;
  font:600 10.5px/1 var(--ui);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);
  border-bottom:1px solid var(--line-soft)}
.shead i{font-style:normal;font:600 10px/1 var(--ui);color:var(--ink-2);
  background:var(--surface-3);border-radius:999px;padding:3px 6px}
.shead .ct{margin-left:auto;font:600 10.5px/1 var(--mono)}
.sempty{padding:8px 7px;font:11.5px/1 var(--ui);color:var(--ink-3);font-style:italic}
/* The per-file button sits in the header row, left of the fold toggle. */
.ix{font:600 10px/1 var(--ui);letter-spacing:.04em;text-transform:uppercase;
  color:var(--ink-2);background:var(--surface-3);border:1px solid var(--line);
  border-radius:6px;padding:5px 8px;cursor:pointer;margin-right:8px}
.ix:hover{color:var(--ink);border-color:var(--wire-hot)}
.ix.busy{pointer-events:none;opacity:.55}
.act.commit{color:var(--pub);border-color:var(--pub)}
.act.commit:hover{background:var(--surface-3)}
.act.commit.busy{pointer-events:none;opacity:.6}
.act.stage{color:var(--ink);border-color:var(--wire-hot)}
.act.stage:hover{background:var(--surface-3)}
.act.stage.busy{pointer-events:none;opacity:.6}
/* What the Stage pass decided, per file, once it has run. Never a toast: the reason a file was NOT
   staged is the half worth keeping on screen, and a toast takes it away while it is still being read. */
.why{font:11px/1.45 var(--ui);color:var(--ink-2);padding:7px 10px;
  border-top:1px dashed var(--line);background:var(--surface-2)}
.why b{color:var(--ink)}
.why.skip b{color:var(--prot)}

/* ── refresh FAB (served pages only) ── */
/* Fixed, bottom-right, above the sticky header's z-index:2. Every colour is a token, so the light
   theme is handled by the same :root override as everything else. */
.fab{position:fixed;right:22px;bottom:22px;width:44px;height:44px;z-index:5;
  display:grid;place-items:center;cursor:pointer;border-radius:50%;
  color:var(--ink-2);background:var(--surface-2);border:1px solid var(--line);
  box-shadow:0 4px 16px rgba(0,0,0,.28)}
.fab:hover{color:var(--wire-hot);border-color:var(--wire-hot)}
.fab svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;
  stroke-linecap:round;stroke-linejoin:round}
/* A re-collect on a large tree is not instant, and a button that looks dead gets clicked twice —
   which is a second full collect for nothing. Spin, and stop taking clicks. */
.fab.busy{pointer-events:none;color:var(--wire-hot)}
.fab.busy svg{animation:fabspin .8s linear infinite;transform-origin:50% 50%}
@keyframes fabspin{to{transform:rotate(360deg)}}

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
.sprite{position:absolute;width:0;height:0;overflow:hidden}
/* 15px is the smallest these silhouettes stay readable at; below it the cube and the sphere converge. */
.ic{width:15px;height:15px;flex:none;display:block}
/* Colour is STATUS, unchanged from the square it replaces — nothing to re-learn. Shape is the type. */
.ic.added{color:var(--pub)} .ic.deleted{color:var(--priv)}
.ic.modified{color:var(--prot)} .ic.renamed{color:var(--wire-hot)}
.fh .ic{width:16px;height:16px}
/* Kept for anything still rendering a bare status square. */
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
/* ── line comments · served page only ── */
.l{position:relative}
.cbtn{flex:none;width:17px;height:15px;margin:1px 2px 0 0;padding:0;border:1px solid var(--wire-hot);
  border-radius:4px;background:var(--wire-hot);color:var(--bg);font:700 11px/13px var(--mono);
  cursor:pointer;visibility:hidden;align-self:center}
[data-theme="light"] .cbtn{color:#fff}
.l:hover .cbtn{visibility:visible}
.cbtn:hover{filter:brightness(1.15)}
.thread,.cform{white-space:normal;font-family:var(--ui);margin:7px 0 7px 62px;max-width:760px}
.cmt{border:1px solid var(--line);border-radius:9px;background:var(--surface-2);margin-bottom:7px;overflow:hidden}
.cmt-h{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface-3);
  border-bottom:1px solid var(--line-soft);font-size:11.5px;color:var(--ink-3)}
.cmt-h .who{font-weight:650;color:var(--ink-2)}
.cmt-b{padding:9px 11px;font-size:12.5px;line-height:1.55;color:var(--ink);white-space:pre-wrap;word-break:break-word}
.cmt.reply{border-color:var(--wire-hot)}
.cmt.reply .cmt-h .who{color:var(--wire-hot)}
.cmt.reply.err{border-color:var(--priv)}
.cmt.reply.err .cmt-b{color:var(--priv)}
.age{margin-left:auto;font:11px/1 var(--mono);color:var(--ink-3);font-variant-numeric:tabular-nums}
.age+.badge{margin-left:8px}
.badge{margin-left:auto;font:600 10px/1 var(--mono);padding:3px 6px;border-radius:5px;
  border:1px solid var(--line);color:var(--ink-3);background:var(--surface)}
.badge.pending{color:var(--prot);border-color:var(--prot)}
.badge.working{color:var(--wire-hot);border-color:var(--wire-hot)}
.badge.done{color:var(--pub);border-color:var(--pub)}
.badge.failed{color:var(--priv);border-color:var(--priv)}
.cform{border:1px solid var(--wire-hot);border-radius:9px;background:var(--surface-2);padding:9px}
.cform textarea{width:100%;min-height:62px;resize:vertical;background:var(--surface);color:var(--ink);
  border:1px solid var(--line);border-radius:7px;padding:8px 9px;font:12.5px/1.5 var(--ui)}
.cform textarea:focus{outline:none;border-color:var(--wire-hot)}
.cform .fa{display:flex;align-items:center;gap:9px;margin-top:8px}
.cform .hint{color:var(--ink-3);font-size:11px;margin-left:auto}
.send{font:600 11.5px/1 var(--ui);color:var(--bg);background:var(--wire-hot);border:none;
  border-radius:7px;padding:7px 13px;cursor:pointer}
[data-theme="light"] .send{color:#fff}
.send[disabled]{opacity:.55;cursor:default}
.cancel{font:11.5px/1 var(--ui);color:var(--ink-3);background:none;border:1px solid var(--line);
  border-radius:7px;padding:7px 11px;cursor:pointer}
.orphan{margin:11px 0;padding:9px 12px;border:1px dashed var(--prot);border-radius:9px}
.orphan .oh{font:11px/1.45 var(--mono);color:var(--prot);margin-bottom:7px}
.orphan .thread{margin-left:0}
kbd{font:10.5px/1 var(--mono);border:1px solid var(--line);border-bottom-width:2px;
  border-radius:4px;padding:3px 5px;color:var(--ink-3)}
</style></head><body>
<div class="top">
  <h1>${esc(set.branch)}</h1>
  <span class="sub">vs ${esc(set.against)} · ${esc(set.head)}</span>
  <span class="stat">
    <b class="p">+${totalAdd}</b><b class="m">−${totalDel}</b>
    <kbd>j</kbd><kbd>k</kbd> file <kbd>t</kbd> theme
    ${o.interactive
      ? '<span class="sub">hover a line to comment</span>'
      : '<span class="sub">read-only page · comments need the session that served it</span>'}
    <button class="act" id="theme">light</button>
  </span>
</div>
<div class="chips">${chipHtml}
  <span class="count" id="count"></span>
  <button class="act" id="all">show all</button>
  <button class="act" id="none">defaults</button>
  ${o.interactive ? '<button class="act stage" id="autostage" title="Stage what this project type says is safe to stage">Stage</button>' : ''}
</div>
${iconSprite()}
<aside id="side">${sidebarSections(set.files)}</aside>
<main id="main">${commitPanel(o)}${omitted}${filesHtml || '<div class="empty">Working tree is clean.</div>'}</main>
${o.interactive ? refreshFab() : ''}
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

    // Section counts follow the FILTER, exactly like the global count. A header reading "Staged 2"
    // above one visible row is the same lie the hidden-file count exists to prevent — measured on a
    // fixture where a .controller, hidden by the default chips, left the count and the list
    // disagreeing. Summed from the visible rows themselves, so there is one source of truth.
    [].slice.call(document.querySelectorAll('.sect')).forEach(function(sect){
      var all = [].slice.call(sect.querySelectorAll('.row'));
      var vis = all.filter(function(r){ return r.style.display !== 'none'; });
      var a = 0, d = 0;
      vis.forEach(function(r){
        var pp = r.querySelector('.ct .p'), mm = r.querySelector('.ct .m');
        a += Math.abs(parseInt((pp && pp.textContent) || '0', 10) || 0);
        d += Math.abs(parseInt((mm && mm.textContent) || '0', 10) || 0);
      });
      var n = sect.querySelector('.shead i');
      if (n) n.textContent = String(vis.length);
      var ct = sect.querySelector('.shead .ct');
      if (ct) ct.innerHTML = vis.length
        ? '<b class="p">+' + a + '</b><b class="m">\\u2212' + d + '</b>' : '';
      var empty = sect.querySelector('.sempty');
      if (empty) {
        empty.style.display = vis.length ? 'none' : '';
        empty.textContent = all.length
          ? 'all ' + all.length + ' hidden by the filters'
          : (sect.dataset.staged === 'true' ? 'nothing staged' : 'nothing left unstaged');
      }
    });
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
    // Single-letter shortcuts and a text field cannot share a keyboard. Without this, typing "just"
    // into a comment jumps two files and toggles the theme.
    var tn = e.target && e.target.tagName;
    if (tn === 'TEXTAREA' || tn === 'INPUT') return;
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

  ${o.interactive ? commentClient(o) : ''}
})();
</script></body></html>`;
}
