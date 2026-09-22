/**
 * Go surfaces, and `go.mod` as the dependency unit.
 *
 * WHAT "TYPE" MEANS HERE. Go has no classes: a struct is a field list, and its methods are free
 * functions carrying a RECEIVER — `func (r *Reader) Read(p []byte) (int, error)` — that can live in any
 * file of the package, including ones this parser never sees. So `surfaceOf` is honest per FILE, not per
 * package: a struct declared here gets its `line`; a method whose receiver names a struct declared
 * ELSEWHERE still gets recorded (line, endLine, signature all real — they are read directly out of THIS
 * file), attached to a same-named placeholder `DeclaredType` this file cannot label with certainty, so it
 * defaults to `struct` — the overwhelmingly common receiver kind, and the one place this parser guesses
 * rather than knows. A package-level function with no receiver is its own surface, one type standing for
 * itself with one member — the same move `python.ts` makes for a module-level `def`, for the same reason:
 * `DeclaredType` has no bare "function" concept, and a function with no container still has to point
 * somewhere.
 *
 * `type X interface { ... }` is a surface in its own right — a set of signatures with no bodies, ever,
 * regardless of which file implements them.
 *
 * ENDLINE, NOT NET-BRACE-PER-LINE. `csharp.ts`/`typescript.ts` track a running depth and compare it
 * against the type's depth once per line, which silently mis-fires on a one-line body (open and close
 * brace on the SAME line, net change zero) — exactly the shape of `func (c Impl1) Lines() int { return
 * c.lines }`, a real, common Go idiom for one-line accessors. So `findBodyEnd` below walks
 * CHARACTER BY CHARACTER from the declaration, tracking paren/bracket depth so it does not mistake a
 * brace inside an inline anonymous-struct parameter (`func f(x struct{ A int })`) for the function's own
 * body opener, and returns the line the matching `}` (or, for a body-less declaration, the closing `;`-
 * equivalent — Go has none, so a Go interface method ends at the line its own signature balances).
 *
 * THE TRAP THIS FILE WAS WRITTEN AGAINST. Go raw strings are backtick-delimited and routinely carry
 * literal braces (a JSON example, a regex, a struct tag) with no escaping at all; a byte-count-blind scan
 * that treats backtick content as code would open or close a body on a character that was never Go syntax.
 * Line comments and block comments carry the same risk more mundanely — a stray brace mentioned in prose
 * two lines above a real function. All three are stripped to blanks — preserving line and column count,
 * never collapsing lines — before a single brace is counted.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeclaredMember, DeclaredType, Domain, SurfaceLanguage, TypeKind, Visibility } from '../types.js';

/** `type Name struct {` / `type Name interface {` — Go always puts the brace on this same line. */
const TYPE_DECL = /^\s*type\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s+(?<kind>struct|interface)\b/;

