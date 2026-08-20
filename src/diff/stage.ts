/**
 * diff/stage.ts — the review page's own staging policy, and the git writes behind it.
 *
 * WHY THIS IS NOT `unityStageReason`. The watch daemon has an allowlist with two properties stated in
 * its own comments and worth keeping: a prefab never gets auto-staged, and *"there is no model
 * judgement in this decision, by design"*. Both are right for a background process that stages while
 * nobody is watching. Neither is right for a button an operator pressed: they chose the moment, they
 * can see the result, and they can undo it with the button next to it. So this is a SECOND policy,
 * deliberately, and the daemon's is untouched. The cost is two policies to keep in step; the
 * alternative was changing background behaviour on every watched repo to serve a foreground click.
 *
 * WHAT IT STAGES, in a Unity repo:
 *
 *   .anim .controller   whole file — animation data is authored, not generated
 *   .prefab             whole file — the daemon refuses these; a human pressing Stage does not
 *   .asset              only under Assets/, only a ScriptableObject whose m_Script guid resolves to a
 *                       .cs IN THIS PROJECT. That one guid check is what excludes third-party and
 *                       package assets, and the Assets/ test is what excludes ProjectSettings/ and
 *                       EditorSettings — they are not third-party, they are the project's own base
 *                       config, and staging them by machine is how an unrelated editor preference
 *                       rides into someone's commit.
 *   .cs                 LINE BY LINE. A model classifies the added lines; the clean ones are staged
 *                       and the debug ones are left in the working tree. See stageCleanLines().
 *   .meta               follows its asset: staged only when the thing it describes was staged, because
 *                       a .meta without its asset is a guid pointing at nothing.
 *
 * Everything else is skipped WITH A REASON. A file that silently failed to stage is the complaint
 * this whole module exists to answer.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { llmChat } from '../llm/manager.js';
import { log } from '../log.js';
import { prompts, packagePath } from '../prompts-service.js';

/** The same `watch` namespace the daemon's prompts live in — registering twice is idempotent and
 *  returns the same bundle. Registered HERE rather than imported from watch.ts: that module reaches
 *  the LLM manager and, behind it, a blessed screen built at module scope, so importing it to borrow
 *  a bundle would take over the terminal (see hound-off.ts for the same trap). */
const stagePrompts = prompts.register('watch', packagePath('prompts', 'watch')).bundle;

/** Never stage a file bigger than this — blobs and binaries are not review material. */
const MAX_STAGE_BYTES = 2 * 1024 * 1024;
/** Added lines sent to the model in one classification call. */
const MAX_CLASSIFY_LINES = 400;

