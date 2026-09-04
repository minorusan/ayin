/**
 * qa/unity/shape.ts — the DETERMINISTIC consequences of a C# edit in a Unity project.
 *
 * The question this answers: when a field is added to a class, or a type is used, or a file is created,
 * what can be asserted about NAMESPACES and ASMDEFS from the files alone — no model, no opinion, no
 * "consider whether"? Each check below is decidable from the repo's own text, and each one is a real
 * break that a compiler either reports too late (after the agent has said "done") or does not report at
 * all because Unity's damage is to DATA rather than to code.
 *
 * WHAT IS DECIDABLE, AND WHY IT IS NOT A JUDGEMENT CALL:
 *
 *   1. AN ASMDEF REFERENCE THAT IS MISSING. A file compiles into exactly one assembly — the nearest
 *      ancestor `.asmdef`, or the predefined `Assembly-CSharp` if there is none. A type it names lives in
 *      exactly one assembly too, found by scanning declarations. If the second is not the first and is not
 *      in the first's `references`, the compiler WILL say CS0246. Unity's one wrinkle is
 *      `autoReferenced`: that makes an assembly visible to the PREDEFINED assemblies only, never to
 *      another asmdef, so the rule differs by which side the file is on. Both cases are counted here.
 *
 *   2. `UnityEditor` INSIDE A RUNTIME ASSEMBLY. An assembly whose `includePlatforms` is not exactly
 *      `["Editor"]` is compiled into the player, where `UnityEditor` does not exist. It builds in the
 *      editor and fails the player build — the most expensive kind of "works on my machine", and it is a
 *      one-line grep away from being known.
 *
 *   3. A NAMESPACE THAT CONTRADICTS THE ASSEMBLY'S OWN DECLARATION. `rootNamespace` in the `.asmdef` is
 *      not a convention someone might disagree with: it is what that assembly says its scripts are named,
 *      and Unity itself uses it for new files. A namespace that is neither it nor a child of it is a
 *      mismatch by the project's own statement.
 *
 *   4. A `[SerializeField]` ON A TYPE UNITY CANNOT SERIALIZE. `Dictionary<,>`, an interface without
 *      `[SerializeReference]`, `object`, `System.Type`, a delegate — Unity stores NOTHING for these and
 *      says nothing about it. The field looks set in code and is empty at runtime. The set is closed and
 *      documented, so membership is a fact.
 *
 *   5. A SERIALIZED FIELD ADDED TO A TYPE THAT EXISTING ASSETS REFERENCE. Every prefab, scene and asset
 *      that carries this script stores its fields BY NAME; a new name is absent from all of them, so each
 *      one silently takes the default. The count is measurable: the script's GUID comes from its `.meta`,
 *      and the assets that name that GUID are a grep. This is not a bug to fix — it is a consequence the
 *      agent must state (and often a migration to write), which is why it is reported rather than failed.
 *
 * WHAT IS DELIBERATELY NOT HERE: "the namespace should match the folder". Unity does not require it and
 * plenty of projects do not do it, so it cannot be asserted — only compared against what the neighbours
 * do, which is reported as a soft fact naming the sibling namespace.
 *
 * A REGEX READER, NOT A C# PARSER — the same trade the rest of this repo makes. It reads declarations,
 * not expressions, and every check is written so that a shape it fails to understand yields NOTHING
 * rather than a false accusation.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import type { Asmdef, AsmdefIndex } from '../../../testrun/asmdef.js';
import { owningAsmdef, resolveReference } from '../../../testrun/asmdef.js';

/** Types Unity's serializer cannot store, whatever the attribute says. Closed set, from its own docs. */
const NOT_SERIALIZABLE = [
  { re: /^(System\.)?Collections\.Generic\.Dictionary</, why: 'Unity does not serialize Dictionary — use two lists or a custom serializable pair type' },
  { re: /^Dictionary</, why: 'Unity does not serialize Dictionary — use two lists or a custom serializable pair type' },
  { re: /^(System\.)?Object$|^object$/, why: 'Unity does not serialize `object` — declare the concrete type' },
  { re: /^(System\.)?Type$/, why: 'Unity does not serialize System.Type — store an assembly-qualified name string' },
  { re: /^(System\.)?Action(<|$)|^(System\.)?Func</, why: 'Unity does not serialize delegates' },
  { re: /^I[A-Z]\w*$/, why: 'an interface field needs [SerializeReference] to be serialized at all' },
];

