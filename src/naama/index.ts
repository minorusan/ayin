/**
 * NAAMA — authoring the design, fast, as data.
 *
 * The design loop is a conversation: the operator says a thing, the agent records it, and the picture
 * accumulates. That means the agent needs to write DESIGN FACTS at conversational speed, and the two
 * obvious ways are both bad.
 *
 * Hand-writing `.puml` through `write_file` means regenerating a growing document from memory on every
 * change — the precise failure `write_file`'s own description warns about, and the one that silently
 * drops half a file. Editing it with `str_replace` means a model doing bracket arithmetic in a nested
 * syntax, where one wrong `}` moves ten types into the wrong package and nothing complains.
 *
 * So the agent appends facts one line each and this module rewrites the document from the model it holds.
 * A whole assembly is one tool call. Nothing is regenerated from MEMORY, and a fact about a type that does
 * not exist fails loudly instead of landing somewhere harmless.
 *
 * WHY THIS MATTERS BEYOND CONVENIENCE
 *
 * A rendered diagram stores its constraints as DISPLAY TEXT: measured on a real one, the assembly rules
 * lived inside a cluster's `label` string — `references: NONE · noEngineReferences: true` — beside the
 * geometry. Coordinates were first-class; the architectural rule a checker would enforce was prose for a
 * human to read. So the diagram knew every rule and could enforce none of them.
 *
 * Authoring through this toolkit makes a design checkable by construction rather than by a later parsing
 * effort that has to guess.
 *
 * THE FORMAT IS PLANTUML. THERE IS NO SECOND FORMAT.
 *
 * `naamah weave <file.puml>` renders through the plantuml CLI and extracts entity metadata from the
 * resulting SVG. So `.puml` is not an export target beside a native document — it IS the document, and a
 * `.naama.json` alongside it would be a parallel structure with nothing to justify it. This module owns
 * the format: it serializes to `.puml`, parses `.puml` back, and `entangle` reads designs through this
 * same parser rather than a second one that would drift.
 *
 * WHERE THE STRUCTURED CONSTRAINTS LIVE, AND WHY THEY HAVE TO HIDE
 *
 * naamah reads clusters out of the RENDERED SVG, where a package survives only as its label string. That
 * is the whole reason a real diagram ended up with `references: NONE · noEngineReferences: true` crammed
 * into a cluster label beside the geometry: the label is the only channel plantuml carries through. It is
 * a property of the pipeline, not carelessness.
 *
 * PlantUML comments (`'`) are stripped before rendering and never reach the SVG. So the machine-readable
 * half rides in `' naamah:` directives: invisible to plantuml, invisible to naamah, read here. One file,
 * one format, a human-readable label, and `references` still an array where a checker needs one.
 *
 * Not a renderer. Layout, geometry and the page belong to naamah; this owns the model it draws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TypeKind } from '../entangle/types.js';

export interface NaamaMember {
  /** As written in the diagram: `Feed(Telemetry)`, `Scale : int`, `event Activated(...)`. */
  sig: string;
  /** What it must DO. The half a surface diagram cannot carry and an implementer cannot infer. */
  intent?: string;
  /** Public unless said otherwise — the diagram is a contract, and a contract is its public face. */
  vis?: 'public' | 'private' | 'protected';
}

export interface NaamaType {
  name: string;
  kind: TypeKind;
  /** Which domain owns it. Must be a declared domain. */
  domain: string;
  /** One line on what the type is for, when the name is not enough. */
  lede?: string;
  members: NaamaMember[];
}

export interface NaamaDomain {
  name: string;
  /** STRUCTURED, not prose — this is what a reference check reads. */
  references: string[];
  /** Closed to the engine/platform (`noEngineReferences`, a package with no runtime deps). */
  sealed: boolean;
}

export interface NaamaEdge {
  from: string;
  to: string;
  kind: 'dependency' | 'extension' | 'composition' | 'aggregation';
}

export interface NaamaDoc {
  title: string;
  domains: NaamaDomain[];
  types: NaamaType[];
  edges: NaamaEdge[];
}

const KINDS: TypeKind[] = ['class', 'interface', 'struct', 'enum', 'abstract'];
const EDGE_KINDS: NaamaEdge['kind'][] = ['dependency', 'extension', 'composition', 'aggregation'];

export function emptyDoc(title: string): NaamaDoc {
  return { title, domains: [], types: [], edges: [] };
}

export function loadDoc(path: string): NaamaDoc {
  return parsePuml(readFileSync(path, 'utf-8'));
}

export function saveDoc(path: string, doc: NaamaDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toPuml(doc), 'utf-8');
}