const ANIM_RE = /\.(anim|controller)$/i;
const MONO_SCRIPT_RE = /m_Script:\s*\{fileID:\s*11500000,\s*guid:\s*([0-9a-f]{32})/;

export interface StageOutcome {
  path: string;
  staged: boolean;
  /** Why it was staged, or why it was not. Always present — this is the product. */
  why: string;
  /** Lines held back by the line-level pass, when any were. */
  heldBack?: number;
}

function git(repo: string, args: string[], maxBuffer = 8 * 1024 * 1024): string {
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', maxBuffer, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function gitQuiet(repo: string, args: string[]): string {
  try { return git(repo, args).trim(); } catch { return ''; }
}

/**
 * Like gitQuiet but WITHOUT trim, for output whose leading whitespace is data.
 *
 * `git status --porcelain` puts the index status in column 1 and the worktree status in column 2, so an
 * unstaged modification begins with a SPACE. Trimming the whole blob eats that space off the FIRST line
 * only — which turned ` M Assets/Anim/Hero.controller` into `M Assets/…`, read as already-staged, and
 * shifted the path by one character. Position-dependent and silent: the file was simply never
 * considered, and every other line was fine. Measured on the fixture — the animator controller vanished
 * from the pass while its six siblings were judged correctly.
 */
function gitRaw(repo: string, args: string[]): string {
  try { return git(repo, args); } catch { return ''; }
}

/** A path from a browser. It must name a file inside this repo and nothing else. */
export function safeRepoPath(repo: string, path: string): boolean {
  if (!path || path.length > 4096) return false;
  if (path.startsWith('/') || path.startsWith('-') || /^[A-Za-z]:/.test(path)) return false;
  if (path.split('/').some((seg) => seg === '..')) return false;
  return existsSync(join(repo, path)) || gitQuiet(repo, ['ls-files', '--', path]) !== ''
    || gitQuiet(repo, ['diff', '--cached', '--name-only', '--', path]) !== '';
}

export function isUnityRepo(repo: string): boolean {
  return existsSync(join(repo, 'ProjectSettings', 'ProjectVersion.txt'))
    || existsSync(join(repo, 'Assets'));
}

// ── the two single-file writes the per-file buttons make ─────────────────────────

export function stageOne(repo: string, path: string): void {
  git(repo, ['add', '--', path]);
}

/** `restore --staged` keeps the working tree exactly as it is — only the index moves. For a file that
 *  is not in HEAD at all, that leaves it untracked again, which is the honest inverse of staging it. */
export function unstageOne(repo: string, path: string): void {
  git(repo, ['restore', '--staged', '--', path]);
}

// ── the .cs line-level pass ──────────────────────────────────────────────────────

/** The added lines of a file's UNSTAGED diff, as `{ n, text }` where n indexes into the patch body. */
interface PatchLine { idx: number; text: string }

/**
 * Ask the model which added lines are live debug output. Returns the set of patch indices to hold back.
 *
 * A failure here holds NOTHING back and says so — the caller then stages the file whole. That is the
 * safe direction: the operator asked for these changes to be staged, and a model that could not answer
 * is not a reason to silently drop their work from the index. The reason travels with the outcome.
 */
async function debugLineIndices(lines: PatchLine[]): Promise<{ hold: Set<number>; note: string }> {
  if (lines.length === 0) return { hold: new Set(), note: '' };
  if (lines.length > MAX_CLASSIFY_LINES) {
    return { hold: new Set(), note: `${lines.length} added lines exceeds the ${MAX_CLASSIFY_LINES}-line classification cap` };
  }
  const numbered = lines.map((l, i) => `${i + 1}: ${l.text}`).join('\n');
  let raw = '';
  try {
    // declareTools:false — this asks for JSON, not for work. A sub-loop that declares the tool
    // catalogue gets a native provider calling `grep` instead of answering (see LlmChatOptions).
    raw = await llmChat(
      [{ role: 'user', content: stagePrompts.get('stageDebugLines', { LINES: numbered }) }],
      { declareTools: false },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('WARN', 'stage_classify_failed', { error: msg });
    return { hold: new Set(), note: `debug classification failed (${msg}) — staged whole` };
  }
  const m = /\{[\s\S]*?"debug"\s*:\s*\[([^\]]*)\][\s\S]*?\}/.exec(raw);
  if (!m) return { hold: new Set(), note: 'debug classification returned no usable JSON — staged whole' };
  const hold = new Set<number>();
  for (const tok of m[1].split(',')) {
    const n = parseInt(tok.trim(), 10);
    // A number outside the list it was given is a hallucinated index, not a line to hold back.
    if (Number.isInteger(n) && n >= 1 && n <= lines.length) hold.add(lines[n - 1].idx);
  }
  return { hold, note: '' };
}

/**
 * Rebuild a unified diff with some ADDED lines dropped, then apply it to the index alone.
 *
 * Dropping a `+` line changes that hunk's new-side count, so the header is RECOMPUTED rather than
 * copied — a stale `@@` count is a patch git refuses, and refusing is the good case; the bad case is
 * a patch that applies at the wrong offset. A hunk left with no changes at all is dropped whole,
 * because a context-only hunk is noise git has to re-verify for nothing.
 *
 * `--cached` is the whole point: the index gets the clean lines, the working tree keeps everything,
 * and the held-back lines show up as the file's remaining unstaged change — which is exactly where an
 * operator would look for them.
 */
function applyFiltered(repo: string, patch: string, hold: Set<number>): { applied: boolean; held: number } {
  const src = patch.split('\n');
  const head: string[] = [];
  let i = 0;
  for (; i < src.length; i++) {
    head.push(src[i]);
    if (src[i].startsWith('+++ ')) { i++; break; }
  }
  const out = [...head];
  let held = 0;
  while (i < src.length) {
    if (!src[i].startsWith('@@')) { i++; continue; }
    const hdr = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(src[i]);
    if (!hdr) { i++; continue; }
    const oldStart = Number(hdr[1]);
    const newStart = Number(hdr[3]);
    const tail = hdr[5] ?? '';
    i++;
    const body: string[] = [];
    let oldN = 0, newN = 0, changes = 0;
    for (; i < src.length && !src[i].startsWith('@@') && !src[i].startsWith('diff --git'); i++) {
      const line = src[i];
      if (line === '' && i === src.length - 1) continue;
      if (line.startsWith('\\')) { body.push(line); continue; }  // "\ No newline at end of file"
      const kind = line[0];
      if (kind === '+') {
        if (hold.has(i)) { held++; continue; }                    // dropped: not applied, not counted
        body.push(line); newN++; changes++;
      } else if (kind === '-') {
        body.push(line); oldN++; changes++;
      } else {
        body.push(line); oldN++; newN++;
      }
    }
    if (!changes) continue;                                        // context-only after filtering
    out.push(`@@ -${oldStart},${oldN} +${newStart},${newN} @@${tail}`);
    out.push(...body);
  }
  if (out.length === head.length) return { applied: false, held };
  try {
    execFileSync('git', ['apply', '--cached', '--whitespace=nowarn', '-'], {
      cwd: repo, input: `${out.join('\n')}\n`, stdio: ['pipe', 'ignore', 'pipe'],
    });
    return { applied: true, held };
  } catch (e) {
    log('WARN', 'stage_filtered_apply_failed', { error: e instanceof Error ? e.message : String(e) });
    return { applied: false, held };
  }
}

/**
 * Stage a tracked `.cs` line by line: the clean added lines land in the index, the debug ones do not.
 *
 * An UNTRACKED `.cs` is staged whole or not at all. Partially staging a brand-new file would put a
 * version of it in the index that has never existed on disk, and "the file I just created is in the
 * index minus three lines I cannot see" is a worse surprise than being told it was skipped.
 */
async function stageCleanLines(repo: string, path: string, untracked: boolean): Promise<StageOutcome> {
  const patch = gitQuiet(repo, ['diff', '--no-color', '--no-ext-diff', '--', path]);
  if (untracked || !patch) {
    const body = (() => {
      try { return readFileSync(join(repo, path), 'utf-8').split('\n'); } catch { return []; }
    })();
    const { hold, note } = await debugLineIndices(body.map((text, idx) => ({ idx, text })));
    if (hold.size) {
      return { path, staged: false, why: `${hold.size} live debug line(s) — a new file is staged whole or not at all` };
    }
    stageOne(repo, path);
    return { path, staged: true, why: note || 'C# source, no live debug output' };
  }

  const src = patch.split('\n');
  const added: PatchLine[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i].startsWith('+') && !src[i].startsWith('+++')) added.push({ idx: i, text: src[i].slice(1) });
  }
  const { hold, note } = await debugLineIndices(added);
  if (hold.size === 0) {
    stageOne(repo, path);
    return { path, staged: true, why: note || 'C# source, no live debug output' };
  }
  const { applied, held } = applyFiltered(repo, patch, hold);
  if (!applied) {
    return { path, staged: false, why: `${hold.size} live debug line(s) and the filtered patch did not apply — left alone` };
  }
  return {
    path, staged: true, heldBack: held,
    why: `staged without ${held} live debug line(s) — they remain as this file's unstaged change`,
  };
}

