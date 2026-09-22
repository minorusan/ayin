/**
 * Rust surfaces, and `Cargo.toml` as the dependency unit.
 *
 * WHAT "TYPE" MEANS HERE. `struct`/`enum`/`trait` declare a SHAPE; the methods live in one or more
 * separate `impl Type { ... }` / `impl Trait for Type { ... }` blocks, possibly several per type,
 * possibly in another file entirely. This file MERGES every `impl` block for a given name, found
 * anywhere in the source it is handed, into ONE `DeclaredType` — a model reading the skeleton wants
 * "everything `Graph` can do" in one place, the way a C# partial class already reads as one type despite
 * being split across files. The cost, paid deliberately: two different trait impls that both name a
 * method `fmt` (a real, common shape — `Display` and `Debug` on the same struct) collapse into two
 * same-named members on one type, and `expand_method`'s disambiguation-by-class-name cannot tell them
 * apart. That case is rare, and refusing with both candidates listed (which is what happens) is still
 * the safe failure — a wrong body handed over silently would be worse. A struct whose `impl` lives in a
 * file this parser never sees gets the same honest placeholder Go's cross-file receivers get: real
 * methods, real ranges, a guessed `kind` because nothing here can otherwise say what the name refers to.
 *
 * ENDLINE, THREE WAYS TO CLOSE. A brace-bodied item (`struct Foo { ... }`, any `impl`, any `fn` with a
 * body) ends at its matching `}`. A tuple or unit struct (`pub struct InputCellId();`, a real line in
 * this codebase's own test material) has no `{` at all and ends at its `;`. A trait method may be
 * either — a default body, or a bare signature ending in `;` — so both trait members and struct/enum
 * declarations are resolved with the same paren/bracket-aware scan used for Go, extended to prefer
 * whichever terminator (`{` or top-level `;`) comes first.
 *
 * TWO TRAPS THIS FILE IS WRITTEN AGAINST, both real Rust, neither hypothetical:
 *
 * 1. BLOCK COMMENTS NEST IN RUST — unlike C, C#, Go or JS. A block comment containing a second,
 *    complete block comment inside it is still ONE comment in Rust; a scanner that closes on the first
 *    close-marker it sees ends early, un-blanking real comment text (harmless) but worse, RE-ENTERING
 *    code mode while still logically inside a comment, so the next stray brace in that prose starts
 *    counting as a real one. A depth counter, incremented on every open marker and decremented on
 *    every close marker regardless of nesting, is required — a single boolean "in a comment" flag is
 *    wrong for this language specifically.
 *
 * 2. A CHARACTER LITERAL AND A LIFETIME START THE SAME WAY. A char literal (`'x'`, an escape like
 *    `'\n'`, or a unicode escape) and a lifetime (`'a`, `'static`, as in `&'a str`) both begin with a
 *    single quote, and a lifetime is not a string-like token at all — treating it as one opens a quote
 *    that never legitimately closes, which is exactly the failure mode that dropped 32 of 75 methods in
 *    the Python case this project keeps in its memory. So a quote only starts "char mode" when what
 *    follows is UNAMBIGUOUSLY a closed char literal; anything else is read as a lifetime and the quote
 *    passes through as an ordinary character, which cannot desync anything downstream because a
 *    lifetime carries no braces.
 *
 * Raw strings — an `r` or `br` prefix, zero or more `#` marks, then a quote — are handled by matching
 * the exact number of `#` marks back on close; a wrong count either over- or under-runs the literal.
 *
 * KNOWN GAP, STATED RATHER THAN HIDDEN: a field or enum-variant that WRAPS onto its own line — a tuple
 * variant's payload type alone on the next line, or a generic field type broken at an internal comma —
 * is scanned line-by-line with no depth tracking of its own (unlike a method, which is protected by
 * jumping straight to its computed `endLine`). A wrapped continuation line can therefore surface as a
 * spurious extra member. This never produces a WRONG `line`/`endLine` on anything real — fields and
 * variants never carry an `endLine` in the first place, so there is nothing for `expand_method` to act
 * on incorrectly — only, rarely, one extra name in a field/variant list. Fixing it properly needs
 * angle-bracket-aware depth tracking (a bare paren/brace counter misreads `HashMap<String, String>`'s
 * internal comma as a field boundary), which was judged not worth the added surface for a cosmetic gap
 * with no expand_method-facing consequence.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeclaredMember, DeclaredType, Domain, SurfaceLanguage, TypeKind, Visibility } from '../types.js';

const ITEM_DECL = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?<kind>struct|enum|trait)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/;
const FIELD = /^\s*(?<vis>pub(?:\([^)]*\))?)?\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?<type>.+)$/;
const VARIANT = /^\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?:[({,]|$)/;
const FN_DECL = /^\s*(?<vis>pub(?:\([^)]*\))?)?\s*(?:default\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/;

const RUST_BUILTIN = new Set([
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'f32', 'f64', 'bool', 'char', 'str', 'Self',
  'String', 'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'RefCell', 'Cell', 'Cow',
  'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'VecDeque', 'PhantomData',
]);

/** The standard-library crates — never a Cargo dependency, always available. */
const RUST_STD = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);