export interface FieldDecl {
  name: string;
  type: string;
  attributes: string[];
  visibility: 'public' | 'private' | 'protected' | 'internal';
  isStatic: boolean;
  isReadonly: boolean;
  isConst: boolean;
  line: number;
}

export interface CsFacts {
  namespace: string | null;
  usings: string[];
  /** Declared type names, with the Unity base they derive from when there is one. */
  types: Array<{ name: string; base: string | null; line: number }>;
  fields: FieldDecl[];
  /** Every identifier used in a TYPE position: field types, base types, generic arguments. */
  typeRefs: string[];
}

const KEYWORDS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'readonly', 'const', 'new', 'override', 'virtual',
  'abstract', 'sealed', 'partial', 'async', 'extern', 'unsafe', 'volatile', 'event', 'class', 'struct',
  'interface', 'enum', 'void', 'var', 'return', 'if', 'else', 'for', 'foreach', 'while', 'switch', 'case',
  'this', 'base', 'null', 'true', 'false', 'string', 'int', 'float', 'bool', 'double', 'long', 'byte', 'char',
  'decimal', 'short', 'uint', 'ulong', 'ushort', 'object', 'get', 'set', 'namespace', 'using', 'in', 'out', 'ref',
]);

/** Strip strings and comments so a name inside either is never read as code. */
function stripNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/@"(?:[^"]|"")*"/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

