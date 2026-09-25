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
export const BUILTIN = new Set([
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

/**
 * NEUTRALIZE COMMENTS AND STRING BODIES BEFORE A SINGLE BRACE IS COUNTED.
 *
 * The trap here wears the verbatim-string costume: `@"{ \"template\": true }"` is legal C# for a
 * literal JSON blob, spans lines freely, and a counter that does not know it is inside one reads its
 * braces as class/member structure — the exact failure class as Python's docstring bug, just triggered
 * by `@"` instead of `"""`. Raw string literals (`"""…"""`, C# 11) are the same hazard again, unescaped.
 *
 * Returns the file as an array of lines, same count as the source, every comment and string BODY
 * replaced with blanks so brace/paren counting on the result is exact; code characters are untouched.
 */
function stripSource(source: string): string[] {
  const lines: string[] = [];
  let out = '';
  let i = 0;
  const n = source.length;
  let lineComment = false;
  let blockComment = false;
  // A plain `"…"` uses backslash escapes and cannot legally span a line; a verbatim `@"…"` has no
  // escapes (`""` is a literal quote) and MAY span lines — that difference is the whole reason this
  // is two states rather than one.
  let str: 'plain' | 'verbatim' | null = null;
  let rawQuotes = 0; // > 0 while inside a `"""` raw string literal — its value is the opening run length.
  while (i < n) {
    const c = source[i];
    if (c === '\n') {
      // A plain string cannot legally hold a literal newline. Still thinking we are inside one means
      // the quote was never closed — end it here rather than let it consume the rest of the file.
      if (str === 'plain') str = null;
      lines.push(out);
      out = '';
      lineComment = false;
      i++;
      continue;
    }
    if (lineComment) { i++; continue; }
    if (blockComment) {
      if (c === '*' && source[i + 1] === '/') { blockComment = false; out += '  '; i += 2; continue; }
      out += ' '; i++; continue;
    }
    if (rawQuotes > 0) {
      if (c === '"') {
        let run = 0;
        while (source[i + run] === '"') run++;
        if (run >= rawQuotes) { rawQuotes = 0; out += ' '.repeat(run); i += run; continue; }
      }
      out += ' '; i++; continue;
    }
    if (str === 'plain') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '"') { str = null; out += ' '; i++; continue; }
      out += ' '; i++; continue;
    }
    if (str === 'verbatim') {
      if (c === '"') {
        if (source[i + 1] === '"') { out += '  '; i += 2; continue; } // `""` — a literal quote, not the end
        str = null; out += ' '; i++; continue;
      }
      out += ' '; i++; continue;
    }
    // code
    if (c === '/' && source[i + 1] === '/') { lineComment = true; i += 2; continue; }
    if (c === '/' && source[i + 1] === '*') { blockComment = true; i += 2; continue; }
    if (c === '"') {
      let run = 0;
      while (source[i + run] === '"') run++;
      if (run >= 3) { rawQuotes = run; out += ' '.repeat(run); i += run; continue; }
      str = source[i - 1] === '@' ? 'verbatim' : 'plain';
      out += ' '; i++; continue;
    }
    out += c;
    i++;
  }
  lines.push(out);
  return lines;
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
    let depth = 0;
    /**
     * A STACK, BECAUSE C# TYPES NEST — and a single `current` silently loses the outer one.
     *
     * `RewardService` declares a private `Entry` class at the top of its body. With one `current`,
     * `Entry`'s declaration overwrote it and `Entry`'s close reset it to null, so the twenty-odd
     * members declared AFTER the nested type — every field, every event, the whole service — were
     * attributed to nothing and dropped. Measured on that file: `class RewardService members: 0`,
     * next to `class Entry members: 12`. Both types are still reported, which is what made it
     * invisible: nothing errors, and a type with no members reads like a marker interface rather
     * than a parse failure. `entangle`'s closure gate and the too-big-file skeleton both read this.
     *
     * `entered` is per frame and load-bearing for Allman brace style, which is the Microsoft/Unity
     * standard and what real C# looks like:
     *
     *     public class Foo          <- DECL seen here, depth is still 1
     *     {                         <- the brace is on the NEXT line
     *         public void Bar()     <- members live at depth 2
     *
     * `typeDepth` is recorded at the DECL line, before that brace is counted, so without the flag the
     * end-of-frame check (`depth <= typeDepth`) fires on the declaration line ITSELF and pops the
     * frame immediately — every member skipped, silently, with the same plausible empty result. K&R
     * style (`class Foo {`) happened to work, which is why that one survived too.
     */
    const stack: Array<{ type: DeclaredType; typeDepth: number; entered: boolean }> = [];
    const top = (): { type: DeclaredType; typeDepth: number; entered: boolean } | undefined => stack[stack.length - 1];
    const masked = stripSource(source);
    const rawLines = source.split('\n');
    /**
     * The member being measured for its END. `parenDepth` gates what counts as "the body opened": a
     * `{` seen while a paren from the member's OWN parameter list is still open is a nested construct
     * (an attribute argument, a collection/array initializer), never the member's body — C# has no
     * expression-valued default parameters that could hide one there, but attributes sit exactly where
     * this would bite if it were not gated. `entered` (below, C#'s existing Allman-style flag) is the
     * type-level version of the same idea; this is its member-level twin.
     */
    let pending: { member: DeclaredMember; entered: boolean; parenDepth: number } | null = null;

    for (let idx = 0; idx < masked.length; idx++) {
      const n = idx + 1;
      const line = masked[idx];
      if (!pending) {
        const decl = DECL.exec(line);
        const frame = top();
        if (decl?.groups) {
          const kind = decl.groups.mods?.includes('abstract') ? 'abstract' : KIND[decl.groups.kind];
          const declared: DeclaredType = { name: decl.groups.name, kind, members: [], line: n };
          types.push(declared);
          stack.push({ type: declared, typeDepth: depth, entered: false });
        } else if (frame && depth === frame.typeDepth + 1 && frame.type.kind === 'enum') {
          // Enum members BEFORE the general member rule, not after it. `Klondike,` is a bare
          // identifier: MEMBER needs `<type> <name> <tail>` and cannot match it, so the enum branch
          // being an `else if` after MEMBER made it unreachable for any enum whose body opens on its
          // own line — every enum in a real project. `RewardType.cs`, whose values decide a live
          // ticket, therefore had no surface at all and indulged to zero questions.
          const name = line.trim().replace(/[,=].*$/, '').trim();
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            // An enum value is always exactly one line — there is no body to walk.
            frame.type.members.push({ name, kind: 'field', visibility: 'public', sig: rawLines[idx].trim(), line: n, endLine: n });
          }
        } else if (frame && depth === frame.typeDepth + 1) {
          const m = MEMBER.exec(line);
          if (m?.groups && m.groups.name !== frame.type.name) {
            const kind: DeclaredMember['kind'] = m.groups.ev ? 'event'
              : m.groups.tail === '(' ? 'method'
              : m.groups.tail === '{' ? 'property' : 'field';
            // An interface member carries no access modifier and is public BY DEFINITION. Reading the
            // absent modifier as C#'s `private` default made MEMBER skip every interface — which is
            // where most of a design's contract actually lives.
            const vis: Visibility = frame.type.kind === 'interface' ? 'public' : visibility(m.groups.vis);
            const member: DeclaredMember = { name: m.groups.name, kind, visibility: vis, sig: rawLines[idx].replace(/\/\/.*$/, '').trim(), line: n };
            frame.type.members.push(member);
            pending = { member, entered: false, parenDepth: 0 };
          }
        }
      }
      for (const ch of line) {
        if (pending) {
          if (ch === '(') pending.parenDepth++;
          else if (ch === ')') pending.parenDepth = Math.max(0, pending.parenDepth - 1);
        }
        const f = top();
        if (ch === '{') {
          if (pending && !pending.entered && pending.parenDepth === 0 && f && depth === f.typeDepth + 1) pending.entered = true;
          depth++;
        } else if (ch === '}') {
          depth--;
          if (pending?.entered && f && depth === f.typeDepth + 1) {
            pending.member.endLine = n;
            pending = null;
          }
        }
      }
      // No body ever opened and this line closed at the member's own level with `;` — a field, an
      // auto-property with no initializer past this point, or (inside an interface) a bare signature.
      const open = top();
      if (pending && !pending.entered && pending.parenDepth === 0 && open && depth === open.typeDepth + 1 && /;\s*$/.test(line)) {
        pending.member.endLine = n;
        pending = null;
      }
      if (open && depth > open.typeDepth) open.entered = true;
      // Pop every frame this line closed, not just the innermost: `} } }` on one line ends three.
      while (stack.length) {
        const f = stack[stack.length - 1];
        if (!f.entered || depth > f.typeDepth) break;
        pending = null;
        stack.pop();
      }
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