/**
 * `.puml` → the model. The inverse of `toPuml`, and the ONLY puml parser in ayin — `entangle` calls this
 * rather than keeping a second one, because two parsers of one format diverge and the divergence shows up
 * as a design that enforces something subtly different from what the operator drew.
 */
export function parsePuml(src: string): NaamaDoc {
  const doc = emptyDoc('');
  let domain = '';
  let current: NaamaType | null = null;

  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line === '@startuml' || line === '@enduml') continue;

    // `' naamah:` directives — the machine-readable half plantuml throws away.
    const dir = /^'\s*naamah:(.*)$/.exec(line);
    if (dir) {
      const body = dir[1].trim();
      const t = /^title\s+(.*)$/.exec(body);
      if (t) { doc.title = t[1].trim(); continue; }
      const d = /^domain\s+(\S+)(.*)$/.exec(body);
      if (d) {
        const refsRaw = /refs=(\S+)/.exec(d[2] ?? '')?.[1] ?? '';
        const references = !refsRaw || refsRaw.toUpperCase() === 'NONE'
          ? [] : refsRaw.split(',').map((x) => x.trim()).filter(Boolean);
        const name = d[1];
        const existing = doc.domains.find((x) => x.name === name);
        const sealed = /\bsealed\b/.test(d[2] ?? '');
        if (existing) { existing.references = references; existing.sealed = sealed; }
        else doc.domains.push({ name, references, sealed });
        continue;
      }
      continue; // an unknown directive is ignored, never fatal
    }
    if (line.startsWith("'")) continue; // an ordinary comment

    const pkg = /^package\s+"?([^"{]+)"?/.exec(line);
    if (pkg && !current) {
      domain = pkg[1].trim();
      if (!doc.domains.some((x) => x.name === domain)) doc.domains.push({ name: domain, references: [], sealed: false });
      continue;
    }

    const decl = /^(abstract class|class|interface|enum|struct)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?(.*)$/.exec(line);
    if (decl) {
      const kind = (decl[1] === 'abstract class' ? 'abstract' : decl[1]) as TypeKind;
      current = { name: decl[2], kind, domain, members: [] };
      doc.types.push(current);
      if (!decl[3].includes('{')) current = null;
      continue;
    }

    if (current) {
      if (line === '}') { current = null; continue; }
      const lede = /^\.\.\s*(.+?)\s*\.\.$/.exec(line);
      if (lede) { current.lede = lede[1]; continue; }
      if (line.startsWith('..') || line.startsWith('--')) continue;
      const mem = /^([+\-#~])(.*)$/.exec(line);
      if (mem) {
        const { sig, intent } = splitIntent(mem[2]);
        if (sig) current.members.push({ sig, ...(intent ? { intent } : {}), ...(mem[1] === '-' ? { vis: 'private' as const } : {}) });
      }
      continue;
    }

    const rel = /^([A-Za-z_][A-Za-z0-9_]*)\s*(-->|<\|--|\*--|o--|\.\.>)\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (rel) {
      const [, a, op, b] = rel;
      if (op === '<|--') doc.edges.push({ from: b, to: a, kind: 'extension' });
      else if (op === '*--') doc.edges.push({ from: a, to: b, kind: 'composition' });
      else if (op === 'o--') doc.edges.push({ from: a, to: b, kind: 'aggregation' });
      else doc.edges.push({ from: a, to: b, kind: 'dependency' });
    }
  }

  // A package with no directive still had its declaration seen; drop domains nothing lives in.
  doc.domains = doc.domains.filter((d) => doc.types.some((t) => t.domain === d.name) || d.references.length || d.sealed);
  return doc;
}

/** `Type.member : ret — intent` → the pieces. The em dash separates declaration from intent. */
function splitIntent(rest: string): { sig: string; intent?: string } {
  const m = /^(.*?)\s+[—–]\s+(.*)$/.exec(rest.trim());
  return m ? { sig: m[1].trim(), intent: m[2].trim() } : { sig: rest.trim() };
}

/**
 * Apply one line of the authoring language. Returns what happened, or throws with the reason — a design
 * fact that lands in the wrong place is worse than one that is refused, because nobody looks again.
 *
 *   domain <name> [refs=A,B|NONE] [sealed]
 *   type <Name> : <kind> @ <domain>            [— lede]
 *   member <Type>.<sig>                        [— intent]
 *   private <Type>.<sig>                       [— intent]
 *   edge <From> -> <To> : <kind>
 *   drop type <Name> | drop domain <name>
 */
