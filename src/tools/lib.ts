/**
 * Shared machinery for the built-in tools: bounded shell execution, path suggestions, and unified diffs.
 *
 * It reaches the shell through the same runtime seam every tool uses, not through core: extracting these
 * helpers must not smuggle back the one import the directory was cleared of.
 *
 * Extracted so each tool can live in its own file under `defs/` and be DISCOVERED rather than listed. A
 * static array meant every new tool — including a private or MCP-backed one — was an edit to the one file
 * both the public repo and any private copy always touch, which is the merge conflict that makes a fork
 * unworkable. Nothing here is tool-specific; it is the platform the file primitives share.
 */

import { toolShell } from './runtime.js';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, basename, resolve, join, isAbsolute } from 'node:path';

// ── Async exec ──────────────────────────────────────────────────────

let activeToolCancel: (() => void) | null = null;

export function cancelActiveToolExecution(): boolean {
  if (!activeToolCancel) return false;
  activeToolCancel();
  activeToolCancel = null;
  return true;
}

/**
 * Single-quote a value for the shell. A pattern or path is DATA: unquoted, a `$`, a backtick or a `"`
 * in it either expands to nothing (silently changing the search) or executes. `'` is closed, escaped
 * and reopened — the only safe form inside single quotes.
 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Result caps. Exceeding one is REPORTED, never silently cut — a truncated list the model believes is
 *  complete is how it concludes "that is everything" and stops looking. */
export const GREP_LIMIT = 50;
export const FIND_LIMIT = 30;

/**
 * Directories a code search must never WANDER INTO. Shared by `grep` and `find_files`, because two
 * search tools disagreeing about what the repo contains is its own bug.
 *
 * WATCHED IT HAPPEN. On a Unity repo, `grep pattern .` returned `.git/COMMIT_EDITMSG`,
 * `.git/packed-refs` and `.git/info/refs` among its first six hits — three of the model's opening
 * facts were git plumbing. Not merely noise: `COMMIT_EDITMSG` and the `*_MSG` files are PROSE ABOUT
 * CODE, frequently code that has since changed or been deleted, and it arrives looking exactly like a
 * source match. Same class of evidence as a stale corpus note, and just as hard to argue with later.
 *
 * The rest is flat waste: the result cap gets spent on plumbing, and Unity's `Library/` is gigabytes
 * of imported artifacts no question is ever about.
 *
 * An EXPLICIT path still wins. These prune what a search recurses INTO, never the directory it was
 * pointed at, so `path=Library` searches Library exactly as before — "do not wander in", not "you may
 * not look here".
 */
export const NEVER_RECURSE = [
  '.git', 'node_modules',
  'Library', 'Temp', 'obj', 'Logs', // Unity: imported artifacts and build scratch
  'dist', 'build', 'out', '.next', 'coverage', '__pycache__', '.venv', 'vendor',
];
/** Lines per read_file call. Without a cap the tool returned the whole file and the 16 KB window cut
 *  it silently — the one failure mode that makes a model confidently wrong about code it 'read'. */
export const READ_MAX_LINES = 800;

/**
 * Tool arguments arrive from the model as STRINGS, so `ignore_case="false"` is a non-empty string and
 * a plain truthiness test turns the flag ON — the opposite of what the model asked for. A model that
 * writes false must get false.
 */