export function readCsFacts(source: string): CsFacts {
  const code = stripNonCode(source);
  const lineOf = (index: number): number => code.slice(0, index).split('\n').length;

  const namespace = /^\s*namespace\s+([A-Za-z_][\w.]*)/m.exec(code)?.[1] ?? null;
  const usings = [...code.matchAll(/^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm)].map((m) => m[1]);

  const types: CsFacts['types'] = [];
  // NOT anchored to the line start: `namespace X { public class Y {} }` on one line is legal C#, and a
  // parser that only sees a declaration at column zero silently knows nothing about that file — which in
  // the reference check reads as "no such type anywhere", i.e. a missing finding rather than a wrong one.
  for (const m of code.matchAll(/\b(?:class|struct|interface|record)\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*(?::\s*([^\n{]+))?/g)) {
    types.push({ name: m[1], base: (m[2] ?? '').trim() || null, line: lineOf(m.index ?? 0) });
  }

  const fields: FieldDecl[] = [];
  // `[attrs] modifiers Type name;` / `= value;` — a FIELD, not a property (no `{`) and not a method (no `(`).
  const FIELD = /^([ \t]*)((?:\[[^\]]*\][ \t]*\r?\n?[ \t]*)*)((?:(?:public|private|protected|internal|static|readonly|const|volatile|new|unsafe)[ \t]+)*)([A-Za-z_][\w.<>,\[\]?\s]*?)[ \t]+([A-Za-z_]\w*)[ \t]*(?:=[^;]*)?;/gm;
  for (const m of code.matchAll(FIELD)) {
    const mods = m[3] ?? '';
    const type = m[4].trim().replace(/\s+/g, '');
    const name = m[5];
    // A KEYWORD TYPE IS USUALLY A STATEMENT (`return x;`, `throw e;`) — except when it is a primitive,
    // which is the most ordinary field there is. Rejecting every keyword type dropped `public float speed`
    // and with it every serialized number in the project; the gate caught that on the first run.
    if (KEYWORDS.has(name)) continue;
    if (KEYWORDS.has(type) && !PRIMITIVES.has(type)) continue;
    if (/\b(return|throw|new)\b/.test(m[0]) && !/^\s*(\[|public|private|protected|internal|static|readonly)/.test(m[0])) continue;
    const attributes = [...(m[2] ?? '').matchAll(/\[([^\]]*)\]/g)].map((a) => a[1].trim());
    fields.push({
      name,
      type,
      attributes,
      visibility: /\bpublic\b/.test(mods) ? 'public' : /\bprotected\b/.test(mods) ? 'protected' : /\binternal\b/.test(mods) ? 'internal' : 'private',
      isStatic: /\bstatic\b/.test(mods),
      isReadonly: /\breadonly\b/.test(mods),
      isConst: /\bconst\b/.test(mods),
      line: lineOf(m.index ?? 0),
    });
  }

  // Type positions only: field types, base lists, generic arguments inside them. Never expressions.
  const refs = new Set<string>();
  const addType = (raw: string): void => {
    for (const id of raw.split(/[^A-Za-z_0-9.]+/)) {
      const head = id.split('.')[0];
      if (!head || KEYWORDS.has(head) || !/^[A-Z_]/.test(head)) continue;
      refs.add(head);
    }
  };
  for (const f of fields) addType(f.type);
  for (const t of types) if (t.base) addType(t.base);
  for (const m of code.matchAll(/\bnew\s+([A-Z][\w.]*)\s*[(<]/g)) addType(m[1]);

  return { namespace, usings, types, fields, typeRefs: [...refs] };
}

/** Is this field stored by Unity? public (and not static/const/readonly/NonSerialized) or [SerializeField]. */
export function isSerialized(f: FieldDecl): boolean {
  if (f.isStatic || f.isConst || f.isReadonly) return false;
  if (f.attributes.some((a) => /^NonSerialized\b/.test(a))) return false;
  if (f.attributes.some((a) => /^SerializeField\b/.test(a) || /^SerializeReference\b/.test(a))) return true;
  return f.visibility === 'public';
}

/** Keyword TYPES that are perfectly good field types — the reason the keyword filter is not blanket. */
const PRIMITIVES = new Set([
  'bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint', 'long', 'ulong', 'short',
  'ushort', 'string', 'object', 'nint', 'nuint',
]);

const UNITY_BASE = /\b(MonoBehaviour|ScriptableObject|NetworkBehaviour|StateMachineBehaviour)\b/;

/** Does this file declare a type whose instances Unity serializes into scenes, prefabs and assets? */
export function declaresUnityAsset(facts: CsFacts): { name: string; base: string } | null {
  for (const t of facts.types) {
    const m = t.base ? UNITY_BASE.exec(t.base) : null;
    if (m) return { name: t.name, base: m[1] };
  }
  return null;
}

/**
 * DOES THIS MonoBehaviour CARRY LOGIC? — the deterministic half of a semantic question.
 *
 * The rule the operator wants enforced is a judgement: a MonoBehaviour should be a view — fields the
 * inspector fills, properties, and plumbing inside its own hierarchy (`GetComponent`, `transform`,
 * `SetActive`, wiring a listener) — and nothing that decides anything. Whether a given method "decides
 * something" is not decidable by a scanner, and pretending otherwise produces either a rule nobody can
 * satisfy or one that misses everything interesting.
 *
 * So this function answers only the part that IS decidable: **is there anything here worth a model's
 * attention?** A type with nothing but fields, properties and empty or one-line plumbing bodies provably
 * has no logic and costs nothing to clear; anything else — a branch, a loop, arithmetic, a LINQ chain, a
 * body over a couple of statements — is HANDED TO THE MODEL, which then answers the semantic question with
 * the file in front of it.
 *
 * BIASED TOWARD SENDING. A false "send" costs one LLM call on a turn that already spent several; a false
 * "skip" is the whole check silently not happening. So the plumbing allowance is deliberately narrow, and
 * anything the scanner does not understand counts as a reason to send.
 */

/** Calls that are hierarchy plumbing rather than decisions — Unity's own view-layer vocabulary. */
const PLUMBING = new RegExp([
  'GetComponent(InChildren|InParent)?', 'TryGetComponent', 'gameObject', 'transform', 'SetActive',
  'SetParent', 'AddListener', 'RemoveListener', 'RemoveAllListeners', 'Instantiate', 'Destroy',
  'DontDestroyOnLoad', 'SetText', 'SetTrigger', 'SetBool', 'SetFloat', 'Play', 'Stop', 'enabled',
  'interactable', 'sprite', 'text', 'color', 'Invoke', 'InvokeRepeating', 'StartCoroutine', 'StopCoroutine',
].join('|'));

/**
 * Control flow and computation — the shapes that mean "a decision is being made here".
 *
 * TWO THINGS DELIBERATELY ABSENT, both of which the gate caught on the first run:
 *   · a bare `<` or `>`. `GetComponentInChildren<Image>()` is a generic argument, not a comparison, and
 *     flagging it made every component lookup in the project look like a decision. A real comparison is
 *     spaced (`a > b`) or compound (`>=`), and one inside an `if` is caught by the keyword anyway.
 *   · `return <expr>`. A trivial getter is `return field;` — the single most common allowed member in a
 *     view. Long or computed bodies are caught by the statement count and by the operators below.
 */
const DECISION = /\b(if|else|for|foreach|while|switch|case|try|catch|do|goto|yield)\b|==|!=|>=|<=|&&|\|\||\?\?|\+\+|--|[-+*/%]=|\s[<>]\s|\bMath(f)?\./;

export interface MonoBody {
  /** The declared type. */
  type: string;
  /** Method names with a body, and how many statements each carries. */
  methods: Array<{ name: string; statements: number; decisions: number; plumbingOnly: boolean }>;
  /** Non-auto property accessors with real bodies. */
  computedProperties: string[];
}

/**
 * Method and property bodies of the MonoBehaviour types in a file, measured.
 *
 * Brace-matched rather than regex-captured, because a method body contains braces and a regex that
 * pretends otherwise stops at the first `}` — which is how "this method has one statement" gets reported
 * about a forty-line method.
 */
export function monoBodies(source: string): MonoBody[] {
  const code = stripNonCode(source);
  const out: MonoBody[] = [];
  const typeRe = /\b(?:class|struct)\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*:\s*([^\n{]+)\{/g;
  for (const t of code.matchAll(typeRe)) {
    if (!UNITY_BASE.test(t[2])) continue;
    const bodyStart = (t.index ?? 0) + t[0].length - 1;
    const body = braceBlock(code, bodyStart);
    const methods: MonoBody['methods'] = [];
    const computedProperties: string[] = [];

    // `Name(args) {` — a method. `Name {` after a type is a property; `Name { get; set; }` is an auto one.
    const memberRe = /(?:^|[\s;}])(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|new|abstract|extern|unsafe|partial)\s+)*[A-Za-z_][\w.<>,\[\]?]*\s+([A-Za-z_]\w*)\s*(\([^)]*\))?\s*\{/g;
    for (const m of body.matchAll(memberRe)) {
      const at = (m.index ?? 0) + m[0].length - 1;
      const inner = braceBlock(body, at);
      if (!m[2]) {
        // a property: auto-implemented is `get; set;` and nothing else
        // `{ get; set; }` is an AUTO property — whitespace between the accessors and all four combinations.
        // Without allowing that space, every auto-property in the project read as computed.
        if (!/^\s*(?:(?:get|set|init)\s*;\s*)+$/.test(inner)) computedProperties.push(m[1]);
        continue;
      }
      const statements = inner.split(';').filter((x) => x.trim()).length;
      const decisions = (inner.match(DECISION) ?? []).length;
      const plumbingOnly = statements > 0 && decisions === 0
        && inner.split(';').filter((x) => x.trim()).every((st) => PLUMBING.test(st));
      methods.push({ name: m[1], statements, decisions, plumbingOnly });
    }
    out.push({ type: t[1], methods, computedProperties });
  }
  return out;
}

/** The `{ … }` starting at `open`, brace-matched. Empty string when it never closes. */
function braceBlock(text: string, open: number): string {
  if (text[open] !== '{') return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return '';
}

/** How many statements a plumbing-only body may hold and still be obviously a view. */
const TRIVIAL_STATEMENTS = 2;

/**
 * Should this file go to the model for the no-logic judgement? With the reason, which becomes the fact's
 * detail either way — "sent because X" is as much of an answer as "clean".
 */
export function needsLogicReview(source: string): { send: boolean; reason: string; types: string[] } {
  const bodies = monoBodies(source);
  if (!bodies.length) return { send: false, reason: 'declares no MonoBehaviour', types: [] };
  const types = bodies.map((b) => b.type);
  const reasons: string[] = [];
  for (const b of bodies) {
    if (b.computedProperties.length) {
      reasons.push(`${b.type} has ${b.computedProperties.length} computed propert(y/ies) (${b.computedProperties.slice(0, 3).join(', ')})`);
    }
    for (const m of b.methods) {
      if (m.statements === 0) continue;                                  // an empty lifecycle stub decides nothing
      if (m.decisions > 0) { reasons.push(`${b.type}.${m.name} branches or computes`); continue; }
      if (m.plumbingOnly && m.statements <= TRIVIAL_STATEMENTS) continue; // one or two hierarchy calls
      reasons.push(`${b.type}.${m.name} has ${m.statements} statement(s)${m.plumbingOnly ? '' : ' beyond hierarchy plumbing'}`);
    }
  }
  if (!reasons.length) {
    return { send: false, reason: `${types.join(', ')}: fields, properties and at most ${TRIVIAL_STATEMENTS} hierarchy call(s) per method — no logic to judge`, types };
  }
  return { send: true, reason: reasons.slice(0, 4).join('; '), types };
}

// ── the assembly a NAME lives in ──────────────────────────────────────────────────

export interface TypeOwners {
  /** Type name → the assembly that declares it. First declaration wins; a name in two is reported. */
  owner: Map<string, string>;
  scanned: number;
}

/**
 * Which assembly declares each type in the repo.
 *
 * One bounded walk, declarations only. It is the other half of the reference check: without it "is this
 * type visible from here" cannot be answered at all, and with it the answer is a map lookup. Files under
 * no asmdef belong to the predefined assembly, which is exactly how Unity compiles them.
 */
export function typeOwners(repo: string, index: AsmdefIndex, limit = 20_000): TypeOwners {
  const owner = new Map<string, string>();
  let scanned = 0;
  const skip = /^(Library|Temp|obj|Build|Builds|Logs|\.git|node_modules|ProjectSettings|UserSettings)$/;
  const walk = (dir: string): void => {
    if (scanned >= limit) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (scanned >= limit) return;
      if (e.startsWith('.') || skip.test(e)) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (extname(e).toLowerCase() !== '.cs') continue;
      scanned++;
      let text = '';
      try { text = readFileSync(p, 'utf-8'); } catch { continue; }
      const asm = owningAsmdef(index, relative(repo, p))?.name ?? 'Assembly-CSharp';
      for (const t of readCsFacts(text).types) if (!owner.has(t.name)) owner.set(t.name, asm);
    }
  };
  walk(repo);
  return { owner, scanned };
}