// ── the policy ───────────────────────────────────────────────────────────────────

/** Does the guid belong to a `.cs` in THIS project rather than a package or Unity itself? */
function guidIsProjectScript(repo: string, guid: string, cache: Map<string, boolean>): boolean {
  const hit = cache.get(guid);
  if (hit !== undefined) return hit;
  const found = gitQuiet(repo, ['grep', '-l', '--untracked', '-F', '-e', `guid: ${guid}`, '--', 'Assets/*.cs.meta']) !== '';
  cache.set(guid, found);
  return found;
}

function assetReason(repo: string, path: string, cache: Map<string, boolean>): string | null {
  if (!/^Assets\//.test(path)) return null;   // ProjectSettings/, EditorSettings, Packages/, anything outside
  let text = '';
  try { text = readFileSync(join(repo, path), 'utf-8').slice(0, 64 * 1024); } catch { return null; }
  const guid = text.match(MONO_SCRIPT_RE)?.[1];
  if (!guid) return null;                      // baked data or a built-in asset type, not a ScriptableObject
  return guidIsProjectScript(repo, guid, cache) ? 'custom ScriptableObject asset' : null;
}

/**
 * Run the project-type policy over everything not yet staged, and report every file either way.
 *
 * Order matters for `.meta`: an asset decides first, and its sidecar follows that decision, so the two
 * never disagree. A `.meta` whose asset was skipped is skipped too, and says which asset decided it.
 */
export async function autoStage(repo: string): Promise<{ outcomes: StageOutcome[]; policy: string }> {
  if (!isUnityRepo(repo)) {
    return { outcomes: [], policy: 'none' };
  }
  const status = gitRaw(repo, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall']);
  const rows = status.split('\n').filter((l) => l.length > 3).map((l) => ({ xy: l.slice(0, 2), path: l.slice(3) }));
  // Only what is not already fully staged. A row whose worktree column is clean has nothing left to add.
  const candidates = rows.filter((r) => r.xy[1] !== ' ' || r.xy === '??');
  const guidCache = new Map<string, boolean>();
  const outcomes: StageOutcome[] = [];
  const decided = new Map<string, boolean>();

  const tooBig = (p: string): boolean => {
    try { return statSync(join(repo, p)).size > MAX_STAGE_BYTES; } catch { return false; }
  };

  // Assets before their sidecars, so `.meta` can follow a decision that already exists.
  const ordered = [...candidates].sort((a, b) => Number(a.path.endsWith('.meta')) - Number(b.path.endsWith('.meta')));

  for (const r of ordered) {
    const p = r.path;
    if (tooBig(p)) { outcomes.push({ path: p, staged: false, why: `larger than ${MAX_STAGE_BYTES / 1024 / 1024}MB` }); continue; }

    if (p.endsWith('.meta')) {
      const owner = p.slice(0, -'.meta'.length);
      const ownerStaged = decided.get(owner);
      if (ownerStaged === true) { stageOne(repo, p); outcomes.push({ path: p, staged: true, why: `sidecar of ${owner}` }); }
      else if (ownerStaged === false) outcomes.push({ path: p, staged: false, why: `its asset ${owner} was not staged` });
      else outcomes.push({ path: p, staged: false, why: 'no changed asset beside it to follow' });
      continue;
    }

    let outcome: StageOutcome;
    if (ANIM_RE.test(p)) { stageOne(repo, p); outcome = { path: p, staged: true, why: 'animator controller / clip' }; }
    else if (/\.prefab$/i.test(p)) { stageOne(repo, p); outcome = { path: p, staged: true, why: 'prefab' }; }
    else if (/\.cs$/i.test(p)) { outcome = await stageCleanLines(repo, p, r.xy === '??'); }
    else if (/\.asset$/i.test(p)) {
      const why = assetReason(repo, p, guidCache);
      if (why) { stageOne(repo, p); outcome = { path: p, staged: true, why }; }
      else {
        outcome = {
          path: p, staged: false,
          why: /^Assets\//.test(p)
            ? 'not a ScriptableObject of a script in this project — third-party or baked data'
            : 'outside Assets/ — project base config (ProjectSettings / EditorSettings)',
        };
      }
    } else outcome = { path: p, staged: false, why: `${p.split('.').pop() ?? 'this'} files are not in this project type's policy` };

    decided.set(p, outcome.staged);
    outcomes.push(outcome);
  }
  return { outcomes, policy: 'unity' };
}
