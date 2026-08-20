/**
 * diff/collect.ts — the working tree, as a structure a page can render.
 *
 * "The diff" here means **everything that is not in HEAD**: staged, unstaged, AND untracked. Leaving
 * untracked files out is the tempting simplification and it is wrong — a new file is the part of a
 * change most worth reviewing, and a review page that silently omits it teaches the reader to trust
 * a picture that is missing its newest half.
 *
 * Two limits are enforced here rather than in the renderer, because a renderer that has already been
 * handed 400k lines has already lost. Both are REPORTED, never silent: a truncation the reader cannot
 * see is indistinguishable from a small diff, and that is exactly the wrong conclusion to hand
 * someone deciding whether their tree is safe to commit.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Per-file line cap. A generated file with a 40k-line change is a fact, not something to read. */
const MAX_LINES_PER_FILE = 2000;
/** Whole-run file cap. Past this the page stops being a review and becomes a scroll. */
const MAX_FILES = 500;
/**
 * Whole-page line budget — the limit that actually protects the reader.
 *
 * Measured, not guessed: the first run of this against a real tree produced a **48 MB page** with
 * 341k lines, 439 of them generated `.js` from build-output directories that were untracked but not
 * ignored. A per-file cap does nothing there, because no single file was large; there were simply
 * hundreds. Past this budget a file keeps its row, its status and its true +/− counts — so the
 * sidebar and the totals stay honest — and only its body is dropped.
 */
const MAX_TOTAL_LINES = 60000;
/** Untracked files larger than this are listed, not read. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
/** git output is not small. The default 1 MiB maxBuffer throws on any real diff. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

export type LineKind = 'ctx' | 'add' | 'del';
export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** [start, end) character span that actually changed, when a del/add pair differ in one place. */
  span?: [number, number];
  /** The change is whitespace only — real, but not what the eye should be spending itself on. */
  wsOnly?: boolean;
}

export interface Hunk {
  header: string;      // the @@ … @@ itself
  section: string;     // what git puts after it: the enclosing function, usually
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  ext: string;         // lowercase, WITH the dot; '' for extensionless
  additions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
  /**
   * Are THESE hunks in the index?
   *
   * A file is not staged or unstaged — its individual changes are. `git status` reports two columns
   * for exactly that reason, and a partially-staged file (`MM`) genuinely has both. So one path can
   * yield TWO FileDiff entries, one per side, each carrying only the hunks that belong to it. Reading
   * the combined `git diff HEAD` and labelling the file by its index column would show staged and
   * unstaged hunks under one heading, which is a diff that does not exist in either place.
   */
  staged: boolean;
  hunks: Hunk[];
  truncated: boolean;    // hit MAX_LINES_PER_FILE
  bodyOmitted: boolean;  // hit MAX_TOTAL_LINES — counts are real, the text is not rendered
}

export interface DiffSet {
  repo: string;
  branch: string;
  against: string;     // what the working tree was compared to
  head: string;        // short sha + subject
  files: FileDiff[];
  filesOmitted: number;   // dropped by MAX_FILES — reported, never silent
  bodiesOmitted: number;  // rendered as a row only, because the page budget ran out
  generatedAt: string;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function gitQuiet(repo: string, args: string[]): string {
  try { return git(repo, args).trim(); } catch { return ''; }
}

// ── word-level marking ───────────────────────────────────────────────────────────
//
// The single largest readability win after triage. A one-token change on a 120-character line reads
// as an entire rewritten line when both sides are flat red and green — the reader re-derives what
// changed, on every line, by eye. Common prefix + common suffix finds the changed span in one pass
// and catches nearly every real edit (a renamed identifier, a flipped operator, an added argument)
// without paying for a word-level Myers diff on a page that may hold thousands of pairs.

function markSpan(del: DiffLine, add: DiffLine): void {
  const a = del.text, b = add.text;
  if (a === b) return;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  // Snap outward to whole tokens. Raw character boundaries are correct and unreadable: `100` → `250`
  // shares no prefix but shares the trailing `0`, so the exact span is `10` → `25` and the page
  // renders `1̲0̲0` — a highlight that cuts a number in half, which the eye has to undo before it can
  // read either value. Word characters on both sides are pulled in so the mark covers the identifier
  // or literal a human would say had changed.
  const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  while (start > 0 && isWord(a[start - 1])) start--;
  while (endA < a.length && endB < b.length && isWord(a[endA]) && isWord(b[endB])) { endA++; endB++; }

  // A span covering the whole line teaches nothing — that is just "this line changed", which the
  // colour already said.
  if (start === 0 && endA === a.length && endB === b.length) return;
  del.span = [start, endA];
  add.span = [start, endB];
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) { del.wsOnly = true; add.wsOnly = true; }
}

