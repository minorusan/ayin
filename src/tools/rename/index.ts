/**
 * rename/index.ts — the orchestration: find the files, refuse early, edit, move files, report.
 *
 * ORDER IS THE WHOLE DESIGN, because a rename that fails halfway is worse than one that never started:
 *
 *   1. REFUSE on anything decidable up front — an invalid identifier, a keyword, a new name that already
 *      exists as a declaration in the same file (that is a merge, not a rename, and it compiles).
 *   2. Scan every candidate file and build the plan WITHOUT writing. `dryRun` stops here, and that is the
 *      form the agent is told to run first.
 *   3. Write source edits file by file (one write per file, all its occurrences in it).
 *   4. Move files LAST. A rename that edited three files and then failed to move one leaves a tree that
 *      compiles-but-does-not-bind in Unity; doing the move after the edits means the only way to end up
 *      inconsistent is a crash between two syscalls, and the report names what moved.
 *
 * FILE DISCOVERY is a plain walk, not `git grep`: this has to work in a tree with uncommitted files and in
 * one that is not a repo at all. `node_modules`, `.git`, `Library`, `obj`, `bin` and `dist` are skipped —
 * a Unity `Library/` alone is hundreds of thousands of files, and renaming inside `dist` would edit build
 * output that the next build overwrites.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { RenameLanguage, type FileEdit, type RenamePlan, type RenameWarning } from './base.js';
import { csharpRename } from './csharp.js';
import { typescriptRename } from './typescript.js';

/** One entry per language, exactly like `entangle`'s LANGUAGES. A third language is one line plus a file. */
const LANGUAGES: RenameLanguage[] = [csharpRename, typescriptRename];

export function renameLanguageFor(path: string): RenameLanguage | null {
  return LANGUAGES.find((l) => l.handles(path)) ?? null;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'obj', 'bin',
  // Unity's caches. `Library` is enormous and entirely generated; `Temp` and `Logs` are noise.
  'Library', 'Temp', 'Logs', 'ProjectSettings/.cache',
]);

/** Every source file under `root` a language claims. */
function candidates(root: string, limit = 20_000): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(p);
        continue;
      }
      if (renameLanguageFor(p)) out.push(p);
    }
  };
  const st = statSync(root);
  if (st.isFile()) {
    if (renameLanguageFor(root)) out.push(root);
  } else walk(root);
  return out;
}

export class RenameRefusal extends Error {}

export interface RenameOptions {
  symbol: string;
  to: string;
  /** A file or a directory. A directory is walked; a file renames within that file only. */
  root: string;
  dryRun: boolean;
}

/**
 * Plan and (unless `dryRun`) perform the rename.
 *
 * Throws `RenameRefusal` for the decidable mistakes — an invalid name, a keyword, a collision — because
 * those are answers, not failures, and the caller turns them into a sentence rather than a stack trace.
 */
export function renameSymbol(opts: RenameOptions): RenamePlan {
  const { symbol, to, root, dryRun } = opts;
  if (!symbol || !to) throw new RenameRefusal('both `symbol` and `to` are required');
  if (symbol === to) throw new RenameRefusal(`\`symbol\` and \`to\` are both "${symbol}" — nothing to rename`);
  if (!existsSync(root)) throw new RenameRefusal(`no such path: ${root}`);

  const files = candidates(root);
  if (!files.length) throw new RenameRefusal(`no C# or TypeScript files under ${root}`);

  // The language is decided by what the DECLARATION is in, not by the first file walked: a TS repo with a
  // stray .cs script would otherwise validate the new name against the wrong grammar.
  const langs = new Set(files.map((f) => renameLanguageFor(f)?.id).filter(Boolean));
  const primary = renameLanguageFor(files[0])!;
  for (const l of LANGUAGES) {
    if (files.some((f) => l.handles(f) && l.declarationKind(safeRead(f), symbol))) {
      if (!l.validIdentifier(to)) throw new RenameRefusal(`"${to}" is not a valid ${l.id} identifier`);
      if (l.isReserved(to)) throw new RenameRefusal(`"${to}" is a ${l.id} keyword`);
      return run(l, files.filter((f) => l.handles(f)), opts, langs);
    }
  }
  // No declaration found anywhere: still a legitimate rename of references (the declaration may live in a
  // dependency), but the caller is told, because it is also what a typo in `symbol` looks like.
  if (!primary.validIdentifier(to)) throw new RenameRefusal(`"${to}" is not a valid ${primary.id} identifier`);
  if (primary.isReserved(to)) throw new RenameRefusal(`"${to}" is a ${primary.id} keyword`);
  const plan = run(primary, files.filter((f) => primary.handles(f)), opts, langs);
  plan.warnings.unshift({
    message: `no DECLARATION of "${symbol}" was found under ${root} — only references were renamed. If that is unexpected, check the spelling or widen the path.`,
  });
  return plan;
}