/** Assemblies a file's own assembly may use, by Unity's rules. */
export function visibleAssemblies(index: AsmdefIndex, own: Asmdef | null): Set<string> {
  const out = new Set<string>();
  if (own) {
    out.add(own.name);
    for (const r of own.references) {
      const dep = resolveReference(index, r);
      if (dep) out.add(dep.name);
      else out.add(r.replace(/^GUID:/, '')); // a reference to something outside this repo (a package)
    }
    return out;
  }
  // No asmdef → the predefined assembly, which sees every autoReferenced assembly and nothing else.
  out.add('Assembly-CSharp');
  for (const a of index.all) if (a.autoReferenced) out.add(a.name);
  return out;
}

export interface ShapeFinding {
  /** `asmdef-reference`, `editor-api`, `root-namespace`, `serialize-field`, `serialized-layout`, `namespace-sibling` */
  kind: string;
  /** True when the consequence is certain and mechanical — the caller marks the fact `hard`. */
  certain: boolean;
  line: string;
}

/**
 * Every deterministic finding for ONE edited file.
 *
 * `addedFields` is what the diff added (empty for a new file, where every field is new) and is what makes
 * "a field was added" answerable rather than guessed.
 */
/**
 * Assemblies Unity creates itself. None of them can appear in an .asmdef `references` array.
 */
