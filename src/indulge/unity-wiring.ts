/**
 * indulge/unity-wiring.ts — the two facts a Unity answer kept being unable to prove.
 *
 * `connections` asks who constructs this and who calls it; `dependencies` asks which of a file's
 * needs cross an assembly boundary. Measured on a real corpus: those two angles owned 316 of 621
 * failed questions and 280 of the answers that came back saying "there is no evidence in the code" —
 * roughly an eighth of a night, spent proving nothing.
 *
 * Neither was a prompt failure. **The answer was not in the bytes the model was shown, and could not
 * be.** A container binding lives in an installer three directories away, and an assembly boundary
 * lives in a `.asmdef` — a JSON manifest that `languageFor()` correctly refuses as source, so it is
 * never in a prompt at all. Asked about a file, the model saw the file, answered honestly that the
 * file does not say, and the citation gate threw the answer away.
 *
 * So the facts are derived here instead, deterministically, from disk:
 *
 *   - **assembly membership** — the nearest ancestor `.asmdef`, its name, and what it references.
 *     A file's assembly is not a heuristic: Unity resolves it exactly this way.
 *   - **container bindings and injection sites** — the lines that name a type declared in this file.
 *     A grep, not an inference: the text says `Bind<Thing>` or it does not.
 *
 * Both carry `file:line` AND THE LINE ITSELF, because a citation the model has not seen the text of
 * is a citation it is guessing at, and the gate would rightly reject it.
 *
 * A CROSSING IS ONLY CLAIMED WHEN BOTH SIDES ARE KNOWN. A binding written in an assembly ayin could
 * not resolve is reported as a binding with an unknown assembly, never as a boundary crossing — the
 * whole value of this file is that it says "no" where a model would say "probably".
 *
 * Cost: one pass over the C# tree per run, memoised. That is the overnight side, where it belongs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isUnderVendorRoot } from './vendor.js';

/** Sites listed per type. The total is reported separately — a cut that hides its size reads as all. */
const MAX_SITES = 8;
/** C# files read per index build. A tree past this is reported as truncated, never silently cut. */
const MAX_FILES = 20_000;
/** Directories holding no authored source. `Library` alone can hold hundreds of thousands of files. */
const SKIP = new Set(['Library', 'Temp', 'Logs', 'obj', 'bin', 'Build', 'Builds', '.git', 'node_modules']);
/** A source line longer than this is minified or generated; quoting it helps nobody. */
const MAX_LINE = 200;

export interface Asmdef {
  /** Repo-relative path to the `.asmdef`. */
  path: string;
  /** Repo-relative directory it governs. */
  dir: string;
  name: string;
  references: string[];
}

export interface WiringSite {
  file: string;
  line: number;
  /** The source line, trimmed. What makes the citation provable rather than guessed. */
  text: string;
  /** The assembly the SITE sits in, or null when no `.asmdef` governs it. */
  assembly: string | null;
  kind: 'bind' | 'inject';
}

export interface WiringFacts {
  assembly: string | null;
  assemblyPath: string | null;
  /** What this file's assembly is allowed to see. Empty for the default assembly. */
  references: string[];
  declares: string[];
  /** Container bindings naming a type declared here. */
  boundBy: WiringSite[];
  boundByTotal: number;
  /** `[Inject]` declarations elsewhere whose type is declared here. */
  injectedInto: WiringSite[];
  injectedIntoTotal: number;
  /** `[Inject]` declarations INSIDE this file — what it asks to be handed. */
  injects: Array<{ type: string; assembly: string | null; line: number; text: string }>;
  /** `from → to` for every site whose assembly differs from this file's, both sides known. */
  crossAssembly: string[];
  /** The index is a snapshot of the tree as it was read; nothing on the chunk guards it. */
  asOf: string;
}

interface Index {
  root: string;
  asmdefs: Asmdef[];
  /** Repo-relative C# path → the assembly governing it. */
  assemblyByFile: Map<string, string>;
  /** Type name → the files declaring it. A name declared twice is reported as both. */
  declaredIn: Map<string, string[]>;
  /** Type name → every bind or inject site naming it. */
  sitesByType: Map<string, WiringSite[]>;
  /** Repo-relative C# path → the `[Inject]` declarations inside it. */
  injectsByFile: Map<string, Array<{ type: string; line: number; text: string }>>;
  truncated: boolean;
}

let cache: Index | null = null;

/** Between runs the index must go, or a second night reports the first night's tree. */
export function clearWiringIndex(): void { cache = null; }

const rel = (root: string, abs: string): string => relative(root, abs).split(sep).join('/');

/** Unity's own rule: a file belongs to the assembly of the nearest `.asmdef` above it. */
function assemblyFor(asmdefs: Asmdef[], file: string): Asmdef | null {
  let best: Asmdef | null = null;
  for (const a of asmdefs) {
    const prefix = a.dir ? `${a.dir}/` : '';
    if (!file.startsWith(prefix)) continue;
    if (!best || a.dir.length > best.dir.length) best = a;
  }
  return best;
}

