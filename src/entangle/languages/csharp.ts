/**
 * C# surfaces, and `.asmdef` as the dependency unit.
 *
 * Unity's assembly definitions are the strongest constraint in a Unity codebase and the cheapest to
 * verify: the manifest is JSON, `references` is an array, and `noEngineReferences` is a boolean. Nothing
 * about this needs a compiler.
 *
 * Declarations only — no bodies, no expressions, no generics resolution. A surface diff needs to know
 * that `class Foo` exists with a public `Bar()`; it does not need to understand `Bar`. That is what keeps
 * this a regex instead of a C# front end, and the honest limit of it: source that hides a declaration
 * behind a preprocessor branch or a `partial` split across files is read one file at a time.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import type { DeclaredMember, DeclaredType, Domain, SurfaceLanguage, TypeKind, Visibility } from '../types.js';

const KIND: Record<string, TypeKind> = {
  class: 'class', interface: 'interface', struct: 'struct', enum: 'enum', record: 'class',
};

/** `public abstract class Foo : Bar` → one declaration. Modifiers in any order, as C# allows. */
const DECL = /^\s*(?:\[[^\]]*\]\s*)*(?<mods>(?:public|internal|private|protected|abstract|sealed|static|partial|readonly|unsafe|new|ref)\s+)*(?<kind>class|interface|struct|enum|record)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/;