function safeRead(p: string): string {
  try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}

function run(lang: RenameLanguage, files: string[], opts: RenameOptions, langs: Set<string | undefined>): RenamePlan {
  const { symbol, to, root, dryRun } = opts;
  const plan: RenamePlan = { language: lang.id, symbol, to, edits: [], skipped: [], fileRenames: [], warnings: [] };
  if (langs.size > 1) {
    plan.warnings.push({
      message: `the tree has ${[...langs].join(' + ')} sources; only the ${lang.id} ones were touched. Cross-language references (a C# name in a .ts binding, or the reverse) are not renamed.`,
    });
  }

  const pending: Array<{ path: string; source: string }> = [];
  for (const file of files) {
    const before = safeRead(file);
    if (!before) continue;
    // Collision: the new name is ALREADY declared in this file. Renaming into it produces code that very
    // often still compiles, with two things silently one thing.
    if (lang.declarationKind(before, to)) {
      throw new RenameRefusal(`"${to}" is already declared in ${relative(root, file) || file} — that is a merge, not a rename`);
    }
    // The language's own pre-pass first (TS shorthand expansion), then the generic rename over it.
    const prepared = lang.beforeRewrite(before, symbol, to);
    const r = lang.rewrite(prepared, symbol, to);
    r.source = lang.afterRewrite(r.source, symbol, to);
    for (const s of r.skipped) plan.skipped.push({ path: file, line: s.line, text: s.text, where: s.where as 'string' | 'comment' });
    if (!r.edit) continue;
    r.edit.path = file;

    // Consequences DETECT on `before` and EDIT on `r.source` — see RenameLanguage.consequences.
    const extra = lang.consequences(file, before, r.source, symbol, to);
    plan.edits.push(r.edit);
    plan.fileRenames.push(...(extra.fileRenames ?? []));
    plan.warnings.push(...(extra.warnings ?? []));
    pending.push({ path: file, source: extra.source ?? r.source });
  }

  if (!plan.edits.length) {
    plan.warnings.push({ message: `"${symbol}" does not appear in code under ${root} (${files.length} file(s) scanned)` });
    return plan;
  }

  if (dryRun) return plan;

  // Writes, then moves — see the header.
  for (const p of pending) writeFileSync(p.path, p.source, 'utf-8');
  for (const mv of plan.fileRenames) {
    try { renameSync(mv.from, mv.to); }
    catch (e) {
      plan.warnings.push({ path: mv.from, message: `could not rename the file to ${mv.to} — ${e instanceof Error ? e.message : String(e)}. The source edits ARE applied; move it by hand.` });
    }
  }
  return plan;
}

/** The report the model reads: what changed, what moved, and what it must decide by hand. */
export function formatPlan(plan: RenamePlan, root: string, dryRun: boolean): string {
  const lines: string[] = [];
  const total = plan.edits.reduce((n, e) => n + e.count, 0);
  lines.push(`${dryRun ? 'WOULD RENAME' : 'RENAMED'} ${plan.symbol} → ${plan.to} · ${plan.language} · ${total} occurrence(s) in ${plan.edits.length} file(s)`);
  for (const e of plan.edits) {
    lines.push(`  ${relative(root, e.path) || e.path} (${e.count})`);
    for (const l of e.lines.slice(0, 4)) {
      lines.push(`    ${l.line}: ${l.before.trim()}`);
      lines.push(`     → ${l.after.trim()}`);
    }
    if (e.lines.length > 4) lines.push(`    … ${e.lines.length - 4} more line(s)`);
  }
  for (const mv of plan.fileRenames) {
    lines.push(`  ${dryRun ? 'would move' : 'moved'}: ${relative(root, mv.from) || mv.from} → ${relative(root, mv.to) || mv.to}`);
  }
  if (plan.skipped.length) {
    // Never silent: a name in a string is where a rename breaks something no compiler will mention.
    lines.push(`  ${plan.skipped.length} mention(s) in STRINGS or COMMENTS left alone — check whether any is a key, a reflection lookup or a serialized name:`);
    for (const s of plan.skipped.slice(0, 6)) lines.push(`    ${relative(root, s.path) || s.path}:${s.line} (${s.where}) ${s.text.trim().slice(0, 100)}`);
    if (plan.skipped.length > 6) lines.push(`    … ${plan.skipped.length - 6} more`);
  }
  for (const w of plan.warnings) lines.push(`  ! ${w.path ? `${relative(root, w.path) || w.path}: ` : ''}${w.message}`);
  return lines.join('\n');
}

export type { RenamePlan, FileEdit, RenameWarning };