const PREDEFINED_ASSEMBLIES = new Set([
  'Assembly-CSharp', 'Assembly-CSharp-firstpass',
  'Assembly-CSharp-Editor', 'Assembly-CSharp-Editor-firstpass',
]);

export function inspectFile(opts: {
  repo: string;
  file: string;
  source: string;
  index: AsmdefIndex;
  owners: TypeOwners;
  addedFields: Set<string>;
}): ShapeFinding[] {
  const { repo, file, source, index, owners, addedFields } = opts;
  const rel = relative(repo, file);
  const facts = readCsFacts(source);
  const own = owningAsmdef(index, rel);
  const asmName = own?.name ?? 'Assembly-CSharp';
  const visible = visibleAssemblies(index, own);
  const out: ShapeFinding[] = [];

  // 1 ── a type this file names lives in an assembly this one cannot see
  const unreachable = new Map<string, string[]>();
  for (const t of facts.typeRefs) {
    const declaredIn = owners.owner.get(t);
    if (!declaredIn || visible.has(declaredIn)) continue;
    const list = unreachable.get(declaredIn) ?? [];
    list.push(t);
    unreachable.set(declaredIn, list);
  }
  for (const [assembly, typeNames] of unreachable) {
    const named = typeNames.slice(0, 4).join(', ');
    // AN ASMDEF CANNOT REFERENCE A PREDEFINED ASSEMBLY, so never advise adding one.
    //
    // Unity's dependency direction is one-way: Assembly-CSharp references every autoReferenced
    // asmdef, and no asmdef may reference it back. Told otherwise, the QA loop wrote
    // "Assembly-CSharp" into a real Core.asmdef references array and reported the issue fixed. The
    // entry is not merely useless, it is invalid — and the loop had been handed it as `certain`.
    //
    // Reaching here usually means the type's own asmdef is missing from the index rather than that
    // the type is really in the predefined assembly, so this says what it actually knows and stops
    // short of an instruction. `certain` is false for the same reason: there is no mechanical fix.
    if (PREDEFINED_ASSEMBLIES.has(assembly)) {
      out.push({
        kind: 'asmdef-reference',
        certain: false,
        line: `${rel} compiles into ${asmName} and names ${named}, which ayin resolved to ${assembly}. `
          + 'An .asmdef CANNOT reference a predefined assembly — do NOT add it to the references array. '
          + `Either ${named} really lives outside every .asmdef (then it must move into one, or this file must leave ${asmName}), `
          + 'or the .asmdef that owns it failed to parse and was dropped from the index — check for one before changing anything.',
      });
      continue;
    }
    out.push({
      kind: 'asmdef-reference',
      certain: true,
      line: `${rel} compiles into ${asmName}, which does not reference ${assembly} — but names ${named} from it. `
        + (own
          ? `Add "${assembly}" to the references array of ${own.path}, or this is CS0246.`
          : `${assembly} is not autoReferenced, so the predefined assembly cannot see it — move the file into an assembly that references it.`),
    });
  }

  // 2 ── UnityEditor in an assembly that ships to the player
  const usesEditor = facts.usings.some((u) => u === 'UnityEditor' || u.startsWith('UnityEditor.'))
    || /\bUnityEditor\s*\./.test(stripNonCode(source));
  if (usesEditor && !(own?.editorOnly ?? false)) {
    out.push({
      kind: 'editor-api',
      certain: true,
      line: `${rel} uses UnityEditor but compiles into ${asmName}, which is NOT editor-only`
        + `${own ? ` (includePlatforms in ${own.path} is ${own.includePlatforms.length ? JSON.stringify(own.includePlatforms) : 'empty = every platform'})` : ' (the predefined assembly ships to the player)'}`
        + ' — it builds in the editor and fails the player build. Move it to an Editor assembly or wrap it in #if UNITY_EDITOR.',
    });
  }

  // 3 ── the assembly's own declared namespace
  if (own?.rootNamespace) {
    const ns = facts.namespace;
    const okNs = ns === own.rootNamespace || (ns ?? '').startsWith(`${own.rootNamespace}.`);
    if (!okNs) {
      out.push({
        kind: 'root-namespace',
        certain: true,
        line: `${rel} declares ${ns ? `namespace ${ns}` : 'NO namespace'}, but ${own.name} sets rootNamespace "${own.rootNamespace}" in ${own.path} — the assembly's own declaration. Use ${own.rootNamespace}[.Sub].`,
      });
    }
  } else if (facts.namespace !== null) {
    // 6 ── no declaration to check against: compare with what the neighbours actually do
    const siblings = siblingNamespaces(dirname(file), file);
    if (siblings.size && !siblings.has(facts.namespace)) {
      out.push({
        kind: 'namespace-sibling',
        certain: false,
        line: `${rel} declares namespace ${facts.namespace}; every other .cs in that folder declares ${[...siblings].slice(0, 2).join(' / ')}. No asmdef rootNamespace to settle it — check which is intended.`,
      });
    }
  }

  // 4 ── [SerializeField] on something Unity does not store
  for (const f of facts.fields) {
    if (!isSerialized(f)) continue;
    const hit = NOT_SERIALIZABLE.find((n) => n.re.test(f.type));
    if (!hit) continue;
    if (f.attributes.some((a) => /^SerializeReference\b/.test(a))) continue;
    out.push({
      kind: 'serialize-field',
      certain: true,
      line: `${rel}:${f.line} ${f.type} ${f.name} is serialized but ${hit.why}. Unity stores nothing for it and reports nothing — the field is empty at runtime.`,
    });
  }

  // 5 ── a serialized field ADDED to a type existing assets carry
  const asset = declaresUnityAsset(facts);
  const added = facts.fields.filter((f) => addedFields.has(f.name) && isSerialized(f));
  if (asset && added.length) {
    const users = assetsReferencing(repo, file);
    out.push({
      kind: 'serialized-layout',
      certain: false,
      line: `${rel} adds ${added.length} serialized field(s) (${added.map((f) => f.name).join(', ')}) to ${asset.name} : ${asset.base}`
        + (users.count > 0
          ? ` — ${users.count} existing asset(s) carry this script and store fields BY NAME, so every one of them takes the default for the new field(s): ${users.sample.join(', ')}${users.count > users.sample.length ? ', …' : ''}. If a non-default value matters, they need a migration.`
          : ' — no prefab/scene/asset in the repo references this script yet, so nothing existing is affected.'),
    });
  }

  return out;
}

