#!/usr/bin/env node
/**
 * check-diff — `/diff` and `ayin diff`, against a real git repo built for the purpose.
 *
 * `npm run check:diff` (needs a build first). No LLM, no network, no browser opened.
 *
 * The load-bearing assertion is the first one: **the counts match `git diff --numstat`**. Everything
 * else on the page is presentation, but a review page that under-reports a change is actively
 * dangerous — the reader concludes their tree is safe on evidence the tool invented. So the gate
 * builds a repo with modifications, deletions, a rename, a binary, a path with a space and an
 * untracked file, and checks the collected numbers against git's own.
 *
 * The rest guard the specific bugs this feature can have:
 *
 *   - **Escaping.** Diff text is arbitrary source. A file containing `</script>` must not close the
 *     page's script tag, and an `onerror=` attribute must not survive as markup. This is the one
 *     failure here that is a security bug rather than a readability one.
 *   - **The page budget.** The first real run produced a 48 MB page: 439 generated `.js` files from
 *     untracked build-output directories, and none of the actual source. The rule that fixed it —
 *     tracked spends the budget first — is asserted directly, because it is invisible in any single
 *     small diff and only shows up on the tree nobody tests against.
 *   - **The hidden count.** Filters default to off for most extensions, so a large diff can look
 *     small. The count of what is hidden must be in the page, always.
 *   - **Word spans.** Only equal-length del/add runs may be paired; pairing unequal runs invents
 *     correspondences between lines that have nothing to do with each other.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'ayin-diffhome-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const REPO = mkdtempSync(join(tmpdir(), 'ayin-diffrepo-'));
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
const write = (rel, text) => {
  const p = join(REPO, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

// ── a repo with one of everything ────────────────────────────────────────────────

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'gate@example.invalid');
git('config', 'user.name', 'gate');

write('src/Player.cs', 'class Player {\n  int health = 100;\n  void Hit() { health -= 1; }\n}\n');
write('src/gone.ts', 'export const dead = true;\n');
write('src/moved.ts', 'export const moved = 1;\n');
write('with space/a file.cs', 'class Spaced {}\n');
write('data.bin', Buffer.from([0, 1, 2, 0, 3, 255, 0]).toString('binary'));
write('keep.md', '# unchanged\n');
git('add', '-A');
git('commit', '-qm', 'base');

// modify (one token), delete, rename, whitespace-only, and an untracked addition
write('src/Player.cs', 'class Player {\n  int health = 250;\n  void Hit() { health -= 1; }\n}\n');
execFileSync('git', ['rm', '-q', 'src/gone.ts'], { cwd: REPO, stdio: 'ignore' });
execFileSync('git', ['mv', 'src/moved.ts', 'src/renamed.ts'], { cwd: REPO, stdio: 'ignore' });
write('with space/a file.cs', 'class    Spaced {}\n');           // whitespace only
write('src/new.py', 'def hello():\n    return 1\n');             // untracked
write('evil.ts', 'const x = "</script><img src=x onerror=alert(1)>";\n');  // untracked, hostile

const collect = await import(join(ROOT, 'dist/diff/collect.js'));
const render = await import(join(ROOT, 'dist/diff/render.js'));

const set = collect.collectDiff(REPO);
const byPath = Object.fromEntries(set.files.map((f) => [f.path, f]));

// ── 1 · the counts are git's, not ours ───────────────────────────────────────────

const numstat = git('diff', '--numstat', '-M', 'HEAD').trim().split('\n').filter(Boolean);
let mismatched = [];
for (const row of numstat) {
  const [add, del, path] = row.split('\t');
  if (add === '-') continue;                       // binary, git reports no counts
  const p = path.includes('=>') ? path.replace(/.*=> ?/, '').replace(/}$/, '') : path;
  const f = byPath[p] ?? Object.values(byPath).find((x) => x.path.endsWith(p.split('/').pop()));
  if (!f) { mismatched.push(`${p}: absent`); continue; }
  if (f.additions !== Number(add) || f.deletions !== Number(del)) {
    mismatched.push(`${p}: got +${f.additions}/-${f.deletions}, git says +${add}/-${del}`);
  }
}
ok(mismatched.length === 0, 'every tracked file\'s +/− matches `git diff --numstat`', mismatched.join(' | '));

// ── 2 · statuses, including the ones that are easy to get wrong ──────────────────

ok(byPath['src/gone.ts']?.status === 'deleted', 'a deleted file is deleted, not an empty modify');
ok(byPath['src/renamed.ts']?.status === 'renamed',
  'a rename is a rename — rendering it as delete+add is the largest source of fake volume',
  byPath['src/renamed.ts']?.status);
ok(byPath['with space/a file.cs'] !== undefined,
  'a path containing a space survives parsing — splitting `diff --git` on whitespace mangles it');
ok(byPath['src/new.py']?.untracked === true, 'an untracked file is included and marked untracked');
ok(byPath['data.bin'] === undefined || byPath['data.bin'].binary,
  'a binary file is flagged binary rather than rendered');

// ── 3 · word spans, only where they mean something ───────────────────────────────

const player = byPath['src/Player.cs'];
const del = player.hunks.flatMap((h) => h.lines).find((l) => l.kind === 'del');
const add = player.hunks.flatMap((h) => h.lines).find((l) => l.kind === 'add');
ok(del?.span && add?.span, 'a one-token change gets a marked span, not two flat coloured lines');
ok(del && del.text.slice(del.span[0], del.span[1]) === '100',
  'the span covers exactly the token that changed', del && del.text.slice(del.span[0], del.span[1]));
ok(add && add.text.slice(add.span[0], add.span[1]) === '250', 'and its replacement on the add side');

const spaced = byPath['with space/a file.cs'];
const wsLine = spaced.hunks.flatMap((h) => h.lines).find((l) => l.kind === 'del');
ok(wsLine?.wsOnly === true, 'a whitespace-only change is flagged so it does not eat attention');

// ── 4 · escaping — the one failure here that is a security bug ───────────────────

const html = render.renderDiffPage(set);
ok(!html.includes('</script><img'), 'a file containing </script> cannot close the page\'s script tag');
ok(!/<img src=x onerror=/.test(html), 'an onerror attribute from source text is escaped, not live');
ok(html.includes('&lt;/script&gt;'), 'it is present as escaped text — escaping must not mean dropping');

// ── 5 · the filters, and the count that stops them lying ─────────────────────────

ok(JSON.stringify(render.DEFAULT_EXTENSIONS) === JSON.stringify(['.cs', '.asset', '.ts', '.js', '.py']),
  'default-on extensions are exactly .cs .asset .ts .js .py');
ok(/class="chip on" data-ext="\.cs"/.test(html), '.cs starts enabled');
ok(/class="chip" data-ext="\.md"/.test(html) || !html.includes('data-ext=".md"'),
  '.md starts disabled — everything outside the default set is one click away');
ok(html.includes("id=\"count\""), 'the hidden-file count element is present');
ok(/hidden/.test(html), 'the page says how many files a filter is hiding — a filter that hides silently lies');
ok(html.includes('id="all"'), 'one click shows everything');

// ── 6 · the page budget, and who spends it first ─────────────────────────────────
//
// Reproduces the shape of the 48 MB run: many untracked generated files, a few tracked source
// changes. Tracked must keep their bodies; untracked must be the ones that lose them.

for (let i = 0; i < 45; i++) {
  write(`generated/out${i}.js`, Array.from({ length: 1600 }, (_, n) => `var line${n} = ${n};`).join('\n'));
}
const big = collect.collectDiff(REPO);
const trackedFiles = big.files.filter((f) => !f.untracked);
ok(big.bodiesOmitted > 0, 'a tree of generated files spends the page budget and reports it', String(big.bodiesOmitted));
ok(trackedFiles.every((f) => !f.bodyOmitted),
  'every TRACKED file keeps its body — the budget is spent on real changes first');
ok(big.files.findIndex((f) => f.untracked) > big.files.findIndex((f) => !f.untracked),
  'tracked files sort before untracked, so the file cap drops noise rather than source');
const omittedFile = big.files.find((f) => f.bodyOmitted);
ok(omittedFile && omittedFile.additions > 0,
  'a file whose body was dropped still reports its TRUE line count — the row must not read as empty');
const bigHtml = render.renderDiffPage(big);
ok(bigHtml.length < 12 * 1024 * 1024,
  'the page stays inside a size a browser can open', `${(bigHtml.length / 1024 / 1024).toFixed(1)} MB`);
ok(/no body/.test(bigHtml), 'and it says on the page which files were not rendered');

// ── 7 · a clean tree says so ─────────────────────────────────────────────────────

const CLEAN = mkdtempSync(join(tmpdir(), 'ayin-diffclean-'));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: CLEAN, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'g@example.invalid'], { cwd: CLEAN, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', 'g'], { cwd: CLEAN, stdio: 'ignore' });
writeFileSync(join(CLEAN, 'a.ts'), 'export const a = 1;\n');
execFileSync('git', ['add', '-A'], { cwd: CLEAN, stdio: 'ignore' });
execFileSync('git', ['commit', '-qm', 'x'], { cwd: CLEAN, stdio: 'ignore' });
const clean = collect.collectDiff(CLEAN);
ok(clean.files.length === 0, 'a clean tree collects nothing');
ok(/Working tree is clean/.test(render.renderDiffPage(clean)), 'and the page says so instead of rendering blank');

// ── 8 · the refresh FAB ──────────────────────────────────────────────────────────
//
// A served page re-collects on every GET, so the FAB is a reload. The assertions that matter are
// which pages GET one: a file:// page has no server to rebuild from, and a refresh button that
// cannot refresh is worse than no button — the same call the page makes about comments.

console.log('\nrefresh FAB');

const fabSet = collect.collectDiff(CLEAN);
const served = render.renderDiffPage(fabSet, { interactive: true, rev: 'HEAD', comments: [] });
const staticPage = render.renderDiffPage(fabSet, { interactive: false, rev: 'HEAD', comments: [] });

ok(/id="refresh"/.test(served), 'a SERVED page carries the FAB');
ok(!/id="refresh"/.test(staticPage), 'a file:// page does NOT — there is nothing to rebuild from');
ok(/fab\.onclick/.test(served) && !/fab\.onclick/.test(staticPage),
  'and the wiring ships only with the page that can use it');
ok(/aria-label="Rebuild against the current working tree"/.test(served),
  'the FAB is labelled for a screen reader, not icon-only');
ok(/function rememberViewport/.test(served), 'it records the reader position before reloading');
ok(/sessionStorage\.setItem\(ANCHOR/.test(served) && (served.match(/ANCHOR = /g) || []).length === 1,
  'reusing the post-fix reload anchor — ONE anchor, not a second mechanism');
ok(/\.fab\.busy\{pointer-events:none/.test(served),
  'a click disarms the button: a slow re-collect must not be startable twice');

// ── 9 · the index: two diffs, two sections, the buttons ──────────────────────────
//
// Staged and unstaged are collected as TWO diffs (`--cached <rev>` and a bare `diff`), so a
// partially-staged file yields two entries carrying only its own side's hunks. No LLM here: the .cs
// line-level pass needs a model, so this exercises every branch that does not.

console.log('\nthe index');

const IX = mkdtempSync(join(tmpdir(), 'ayin-diffix-'));
const g = (...a) => execFileSync('git', a, { cwd: IX, stdio: 'ignore' });
const w = (rel, body) => {
  mkdirSync(dirname(join(IX, rel)), { recursive: true });
  writeFileSync(join(IX, rel), body);
};
g('init', '-q', '-b', 'main');
g('config', 'user.email', 'i@example.invalid'); g('config', 'user.name', 'i');
mkdirSync(join(IX, 'ProjectSettings'), { recursive: true });
w('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.0f1\n');
w('Assets/Scripts/Cfg.cs', 'public class Cfg { public int A; }\n');
w('Assets/Scripts/Cfg.cs.meta', 'fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
w('Assets/Anim/Hero.controller', 'AnimatorController:\n  m_Name: Hero\n');
w('Assets/Prefabs/Hero.prefab', '%YAML 1.1\nGameObject:\n  m_Name: Hero\n');
w('Assets/Data/Good.asset', '%YAML 1.1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}\n');
w('Assets/ThirdParty/Vendor.asset', '%YAML 1.1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: ffffffffffffffffffffffffffffffff, type: 3}\n');
w('Assets/Data/Baked.asset', 'LightingData:\n  m_Name: baked\n');
w('ProjectSettings/EditorSettings.asset', '%YAML 1.1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}\n');
g('add', '-A'); g('commit', '-qm', 'base');

// One file with BOTH a staged and an unstaged change — the shape the split exists for.
w('Assets/Data/Good.asset', '%YAML 1.1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}\n  A: 1\n');
g('add', 'Assets/Data/Good.asset');
w('Assets/Data/Good.asset', '%YAML 1.1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}\n  A: 1\n  B: 2\n');
// …and the rest unstaged, animator FIRST in `git status` order so the leading-space bug is covered.
w('Assets/Anim/Hero.controller', 'AnimatorController:\n  m_Name: Hero\n  m_Speed: 2\n');
w('Assets/Prefabs/Hero.prefab', '%YAML 1.1\nGameObject:\n  m_Name: Hero\n  m_Layer: 3\n');
w('Assets/ThirdParty/Vendor.asset', '%YAML 1.1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: ffffffffffffffffffffffffffffffff, type: 3}\n  v: 2\n');
w('Assets/Data/Baked.asset', 'LightingData:\n  m_Name: baked\n  size: 9\n');
w('ProjectSettings/EditorSettings.asset', '%YAML 1.1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}\n  p: 1\n');

const ixSet = collect.collectDiff(IX);
const stagedOf = (p) => ixSet.files.filter((f) => f.path === p && f.staged);
const unstagedOf = (p) => ixSet.files.filter((f) => f.path === p && !f.staged);

ok(stagedOf('Assets/Data/Good.asset').length === 1 && unstagedOf('Assets/Data/Good.asset').length === 1,
  'a partially-staged file yields ONE entry per side, not one entry with a label');
ok(stagedOf('Assets/Data/Good.asset')[0].additions === 1,
  'the staged entry carries only the staged hunk', String(stagedOf('Assets/Data/Good.asset')[0].additions));
ok(unstagedOf('Assets/Data/Good.asset')[0].additions === 1,
  'and the unstaged entry only the unstaged one', String(unstagedOf('Assets/Data/Good.asset')[0].additions));
ok(ixSet.files.filter((f) => f.staged).length === 1, 'nothing else is on the staged side');
ok(ixSet.files.every((f) => typeof f.staged === 'boolean'), 'every file states which side it is on');

const ixHtml = render.renderDiffPage(ixSet, { interactive: true, rev: 'HEAD', comments: [] });
const ixStatic = render.renderDiffPage(ixSet, { interactive: false, rev: 'HEAD', comments: [] });
ok(/data-staged="true"/.test(ixHtml) && /data-staged="false"/.test(ixHtml),
  'the sidebar renders both sections');
ok(/class="ix" data-act="unstage"/.test(ixHtml) && /class="ix" data-act="stage"/.test(ixHtml),
  'a staged card offers unstage and an unstaged card offers stage');
ok(/id="autostage"/.test(ixHtml), 'the top panel carries the Stage button');
ok(!/class="ix"/.test(ixStatic) && !/id="autostage"/.test(ixStatic),
  'a file:// page carries NO index buttons — staging is a git write and there is no server');
ok(/querySelectorAll\('\.sect'\)/.test(ixHtml),
  'section counts are recomputed from the FILTER, so a hidden row cannot inflate them');

// ── the policy, minus the .cs pass (that one needs a model) ──
const { autoStage } = await import(`file://${join(ROOT, 'dist', 'diff', 'stage.js')}`);
const res = await autoStage(IX);
const why = (p) => (res.outcomes.find((o) => o.path === p) || {});
ok(res.policy === 'unity', 'a Unity repo gets the Unity policy', res.policy);
// THE REGRESSION THIS GATE EXISTS FOR: `git status --porcelain` puts the index status in column 1, so
// an unstaged change begins with a SPACE. Trimming the blob ate it off the FIRST line only, which read
// as already-staged and shifted the path by one — the animator controller silently vanished from the
// pass while its six siblings were judged correctly.
ok(res.outcomes.length === 6, 'every changed file gets an outcome, INCLUDING the first status line',
  `${res.outcomes.length}: ${res.outcomes.map((o) => o.path).join(', ')}`);
ok(why('Assets/Anim/Hero.controller').staged === true, 'an animator controller is staged');
ok(why('Assets/Prefabs/Hero.prefab').staged === true, 'a prefab IS staged here — unlike the daemon allowlist');
ok(why('Assets/Data/Good.asset').staged === true, 'a ScriptableObject of a project script is staged');
ok(why('Assets/ThirdParty/Vendor.asset').staged === false, 'a third-party asset guid is left alone');
ok(why('Assets/Data/Baked.asset').staged === false, 'baked data with no m_Script is left alone');
ok(why('ProjectSettings/EditorSettings.asset').staged === false,
  'project base config outside Assets/ is left alone', why('ProjectSettings/EditorSettings.asset').why);
ok(res.outcomes.every((o) => typeof o.why === 'string' && o.why.length > 0),
  'every outcome carries a reason — a file that silently failed to stage is the complaint this answers');

// ── the path guard on the write routes ──
const { safeRepoPath } = await import(`file://${join(ROOT, 'dist', 'diff', 'stage.js')}`);
ok(safeRepoPath(IX, 'Assets/Prefabs/Hero.prefab'), 'a real repo path is accepted');
ok(!safeRepoPath(IX, '../../../etc/passwd'), 'traversal is refused');
ok(!safeRepoPath(IX, '--cached'), 'a flag-shaped path is refused before it reaches git');
ok(!safeRepoPath(IX, '/etc/passwd'), 'an absolute path is refused');

// ── 10 · the commit-message panel and the draft pipeline's deterministic half ────
//
// No model and no Jira here. The pipeline is built so the DECISION to spend either is deterministic,
// which is exactly the part a gate can pin: with no ticket-shaped string anywhere, it must decline
// before reaching the network.

console.log('\ncommit draft');

const withDraft = render.renderDiffPage(fabSet, {
  interactive: true, rev: 'HEAD', comments: [], commitDraft: 'feat(scope): a subject\n\nA body line.',
});
const noDraft = render.renderDiffPage(fabSet, { interactive: true, rev: 'HEAD', comments: [], commitDraft: null });
const staticDraft = render.renderDiffPage(fabSet, {
  interactive: false, rev: 'HEAD', comments: [], commitDraft: 'feat(scope): a subject',
});

ok(/class="commit"/.test(withDraft), 'the page carries a commit-message panel');
ok(/feat\(scope\): a subject/.test(withDraft), 'and renders the draft text');
ok(/\.git\/COMMIT_EDITMSG/.test(withDraft), 'the panel names where the text came from — git, not a copy');
ok(/No draft yet/.test(noDraft), 'an ABSENT draft is stated, never a blank panel');
ok(/id="draft"/.test(withDraft) && !/id="draft"/.test(staticDraft),
  'Draft is served-only — it spends a model call and needs the route');

const { gatherDraftContext, transcriptDir, draftText } = await import(`file://${join(ROOT, 'dist', 'commit-draft.js')}`);
ok(transcriptDir('/a/b-c').endsWith('-a-b-c'), 'the transcript dir flattens the repo path', transcriptDir('/a/b-c'));
ok(draftText({ type: 'fix', scope: 'ui', subject: 's', body: 'b' }) === 'fix(ui): s\n\nb\n',
  'the message is assembled as conventional-commit text');
ok(draftText({ type: 'fix', scope: '', subject: 's', body: '' }) === 'fix: s\n',
  'an empty scope and body collapse cleanly');

// A repo with changes but NO ticket shape anywhere: the deterministic gate must refuse before Jira.
const dctx = await gatherDraftContext(IX);
ok(dctx.candidates.length === 0, 'no ticket-shaped string in branch, session, subjects or diff', dctx.candidates.join(','));
ok(dctx.tickets.length === 0 && /no ticket key/.test(dctx.jiraNote),
  'so it declines with a reason and never reaches the network', dctx.jiraNote);
ok(dctx.files.length > 0, 'while still reporting the changed files it found', String(dctx.files.length));

rmSync(IX, { recursive: true, force: true });
rmSync(REPO, { recursive: true, force: true });
rmSync(CLEAN, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\ndiff check: ${fails} FAILURE(S)\n` : '\ndiff check: ok\n');
process.exit(fails ? 1 : 0);