/** A member declaration: `public int Foo { get; }`, `public void Bar(...)`, `public event X Y;`. */
const MEMBER = /^\s*(?:\[[^\]]*\]\s*)*(?<vis>public|private|protected|internal)?\s*(?:static\s+|virtual\s+|override\s+|abstract\s+|sealed\s+|readonly\s+|async\s+|extern\s+|unsafe\s+|new\s+|partial\s+)*(?<ev>event\s+)?(?<sig>[A-Za-z_][A-Za-z0-9_<>,\[\]\.\?\s]*?)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?<tail>\(|\{|=>|;|=)/;

/**
 * C#'s own vocabulary. Erring toward TRUE on purpose — a missed violation costs a review, a false stop on
 * `Dictionary` costs the operator the whole feature.
 */
const BUILTIN = new Set([
  // Namespace roots as well as types: `System.Action<T>` splits into System + Action, and flagging
  // `System` as an undesigned type was a live-run false positive.
  'System', 'Microsoft', 'Collections', 'Generic', 'Linq', 'Text', 'Threading', 'Tasks', 'IO',
  'void', 'var', 'object', 'string', 'bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float',
  'int', 'uint', 'long', 'ulong', 'short', 'ushort', 'nint', 'nuint', 'dynamic',
  'Object', 'String', 'Boolean', 'Byte', 'Char', 'Decimal', 'Double', 'Single', 'Int16', 'Int32', 'Int64',
  'UInt16', 'UInt32', 'UInt64', 'Guid', 'DateTime', 'DateTimeOffset', 'TimeSpan', 'Uri', 'Version',
  'Math', 'Convert', 'Enum', 'Array', 'Tuple', 'ValueTuple', 'Nullable', 'Type', 'Exception',
  'ArgumentException', 'ArgumentNullException', 'ArgumentOutOfRangeException', 'InvalidOperationException',
  'NotImplementedException', 'NotSupportedException', 'IndexOutOfRangeException', 'KeyNotFoundException',
  'List', 'Dictionary', 'HashSet', 'Queue', 'Stack', 'SortedList', 'SortedDictionary', 'SortedSet',
  'LinkedList', 'IEnumerable', 'IEnumerator', 'ICollection', 'IList', 'IDictionary', 'IReadOnlyList',
  'IReadOnlyCollection', 'IReadOnlyDictionary', 'ISet', 'IComparable', 'IComparer', 'IEquatable',
  'IEqualityComparer', 'IDisposable', 'IFormattable', 'ICloneable', 'KeyValuePair', 'EqualityComparer',
  'Comparer', 'StringComparer', 'StringComparison', 'StringBuilder',
  'Action', 'Func', 'Predicate', 'Comparison', 'EventHandler', 'EventArgs', 'Lazy', 'Random',
  'Task', 'ValueTask', 'CancellationToken', 'IProgress', 'Span', 'ReadOnlySpan', 'Memory', 'ReadOnlyMemory',
]);

function visibility(raw: string | undefined): Visibility {
  if (raw === 'public' || raw === 'private' || raw === 'protected' || raw === 'internal') return raw;
  return 'private'; // C#'s default inside a type, which is also the safe reading for closure
}

/** Nearest `.asmdef` walking up. Unity's own rule, so no configuration to get wrong. */
function findAsmdef(from: string): string | null {
  let dir = dirname(from);
  for (;;) {
    try {
      const hit = readdirSync(dir).find((f) => f.endsWith('.asmdef'));
      if (hit) return join(dir, hit);
    } catch { /* unreadable dir — keep walking */ }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export const csharp: SurfaceLanguage = {
  id: 'csharp',

  handles(path) {
    return path.endsWith('.cs');
  },

  domainOf(path) {
    const manifest = findAsmdef(path);
    if (!manifest || !existsSync(manifest)) return null;
    try {
      const j = JSON.parse(readFileSync(manifest, 'utf-8')) as {
        name?: string; references?: string[]; noEngineReferences?: boolean;
      };
      return {
        name: j.name ?? parse(manifest).name,
        manifest,
        allows: j.references ?? [],
        sealed: j.noEngineReferences === true,
      };
    } catch {
      // A malformed manifest must not be read as "everything is permitted" — that would silently
      // disable the strictest check in the codebase. No domain means the domain rule does not run,
      // and the caller says so rather than passing the file.
      return null;
    }
  },

  surfaceOf(source) {
    const types: DeclaredType[] = [];
    let current: DeclaredType | null = null;
    let depth = 0;
    let typeDepth = -1;
    // Has the type's BODY actually opened yet? Load-bearing for Allman brace style, which is the
    // Microsoft/Unity standard and what real C# looks like:
    //
    //     public class Foo          <- DECL seen here, depth is still 1
    //     {                         <- the brace is on the NEXT line
    //         public void Bar()     <- members live at depth 2
    //
    // `typeDepth` is recorded at the DECL line, before that brace is counted. Without this flag the
    // end-of-type check (`depth <= typeDepth`) fires on the declaration line ITSELF and clears
    // `current` immediately, so every member is skipped — silently, with no error and a plausible
    // result: the type is still reported, just with an empty member list. Measured on a real project:
    // `GameFlowManager` yielded the file and the class and NOTHING else, and a struct with eight
    // public fields produced two targets. K&R style (`class Foo {`) happened to work, which is why
    // this survived.
    let entered = false;
    for (const raw of source.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '');
      const decl = DECL.exec(line);
      if (decl?.groups) {
        const kind = decl.groups.mods?.includes('abstract') ? 'abstract' : KIND[decl.groups.kind];
        current = { name: decl.groups.name, kind, members: [] };
        types.push(current);
        typeDepth = depth;
        entered = false;
      } else if (current && depth === typeDepth + 1 && current.kind === 'enum') {
        // Enum members BEFORE the general member rule, not after it. `Klondike,` is a bare
        // identifier: MEMBER needs `<type> <name> <tail>` and cannot match it, so the enum branch
        // being an `else if` after MEMBER made it unreachable for any enum whose body opens on its
        // own line — every enum in a real project. `RewardType.cs`, whose values decide a live
        // ticket, therefore had no surface at all and indulged to zero questions.
        const name = line.trim().replace(/[,=].*$/, '').trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          current.members.push({ name, kind: 'field', visibility: 'public', sig: line.trim() });
        }
      } else if (current && depth === typeDepth + 1) {
        const m = MEMBER.exec(line);
        if (m?.groups && m.groups.name !== current.name) {
          const kind: DeclaredMember['kind'] = m.groups.ev ? 'event'
            : m.groups.tail === '(' ? 'method'
            : m.groups.tail === '{' ? 'property' : 'field';
          // An interface member carries no access modifier and is public BY DEFINITION. Reading the
          // absent modifier as C#'s `private` default made MEMBER skip every interface — which is where
          // most of a design's contract actually lives.
          const vis: Visibility = current.kind === 'interface' ? 'public' : visibility(m.groups.vis);
          current.members.push({ name: m.groups.name, kind, visibility: vis, sig: line.trim() });
        }
      }
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (current && depth > typeDepth) entered = true;
      if (current && entered && depth <= typeDepth) { current = null; typeDepth = -1; entered = false; }
    }
    return types;
  },

  /**
   * The BCL is always available; `references` is about project assemblies. `noEngineReferences: true` is
   * specifically about the ENGINE, so a sealed unit still gets System and still must not get UnityEngine.
   */
  isPlatform(ref) {
    // The engine is never the platform here: it is exactly what `noEngineReferences` is about, and in a
    // non-sealed assembly it still has to be listed in `references`. So it always falls through to the
    // manifest check rather than being waved past.
    if (/^(UnityEngine|UnityEditor|Unity|TMPro|Cinemachine)\b/.test(ref)) return false;
    return /^(System|Microsoft\.CSharp|mscorlib|netstandard)\b/.test(ref);
  },

  referencesOf(source) {
    const out = new Set<string>();
    for (const m of source.matchAll(/^\s*using\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*;/gm)) out.add(m[1]);
    return [...out];
  },

  isBuiltinType(name) {
    return BUILTIN.has(name);
  },
};