export function boolParam(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * Bounds on any shell-out. Neither existed: a command that never returns hung the turn forever (nothing
 * cancels it in headless, where no human is watching), and a command that printed without end was
 * buffered whole into memory and then silently cut to 16 KB by the window — the model reading a
 * fraction of a build log with no sign that it was a fraction.
 */
export const EXEC_TIMEOUT_MS = 120_000;
export const EXEC_MAX_BYTES = 256 * 1024;

export function execAsync(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = toolShell().spawn(command, { cwd: opts.cwd });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let truncated = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeToolCancel === cancel) activeToolCancel = null;
      fn();
    };

    const cancel = (): void => {
      cancelled = true;
      toolShell().kill(child, 'SIGTERM');
      setTimeout(() => toolShell().kill(child, 'SIGKILL'), 1500);
    };
    activeToolCancel = cancel;

    const timer = setTimeout(() => {
      timedOut = true;
      toolShell().kill(child, 'SIGTERM');
      setTimeout(() => toolShell().kill(child, 'SIGKILL'), 1500);
    }, opts.timeoutMs ?? EXEC_TIMEOUT_MS);

    // Stop ACCUMULATING at the cap but let the process run to its own end: killing a build half way
    // through would leave the tree in a state the model then reasons about wrongly.
    const take = (buf: string, chunk: Buffer | string): string => {
      if (buf.length >= EXEC_MAX_BYTES) { truncated = true; return buf; }
      const next = buf + chunk.toString();
      if (next.length > EXEC_MAX_BYTES) { truncated = true; return next.slice(0, EXEC_MAX_BYTES); }
      return next;
    };
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout = take(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr = take(stderr, chunk); });

    child.on('error', (error) => {
      finish(() => reject(error));
    });

    child.on('close', (code) => {
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();

      if (cancelled) {
        finish(() => reject(new Error('Command cancelled.')));
        return;
      }

      finish(() => {
        const notes = [
          truncated ? `(output truncated at ${Math.round(EXEC_MAX_BYTES / 1024)} KB — redirect to a file and grep it if you need the rest)` : '',
          timedOut
            ? `(TIMED OUT after ${Math.round((opts.timeoutMs ?? EXEC_TIMEOUT_MS) / 1000)}s and was killed — the command did not finish, so this output is PARTIAL. ` +
              `If it is long-running or interactive, start it in the background instead: \`cmd >/tmp/out.log 2>&1 &\` then read the log.)`
            : '',
        ].filter(Boolean).join('\n');
        const withNotes = (body: string): string => (notes ? `${body}\n${notes}` : body);

        // A failing command WITH output must still say it failed — both the model and the
        // chat card otherwise read stderr text as success.
        if (out) resolve(withNotes(code && code !== 0 && !timedOut ? `${out}\n(exit code ${code})` : out));
        else if (timedOut) resolve(withNotes('Command produced no output before it was killed.'));
        else if (code && code !== 0) resolve(withNotes(`Command exited with code ${code}`));
        else resolve(withNotes('(no output)'));
      });
    });
  });
}

// ── Path suggestions (for "file not found" hints) ──────────────────
//
// When a path-taking tool (read_file, grep, find_files) can't find its
// target, suggest the closest existing sibling so the model can
// self-correct on the next round instead of spinning on typo variants.
// Triggered primarily by gemma4, which mistypes proper nouns in paths
// (e.g. `WidgetPanel` ↔ `WidgetPanle`).

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = [...curr];
  }
  return prev[n];
}