/**
 * Blank comments/strings/chars to spaces, preserving every line and column, so nothing downstream ever
 * counts a brace that lived only in prose or a string. See the header for the two traps this guards.
 */
function clean(source: string): string[] {
  let out = '';
  let i = 0;
  const n = source.length;
  let state: 'normal' | 'line' | 'block' | 'string' | 'raw' = 'normal';
  let blockDepth = 0;
  let rawHashes = 0;
  while (i < n) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    if (state === 'normal') {
      if (two === '//') { state = 'line'; out += '  '; i += 2; continue; }
      if (two === '/*') { state = 'block'; blockDepth = 1; out += '  '; i += 2; continue; }
      const raw = /^b?r(#*)"/.exec(source.slice(i, i + 32));
      if (raw) {
        rawHashes = raw[1].length;
        state = 'raw';
        out += ' '.repeat(raw[0].length);
        i += raw[0].length;
        continue;
      }
      if (ch === '"' || two === 'b"') {
        const len = ch === '"' ? 1 : 2;
        state = 'string';
        out += ' '.repeat(len);
        i += len;
        continue;
      }
      if (ch === "'") {
        // A char literal only when unambiguously closed right here; otherwise a lifetime — see header.
        let closeAt = -1;
        if (source[i + 1] === '\\') {
          const m = /^\\u\{[0-9a-fA-F]+\}'|^\\.'/.exec(source.slice(i + 1));
          if (m) closeAt = i + 1 + m[0].length;
        } else if (source[i + 2] === "'") {
          closeAt = i + 3;
        }
        if (closeAt > 0) { out += ' '.repeat(closeAt - i); i = closeAt; continue; }
        out += ch; i++; continue; // lifetime — leave it as an ordinary character
      }
      out += ch; i++; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'normal'; out += ch; i++; continue; }
      out += ' '; i++; continue;
    }
    if (state === 'block') {
      if (two === '/*') { blockDepth++; out += '  '; i += 2; continue; }
      if (two === '*/') { blockDepth--; out += '  '; i += 2; if (blockDepth === 0) state = 'normal'; continue; }
      out += ch === '\n' ? '\n' : ' '; i++; continue;
    }
    if (state === 'string') {
      if (ch === '\\') { out += (source[i + 1] === '\n' ? ' \n' : '  '); i += 2; continue; }
      if (ch === '"') { state = 'normal'; out += ' '; i++; continue; }
      out += ch === '\n' ? '\n' : ' '; i++; continue;
    }
    // raw string — no escapes exist inside one; only the matching `"` + same hash count closes it.
    if (ch === '"' && source.slice(i + 1, i + 1 + rawHashes) === '#'.repeat(rawHashes)) {
      state = 'normal';
      out += ' '.repeat(1 + rawHashes);
      i += 1 + rawHashes;
      continue;
    }
    out += ch === '\n' ? '\n' : ' '; i++;
  }
  return out.split('\n');
}