/**
 * Pair the del-run and add-run inside a hunk, positionally.
 *
 * Only equal-length runs are paired. Unequal runs mean lines were inserted or removed rather than
 * edited, and pairing them by index invents correspondences that are not there — highlighting a
 * "change" between two lines that have nothing to do with each other is worse than no highlight.
 */
function markHunk(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== 'del') { i++; continue; }
    let d = i; while (d < lines.length && lines[d].kind === 'del') d++;
    let a = d; while (a < lines.length && lines[a].kind === 'add') a++;
    const dels = d - i, adds = a - d;
    if (dels > 0 && dels === adds) {
      for (let k = 0; k < dels; k++) markSpan(lines[i + k], lines[d + k]);
    }
    i = a > i ? a : i + 1;
  }
}

// ── parsing ──────────────────────────────────────────────────────────────────────

function parseUnified(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0, newNo = 0;

  const push = () => { if (file) { markHunkAll(file); files.push(file); } };
  const markHunkAll = (f: FileDiff) => { for (const h of f.hunks) markHunk(h.lines); };

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      push();
      hunk = null;
      // `diff --git a/x b/y` — paths may contain spaces, so take the halves around ' b/' rather than
      // splitting on whitespace, which silently mangles every path with a space in it.
      const rest = line.slice('diff --git '.length);
      const mid = rest.lastIndexOf(' b/');
      const p = mid > 0 ? rest.slice(mid + 3) : rest.replace(/^a\//, '');
      file = {
        path: p, status: 'modified', ext: extname(p).toLowerCase(),
        additions: 0, deletions: 0, binary: false, untracked: false, hunks: [], truncated: false, bodyOmitted: false,
        // Stamped by the caller: parseUnified does not know which of the two diffs it was handed.
        staged: false,
      };
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) { file.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
    if (line.startsWith('rename from ')) { file.oldPath = line.slice('rename from '.length); file.status = 'renamed'; continue; }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) { file.binary = true; continue; }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
      if (!m) continue;
      oldNo = Number(m[1]); newNo = Number(m[2]);
      hunk = { header: line.slice(0, line.indexOf('@@', 2) + 2), section: m[3] ?? '', lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (file.truncated) continue;
    if (hunk.lines.length + countLines(file) >= MAX_LINES_PER_FILE) { file.truncated = true; continue; }

    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
      file.additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
      file.deletions++;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    }
    // '\ No newline at end of file' and mode lines fall through deliberately.
  }
  push();
  return files;
}

function countLines(f: FileDiff): number {
  let n = 0;
  for (const h of f.hunks) n += h.lines.length;
  return n;
}

// ── untracked ────────────────────────────────────────────────────────────────────