/** Resolve `path` against CWD if it isn't already absolute. */
export function resolveAgainstCwd(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** For a missing path, suggest up to 3 closest existing entries at the
 *  deepest existing ancestor — comparing against the *first missing*
 *  path segment (e.g. for `Assets/Scripts/WidgetPanle/Foo.cs` when only
 *  `Assets/Scripts` exists, the first missing segment is `WidgetPanle`).
 *  This catches both pure-filename typos and directory-name typos.
 *  Returns "" when no good matches. */
export function suggestSimilarPaths(missing: string, maxSuggestions = 3): string {
  const target = resolveAgainstCwd(missing);

  // Walk up to the deepest existing ancestor; remember the first missing segment.
  let ancestor = target;
  let firstMissing = basename(target);
  let depth = 0;
  while (depth < 20 && ancestor !== '/' && ancestor !== '.' && !existsSync(ancestor)) {
    firstMissing = basename(ancestor);
    ancestor = dirname(ancestor);
    depth++;
  }
  if (!existsSync(ancestor) || !firstMissing) return '';

  const wanted = firstMissing.toLowerCase();

  let entries: string[];
  try {
    entries = readdirSync(ancestor, { withFileTypes: true })
      .filter(e => e.isFile() || e.isDirectory())
      .map(e => e.name);
  } catch {
    return '';
  }
  if (entries.length === 0) return '';

  // Accept matches within ~1/3 of the wanted length — catches common
  // single-character typos (WidgetPanel ↔ WidgetPanle) without flooding.
  const threshold = Math.max(2, Math.floor(wanted.length / 3));

  const ranked = entries
    .map(name => ({ name, d: levenshtein(name.toLowerCase(), wanted) }))
    .filter(x => x.d <= threshold && x.d > 0)
    .sort((a, b) => a.d - b.d)
    .slice(0, maxSuggestions);

  if (ranked.length === 0) return '';

  const suggestions = ranked.map(r => join(ancestor, r.name)).join(', ');
  return ` Did you mean: ${suggestions}?`;
}

/**
 * Why an exact-match edit missed. "old_str not found" is almost never a wrong location — it is CRLF, or
 * indentation the model retyped instead of copied. Telling it *which*, and where the text actually sits,
 * turns a dead end into a next move; the bare error just invites the same call again with a guess.
 */
export function diagnoseMiss(fileText: string, oldStr: string): string {
  const norm = (s: string): string => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
  if (fileText.includes('\r\n') && !oldStr.includes('\r\n')) {
    return ' The file has CRLF line endings and old_str has LF — copy the text from read_file, or edit a single line only.';
  }
  const firstLine = oldStr.split('\n').map((l) => l.trim()).find((l) => l.length > 3);
  const lines = fileText.split('\n');
  const at = firstLine ? lines.findIndex((l) => l.trim() === firstLine) : -1;
  if (norm(fileText).includes(norm(oldStr))) {
    const where = at >= 0 ? ` It starts at line ${at + 1}.` : '';
    return ` The text IS present but its whitespace differs (indentation or blank lines).${where} Read those lines and copy them verbatim — do not retype them.`;
  }
  if (at >= 0) {
    const excerpt = lines.slice(at, at + Math.min(6, oldStr.split('\n').length + 1)).map((l, i) => `${at + i + 1}\t${l}`).join('\n');
    return ` Its first line matches at line ${at + 1}, but what follows differs. The file currently reads:\n${excerpt}`;
  }
  return ' No part of it matched. read_file the region first and copy the exact text (including indentation).';
}

// ── Tool interface ──────────────────────────────────────────────────
// Defined in tools/base.ts alongside BaseTool, so a tool package can implement the contract
// without importing this module (which pulls in the whole registry). Re-exported here because
// every existing call site imports `Tool` from './tools.js'.

export type { Tool, ToolParameter } from './base.js';
export { BaseTool } from './base.js';

type DiffOp =
  | { type: 'equal'; line: string }
  | { type: 'delete'; line: string }
  | { type: 'insert'; line: string };

function buildLineDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'equal', line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: 'insert', line: newLines[j] });
      j++;
    }
  }

  while (i < rows) ops.push({ type: 'delete', line: oldLines[i++] });
  while (j < cols) ops.push({ type: 'insert', line: newLines[j++] });
  return ops;
}

export function buildUnifiedDiff(path: string, before: string, after: string, contextLines = 3): string {
  if (before === after) return `File: ${path}\n(no changes)`;

  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const ops = buildLineDiff(oldLines, newLines);

  const changeIndexes: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type !== 'equal') changeIndexes.push(idx);
  }

  const hunks: Array<{ start: number; end: number }> = [];
  for (const idx of changeIndexes) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(ops.length, idx + contextLines + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }

  const out: string[] = [`File: ${path}`, `--- ${path}`, `+++ ${path}`];

  for (const hunk of hunks) {
    let oldLineNo = 1;
    let newLineNo = 1;
    for (let idx = 0; idx < hunk.start; idx++) {
      const op = ops[idx];
      if (op.type !== 'insert') oldLineNo++;
      if (op.type !== 'delete') newLineNo++;
    }

    const hunkOps = ops.slice(hunk.start, hunk.end);
    const oldCount = hunkOps.filter(op => op.type !== 'insert').length;
    const newCount = hunkOps.filter(op => op.type !== 'delete').length;
    out.push(`@@ -${oldLineNo},${oldCount} +${newLineNo},${newCount} @@`);

    for (const op of hunkOps) {
      if (op.type === 'equal') out.push(` ${op.line}`);
      else if (op.type === 'delete') out.push(`-${op.line}`);
      else out.push(`+${op.line}`);
    }
  }

  return out.join('\n');
}

// ── Tool implementations ────────────────────────────────────────────
