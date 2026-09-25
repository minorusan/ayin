/**
 * depmap — the dependency graph around a few files, derived, never drawn from memory.
 *
 * THERE IS NO MODEL IN HERE. That is the whole point of the module. `diagram` asks a model to invent
 * PlantUML and then checks only that it PARSES, so the same subject twice gives two different pictures
 * and neither is evidence of anything. This answers a narrower question — "what does this file
 * actually touch" — and answers it the way `explore` does: from bytes on disk, the same way every
 * time, with "nothing found" as a real answer.
 *
 * TWO WALKS, AND THEY ARE BOUNDED DIFFERENTLY ON PURPOSE.
 *
 *   ancestry   base classes and interfaces, and THEIR bases, with no depth limit at all. A type's
 *              supertypes are what it IS; truncating that chain draws a class whose contract is
 *              somewhere off the edge of the page. It terminates on its own — inheritance is acyclic
 *              and shallow in practice.
 *   forward    the types a member's declaration names, `depth` hops out. This is the one that
 *              explodes: from one service in a real Unity project the reference graph reaches most of
 *              `Assets/` in about three hops, so it is bounded by a number the caller passes.
 *
 * A type reached at the limit is still DRAWN, with no members, and named in `boundary`. Cutting the
 * node entirely would draw an edge into nothing; drawing it whole would defeat the bound.
 *
 * THE GROUPING IS THE ASSEMBLY, and that is the only grouping here that is a fact rather than a
 * folder convention. `SurfaceLanguage.domainOf` walks up to the nearest manifest — an `.asmdef` in
 * Unity — and hands back its declared name, what it is allowed to reference, and whether it is sealed
 * off from the engine. A person reading the source cannot see any of that; it is the thing worth
 * putting on a diagram.
 *
 * WHAT IS BORROWED RATHER THAN REBUILT: `languageFor` picks the parser, `surfaceOf` gives types and
 * members with comments and verbatim strings already stripped, `domainOf` gives the assembly, and
 * `toPuml` turns the result into PlantUML. Nothing here re-parses anything that module already parses.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { languageFor } from '../entangle/index.js';
import { BUILTIN } from '../entangle/languages/csharp.js';
import type { DeclaredMember, DeclaredType, SurfaceLanguage } from '../entangle/types.js';
import { emptyDoc, type NaamaDoc, type NaamaEdge, type NaamaType } from '../naama/index.js';

/** Hops of FORWARD expansion when the caller does not say. Ancestry ignores this entirely. */
export const DEFAULT_DEPTH = 3;

/** A ceiling on the whole graph. A picture with more nodes than this is not a picture. */
const MAX_NODES = 120;

/** Directories a source scan must never descend into. Same shape as explore's list. */
const PRUNE = new Set([
  '.git', 'node_modules', 'Library', 'Temp', 'obj', 'Logs', 'Build', 'Builds',
  'dist', 'build', 'out', '.next', 'coverage', '__pycache__', '.venv', 'vendor',
]);

/**
 * How a type names its supertypes, per language.
 *
 * NOT ON `SurfaceLanguage`. That interface answers "what does this file declare" and is implemented
 * nine times; adding a tenth method to it to serve one tool would change nine files for a fact only
 * this one wants. So the extractor lives here, keyed on the language id, and a language with no entry
 * simply reports no ancestry rather than a wrong one — which is the same contract `bodyFactsOf`
 * already sets for optional per-language knowledge.
 */
const BASES: Record<string, (source: string, name: string) => string[]> = {
  csharp(source, name) {
    // `class Foo<T> : Bar<T>, IBaz where T : struct` — generic args tolerated, constraints dropped.
    const m = new RegExp(
      `\\b(?:class|struct|interface|record)\\s+${name}\\b\\s*(?:<[^>]*>)?\\s*:\\s*([^\\{]+)`,
    ).exec(source);
    if (!m) return [];
    return m[1]
      .replace(/\bwhere\b[\s\S]*$/, '')
      .split(',')
      .map((t) => t.trim().replace(/<.*>$/, ''))
      .filter(Boolean);
  },
  typescript(source, name) {
    const m = new RegExp(
      `\\b(?:class|interface)\\s+${name}\\b\\s*(?:<[^>]*>)?\\s*([^\\{]*)\\{`,
    ).exec(source);
    if (!m) return [];
    return [...m[1].matchAll(/(?:extends|implements)\s+([^{]+?)(?=\s+(?:extends|implements)\s|$)/g)]
      .flatMap((g) => g[1].split(','))
      .map((t) => t.trim().replace(/<.*>$/, ''))
      .filter(Boolean);
  },
};

/** A collection of X, rather than an X — the difference between aggregation and composition. */
const COLLECTION = /\b(?:List|IList|IReadOnlyList|ICollection|IReadOnlyCollection|IEnumerable|HashSet|ISet|Queue|Stack|LinkedList|Array|Dictionary|IDictionary|IReadOnlyDictionary|SortedList|SortedDictionary|SortedSet|Set|Map)\s*</;

export interface DepMapResult {
  doc: NaamaDoc;
  /** Seeds as given, resolved and made relative to the project root. */
  seeds: string[];
  language: string;
  root: string;
  depth: number;
  /** Types drawn with no members because the walk stopped there. */
  boundary: string[];
  /** Names a declaration referenced that resolve to no file in this project. Reported, not guessed at. */
  unresolved: string[];
  /** Names matching more than one file, where the same assembly did not settle it. */
  ambiguous: string[];
  /** True when MAX_NODES cut the walk short — the graph is a subset and must not read as complete. */
  capped: boolean;
}

interface Node {
  type: DeclaredType;
  file: string;
  domain: string;
  /** Forward hops from the nearest seed. Ancestry inherits its subtype's distance. */
  dist: number;
  expanded: boolean;
}

/** The project root: the nearest ancestor holding a marker, else the seed's own directory. */
function rootFor(start: string): string {
  let dir = statSync(start, { throwIfNoEntry: false })?.isDirectory() ? start : dirname(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'Assets')) || existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dirname(start);
}

