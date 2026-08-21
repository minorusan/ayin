/**
 * chore/render.ts — the report as text for a terminal, and as one self-contained page.
 *
 * TWO AUDIENCES, ONE MODEL. The text is what `ayin chore` prints and what the agent reads: dense, one
 * finding per block, no decoration. The page is what `/chore` opens, and it exists because a dead-code
 * report is a list you triage — you want the confident ones first, the commit that introduced each item
 * beside it, and somewhere to look away to. Neither is generated from the other; both are generated from
 * the report, so they cannot disagree.
 *
 * EVERY NUMBER IS COUNTED, never estimated, and the caveats travel with the item rather than sitting in a
 * legend nobody scrolls back to. A finding that says "unused" without saying "except that Unity may call
 * it from an asset" is the kind of confident wrongness that gets a whole report ignored.
 */

import type { ChoreReport, Finding } from './index.js';

const CONFIDENCE_NOTE: Record<Finding['confidence'], string> = {
  likely: 'nothing references it, and nothing about it suggests something else might',
  possible: 'nothing references it by name, but read the caveat before deleting',
  unlikely: 'something does reference it — listed because you asked for everything',
};

export function renderChoreText(r: ChoreReport): string {
  const out: string[] = [];
  const range = r.commits.length
    ? `${r.commits[r.commits.length - 1].sha}..${r.commits[0].sha}`
    : '(no commits)';
  out.push(`chore · ${r.branch} · last ${r.commits.length} commit(s) ${range}`);
  out.push(`${r.filesExamined} code file(s) touched · ${r.candidates} member(s) added · ${r.findings.length} unused`);

  if (r.skipped.length) {
    out.push('');
    for (const s of r.skipped) out.push(`note: ${s}`);
  }

  if (!r.findings.length) {
    out.push('');
    out.push('Nothing added in that range is unused. That is the answer, not an empty result.');
    return out.join('\n');
  }

  let lastConfidence = '';
  for (const f of r.findings) {
    if (f.confidence !== lastConfidence) {
      out.push('');
      out.push(`── ${f.confidence} — ${CONFIDENCE_NOTE[f.confidence]}`);
      lastConfidence = f.confidence;
    }
    out.push('');
    out.push(`${f.kind} ${f.name}   ${f.file}:${f.line}`);
    out.push(`  ${f.declaration}`);
    out.push(`  added ${f.commit.sha} · ${f.commit.date} · ${f.commit.author} · ${f.commit.subject}`);
    for (const c of f.caveats) out.push(`  caveat: ${c}`);
    if (f.uses) {
      out.push(`  referenced ${f.uses}× in: ${f.usedIn.map((u) => `${u.file} (${u.count})`).join(', ')}`);
    }
    if (f.assetRefs.length) {
      out.push(`  named in: ${f.assetRefs.map((u) => `${u.file} (${u.count})`).join(', ')}`);
    }
  }

  out.push('');
  out.push('Each item is a member ADDED in that range whose declaration is still in HEAD. "Unused" means');
  out.push('no word-boundary reference anywhere in the tracked tree — code and assets both searched.');
  return out.join('\n');
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One page, no external asset: it has to open on a machine with no network. */
export function renderChorePage(r: ChoreReport): string {
  const groups: Array<Finding['confidence']> = ['likely', 'possible', 'unlikely'];
  const byConfidence = groups
    .map((c) => ({ c, items: r.findings.filter((f) => f.confidence === c) }))
    .filter((g) => g.items.length);

  const card = (f: Finding): string => `
    <article class="item ${f.confidence}">
      <header>
        <span class="kind">${esc(f.kind)}</span>
        <h3>${esc(f.name)}</h3>
        <span class="where">${esc(f.file)}:${f.line}</span>
      </header>
      <pre class="decl">${esc(f.declaration)}</pre>
      <p class="commit"><span class="sha">${esc(f.commit.sha)}</span> ${esc(f.commit.date)} ·
        ${esc(f.commit.author)} — ${esc(f.commit.subject)}</p>
      ${f.caveats.length ? `<ul class="caveats">${f.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
      ${f.uses ? `<p class="refs">referenced ${f.uses}× — ${f.usedIn.map((u) => `${esc(u.file)} (${u.count})`).join(', ')}</p>` : ''}
      ${f.assetRefs.length ? `<p class="refs asset">named in ${f.assetRefs.map((u) => `${esc(u.file)} (${u.count})`).join(', ')}</p>` : ''}
    </article>`;

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>chore · ${esc(r.branch)}</title>
<style>
  :root { --bg:#0a0c12; --panel:#12151f; --ink:#e6ebf5; --ink-2:#a3aec4; --ink-3:#6b7689;
          --likely:#f0666f; --possible:#e5a03c; --unlikely:#5c8ad0; --line:#232838;
          --ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
          --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.55 var(--ui); }
  header.top { padding:22px 26px 16px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 4px; font-size:16px; font-weight:600; letter-spacing:.01em; }
  .sub { color:var(--ink-2); font-size:12.5px; }
  main { padding:18px 26px 60px; max-width:1100px; }
  h2 { font-size:12.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink-3);
       margin:26px 0 10px; font-weight:600; }
  h2 .why { text-transform:none; letter-spacing:0; color:var(--ink-3); font-weight:400; }
  .item { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--unlikely);
          border-radius:6px; padding:12px 14px; margin:0 0 10px; }
  .item.likely { border-left-color:var(--likely); }
  .item.possible { border-left-color:var(--possible); }
  .item header { display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; }
  .item h3 { margin:0; font:600 14px var(--mono); }
  .kind { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--ink-3);
          border:1px solid var(--line); border-radius:3px; padding:1px 5px; }
  .where { color:var(--ink-3); font:11.5px var(--mono); margin-left:auto; }
  pre.decl { margin:8px 0 6px; padding:8px 10px; background:#0d1017; border:1px solid var(--line);
             border-radius:4px; font:12px/1.5 var(--mono); color:var(--ink); overflow-x:auto; }
  .commit { margin:4px 0; color:var(--ink-2); font-size:12px; }
  .sha { font:600 12px var(--mono); color:var(--ink); }
  ul.caveats { margin:6px 0 0; padding-left:18px; color:var(--possible); font-size:12px; }
  .refs { margin:5px 0 0; color:var(--ink-3); font:11.5px var(--mono); }
  .refs.asset { color:var(--unlikely); }
  .empty { color:var(--ink-2); }
  footer { padding:0 26px 40px; color:var(--ink-3); font-size:12px; max-width:1100px; }
  .notes { margin:10px 0 0; padding-left:18px; }
</style>
<header class="top">
  <h1>chore · ${esc(r.branch)}</h1>
  <div class="sub">${r.commits.length} commit(s) · ${r.filesExamined} code file(s) touched ·
    ${r.candidates} member(s) added · <strong>${r.findings.length} unused</strong> ·
    ${esc(r.generatedAt.slice(0, 19).replace('T', ' '))}</div>
</header>
<main>
${byConfidence.length
    ? byConfidence.map((g) => `<h2>${g.c} <span class="why">— ${esc(CONFIDENCE_NOTE[g.c])}</span></h2>`
      + g.items.map(card).join('')).join('')
    : '<p class="empty">Nothing added in that range is unused. That is the answer, not an empty result.</p>'}
</main>
<footer>
  Each item is a member ADDED in the range whose declaration is still in HEAD — added-then-removed is
  history and was dropped. &ldquo;Unused&rdquo; means no word-boundary reference anywhere in the tracked
  tree; code and assets were both searched, because a Unity field is named from a prefab and a method can
  be named from an animation clip.
  ${r.skipped.length ? `<ul class="notes">${r.skipped.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
</footer>
`;
}