export function applyLine(doc: NaamaDoc, line: string): string {
  const t = line.trim();
  if (!t || t.startsWith('#') || t.startsWith("'")) return '';

  let m = /^domain\s+(\S+)(.*)$/i.exec(t);
  if (m) {
    const name = m[1];
    const tail = m[2] ?? '';
    const refsRaw = /refs=(\S+)/i.exec(tail)?.[1] ?? '';
    const references = !refsRaw || /^none$/i.test(refsRaw) ? [] : refsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const sealed = /\bsealed\b/i.test(tail);
    const existing = doc.domains.find((d) => d.name === name);
    if (existing) { existing.references = references; existing.sealed = sealed; return `domain ${name} updated`; }
    doc.domains.push({ name, references, sealed });
    return `domain ${name} (refs: ${references.length ? references.join(', ') : 'NONE'}${sealed ? ', sealed' : ''})`;
  }

  m = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\w+)\s*@\s*(\S+)(.*)$/i.exec(t);
  if (m) {
    const [, name, kindRaw, domain, tail] = m;
    const kind = kindRaw.toLowerCase() as TypeKind;
    if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kindRaw}" — use one of ${KINDS.join(', ')}`);
    if (!doc.domains.some((d) => d.name === domain)) {
      throw new Error(`no domain "${domain}" — declare it first: domain ${domain} refs=NONE sealed`);
    }
    const { intent } = splitIntent(tail);
    const existing = doc.types.find((x) => x.name === name);
    if (existing) { existing.kind = kind; existing.domain = domain; if (intent) existing.lede = intent; return `type ${name} updated`; }
    doc.types.push({ name, kind, domain, ...(intent ? { lede: intent } : {}), members: [] });
    return `${kind} ${name} @ ${domain}`;
  }

  m = /^(member|private)\s+([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/i.exec(t);
  if (m) {
    const [, kw, typeName, rest] = m;
    const owner = doc.types.find((x) => x.name === typeName);
    if (!owner) throw new Error(`no type "${typeName}" — declare it first: type ${typeName} : class @ <domain>`);
    const { sig, intent } = splitIntent(rest);
    if (!sig) throw new Error('empty member signature');
    const vis = kw.toLowerCase() === 'private' ? 'private' as const : undefined;
    const name = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(sig.replace(/^event\s+/i, ''))?.[1] ?? sig;
    const dup = owner.members.find((x) => x.sig === sig);
    if (dup) { if (intent) dup.intent = intent; return `${typeName}.${name} updated`; }
    owner.members.push({ sig, ...(intent ? { intent } : {}), ...(vis ? { vis } : {}) });
    return `${typeName}.${name}`;
  }

  m = /^edge\s+([A-Za-z_][A-Za-z0-9_]*)\s*->\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(\w+))?$/i.exec(t);
  if (m) {
    const [, from, to, kindRaw] = m;
    const kind = (kindRaw?.toLowerCase() ?? 'dependency') as NaamaEdge['kind'];
    if (!EDGE_KINDS.includes(kind)) throw new Error(`unknown edge kind "${kindRaw}" — use ${EDGE_KINDS.join(', ')}`);
    for (const n of [from, to]) {
      if (!doc.types.some((x) => x.name === n)) throw new Error(`no type "${n}" — an edge between undeclared types is a typo, not a design`);
    }
    if (!doc.edges.some((e) => e.from === from && e.to === to && e.kind === kind)) doc.edges.push({ from, to, kind });
    return `${from} -${kind}-> ${to}`;
  }

  m = /^drop\s+(type|domain)\s+(\S+)$/i.exec(t);
  if (m) {
    const [, what, name] = m;
    if (what.toLowerCase() === 'type') {
      const before = doc.types.length;
      doc.types = doc.types.filter((x) => x.name !== name);
      doc.edges = doc.edges.filter((e) => e.from !== name && e.to !== name);
      if (doc.types.length === before) throw new Error(`no type "${name}" to drop`);
      return `dropped type ${name} and its edges`;
    }
    const before = doc.domains.length;
    doc.domains = doc.domains.filter((d) => d.name !== name);
    if (doc.domains.length === before) throw new Error(`no domain "${name}" to drop`);
    const orphans = doc.types.filter((x) => x.domain === name).map((x) => x.name);
    return `dropped domain ${name}${orphans.length ? ` — ${orphans.length} type(s) now have no domain: ${orphans.join(', ')}` : ''}`;
  }

  throw new Error(`unrecognised line: "${t}"`);
}