/** `class Foo`, `record struct Bar`, `interface IBaz`, `enum Qux`. */
function declaredTypes(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\b(?:class|struct|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * Type names bound by one container statement.
 *
 * Every generic argument in a statement that mentions `Bind` — so `Bind<IThing>().To<Thing>()`
 * yields BOTH, which is the point: "what is bound to this concrete type" and "what does this
 * interface resolve to" are the same question asked from either end, and a corpus that answers only
 * one of them answers neither reliably. Namespace-qualified names are reduced to the type, because
 * that is what a declaration and a question both use.
 *
 * A STATEMENT, NOT A LINE. Measured on a real installer:
 *
 *     Container.Bind<PlayPerfect.…IRewardService>()
 *         .To<PlayPerfect.…RewardService>().AsSingle();
 *
 * A line-scoped scan sees `Bind` on the first line and the concrete type on the second, matches
 * neither against the other, and reports the service as bound nowhere — which is the exact false
 * negative this whole file exists to remove. A fluent chain is one statement; it is read as one.
 *
 * `BindInstance(thing)` names no type and is not captured. A binding whose type cannot be read is
 * not reported as a binding of something else.
 */
export function boundTypesIn(statement: string): string[] {
  if (!/\bBind[A-Za-z]*\s*[<(]/.test(statement)) return [];
  const out = new Set<string>();
  for (const m of statement.matchAll(/<\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:,[^>]*)?>/g)) {
    out.add(m[1].split('.').pop() as string);
  }
  return [...out];
}

/** How many lines a fluent chain may span before it stops being one statement. */
const MAX_STATEMENT_LINES = 8;

/** How far an `[Inject]` parameter list may run before it is treated as unreadable. */
const MAX_INJECT_LINES = 24;

/**
 * Statements in a C# file, each with the line its first token sat on.
 *
 * Semicolon-delimited and deliberately naive: this is looking for `Bind<T>` chains, not parsing C#.
 * A string literal holding a `;` splits a statement in two, which costs at worst a missed binding —
 * and a missed binding is reported as "not bound", never as a binding of something else.
 */
export function statementsOf(lines: string[]): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let buf = '';
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    if (!buf) start = i + 1;
    buf = buf ? `${buf} ${trimmed}` : trimmed;
    if (trimmed.includes(';') || i - start + 1 >= MAX_STATEMENT_LINES) {
      out.push({ text: buf, line: start });
      buf = '';
    }
  }
  if (buf) out.push({ text: buf, line: start });
  return out;
}

/**
 * Types asked for by an `[Inject]` declaration.
 *
 * The attribute and the declaration are usually on separate lines, so the declaration is taken from
 * the next non-blank line when the attribute line carries nothing else. Modifiers, `readonly` and the
 * field name are stripped; what is left is the type.
 */
export function injectedTypesAt(lines: string[], at: number): { types: string[]; line: number; text: string } | null {
  if (!/\[Inject[\]\(]/.test(lines[at] ?? '')) return null;
  let decl = lines[at].replace(/^\s*\[Inject[^\]]*\]\s*/, '').trim();
  let lineNo = at + 1;
  if (!decl) {
    for (let i = at + 1; i < Math.min(lines.length, at + 4); i++) {
      if (lines[i].trim()) { decl = lines[i].trim(); lineNo = i + 1; break; }
    }
  }
  if (!decl) return null;

  // A CONSTRUCT METHOD'S PARAMETER LIST SPANS LINES, and that is the ordinary shape, not an edge
  // case: an injected method takes a dozen services and nobody writes them on one line. Reading only
  // the first line leaves an unbalanced `(`, the parameter parse fails, and the file is reported as
  // asking to be handed nothing — the same false negative the binding scan had.
  //
  // AND IF THE LIST STILL DOES NOT CLOSE, THIS RETURNS NOTHING. Falling through to the field parse
  // read the last-but-one word of a truncated blob and reported one arbitrary parameter as THE
  // injected type — a confident, wrong, citable fact, which is the one output worth more than a
  // missing one to avoid. Measured on a real `Construct` taking eleven services: it reported the
  // ninth and dropped the other ten.
  if (decl.includes('(')) {
    for (let i = lineNo; !decl.includes(')') && i < Math.min(lines.length, lineNo + MAX_INJECT_LINES); i++) {
      decl = `${decl} ${lines[i].trim()}`;
    }
    if (!decl.includes(')')) return null;
  }

  const types = new Set<string>();
  // A method or constructor: every parameter's type. Otherwise a field or property: one type.
  const params = decl.match(/\(([^)]*)\)/);
  const source = params
    ? params[1].split(',')
    : [decl.replace(/=.*$/, '').replace(/[;{].*$/, '')];
  for (const part of source) {
    // A per-parameter attribute (`[InjectOptional]`, `[Inject(Id = …)]`) is not the type.
    const words = part.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/)
      .filter((w) => !/^(public|private|protected|internal|readonly|static|ref|out|in|params|this|virtual|override|sealed|async)$/.test(w));
    if (words.length < 2) continue;              // a bare name is the parameter, with no type read
    const type = words[words.length - 2].replace(/<.*$/, '').replace(/[\[\]?]/g, '').split('.').pop();
    if (type && /^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) types.add(type);
  }
  return types.size ? { types: [...types], line: lineNo, text: decl.slice(0, MAX_LINE) } : null;
}

