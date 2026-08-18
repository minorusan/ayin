/**
 * TypeScript — the facts a chunk about a `.ts` file cannot derive from its own bytes.
 *
 * The Unity indulger exists because a C# file is wired to the game by a GUID living in a sibling
 * `.meta`, and no amount of reading the class tells you which prefabs use it. TypeScript looks like
 * the opposite — symbols have names, imports are explicit — and that is true of the IMPORT GRAPH and
 * false of how these codebases actually connect. Counted in ayin itself:
 *
 *   - a tool exists because it is listed in `tools/defs/index.ts`. The file declaring it says nothing
 *     about whether it is reachable, and a tool that is written but unregistered is dead code that
 *     reads exactly like live code.
 *   - a prompt is named by a STRING (`getPrompt('planTriage')`) and lives in a `.txt` beside the code.
 *     Nothing in the calling file names that file, and renaming the id breaks nothing at compile time.
 *   - a gate script asserts things about a module from outside it. `check-explore.mjs` is the reason
 *     several behaviours in `tools/explore/` may not change, and the module itself cannot say so.
 *
 * All three are the same shape as a Unity GUID: a link that is a string rather than a reference. This
 * hook resolves them ONCE, overnight, so the answers travel with the chunk.
 *
 * WHAT IT DOES NOT DO. It states facts and never advice — "registered in tools/defs/index.ts" is a
 * fact; "remember to register your tool" is a rules file with extra steps. That distinction is the
 * whole reason this mechanism exists rather than a longer system prompt.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Chunk } from '../store.js';
import type { Indulger, IndulgeContext } from '../hooks/types.js';

/** Resolved once per file per run — otherwise every question about a file re-scans for it. */
const perFile = new Map<string, Record<string, unknown> | null>();
/** The repo walk is shared by every file in the run; a night must not re-walk per chunk. */
let repoScan: RepoScan | null = null;

interface RepoScan {
  root: string;
  sources: string[];
  /** Gate and test scripts, which assert about other modules from outside them. */
  gates: string[];
  /** Prompt id -> the `.txt` file holding it. */
  prompts: Map<string, string>;
  /**
   * Exported name -> how many files export it.
   *
   * A name many files export attributes nothing. Every tool definition in ayin exports `tool`, so
   * membership matching on it reported `defs/explore.ts` as registered wherever the word appeared in
   * any list — including `agent.ts`. Same reasoning as the ambiguous-stem rule above: a shared name
   * is not an identity.
   */
  exportCount: Map<string, number>;
  /** file -> the other source files that reference it. */
  referencedBy: Map<string, string[]>;
  /**
   * file -> how many distinct sibling modules it references.
   *
   * This is what separates a REGISTRY from a plain `index.ts`. Naming was not enough: ayin has
   * twelve `index.ts` files and almost all are ordinary module entry points, so a name-based rule
   * reported `plan/index.ts` as the registry of `tools/defs/explore.ts` when it is simply a caller.
   * A file that pulls in many siblings is collecting them; one that pulls in a few is using them.
   */
  collects: Map<string, number>;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage']);
const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs']);

/**
 * How many distinct siblings a file must pull in before it counts as a REGISTRY rather than a caller.
 *
 * Measured in ayin: ordinary modules reference a handful; the files that actually declare membership
 * reference many. Naming cannot make this call — twelve `index.ts` files here are plain entry points.
 */
const REGISTRY_MIN_COLLECTS = 8;

function walk(root: string, rel: string, out: string[], depth = 0): void {
  if (depth > 12) return;
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { walk(root, child, out, depth + 1); continue; }
    out.push(child);
  }
}