/**
 * From an item's own declaration line, find where it ends: the matching `}` of the first `{` opened at
 * paren/bracket depth 0, or — for a tuple/unit struct, a trait method with no default body, a `type`
 * alias — the top-level `;` reached first instead. Returns null, never a guess, if the file runs out.
 */
function findItemEnd(lines: string[], startLine: number): number | null {
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
      } else if (!openedBrace && ch === ';' && parenDepth === 0 && bracketDepth === 0) {
        return li + 1;
      }
    }
  }
  return null;
}

function visibilityOf(vis: string | undefined): Visibility {
  if (!vis) return 'private'; // Rust's default, unlike TS
  if (vis === 'pub') return 'public';
  return 'internal'; // pub(crate) / pub(super) / pub(in path) — visible, but not to the world
}

/**
 * `impl<T: Clone> Trait<T> for Bar<T>` — parsed by hand rather than one regex, because the leading
 * generic parameter list can itself contain `<>` (a bound like `Iterator<Item = U>`) and a single
 * non-nesting `<[^>]*>` would close on the FIRST `>`, well before the real one.
 */
function parseImplHeader(line: string): { name: string } | null {
  const head = /^\s*impl\b(.*)$/.exec(line);
  if (!head) return null;
  let rest = head[1].replace(/^\s*/, '');
  if (rest.startsWith('<')) {
    let depth = 0;
    let i = 0;
    for (; i < rest.length; i++) {
      if (rest[i] === '<') depth++;
      else if (rest[i] === '>') { depth--; if (depth === 0) { i++; break; } }
    }
    rest = rest.slice(i).trim();
  }
  const braceAt = rest.indexOf('{');
  const whereAt = rest.search(/\bwhere\b/);
  const cut = [braceAt, whereAt].filter((x) => x >= 0);
  const header = (cut.length ? rest.slice(0, Math.min(...cut)) : rest).trim();
  const forMatch = /^[A-Za-z_][\w:<>, ]*?\bfor\s+(?<name>[A-Za-z_][\w:]*)/.exec(header);
  if (forMatch?.groups) return { name: forMatch.groups.name.split('::').pop() ?? forMatch.groups.name };
  const bare = /^(?<name>[A-Za-z_][\w:]*)/.exec(header);
  return bare?.groups ? { name: bare.groups.name.split('::').pop() ?? bare.groups.name } : null;
}

