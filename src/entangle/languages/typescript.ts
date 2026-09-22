/**
 * TypeScript / JavaScript surfaces, and `package.json` as the dependency unit.
 *
 * The JS analogue of an `.asmdef` is the package: it has a name, and `dependencies` states what it may
 * reference. The mapping is not perfect and the difference is worth being honest about — a monorepo file
 * can import a sibling by relative path and no manifest forbids it, where C# would need an assembly
 * reference. So `allows` covers PACKAGE references (bare specifiers); relative imports inside the same
 * package are the package's own business, exactly as files inside one assembly are.
 *
 * `interface` and `type` both declare a surface here; `type X = {...}` is how a great deal of TS declares
 * what C# would call an interface, and ignoring it would leave the biggest hole in the check.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeclaredMember, DeclaredType, Domain, SurfaceLanguage, TypeKind, Visibility } from '../types.js';

const DECL = /^\s*(?:export\s+)?(?:declare\s+)?(?<abstract>abstract\s+)?(?<kind>class|interface|enum|type)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/;

/** A class member, or an interface/type-literal field. `private`/`#` are the non-public forms. */
const MEMBER = /^\s*(?<hash>#)?(?<vis>public|private|protected|readonly)?\s*(?:static\s+|readonly\s+|async\s+|get\s+|set\s+|abstract\s+)*(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*(?<tail>\(|<|:|=|\?)/;

/** TypeScript's own vocabulary; same bias toward TRUE as the C# list. */
const TS_BUILTIN = new Set([
  'string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'null', 'undefined', 'object',
  'symbol', 'bigint', 'this', 'Array', 'ReadonlyArray', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'JSON', 'Math', 'Object', 'String', 'Number',
  'Boolean', 'Function', 'Symbol', 'BigInt', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
  'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters', 'Awaited', 'Iterable', 'Iterator',
  'AsyncIterable', 'ArrayBuffer', 'Uint8Array', 'Buffer', 'AbortSignal', 'URL', 'Event',
]);

function kindOf(g: Record<string, string | undefined>): TypeKind {
  if (g.abstract) return 'abstract';
  if (g.kind === 'type') return 'interface'; // a type literal is an interface by any other name
  return (g.kind as TypeKind) ?? 'class';
}

function visibility(g: Record<string, string | undefined>): Visibility {
  if (g.hash || g.vis === 'private') return 'private';
  if (g.vis === 'protected') return 'protected';
  return 'public'; // TS default, unlike C#
}

/**
 * NEUTRALIZE STRINGS, COMMENTS AND TEMPLATE LITERALS BEFORE COUNTING A SINGLE BRACE.
 *
 * A brace counter that has not done this is Python's docstring bug wearing a different costume: a
 * template literal used for a CSS-in-JS block or a multi-line prompt routinely contains `{` with no
 * code meaning at all, and a `//` inside a string (`"http://x"`) is not a comment. Either one moves
 * `depth` and desyncs every type/member boundary after it — silently, because the file still "parses"
 * and produces a plausible-looking, wrong skeleton.
 *
 * Returns the file as an array of lines, same count and same line NUMBERS as the source, with every
 * comment and string/template BODY replaced by blanks — real code characters, including the code
 * inside a `${...}` interpolation, are passed through untouched so brace/paren counting on the result
 * is exact. Interpolation is tracked with a stack so nesting (`` `${ `${x}` }` ``) and a string opened
 * INSIDE an interpolation both resolve correctly.
 */
function stripSource(source: string): string[] {
  const lines: string[] = [];
  let out = '';
  let i = 0;
  const n = source.length;
  let lineComment = false;
  let blockComment = false;
  let quote: '"' | "'" | null = null;
  // Top of stack: 'template' means we are in template TEXT; a number means we are in the CODE of a
  // `${...}` interpolation, counting that interpolation's OWN unmatched `{` so a nested object
  // literal's `}` is not mistaken for the one that closes the interpolation.
  const stack: Array<'template' | number> = [];
  while (i < n) {
    const c = source[i];
    if (c === '\n') {
      // A plain quoted string cannot legally hold a literal newline. If we still think we are
      // inside one, the quote was never closed — treat it as ended here rather than let one
      // unterminated string swallow the rest of the file the way the missed docstring did.
      if (quote) quote = null;
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
    if (quote) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) { quote = null; out += ' '; i++; continue; }
      out += ' '; i++; continue;
    }
    const top = stack[stack.length - 1];
    if (top === 'template') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') { stack.pop(); out += ' '; i++; continue; }
      if (c === '$' && source[i + 1] === '{') { stack.push(0); out += '  '; i += 2; continue; }
      out += ' '; i++; continue;
    }
    // Code — either top-level, or inside a `${...}` interpolation (top is a number).
    if (c === '/' && source[i + 1] === '/') { lineComment = true; i += 2; continue; }
    if (c === '/' && source[i + 1] === '*') { blockComment = true; i += 2; continue; }
    if (c === '"' || c === "'") { quote = c; out += ' '; i++; continue; }
    if (c === '`') { stack.push('template'); out += ' '; i++; continue; }
    if (typeof top === 'number') {
      if (c === '{') { stack[stack.length - 1] = top + 1; out += c; i++; continue; }
      if (c === '}') {
        if (top === 0) { stack.pop(); out += ' '; i++; continue; } // closes the interpolation itself
        stack[stack.length - 1] = top - 1; out += c; i++; continue;
      }
    }
    out += c;
    i++;
  }
  lines.push(out);
  return lines;
}

