/**
 * Python surfaces, and the packaging manifest as the dependency unit.
 *
 * WHY THIS FILE EXISTS, and it is not a nicety. `languageFor()` gated on `[csharp, typescript, dart]`,
 * so `languageFor('requests/models.py')` was null and every Python file in every repository classified
 * as "not source". `indulge`'s discovery drops a seed the moment that check fails — so a corpus could
 * not be built for a Python repo AT ALL. Measured: two SWE-bench repositories, six domains each, every
 * seed discarded, both runs ending "Nothing matched. No questions, no chunks." Not a poor corpus — none.
 *
 * INDENTATION IS THE BRACE. The other three languages find a type's members by counting `{` and `}`;
 * Python has neither, so the class body is whatever is indented past the `class` line and a member is a
 * declaration exactly one level in. Anything deeper is a nested function or a method body, which the
 * other surfaces skip for free and this one has to skip on purpose.
 *
 * VISIBILITY IS A CONVENTION HERE, not a keyword, and the convention is worth honouring: `_name` is
 * protected by agreement and `__name` is name-mangled by the runtime, which is as private as Python
 * gets. Reporting everything public would make a surface that says nothing.
 *
 * A DOMAIN ONLY EXISTS WHEN THE DEPENDENCIES ARE READABLE. `setup.py` states its dependencies in
 * executable code, and this file will not run somebody's setup script to find out. When the manifest
 * cannot be parsed the answer is null — the file is in no dependency unit — rather than a Domain with
 * an empty `allows`, which the shared rules read as SEALED and would turn every import in the repo into
 * a violation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeclaredMember, DeclaredType, Domain, SurfaceLanguage, TypeKind, Visibility } from '../types.js';

/** `class X:`, `class X(Base):` — the only type declaration Python has. */
const CLASS = /^(?<indent>\s*)class\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\((?<bases>[^)]*)\))?\s*:/;
/** A member: a def (sync or async), or an annotated/assigned attribute. */
const MEMBER = /^(?<indent>\s*)(?:async\s+)?(?:def\s+(?<fn>[A-Za-z_][A-Za-z0-9_]*)|(?<attr>[A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=)/;
/** A module-level def — a function is a surface in Python in a way it is not in C#. */
const FUNC = /^(?<indent>)(?:async\s+)?def\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Python's own furniture. Same bias toward TRUE as the other lists: a missed violation is a bad day, a
 * false stop on `str` is an unusable tool. `typing` is included wholesale because a signature naming
 * `Optional[int]` is not naming a type anybody designed.
 */
const PY_BUILTIN = new Set([
  'str', 'int', 'float', 'bool', 'bytes', 'bytearray', 'complex', 'object', 'type', 'None', 'NoneType',
  'list', 'dict', 'set', 'frozenset', 'tuple', 'range', 'slice', 'memoryview', 'property', 'super',
  'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'AttributeError',
  'RuntimeError', 'NotImplementedError', 'StopIteration', 'OSError', 'IOError', 'ImportError',
  'Any', 'Optional', 'Union', 'List', 'Dict', 'Set', 'Tuple', 'FrozenSet', 'Callable', 'Iterable',
  'Iterator', 'Generator', 'Sequence', 'Mapping', 'MutableMapping', 'Awaitable', 'Coroutine', 'Literal',
  'Final', 'ClassVar', 'TypeVar', 'Generic', 'Protocol', 'NamedTuple', 'TypedDict', 'Self', 'Never',
]);

/** The standard library is the platform, exactly as the BCL is for C# and node: builtins for TS. */
const PY_STDLIB = new Set([
  'abc', 'argparse', 'ast', 'asyncio', 'base64', 'bisect', 'builtins', 'collections', 'contextlib',
  'copy', 'csv', 'dataclasses', 'datetime', 'decimal', 'difflib', 'enum', 'errno', 'functools', 'gc',
  'glob', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'importlib', 'inspect', 'io', 'itertools',
  'json', 'logging', 'math', 'mmap', 'multiprocessing', 'operator', 'os', 'pathlib', 'pickle', 'platform',
  'pprint', 'queue', 're', 'random', 'shutil', 'signal', 'socket', 'sqlite3', 'ssl', 'stat', 'string',
  'struct', 'subprocess', 'sys', 'tempfile', 'textwrap', 'threading', 'time', 'timeit', 'tokenize',
  'traceback', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'warnings', 'weakref',
  'xml', 'zipfile', 'zlib', '__future__',
]);

const MANIFESTS = ['pyproject.toml', 'requirements.txt', 'setup.cfg', 'setup.py'];

function findManifest(from: string): string | null {
  let dir = dirname(from);
  for (;;) {
    for (const m of MANIFESTS) {
      const p = join(dir, m);
      if (existsSync(p)) return p;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** A requirement line or array entry → the distribution name. `requests>=2.0 ; python<"3.9"` → `requests`. */
function distName(spec: string): string {
  return spec.trim().replace(/^["']|["']$/g, '').split(/[<>=!~;\[\s]/)[0].trim();
}

export const python: SurfaceLanguage = {
  id: 'python',

  handles(path) {
    // `.pyi` is a stub: declarations with no bodies, the analogue of `.d.ts`, and excluded for the same
    // reason — a corpus answering questions from stubs describes the shape and never the behaviour.
    return /\.pyw?$/.test(path);
  },

  domainOf(path) {
    const manifest = findManifest(path);
    if (!manifest) return null;
    try {
      const text = readFileSync(manifest, 'utf-8');
      const name = basenameOfProject(text, manifest);
      let allows: string[] = [];
      if (manifest.endsWith('requirements.txt')) {
        allows = text.split('\n').map((l) => l.replace(/#.*$/, ''))
          .filter((l) => l.trim() && !l.trim().startsWith('-')).map(distName).filter(Boolean);
      } else if (manifest.endsWith('pyproject.toml')) {
        // PEP 621 `dependencies = [...]` and poetry's `[tool.poetry.dependencies]` table. A light parse,
        // deliberately: a TOML dependency is not worth a dependency.
        const arr = /(?:^|\n)\s*dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? '';
        allows = arr.split(',').map(distName).filter(Boolean);
        const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1] ?? '';
        for (const line of poetry.split('\n')) {
          const k = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1];
          if (k && k.toLowerCase() !== 'python') allows.push(k);
        }
      } else {
        // setup.py / setup.cfg: the dependencies are in code or in a format not worth guessing at.
        // Null rather than a sealed-looking Domain — see the header.
        return null;
      }
      return { name, manifest, allows, sealed: allows.length === 0 };
    } catch {
      return null;
    }
  },

  surfaceOf(source) {
    const types: DeclaredType[] = [];
    let current: DeclaredType | null = null;
    let classIndent = -1;
    let memberIndent = -1;
    for (const raw of source.split('\n')) {
      if (!raw.trim() || /^\s*#/.test(raw)) continue;
      const line = raw.replace(/\s+#.*$/, '');
      const cls = CLASS.exec(line);
      if (cls?.groups) {
        const bases = cls.groups.bases ?? '';
        // A Protocol or an ABC is an interface by any other name — the same call typescript.ts makes
        // for `type X = {...}`, and for the same reason: ignoring it leaves the biggest hole.
        const kind: TypeKind = /\b(Protocol|ABC|ABCMeta)\b/.test(bases) ? 'interface' : 'class';
        current = { name: cls.groups.name, kind, members: [] };
        types.push(current);
        classIndent = cls.groups.indent.length;
        memberIndent = -1;
        continue;
      }
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (current && indent <= classIndent) { current = null; classIndent = -1; memberIndent = -1; }
      if (current) {
        const m = MEMBER.exec(line);
        if (m?.groups) {
          const at = m.groups.indent.length;
          // The first member seen fixes the body's indent; anything deeper is a nested def or a
          // statement inside a method, which is not surface.
          if (memberIndent < 0) memberIndent = at;
          if (at === memberIndent) {
            const nm = m.groups.fn ?? m.groups.attr;
            const kind: DeclaredMember['kind'] = m.groups.fn ? 'method' : 'field';
            current.members.push({ name: nm, kind, visibility: visibilityOf(nm), sig: line.trim() });
          }
        }
        continue;
      }
      // A module-level function is a declaration in its own right: `requests.get` is the API, and a
      // surface that reported only classes would miss most of what a Python module offers.
      const fn = FUNC.exec(line);
      if (fn?.groups) {
        types.push({ name: fn.groups.name, kind: 'class', members: [] });
      }
    }
    return types;
  },

  isPlatform(ref) {
    return PY_STDLIB.has(ref);
  },

  isBuiltinType(name) {
    return PY_BUILTIN.has(name);
  },

  referencesOf(source) {
    const out = new Set<string>();
    const add = (spec: string): void => {
      const top = spec.split('.')[0].trim();
      if (!top) return;          // a relative `from . import x` — inside the package, its own business
      out.add(top);
    };
    for (const m of source.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)/gm)) add(m[1]);
    for (const m of source.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm)) add(m[1]);
    return [...out];
  },
};

function visibilityOf(name: string): Visibility {
  if (name.startsWith('__') && !name.endsWith('__')) return 'private'; // name-mangled by the runtime
  if (name.startsWith('_')) return 'protected';                        // protected by agreement
  return 'public';
}

/** The project's name, when the manifest states one; the directory otherwise. */
function basenameOfProject(text: string, manifest: string): string {
  const named = /(?:^|\n)\s*name\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
  return named ?? dirname(manifest);
}