/**
 * Every file this language claims, indexed by its BASENAME.
 *
 * Resolving a type name to a file is the one step with no parser behind it, and in C# it does not need
 * one: Unity requires the file name to match the type it declares, which is the same convention
 * `primaryTypeOf` already relies on. TypeScript is looser, so a miss there is reported as unresolved
 * rather than guessed.
 *
 * Built once per call and walked with `readdirSync` rather than a `find`: the prune list is the same
 * either way, and this keeps the module free of a spawned process.
 */
function indexFiles(root: string, lang: SurfaceLanguage): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (PRUNE.has(e) || e.startsWith('.')) continue;
      const abs = join(dir, e);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!lang.handles(abs)) continue;
      const stem = basename(abs, extname(abs));
      byName.set(stem, [...(byName.get(stem) ?? []), abs]);
    }
  };
  walk(root, 0);
  return byName;
}

/**
 * The type names a declaration line mentions.
 *
 * PascalCase, because that is what a type is called in every language this handles and a parameter is
 * not — which separates `RewardConfig` from `config` without parsing the signature. `BUILTIN` removes
 * the platform's own vocabulary, the set the reference checker already maintains for exactly this
 * purpose rather than a second copy that would drift from it.
 */
function namesIn(sig: string, own: Set<string>): string[] {
  const bare = sig.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ' ');
  return [...new Set(bare.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [])]
    .filter((n) => !BUILTIN.has(n) && !own.has(n) && n.length > 1);
}

/** What kind of edge a member implies. Declaration shape only — nothing is inferred from a body. */
function edgeKind(m: DeclaredMember, target: string): NaamaEdge['kind'] {
  if (m.kind === 'method' || m.kind === 'event') return 'dependency';
  const sig = m.sig ?? '';
  if (COLLECTION.test(sig) || new RegExp(`\\b${target}\\s*\\[`).test(sig)) return 'aggregation';
  return 'composition';
}

const VIS: Record<string, NaamaType['members'][number]['vis']> = {
  public: 'public', protected: 'protected', private: 'private', internal: 'private',
};

export interface DepMapOptions {
  depth?: number;
  root?: string;
}

/**
 * Build the graph. Async only so the caller reads the same as every other tool entry point — nothing
 * here awaits anything, which is deliberate: an answer that cannot vary between runs is the feature.
 */