/** Statements that look like a member to a name+tail scan and are not. */
const NOT_A_MEMBER = /^(if|for|while|switch|return|const|let|var|import|export|new|await|throw|case|else|try|catch)$/;

/** Nearest `package.json` walking up — the package boundary, the same way node resolves. */
function findManifest(from: string): string | null {
  let dir = dirname(from);
  for (;;) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export const typescript: SurfaceLanguage = {
  id: 'typescript',

  handles(path) {
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path) && !path.endsWith('.d.ts');
  },

  domainOf(path) {
    const manifest = findManifest(path);
    if (!manifest) return null;
    try {
      const j = JSON.parse(readFileSync(manifest, 'utf-8')) as {
        name?: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
      };
      const allows = [...Object.keys(j.dependencies ?? {}), ...Object.keys(j.peerDependencies ?? {})];
      return {
        name: j.name ?? dirname(manifest),
        manifest,
        allows,
        // No runtime dependencies at all is this ecosystem's `noEngineReferences`: a package that
        // deliberately stands alone, and the one an added import quietly destroys.
        sealed: allows.length === 0,
      };
    } catch {
      return null;
    }
  },

  surfaceOf(source) {
    const types: DeclaredType[] = [];
    const masked = stripSource(source);
    const rawLines = source.split('\n');
    let current: DeclaredType | null = null;
    let depth = 0;
    let typeDepth = -1;
    /**
     * The member currently being measured for its END, alongside the type/member scan above it.
     * `entered` is true once we have seen the `{` that is genuinely this member's OWN body — not a
     * brace inside a still-open parameter list, e.g. `opts: { a: number } = {}` in a signature default,
     * which is why `parenDepth` gates it: a `{` counts as "the body opened" only while no paren from
     * this member's own signature is still open.
     */
    let pending: { member: DeclaredMember; entered: boolean; parenDepth: number } | null = null;

    for (let idx = 0; idx < masked.length; idx++) {
      const n = idx + 1;
      const line = masked[idx];
      /**
       * ASI RECOVERY. A field or expression-bodied member with no trailing `;` (legal — JS inserts
       * one) leaves `pending` open forever unless something says "the next thing is new". A line that
       * itself reads as a fresh declaration is that signal; without it, the semicolon-less member and
       * everything textually after it in the type would never be seen again — the exact shape of the
       * dropped-32-of-75 docstring bug, just triggered by absent punctuation instead of an accidental
       * fence. Bounded to when no paren/brace is still open, so a genuine multi-line signature is
       * never mistaken for two declarations.
       */
      if (pending && !pending.entered && pending.parenDepth === 0 && depth === typeDepth + 1
        && (DECL.test(line) || MEMBER.test(line))) {
        pending.member.endLine = n - 1;
        pending = null;
      }
      if (!pending) {
        const decl = DECL.exec(line);
        if (decl?.groups) {
          current = { name: decl.groups.name, kind: kindOf(decl.groups), members: [], line: n };
          types.push(current);
          typeDepth = depth;
        } else if (current && depth === typeDepth + 1) {
          const m = MEMBER.exec(line);
          if (m?.groups && !NOT_A_MEMBER.test(m.groups.name)) {
            const kind: DeclaredMember['kind'] = m.groups.tail === '(' || m.groups.tail === '<' ? 'method' : 'field';
            // The signature shown is the lightly comment-stripped RAW line, not the masked one — a
            // reader wants to see the string a default value actually holds, not blanks.
            const sig = rawLines[idx].replace(/\/\/.*$/, '').trim();
            const member: DeclaredMember = { name: m.groups.name, kind, visibility: visibility(m.groups), sig, line: n };
            current.members.push(member);
            pending = { member, entered: false, parenDepth: 0 };
          }
        }
      }
      for (const ch of line) {
        if (pending) {
          if (ch === '(') pending.parenDepth++;
          else if (ch === ')') pending.parenDepth = Math.max(0, pending.parenDepth - 1);
        }
        if (ch === '{') {
          if (pending && !pending.entered && pending.parenDepth === 0 && depth === typeDepth + 1) pending.entered = true;
          depth++;
        } else if (ch === '}') {
          depth--;
          if (pending?.entered && depth === typeDepth + 1) {
            pending.member.endLine = n;
            pending = null;
          }
        }
      }
      // No body ever opened, and the line just closed with `;`/`,` at the member's own level — an
      // interface signature, an ambient declaration, or a plain field with a semicolon.
      if (pending && !pending.entered && pending.parenDepth === 0 && depth === typeDepth + 1 && /[;,]\s*$/.test(line)) {
        pending.member.endLine = n;
        pending = null;
      }
      if (current && depth <= typeDepth) { pending = null; current = null; typeDepth = -1; }
    }
    return types;
  },

  /** Node builtins are the platform. `node:`-prefixed specifiers never reach here (see referencesOf). */
  isPlatform(ref) {
    return /^(fs|path|os|url|util|events|stream|crypto|http|https|child_process|assert|buffer|zlib|net|tls|readline|worker_threads|perf_hooks|timers)$/.test(ref);
  },

  isBuiltinType(name) {
    return TS_BUILTIN.has(name);
  },

  referencesOf(source) {
    const out = new Set<string>();
    const add = (spec: string): void => {
      if (spec.startsWith('.')) return; // inside the package — its own business
      if (spec.startsWith('node:')) return; // the platform, not a dependency
      // '@scope/name/deep' → '@scope/name'; 'pkg/deep' → 'pkg'
      const parts = spec.split('/');
      out.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    };
    for (const m of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) add(m[1]);
    for (const m of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
    for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
    return [...out];
  },
};
