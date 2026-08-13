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
    let current: DeclaredType | null = null;
    let depth = 0;
    let typeDepth = -1;
    for (const raw of source.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '');
      const decl = DECL.exec(line);
      if (decl?.groups) {
        current = { name: decl.groups.name, kind: kindOf(decl.groups), members: [] };
        types.push(current);
        typeDepth = depth;
      } else if (current && depth === typeDepth + 1) {
        const m = MEMBER.exec(line);
        if (m?.groups && !/^(if|for|while|switch|return|const|let|var|import|export|new|await|throw|case|else|try|catch)$/.test(m.groups.name)) {
          const kind: DeclaredMember['kind'] = m.groups.tail === '(' || m.groups.tail === '<' ? 'method' : 'field';
          current.members.push({ name: m.groups.name, kind, visibility: visibility(m.groups), sig: line.trim() });
        }
      }
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (current && depth <= typeDepth) { current = null; typeDepth = -1; }
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