/** What the other .cs files in a directory declare as their namespace. */
function siblingNamespaces(dir: string, exclude: string): Set<string> {
  const out = new Set<string>();
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries.slice(0, 60)) {
    if (extname(e).toLowerCase() !== '.cs') continue;
    const p = join(dir, e);
    if (resolve(p) === resolve(exclude)) continue;
    try {
      const ns = /^\s*namespace\s+([A-Za-z_][\w.]*)/m.exec(stripNonCode(readFileSync(p, 'utf-8')))?.[1];
      if (ns) out.add(ns);
    } catch { /* unreadable sibling proves nothing */ }
  }
  return out;
}

/**
 * How many prefabs/scenes/assets carry this script, by the GUID in its `.meta`.
 *
 * The GUID is the only durable identity Unity has for a script — a rename does not change it, and the
 * asset files name nothing else. `git grep` is used when the repo is one (fast, and it is a repo here by
 * construction); a plain scan is the fallback.
 */
export function assetsReferencing(repo: string, csFile: string): { count: number; sample: string[] } {
  const meta = `${csFile}.meta`;
  if (!existsSync(meta)) return { count: 0, sample: [] };
  let guid = '';
  try { guid = /guid:\s*([0-9a-f]{32})/i.exec(readFileSync(meta, 'utf-8'))?.[1] ?? ''; } catch { /* no meta */ }
  if (!guid) return { count: 0, sample: [] };
  try {
    const out = execFileSync('git', ['-C', repo, 'grep', '-l', '--', guid, '--', '*.prefab', '*.unity', '*.asset'], {
      encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out.split('\n').map((l) => l.trim()).filter(Boolean);
    return { count: files.length, sample: files.slice(0, 3) };
  } catch {
    // `git grep` exits 1 for "no matches", which is an answer, not a failure.
    return { count: 0, sample: [] };
  }
}

/**
 * Field names ADDED to a file in the working tree, from git.
 *
 * `git diff -U0` for a tracked file, the whole file for an untracked one. Deterministic, and the only way
 * to answer "was this field added THIS turn" without asking a model to remember.
 */
export function addedFieldNames(repo: string, file: string): Set<string> {
  const rel = relative(repo, file);
  let diff = '';
  try {
    diff = execFileSync('git', ['-C', repo, 'diff', '-U0', 'HEAD', '--', rel], { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { /* not tracked, or no HEAD */ }
  if (!diff.trim()) {
    try {
      // Untracked: every field in it is new.
      const untracked = execFileSync('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard', '--', rel], { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (untracked.trim()) return new Set(readCsFacts(readFileSync(file, 'utf-8')).fields.map((f) => f.name));
    } catch { /* not a repo */ }
    return new Set();
  }
  const addedLines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  return new Set(readCsFacts(addedLines.join('\n')).fields.map((f) => f.name));
}