/** Every `.cs` and `.asmdef` under the repo, vendor roots excluded. */
function walk(repoPath: string, vendorRoots: string[]): { cs: string[]; asmdef: string[]; truncated: boolean } {
  const cs: string[] = [];
  const asmdef: string[] = [];
  const stack = [repoPath];
  let truncated = false;
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(abs); continue; }
      if (!e.isFile()) continue;
      const r = rel(repoPath, abs);
      if (vendorRoots.length && isUnderVendorRoot(r, vendorRoots)) continue;
      if (e.name.endsWith('.asmdef')) { asmdef.push(r); continue; }
      if (!e.name.endsWith('.cs')) continue;
      if (cs.length >= MAX_FILES) { truncated = true; continue; }
      try { if (statSync(abs).size > 2 * 1024 * 1024) continue; } catch { continue; }
      cs.push(r);
    }
  }
  return { cs, asmdef, truncated };
}

/** Build the index, or hand back the one this run already built. */
export function wiringIndex(repoPath: string, vendorRoots: string[] = []): Index {
  if (cache && cache.root === repoPath) return cache;
  const { cs, asmdef, truncated } = walk(repoPath, vendorRoots);

  const asmdefs: Asmdef[] = [];
  for (const path of asmdef) {
    let parsed: { name?: string; references?: unknown };
    try { parsed = JSON.parse(readFileSync(join(repoPath, path), 'utf-8')) as typeof parsed; } catch { continue; }
    if (typeof parsed.name !== 'string' || !parsed.name) continue;
    const dir = path.split('/').slice(0, -1).join('/');
    // References may be assembly names or GUID strings; a GUID says nothing a reader can use, so it
    // is dropped rather than printed as if it were a name.
    const references = Array.isArray(parsed.references)
      ? parsed.references.map(String).filter((r) => !r.startsWith('GUID:'))
      : [];
    asmdefs.push({ path, dir, name: parsed.name, references });
  }

  const assemblyByFile = new Map<string, string>();
  const declaredIn = new Map<string, string[]>();
  const sitesByType = new Map<string, WiringSite[]>();
  const injectsByFile = new Map<string, Array<{ type: string; line: number; text: string }>>();

  for (const file of cs) {
    let source: string;
    try { source = readFileSync(join(repoPath, file), 'utf-8'); } catch { continue; }
    const owner = assemblyFor(asmdefs, file);
    if (owner) assemblyByFile.set(file, owner.name);
    const assembly = owner?.name ?? null;

    for (const t of declaredTypes(source)) {
      const list = declaredIn.get(t);
      if (list) list.push(file); else declaredIn.set(t, [file]);
    }

    const lines = source.split('\n');
    const addSite = (type: string, site: WiringSite): void => {
      const list = sitesByType.get(type);
      if (list) list.push(site); else sitesByType.set(type, [site]);
    };
    for (const st of statementsOf(lines)) {
      for (const t of boundTypesIn(st.text)) {
        addSite(t, { file, line: st.line, text: st.text.slice(0, MAX_LINE), assembly, kind: 'bind' });
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const inj = injectedTypesAt(lines, i);
      if (!inj) continue;
      for (const t of inj.types) {
        addSite(t, { file, line: inj.line, text: inj.text, assembly, kind: 'inject' });
        const own = injectsByFile.get(file);
        const rec = { type: t, line: inj.line, text: inj.text };
        if (own) own.push(rec); else injectsByFile.set(file, [rec]);
      }
    }
  }

  cache = { root: repoPath, asmdefs, assemblyByFile, declaredIn, sitesByType, injectsByFile, truncated };
  return cache;
}

/** The assembly a type lives in, or null when it is declared nowhere ayin indexed. */
function assemblyOfType(idx: Index, type: string): string | null {
  for (const f of idx.declaredIn.get(type) ?? []) {
    const a = idx.assemblyByFile.get(f);
    if (a) return a;
  }
  return null;
}

/** Assembly membership and wiring for one file. */
export function wiringFor(repoPath: string, file: string, source: string, vendorRoots: string[] = []): WiringFacts {
  const idx = wiringIndex(repoPath, vendorRoots);
  const owner = assemblyFor(idx.asmdefs, file);
  const declares = declaredTypes(source);

  const bound: WiringSite[] = [];
  const injected: WiringSite[] = [];
  for (const t of declares) {
    for (const s of idx.sitesByType.get(t) ?? []) {
      if (s.file === file) continue;              // a type wiring itself is not a connection
      (s.kind === 'bind' ? bound : injected).push(s);
    }
  }

  const here = owner?.name ?? null;
  const crossings = new Set<string>();
  for (const s of [...bound, ...injected]) {
    if (here && s.assembly && s.assembly !== here) crossings.add(`${s.assembly} → ${here}`);
  }

  const injects = (idx.injectsByFile.get(file) ?? []).map((r) => ({
    type: r.type,
    assembly: assemblyOfType(idx, r.type),
    line: r.line,
    text: r.text,
  }));
  for (const r of injects) {
    if (here && r.assembly && r.assembly !== here) crossings.add(`${here} → ${r.assembly}`);
  }

  return {
    assembly: here,
    assemblyPath: owner?.path ?? null,
    references: owner?.references ?? [],
    declares,
    boundBy: bound.slice(0, MAX_SITES),
    boundByTotal: bound.length,
    injectedInto: injected.slice(0, MAX_SITES),
    injectedIntoTotal: injected.length,
    injects,
    crossAssembly: [...crossings],
    asOf: new Date().toISOString(),
  };
}

/**
 * The same facts as a block to put in front of the model, before it answers.
 *
 * Every line carries a path and a line number the citation gate can verify, and the source text
 * those numbers point at, so an answer resting on a binding cites the binding rather than the file
 * that happens to be the subject.
 *
 * Returns '' when there is nothing to say. An empty section header is a prompt telling the model
 * something exists for it to use.
 */
export function wiringEvidence(facts: WiringFacts, file: string): string {
  const out: string[] = [];

  if (facts.assembly) {
    out.push(`ASSEMBLY of ${file}: ${facts.assembly}${facts.assemblyPath ? ` (${facts.assemblyPath})` : ''}`);
    out.push(facts.references.length
      ? `  it may reference: ${facts.references.join(', ')}`
      : '  it declares no assembly references');
  } else {
    out.push(`ASSEMBLY of ${file}: no .asmdef governs it — the default predefined assembly`);
  }

  const site = (s: WiringSite): string => `  ${s.file}:${s.line}${s.assembly ? ` [${s.assembly}]` : ' [no .asmdef]'}\n    ${s.text}`;

  if (facts.boundByTotal) {
    out.push(`BOUND IN THE CONTAINER (${facts.boundByTotal} site(s)${facts.boundByTotal > facts.boundBy.length ? `, ${facts.boundBy.length} shown` : ''}):`);
    for (const s of facts.boundBy) out.push(site(s));
  }
  if (facts.injectedIntoTotal) {
    out.push(`INJECTED INTO (${facts.injectedIntoTotal} site(s)${facts.injectedIntoTotal > facts.injectedInto.length ? `, ${facts.injectedInto.length} shown` : ''}):`);
    for (const s of facts.injectedInto) out.push(site(s));
  }
  if (facts.injects.length) {
    out.push('THIS FILE ASKS TO BE HANDED:');
    for (const r of facts.injects) {
      out.push(`  line ${r.line}: ${r.type}${r.assembly ? ` [${r.assembly}]` : ' [assembly not indexed]'}\n    ${r.text}`);
    }
  }
  if (facts.crossAssembly.length) {
    out.push(`CROSSES AN ASSEMBLY BOUNDARY: ${facts.crossAssembly.join(' · ')}`);
  }
  if (!facts.boundByTotal && !facts.injectedIntoTotal && !facts.injects.length) {
    // Zero is the actionable answer here, exactly as `corpus: 0` is at read time: it is the
    // difference between "nothing wires this" and "nobody looked".
    out.push('NOT BOUND IN ANY CONTAINER and NOT INJECTED ANYWHERE that was indexed.');
  }

  return out.join('\n');
}

/** Unity's own marker, without importing the attributor's module into the walk path. */
export function hasAsmdefs(repoPath: string): boolean {
  return existsSync(join(repoPath, 'Assets'));
}

/** How large the index got, for the run's own status line. Zero when nothing has been built. */
export function indexSize(): { assemblies: number; types: number; sites: number; truncated: boolean } {
  if (!cache) return { assemblies: 0, types: 0, sites: 0, truncated: false };
  let sites = 0;
  for (const list of cache.sitesByType.values()) sites += list.length;
  return {
    assemblies: cache.asmdefs.length,
    types: cache.declaredIn.size,
    sites,
    truncated: cache.truncated,
  };
}