function untrackedFiles(repo: string, budget: { left: number }): FileDiff[] {
  // -uall lists files individually; without it git collapses a new directory to `dir/`, which hides
  // every file inside it behind a single row nobody can filter or read.
  const out = gitQuiet(repo, ['ls-files', '--others', '--exclude-standard']);
  if (!out) return [];
  const files: FileDiff[] = [];
  for (const rel of out.split('\n').filter(Boolean)) {
    const abs = join(repo, rel);
    const f: FileDiff = {
      path: rel, status: 'added', ext: extname(rel).toLowerCase(),
      additions: 0, deletions: 0, binary: false, untracked: true, hunks: [], truncated: false, bodyOmitted: false,
      staged: false,  // untracked is in no index, by definition
    };
    try {
      const size = statSync(abs).size;
      if (size > MAX_UNTRACKED_BYTES) { f.binary = true; files.push(f); continue; }
      const buf = readFileSync(abs);
      // A NUL byte in the first block is how git itself decides "binary", and it is the only check
      // that does not depend on guessing from the extension.
      if (buf.subarray(0, 8000).includes(0)) { f.binary = true; files.push(f); continue; }
      const text = buf.toString('utf-8');
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      f.additions = lines.length;
      // Counted either way; built only while the page budget allows. Not an optimisation — 500
      // untracked files at 2000 lines each is a million DiffLine objects nobody will ever read.
      if (budget.left <= 0) { f.bodyOmitted = true; files.push(f); continue; }
      const shown = lines.slice(0, Math.min(MAX_LINES_PER_FILE, budget.left));
      budget.left -= shown.length;
      f.truncated = shown.length < lines.length;
      f.hunks = [{
        header: `@@ -0,0 +1,${lines.length} @@`, section: '',
        lines: shown.map((t, i) => ({ kind: 'add' as LineKind, oldNo: null, newNo: i + 1, text: t })),
      }];
    } catch { f.binary = true; }
    files.push(f);
  }
  return files;
}

// ── the set ──────────────────────────────────────────────────────────────────────

export function collectDiff(repo: string, against = 'HEAD'): DiffSet {
  const branch = gitQuiet(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || '(detached)';
  const head = gitQuiet(repo, ['log', '-1', '--format=%h %s']) || '(no commits yet)';

  // TWO diffs, not one. `--cached <rev>` is index-vs-rev and a bare `diff` is worktree-vs-index; they
  // sum to the worktree-vs-rev this page used to show, but split at the boundary the operator acts
  // on. The split holds for any rev, not just HEAD, because only the first command takes one.
  //
  // A repo with no commits has no HEAD to diff against; everything in it is untracked anyway, so the
  // tracked half is simply empty rather than an error the operator has to interpret.
  let stagedRaw = '', unstagedRaw = '';
  if (head !== '(no commits yet)') {
    // -M finds renames: a moved file rendered as a whole delete plus a whole add is the single
    // largest source of fake volume in a review page.
    try { stagedRaw = git(repo, ['diff', '-M', '--no-color', '--no-ext-diff', '--cached', against]); } catch { stagedRaw = ''; }
    try { unstagedRaw = git(repo, ['diff', '-M', '--no-color', '--no-ext-diff']); } catch { unstagedRaw = ''; }
  }

  // Tracked first, and it spends the budget first. A file git already knows about is a change the
  // operator made on purpose; an untracked one may be build output they never looked at. When
  // something has to be dropped, that ordering decides which — and it is the whole reason the first
  // real run rendered 439 generated `.js` files and none of the source.
  const staged = parseUnified(stagedRaw).map((f) => ({ ...f, staged: true }));
  const unstaged = parseUnified(unstagedRaw).map((f) => ({ ...f, staged: false }));
  const budget = { left: MAX_TOTAL_LINES };
  for (const f of [...staged, ...unstaged]) for (const h of f.hunks) budget.left -= h.lines.length;
  // Untracked files are in no index by definition, so they are always the unstaged side.
  const untracked = untrackedFiles(repo, budget);

  let files = [...staged, ...unstaged, ...untracked];
  // Sort by what a reader triages on — STAGED first (it is what a commit would take), then tracked
  // before untracked, then biggest change first, then path so the order is stable between runs of an
  // unchanged tree.
  files.sort((a, b) =>
    Number(b.staged) - Number(a.staged)
    || Number(a.untracked) - Number(b.untracked)
    || (b.additions + b.deletions) - (a.additions + a.deletions)
    || a.path.localeCompare(b.path));

  const filesOmitted = Math.max(0, files.length - MAX_FILES);
  if (filesOmitted) files = files.slice(0, MAX_FILES);
  const bodiesOmitted = files.filter((f) => f.bodyOmitted).length;

  return {
    repo, branch, against, head, files, filesOmitted, bodiesOmitted,
    generatedAt: new Date().toISOString(),
  };
}

export const LIMITS = { MAX_LINES_PER_FILE, MAX_FILES, MAX_UNTRACKED_BYTES };