/** `func (r *Reader) Read(p []byte) (int, error) {` or `func New() Reactor {`. */
const FUNC_DECL = /^\s*func\s+(?:\((?<recv>[^()]*)\)\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\(/;

/** An interface's method signature — no body, ever: `Value() int`, `CreateInput(int) InputCell`. */
const IFACE_METHOD = /^\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/** `lines, characters, letters int` — one or more comma-separated names sharing a type. */
const FIELD_NAMED = /^\s*(?<names>[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+(?<type>\S.*?)\s*$/;
/** An embedded field: the type IS the (implicit) field name — `io.Reader`, `*sync.Mutex`. */
const FIELD_EMBED = /^\s*(?<embed>\*?[A-Za-z_][A-Za-z0-9_.]*(?:\[[^\]]*\])?)\s*$/;

const GO_BUILTIN = new Set([
  'string', 'bool', 'byte', 'rune', 'error', 'any', 'comparable',
  'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
]);

/**
 * Strip `//`, `/* *​/` and backtick raw strings to blanks, character by character, keeping every line
 * and column in place. Quoted strings (`"..."`) and rune literals (`'...'`) cannot legally contain a raw
 * newline in Go, so they are reset defensively at end-of-line rather than allowed to swallow the rest of
 * the file the way the Python docstring bug did — an unterminated quote here is a malformed file, not a
 * license to keep consuming it.
 */
function clean(source: string): string[] {
  const lines = source.split('\n');
  const out: string[] = [];
  let state: 'normal' | 'line' | 'block' | 'string' | 'raw' | 'rune' = 'normal';
  for (const rawLine of lines) {
    if (state === 'line') state = 'normal';
    let buf = '';
    let i = 0;
    while (i < rawLine.length) {
      const ch = rawLine[i];
      const two = rawLine.slice(i, i + 2);
      if (state === 'normal') {
        if (two === '//') { state = 'line'; buf += '  '; i += 2; continue; }
        if (two === '/*') { state = 'block'; buf += '  '; i += 2; continue; }
        if (ch === '"') { state = 'string'; buf += ' '; i++; continue; }
        if (ch === '`') { state = 'raw'; buf += ' '; i++; continue; }
        if (ch === "'") { state = 'rune'; buf += ' '; i++; continue; }
        buf += ch; i++; continue;
      }
      if (state === 'line') { buf += ' '; i++; continue; }
      if (state === 'block') {
        if (two === '*/') { state = 'normal'; buf += '  '; i += 2; continue; }
        buf += ' '; i++; continue;
      }
      if (state === 'string' || state === 'rune') {
        const closeCh = state === 'string' ? '"' : "'";
        if (ch === '\\') { buf += '  '; i += 2; continue; }
        if (ch === closeCh) { state = 'normal'; buf += ' '; i++; continue; }
        buf += ' '; i++; continue;
      }
      // raw string: only a backtick ends it — no escapes exist inside one.
      if (ch === '`') { state = 'normal'; buf += ' '; i++; continue; }
      buf += ' '; i++;
    }
    out.push(buf);
    if (state === 'string' || state === 'rune') state = 'normal';
  }
  return out;
}

/**
 * From a declaration's own line, find where it ends.
 *
 * `'brace'` — a struct/interface/func body: walk to the matching `}` of the first `{` opened at
 * paren/bracket depth 0 (so a `struct{...}` anonymous-typed parameter cannot be mistaken for the real
 * body). Returns null — never a guess — if the file runs out first.
 *
 * `'signatureLine'` — a Go interface method has no body and no terminator token; its declaration is
 * simply done once its own parens/brackets balance and the line holding the close is exhausted.
 */
function findBodyEnd(lines: string[], startLine: number, mode: 'brace' | 'signatureLine'): number | null {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let openedBrace = false;
  for (let li = startLine; li < lines.length; li++) {
    const line = lines[li];
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === '{' && parenDepth === 0 && bracketDepth === 0) { braceDepth++; openedBrace = true; }
      else if (ch === '}' && parenDepth === 0 && bracketDepth === 0) {
        braceDepth--;
        if (openedBrace && braceDepth === 0) return li + 1;
      }
    }
    if (mode === 'signatureLine' && !openedBrace && parenDepth === 0 && bracketDepth === 0 && line.trim()) {
      return li + 1;
    }
  }
  return null;
}

/** The name a receiver binds to: `c *Impl1` -> `Impl1`, `r reactor` -> `reactor`, generics stripped. */
function receiverTypeName(recv: string): string {
  const last = recv.trim().split(/\s+/).pop() ?? '';
  return last.replace(/^\*/, '').replace(/\[.*\]$/, '');
}

function visibilityOf(name: string): Visibility {
  return /^[A-Z]/.test(name) ? 'public' : 'private'; // Go's whole visibility system, in one rule
}

function findGoMod(from: string): string | null {
  let dir = dirname(from);
  for (;;) {
    const p = join(dir, 'go.mod');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** `module` and every `require`d path, single-line or the `require (...)` block form. */
function parseGoMod(rawText: string): { module: string; requires: string[] } {
  const text = rawText.replace(/\/\/.*$/gm, ''); // trailing `// indirect` etc.
  const module = /^\s*module\s+(\S+)/m.exec(text)?.[1] ?? '';
  const requires: string[] = [];
  for (const m of text.matchAll(/^\s*require\s+(\S+)\s+\S+\s*$/gm)) requires.push(m[1]);
  const block = /require\s*\(([\s\S]*?)\)/.exec(text)?.[1] ?? '';
  for (const raw of block.split('\n')) {
    const m = /^\s*(\S+)\s+\S+/.exec(raw);
    if (m) requires.push(m[1]);
  }
  return { module, requires };
}

export const go: SurfaceLanguage = {
  id: 'go',

  handles(path) {
    return path.endsWith('.go');
  },

  domainOf(path) {
    const manifest = findGoMod(path);
    if (!manifest) return null;
    try {
      const { module, requires } = parseGoMod(readFileSync(manifest, 'utf-8'));
      return {
        name: module || dirname(manifest),
        manifest,
        allows: requires,
        // Same convention as the TS/Dart manifests: zero required modules is this ecosystem's sealed
        // unit — every symbol the file can reach is either its own package or the standard library.
        sealed: requires.length === 0,
      };
    } catch {
      return null;
    }
  },

  surfaceOf(source) {
    const lines = clean(source);
    const types: DeclaredType[] = [];
    const byName = new Map<string, DeclaredType>();
    const getOrCreate = (name: string, kind: TypeKind): DeclaredType => {
      const existing = byName.get(name);
      if (existing) return existing;
      const t: DeclaredType = { name, kind, members: [] };
      byName.set(name, t);
      types.push(t);
      return t;
    };

    // Pass 1 — struct/interface headers, and their directly-declared members.
    for (let i = 0; i < lines.length; i++) {
      const d = TYPE_DECL.exec(lines[i]);
      if (!d?.groups) continue;
      const kind: TypeKind = d.groups.kind === 'interface' ? 'interface' : 'struct';
      const t = getOrCreate(d.groups.name, kind);
      t.kind = kind;
      t.line = i + 1;
      const end = findBodyEnd(lines, i, 'brace');
      if (end === null) continue; // truncated/malformed input — no interior to scan, no guess
      for (let bi = i + 1; bi < end - 1; ) {
        const line = lines[bi];
        if (kind === 'interface') {
          const m = IFACE_METHOD.exec(line);
          if (m?.groups) {
            const sigEnd = findBodyEnd(lines, bi, 'signatureLine') ?? bi + 1;
            t.members.push({
              name: m.groups.name, kind: 'method', visibility: 'public',
              sig: line.trim(), line: bi + 1, endLine: sigEnd,
            });
            bi = sigEnd; // skip the rest of a signature that wrapped across lines
            continue;
          }
        } else {
          const named = FIELD_NAMED.exec(line);
          if (named?.groups) {
            for (const nm of named.groups.names.split(',').map((s) => s.trim()).filter(Boolean)) {
              t.members.push({ name: nm, kind: 'field', visibility: visibilityOf(nm), sig: line.trim(), line: bi + 1 });
            }
          } else {
            const emb = FIELD_EMBED.exec(line);
            if (emb?.groups) {
              const nm = emb.groups.embed.replace(/^\*/, '').split('.').pop() ?? emb.groups.embed;
              t.members.push({ name: nm, kind: 'field', visibility: visibilityOf(nm), sig: line.trim(), line: bi + 1 });
            }
          }
        }
        bi++;
      }
    }

    // Pass 2 — every func: a receiver method attached to its (possibly not-here-declared) type, or a
    // package-level function standing for itself. Independent of pass 1's line-by-line depth so a
    // method declared anywhere in the file — not only right after its type — is found.
    for (let i = 0; i < lines.length; i++) {
      const f = FUNC_DECL.exec(lines[i]);
      if (!f?.groups) continue;
      const end = findBodyEnd(lines, i, 'brace');
      const member: DeclaredMember = {
        name: f.groups.name,
        kind: 'method',
        visibility: visibilityOf(f.groups.name),
        sig: lines[i].trim(),
        line: i + 1,
        // Honest per the contract: a body that never closed gets no endLine rather than a guessed one.
        ...(end !== null ? { endLine: end } : {}),
      };
      if (f.groups.recv) {
        // The receiver's type may be declared elsewhere in the package — this file only ever sees
        // ITS OWN lines, so a type not found above is a placeholder: real name, real method, a
        // guessed `kind` because `struct` is by far the common receiver base and nothing here can
        // tell it apart from a plain named type (`type Weight float64`) without reading the type's
        // own declaration, which may not be in this file at all.
        getOrCreate(receiverTypeName(f.groups.recv), 'struct').members.push(member);
      } else {
        types.push({ name: f.groups.name, kind: 'class', members: [member], line: i + 1 });
      }
    }

    return types;
  },

  /**
   * A Go module path is rooted at a domain name and therefore always contains a `.` in its first
   * segment (`github.com/x/y`); the standard library never does (`fmt`, `encoding/json`). That is the
   * real rule the toolchain itself uses to tell them apart — cheaper and less likely to go stale than a
   * hand-maintained list of package names, and it never needs updating when Go adds a package.
   */
  isPlatform(ref) {
    return !(ref.split('/')[0] ?? '').includes('.');
  },

  isBuiltinType(name) {
    return GO_BUILTIN.has(name);
  },

  referencesOf(source) {
    const out = new Set<string>();
    const stripped = source.replace(/\/\/.*$/gm, '');
    const block = /import\s*\(([\s\S]*?)\)/.exec(stripped)?.[1];
    if (block) {
      for (const m of block.matchAll(/"([^"]+)"/g)) out.add(m[1]);
    }
    for (const m of stripped.matchAll(/^\s*import\s+(?:[A-Za-z_][\w]*\s+|\.\s+|_\s+)?"([^"]+)"/gm)) out.add(m[1]);
    return [...out];
  },
};