export async function buildDepMap(seedPaths: string[], opts: DepMapOptions = {}): Promise<DepMapResult> {
  const depth = Number.isFinite(opts.depth) && (opts.depth as number) >= 0 ? Math.floor(opts.depth as number) : DEFAULT_DEPTH;
  const seeds = seedPaths.map((p) => (isAbsolute(p) ? p : resolve(process.cwd(), p)));
  const missing = seeds.filter((s) => !existsSync(s));
  if (missing.length) throw new Error(`no such file: ${missing.join(', ')}`);
  if (!seeds.length) throw new Error('at least one start file is required');

  const lang = languageFor(seeds[0]);
  if (!lang) throw new Error(`no parser claims ${basename(seeds[0])} — this maps source files, one language at a time`);
  const foreign = seeds.filter((s) => !lang.handles(s));
  if (foreign.length) {
    throw new Error(`all start files must be the same language; ${foreign.map((f) => basename(f)).join(', ')} is not ${lang.id}`);
  }

  const root = opts.root ?? rootFor(seeds[0]);
  const byName = indexFiles(root, lang);
  const basesOf = BASES[lang.id];

  const nodes = new Map<string, Node>();          // type name → node
  const edges: NaamaEdge[] = [];
  const domains = new Map<string, { references: string[]; sealed: boolean }>();
  const boundary = new Set<string>();
  const unresolved = new Set<string>();
  const ambiguous = new Set<string>();
  const sources = new Map<string, string>();      // file → text, read once
  let capped = false;

  const read = (file: string): string => {
    const hit = sources.get(file);
    if (hit !== undefined) return hit;
    let text = '';
    try { text = readFileSync(file, 'utf-8'); } catch { /* unreadable is not a node */ }
    sources.set(file, text);
    return text;
  };

  const domainOf = (file: string): string => {
    const d = lang.domainOf(file);
    if (!d) return '';
    if (!domains.has(d.name)) domains.set(d.name, { references: d.allows ?? [], sealed: d.sealed === true });
    return d.name;
  };

  /**
   * Resolve a type NAME to the file declaring it.
   *
   * Two files can declare the same name in different namespaces, and picking one at random would draw
   * an edge to the wrong assembly with nothing on the page admitting it. The referrer's own assembly
   * settles most of them; the rest are reported as ambiguous and left undrawn, which is the honest
   * answer to "I cannot tell".
   */
  const fileFor = (name: string, from: string): string | null => {
    const hits = byName.get(name);
    if (!hits?.length) { unresolved.add(name); return null; }
    if (hits.length === 1) return hits[0];
    const mine = domainOf(from);
    const same = hits.filter((h) => domainOf(h) === mine);
    if (same.length === 1) return same[0];
    ambiguous.add(name);
    return null;
  };

  const add = (file: string, type: DeclaredType, dist: number): Node | null => {
    const existing = nodes.get(type.name);
    if (existing) {
      if (dist < existing.dist) existing.dist = dist;
      return existing;
    }
    if (nodes.size >= MAX_NODES) { capped = true; return null; }
    const node: Node = { type, file, domain: domainOf(file), dist, expanded: false };
    nodes.set(type.name, node);
    return node;
  };

  const link = (from: string, to: string, kind: NaamaEdge['kind']): void => {
    if (from === to) return;
    if (edges.some((e) => e.from === from && e.to === to)) return;
    edges.push({ from, to, kind });
  };

  /** A type's supertype chain, followed to its end. See the header: this walk is not depth-bounded. */
  const walkAncestry = (node: Node, seen: Set<string>): void => {
    if (!basesOf || seen.has(node.type.name)) return;
    seen.add(node.type.name);
    for (const base of basesOf(read(node.file), node.type.name)) {
      const file = fileFor(base, node.file);
      if (!file) continue;
      const decl = lang.surfaceOf(read(file)).find((t) => t.name === base);
      if (!decl) { unresolved.add(base); continue; }
      const added = add(file, decl, node.dist);
      if (!added) return;
      link(node.type.name, base, 'extension');
      walkAncestry(added, seen);
    }
  };

  const queue: Node[] = [];
  for (const seed of seeds) {
    const src = read(seed);
    for (const decl of lang.surfaceOf(src)) {
      const node = add(seed, decl, 0);
      if (node) queue.push(node);
    }
  }
  if (!nodes.size) {
    throw new Error(`nothing declared in ${seeds.map((s) => basename(s)).join(', ')} — no types to map`);
  }

  // Ancestry first, so a seed's contract is on the page before anything it merely uses.
  for (const node of [...queue]) walkAncestry(node, new Set());

  while (queue.length) {
    const node = queue.shift()!;
    if (node.expanded) continue;
    node.expanded = true;
    if (node.dist >= depth) { boundary.add(node.type.name); continue; }

    const own = new Set([node.type.name, ...node.type.members.map((m) => m.name)]);
    for (const member of node.type.members) {
      for (const name of namesIn(member.sig ?? '', own)) {
        const file = fileFor(name, node.file);
        if (!file) continue;
        const decl = lang.surfaceOf(read(file)).find((t) => t.name === name);
        if (!decl) { unresolved.add(name); continue; }
        const added = add(file, decl, node.dist + 1);
        if (!added) break;
        link(node.type.name, name, edgeKind(member, name));
        if (!added.expanded) { walkAncestry(added, new Set()); queue.push(added); }
      }
    }
  }

  // A node the walk never opened shows no members, and the caller is told which.
  for (const node of nodes.values()) if (node.dist >= depth && node.type.members.length) boundary.add(node.type.name);

  const title = `${seeds.map((s) => basename(s)).join(' + ')} — dependencies, depth ${depth}`;
  const doc: NaamaDoc = emptyDoc(title);
  doc.domains = [...domains.entries()].map(([name, d]) => ({ name, references: d.references, sealed: d.sealed }));
  // Files outside any assembly still have to live somewhere, and an invented domain name would read as
  // a real one. The empty string is what `domainOf` returns for them; it gets a label that says so.
  const LOOSE = '(no assembly)';
  if ([...nodes.values()].some((n) => !n.domain)) doc.domains.push({ name: LOOSE, references: [], sealed: false });

  doc.types = [...nodes.values()].map((n): NaamaType => ({
    name: n.type.name,
    kind: n.type.kind,
    domain: n.domain || LOOSE,
    lede: `${relative(root, dirname(n.file)) || '.'}/`,
    members: boundary.has(n.type.name)
      ? []
      : n.type.members.map((m) => ({ sig: (m.sig ?? m.name).replace(/\s*[{;=].*$/, '').trim(), vis: VIS[m.visibility] ?? 'public' })),
  }));
  doc.edges = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));

  return {
    doc,
    seeds: seeds.map((s) => relative(root, s)),
    language: lang.id,
    root,
    depth,
    boundary: [...boundary].sort(),
    unresolved: [...unresolved].sort(),
    ambiguous: [...ambiguous].sort(),
    capped,
  };
}