/** Gate and test scripts — they assert about modules from outside, including `.mjs` under tool/. */
function allGates(all: string[]): string[] {
  return all.filter((f) => /^(tool|test|tests)\//.test(f) || /check-[\w-]+\.mjs$/.test(f));
}

function scanRepo(root: string): RepoScan {
  if (repoScan && repoScan.root === root) return repoScan;
  const all: string[] = [];
  walk(root, '', all);
  const sources = all.filter((f) => SOURCE_EXT.has(extname(f)));
  const prompts = new Map<string, string>();
  for (const f of all) {
    if (extname(f) !== '.txt' || !f.includes('prompts')) continue;
    // `prompts/<namespace>/<id>.txt` — the id is the basename, which is what `getPrompt` is handed.
    prompts.set(basename(f, '.txt'), f);
  }
  // ONE PASS over every source, building both directions at once. Doing it per chunk would re-read
  // the repository for every question, and a night has thousands.
  const stemOf = (f: string): string => basename(f).replace(/\.[cm]?[tj]sx?$/, '');
  const byStem = new Map<string, string[]>();
  for (const f of sources) {
    const s = stemOf(f);
    if (!s || s === 'index') continue;
    const list = byStem.get(s);
    if (list) list.push(f); else byStem.set(s, [f]);
  }
  const referencedBy = new Map<string, string[]>();
  const collects = new Map<string, number>();
  const scanTargets = [...new Set([...sources, ...allGates(all)])];
  for (const f of scanTargets) {
    let src: string;
    try { src = readFileSync(join(root, f), 'utf-8'); } catch { continue; }
    let n = 0;
    for (const [stem, owners] of byStem) {
      if (owners.length !== 1 || owners[0] === f) continue;   // an ambiguous stem attributes nothing
      if (!new RegExp(`['"\`][^'"\`]*\\b${stem}(\\.[cm]?[tj]s)?['"\`]`).test(src) && !src.includes(owners[0])) continue;
      n++;
      const list = referencedBy.get(owners[0]);
      if (list) { if (!list.includes(f)) list.push(f); } else referencedBy.set(owners[0], [f]);
    }
    collects.set(f, n);
  }

  const exportCount = new Map<string, number>();
  for (const f of sources) {
    let src: string;
    try { src = readFileSync(join(root, f), 'utf-8'); } catch { continue; }
    for (const name of exportedNames(src)) exportCount.set(name, (exportCount.get(name) ?? 0) + 1);
  }

  repoScan = {
    root,
    sources,
    gates: allGates(all),
    prompts,
    referencedBy,
    collects,
    exportCount,
  };
  return repoScan;
}

/** The exported names a module declares — what another file could import from it. */
export function exportedNames(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|class|interface|type|enum|const|let)\s+(\w+)/gm)) {
    out.add(m[1]);
  }
  for (const m of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) out.add(name);
    }
  }
  return [...out];
}