/** The whole design as compact text — for the agent and the operator to READ, not to parse. */
export function render(doc: NaamaDoc): string {
  const out: string[] = [doc.title || '(untitled design)', ''];
  for (const d of doc.domains) {
    out.push(`${d.name}  refs: ${d.references.length ? d.references.join(', ') : 'NONE'}${d.sealed ? '  sealed' : ''}`);
    for (const t of doc.types.filter((x) => x.domain === d.name)) {
      out.push(`  ${t.kind} ${t.name}${t.lede ? `  — ${t.lede}` : ''}`);
      for (const m of t.members) {
        out.push(`      ${m.vis === 'private' ? '-' : '+'}${m.sig}${m.intent ? `  — ${m.intent}` : ''}`);
      }
    }
    out.push('');
  }
  const orphans = doc.types.filter((t) => !doc.domains.some((d) => d.name === t.domain));
  if (orphans.length) {
    out.push(`NO DOMAIN: ${orphans.map((t) => t.name).join(', ')}`, '');
  }
  if (doc.edges.length) {
    out.push('edges:');
    for (const e of doc.edges) out.push(`  ${e.from} -${e.kind}-> ${e.to}`);
    out.push('');
  }
  const members = doc.types.reduce((n, t) => n + t.members.length, 0);
  out.push(`${doc.domains.length} domain(s) · ${doc.types.length} type(s) · ${members} member(s) · ${doc.edges.length} edge(s)`);
  return out.join('\n');
}

const PUML_KIND: Record<TypeKind, string> = {
  class: 'class', interface: 'interface', struct: 'struct', enum: 'enum', abstract: 'abstract class',
};
const PUML_EDGE: Record<NaamaEdge['kind'], string> = {
  dependency: '-->', extension: '<|--', composition: '*--', aggregation: 'o--',
};

/** PlantUML, for a human or a renderer. Intent rides along as a trailing comment so it survives. */
export function toPuml(doc: NaamaDoc): string {
  const out = ['@startuml'];
  if (doc.title) out.push(`' naamah:title ${doc.title}`);
  out.push('');
  for (const d of doc.domains) {
    // The directive is the machine-readable copy; the label stays whatever a human wants to read.
    out.push(`' naamah:domain ${d.name} refs=${d.references.length ? d.references.join(',') : 'NONE'}${d.sealed ? ' sealed' : ''}`);
    out.push(`package "${d.name}" {`);
    for (const t of doc.types.filter((x) => x.domain === d.name)) {
      out.push(`  ${PUML_KIND[t.kind]} ${t.name} {`);
      if (t.lede) out.push(`    .. ${t.lede} ..`);
      for (const m of t.members) {
        out.push(`    ${m.vis === 'private' ? '-' : '+'}${m.sig}${m.intent ? `  — ${m.intent}` : ''}`);
      }
      out.push('  }');
    }
    out.push('}', '');
  }
  for (const e of doc.edges) {
    // extension reads base <|-- derived, so the arrow is written from the other end
    if (e.kind === 'extension') out.push(`${e.to} ${PUML_EDGE.extension} ${e.from}`);
    else out.push(`${e.from} ${PUML_EDGE[e.kind]} ${e.to}`);
  }
  out.push('', '@enduml', '');
  return out.join('\n');
}