function findManifest(from: string): string | null {
  let dir = dirname(from);
  for (;;) {
    const p = join(dir, 'Cargo.toml');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** `[package] name = "..."`, plus every key under `[dependencies]` and `[dev-dependencies]`. */
function readCargo(text: string): { name: string; deps: string[] } {
  const stripped = text.replace(/#.*$/gm, '');
  const name = /\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m.exec(stripped)?.[1] ?? '';
  const deps: string[] = [];
  for (const section of ['dependencies', 'dev-dependencies']) {
    const body = new RegExp(`(?:^|\\n)\\[${section}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(stripped)?.[1] ?? '';
    for (const m of body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) deps.push(m[1]);
  }
  return { name, deps };
}

export const rust: SurfaceLanguage = {
  id: 'rust',

  handles(path) {
    return path.endsWith('.rs');
  },

  domainOf(path) {
    const manifest = findManifest(path);
    if (!manifest) return null;
    try {
      const { name, deps } = readCargo(readFileSync(manifest, 'utf-8'));
      return {
        name: name || dirname(manifest),
        manifest,
        allows: deps,
        // Same convention as every other manifest here: no declared dependency at all is this
        // ecosystem's sealed unit.
        sealed: deps.length === 0,
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

    // Pass 1 — struct/enum/trait headers and their directly-declared members (fields, variants, or —
    // for a trait — method signatures, which may or may not carry a default body).
    for (let i = 0; i < lines.length; i++) {
      const d = ITEM_DECL.exec(lines[i]);
      if (!d?.groups) continue;
      const kind: TypeKind = d.groups.kind === 'trait' ? 'interface' : d.groups.kind === 'enum' ? 'enum' : 'struct';
      const t = getOrCreate(d.groups.name, kind);
      t.kind = kind;
      t.line = i + 1;
      const end = findItemEnd(lines, i);
      // A tuple/unit struct (`struct Id();`, `struct Marker;`) has no field/variant body to scan —
      // its own line IS its whole declaration, and there is nothing between it and `end` to read.
      if (end === null || !lines[i].includes('{')) continue;
      for (let bi = i + 1; bi < end - 1; bi++) {
        const line = lines[bi];
        if (kind === 'interface') {
          const f = FN_DECL.exec(line);
          if (f?.groups) {
            const fEnd = findItemEnd(lines, bi) ?? bi + 1;
            t.members.push({
              // A trait method is exactly as visible as the trait — Rust forbids writing `pub` on one.
              name: f.groups.name, kind: 'method', visibility: 'public',
              sig: line.trim(), line: bi + 1, endLine: fEnd,
            });
            bi = fEnd - 1; // loop's ++ lands exactly on the line after this member
            continue;
          }
        } else if (kind === 'enum') {
          const v = VARIANT.exec(line);
          if (v?.groups) {
            t.members.push({ name: v.groups.name, kind: 'field', visibility: 'public', sig: line.trim(), line: bi + 1 });
          }
        } else {
          const fld = FIELD.exec(line);
          if (fld?.groups) {
            t.members.push({
              name: fld.groups.name, kind: 'field', visibility: visibilityOf(fld.groups.vis), sig: line.trim(), line: bi + 1,
            });
          }
        }
      }
    }

    // Pass 2 — every `impl` block, merged onto its type by name (see header). Scanned independently of
    // pass 1 so an impl anywhere in the file — not only right after its type — is found, and bounded to
    // its own range so a nested local `impl`/`fn` inside a method body is attributed to ITSELF, not
    // folded into the outer one.
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*impl\b/.test(lines[i])) continue;
      const header = parseImplHeader(lines[i]);
      if (!header) continue;
      const end = findItemEnd(lines, i);
      if (end === null) continue;
      // Placeholder default mirrors Go's: the real base could be a struct or an enum, and nothing in
      // an impl block alone can tell them apart when the type itself is declared elsewhere.
      const t = getOrCreate(header.name, 'struct');
      for (let bi = i + 1; bi < end - 1; bi++) {
        const f = FN_DECL.exec(lines[bi]);
        if (!f?.groups) continue;
        const fEnd = findItemEnd(lines, bi) ?? bi + 1;
        t.members.push({
          name: f.groups.name, kind: 'method', visibility: visibilityOf(f.groups.vis),
          sig: lines[bi].trim(), line: bi + 1, endLine: fEnd,
        });
        bi = fEnd - 1;
      }
    }

    return types;
  },

  isPlatform(ref) {
    return RUST_STD.has(ref);
  },

  isBuiltinType(name) {
    return RUST_BUILTIN.has(name);
  },

  referencesOf(source) {
    const out = new Set<string>();
    const stripped = source.replace(/\/\/.*$/gm, '');
    // The crate root is everything before the FIRST `::` or `{` — true regardless of how the rest of
    // the path is grouped, because every entry inside `a::{b, c::d}` shares `a` as its root by Rust's
    // own grammar. Splitting on commas first and re-deriving each part's root independently (the
    // earlier version of this function) loses that shared prefix: `serde::{Deserialize, Serialize}`
    // read `Serialize` back as its OWN crate, a phantom reference to something that was never imported.
    const addRoot = (path: string): void => {
      const top = path.trim().split(/::|\{/)[0]?.trim() ?? '';
      if (!top || top === 'crate' || top === 'self' || top === 'super') return;
      out.add(top);
    };
    for (const m of stripped.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm)) {
      const body = m[1].trim();
      if (body.startsWith('{')) {
        // A top-level group with no shared prefix at all (`use {std::fmt, serde::Serialize};`) — rare,
        // but each entry here genuinely carries its own root.
        for (const part of body.replace(/^\{|\}$/g, '').split(',')) addRoot(part);
      } else {
        addRoot(body);
      }
    }
    for (const m of stripped.matchAll(/^\s*extern\s+crate\s+([A-Za-z0-9_]+)/gm)) addRoot(m[1]);
    return [...out];
  },
};