/** Prompt ids this file asks for by string — a link that names a FILE and no compiler checks. */
export function promptIdsUsed(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\bgetPrompt\s*\(\s*['"`]([\w.-]+)['"`]/g)) out.add(m[1]);
  for (const m of source.matchAll(/\bprompts?\(\)\.get\s*\(\s*['"`]([\w.-]+)['"`]/g)) out.add(m[1]);
  for (const m of source.matchAll(/\bthis\.prompt\s*\(\s*['"`]([\w.-]+)['"`]/g)) out.add(m[1]);
  return [...out];
}

/** Does `other` reference `file`, by import specifier or by path? */
function referencesFile(otherSource: string, file: string): boolean {
  const stem = basename(file).replace(/\.[cm]?[tj]sx?$/, '');
  if (!stem || stem === 'index') return false;
  if (otherSource.includes(file)) return true;
  return new RegExp(`['"\`][^'"\`]*\\b${stem}(\\.[cm]?[tj]s)?['"\`]`).test(otherSource);
}

/**
 * Does `name` appear inside an array literal in `src`?
 *
 * The narrow, checkable form of "is it registered": membership is declared by putting the thing in a
 * list. Bounded scan of each `[` … `]` so a huge file cannot make this quadratic.
 */
export function listMembership(src: string, name: string): boolean {
  const needle = new RegExp(`\\b${name}\\b`);
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('[', i);
    if (open === -1) return false;
    const close = src.indexOf(']', open);
    if (close === -1) return false;
    if (close - open < 4000 && needle.test(src.slice(open + 1, close))) return true;
    i = open + 1;
  }
  return false;
}

export const typescriptIndulger: Indulger = {
  id: 'typescript',

  applies(repoPath) {
    return existsSync(join(repoPath, 'package.json'))
      && (existsSync(join(repoPath, 'tsconfig.json')) || existsSync(join(repoPath, 'src')));
  },

  onChunkCreated(_chunk: Chunk, ctx: IndulgeContext): Record<string, unknown> | null {
    if (!SOURCE_EXT.has(extname(ctx.file))) return null;
    if (perFile.has(ctx.file)) return perFile.get(ctx.file) ?? null;

    const scan = scanRepo(ctx.repoPath);
    const facts: Record<string, unknown> = {};

    const refs = scan.referencedBy.get(ctx.file) ?? [];

    const exports = exportedNames(ctx.source);

    // WHAT ASSERTS ABOUT IT FROM OUTSIDE. A gate is why a behaviour may not change, and the module
    // being constrained never mentions the gate that constrains it.
    const assertedBy = refs.filter((r) => scan.gates.includes(r));
    if (assertedBy.length) facts.assertedBy = assertedBy;

    // WHERE MEMBERSHIP IS DECLARED — and this must be a FACT, not a guess.
    //
    // Counting imports does not distinguish a registry from a hub: `agent.ts` pulls in most of the
    // codebase and was reported as the "registry" of a tool definition, which is simply false. What
    // makes membership real is that one of this file's exported names appears inside a LIST in the
    // other file — `const DIALECTS = [new GlimmerDialect(), …]`. That is checkable, so it is what is
    // checked; a hub that merely calls the module never matches it.
    const registeredIn = refs.filter((r) => {
      if (scan.gates.includes(r)) return false;
      if (!exports.length) return false;
      let src: string;
      try { src = readFileSync(join(ctx.repoPath, r), 'utf-8'); } catch { return false; }
      // Only names that identify THIS module. A name several files export cannot attribute membership.
      return exports.some((name) => (scan.exportCount.get(name) ?? 0) === 1 && listMembership(src, name));
    });
    if (registeredIn.length) facts.registeredIn = registeredIn.slice(0, 6);

    // WHO ELSE USES IT — plain callers, which is what makes a change here a change to them.
    const usedBy = refs.filter((r) => !registeredIn.includes(r) && !assertedBy.includes(r));
    if (usedBy.length) { facts.usedBy = usedBy.slice(0, 10); facts.usedByTotal = usedBy.length; }

    // THE STRING THAT NAMES A FILE. `getPrompt('planTriage')` -> `prompts/plan/planTriage.txt`, which
    // nothing in this file names and no compiler checks.
    const ids = promptIdsUsed(ctx.source);
    const resolved = ids.map((id) => ({ id, file: scan.prompts.get(id) ?? null })).filter((p) => p.file);
    if (resolved.length) facts.promptsUsed = resolved;
    // A prompt id with no file THROWS at call time, by design. Worth carrying as a fact.
    const missing = ids.filter((id) => !scan.prompts.has(id));
    if (missing.length && resolved.length) facts.promptIdsWithNoFile = missing.slice(0, 6);

    if (exports.length) facts.exports = exports.slice(0, 24);

    const out = Object.keys(facts).length ? { ...facts, asOf: new Date().toISOString() } : null;
    perFile.set(ctx.file, out);
    return out;
  },
};

/** Between runs the memo and the scan must go, or a second night reports the first night's counts. */
export function clearTypescriptIndulgerMemo(): void {
  perFile.clear();
  repoScan = null;
}