/** Every fact the design states that cannot be true. Cheap, and run before anyone entangles to it. */
export function validate(doc: NaamaDoc): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const t of doc.types) {
    if (names.has(t.name)) problems.push(`duplicate type "${t.name}"`);
    names.add(t.name);
    if (!doc.domains.some((d) => d.name === t.domain)) problems.push(`type "${t.name}" is in undeclared domain "${t.domain}"`);
    if (t.members.length === 0 && t.kind !== 'enum') problems.push(`type "${t.name}" has no members — a contract with no surface constrains nothing`);
  }
  for (const e of doc.edges) {
    for (const n of [e.from, e.to]) if (!names.has(n)) problems.push(`edge names unknown type "${n}"`);
  }
  // A member naming a type from a domain this one may not reference is the violation entangle will
  // raise LATER, at implementation time. Saying it here turns a week-two stop into a design-time note.
  for (const t of doc.types) {
    const dom = doc.domains.find((d) => d.name === t.domain);
    if (!dom) continue;
    for (const m of t.members) {
      for (const other of doc.types) {
        if (other.domain === t.domain) continue;
        if (!new RegExp(`\\b${other.name}\\b`).test(m.sig)) continue;
        const allowed = dom.references.some((r) => r === other.domain || other.domain.startsWith(`${r}.`));
        if (!allowed) {
          problems.push(
            `${t.name}.${m.sig.split(/[\s(:]/)[0]} names "${other.name}" from "${other.domain}", but ` +
            `"${dom.name}" references ${dom.references.length ? dom.references.join(', ') : 'NOTHING'} — ` +
            `implementation cannot satisfy this`,
          );
        }
      }
    }
  }
  // IS EVERY MEMBER ROW ACTUALLY IMPLEMENTABLE? Measured, and it cost seven trial runs to see: a real
  // as-built diagram writes rows as human shorthand — `Count / Target` (two members, no types), `State`
  // (no type), `event Changed(Reading)` where Reading is declared nowhere. Each reads
  // perfectly to a person and cannot be turned into code, so an implementer must invent a type for every
  // one, and a gate that refuses inventions then refuses the whole file. The design was un-implementable
  // and the agent looked broken.
  //
  // Said HERE it is a five-minute edit. Said at implementation time it is an agent grinding into a wall.
  const declared = new Set(doc.types.map((t) => t.name));
  for (const t of doc.types) {
    if (t.kind === 'enum') continue; // enum rows are values, not typed members
    for (const m of t.members) {
      const sig = m.sig.trim();
      if (sig.includes('/')) {
        problems.push(`${t.name}.${sig} — one row, two members: split it, or nothing can implement it`);
        continue;
      }
      const isMethod = sig.includes('(');
      if (!isMethod && !sig.includes(':')) {
        problems.push(`${t.name}.${sig} — a field with no type: write \`${sig} : <Type>\``);
        continue;
      }
      // The member's OWN name is not a type. `Configure(GaugeConfig)` mentions two identifiers and only
      // the second one has to exist.
      const rest = sig.replace(/^event\s+/i, '').replace(/^[A-Za-z_$][A-Za-z0-9_$]*/, '');
      for (const n of rest.split(/[^A-Za-z0-9_$]+/).filter(Boolean)) {
        if (!/^[A-Z]/.test(n) || declared.has(n)) continue;
        if (BCL.has(n)) continue;
        problems.push(`${t.name}.${sig} names "${n}", which the design does not declare`);
      }
    }
  }
  return problems;
}

/** Names a design may use without declaring them — the languages' own vocabulary. */
const BCL = new Set([
  'System', 'Object', 'String', 'Boolean', 'Int32', 'Single', 'Double', 'Guid', 'DateTime', 'TimeSpan',
  'List', 'Dictionary', 'HashSet', 'IEnumerable', 'IReadOnlyList', 'KeyValuePair', 'Action', 'Func',
  'Task', 'Nullable', 'Array', 'Tuple', 'Record', 'Map', 'Set', 'Promise', 'Number', 'Date',
]);

/**
 * Render the design into a page you can actually look at, via naamah.
 *
 * naamah is a SUBMODULE rather than vendored code or a dependency, and this is the one place in the
 * project where that is the right answer: it is a separate program with its own repo and its own life —
 * it renders any `.puml`, ayin is merely one caller — where `tools/` and `providers/` were only ever
 * directories of ayin being split for tidiness. It is MIT, publicly clonable and has zero runtime
 * dependencies, so a stranger gets it with `--recursive` and nothing else.
 *
 * OPTIONAL ON PURPOSE. A clone WITHOUT `--recursive`, or a machine with no plantuml, still authors and
 * enforces designs — only the picture is missing, and the caller is told exactly which of the two is
 * absent. Rendering is the pleasant half; the contract does not depend on it, and an agent that refused
 * to work because a diagram could not be drawn would be absurd.
 */
const NAAMAH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'naamah', 'bin', 'naamah.mjs');

export function naamahAvailable(): boolean {
  return existsSync(NAAMAH);
}

export async function renderDesign(pumlPath: string): Promise<string> {
  if (!naamahAvailable()) {
    return `Cannot render: the naamah submodule is not present (${NAAMAH}). `
      + 'Run `git submodule update --init` to fetch it. The design itself is unaffected — it is authored '
      + 'and enforced without a renderer.';
  }
  return new Promise((done) => {
    execFile(process.execPath, [NAAMAH, 'weave', resolve(pumlPath)], { timeout: 120_000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      if (!err) { done(out || 'rendered.'); return; }
      // plantuml is naamah's own dependency, not ayin's, so say which layer is missing rather than
      // reporting a generic failure the operator has to go and diagnose.
      done(/plantuml is not on PATH/.test(out)
        ? 'Cannot render: plantuml is not installed (naamah needs it for .puml input). The design is '
          + 'authored and enforced regardless — install plantuml only if you want the picture.'
        : `naamah failed: ${out.slice(0, 400)}`);
    });
  });
}
