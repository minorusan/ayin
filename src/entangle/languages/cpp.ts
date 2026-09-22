/**
 * C++ surfaces, and CMakeLists.txt as the dependency unit.
 *
 * THE DESIGN CALL THIS FILE MAKES, STATED UP FRONT: a `.cpp` file's skeleton is the `.cpp`'s OWN
 * declarations, never the header it implements. Out-of-line definitions (`void Bankaccount::open() {}`,
 * the norm in real C++) declare a member of `Bankaccount` with no `class Bankaccount` anywhere in the
 * file, so this parser SYNTHESISES a `DeclaredType` for the qualifier the first time it sees one and
 * attaches every `Class::member` definition in the file to it. What that type never gets is a `line` (no
 * declaration of it exists here to point at — see `DeclaredMember`'s doc: absent is the honest answer,
 * a guessed header line would be worse) and its `kind` defaults to `class` even when the header actually
 * wrote `struct` — this file has not read the header and will not go looking for it. The cost, named
 * plainly: a model asking "what fields does this type have" from the .cpp alone gets nothing, because a
 * field is a header declaration, not a definition — it has to also read the header, exactly as a human
 * maintaining this codebase does. What the .cpp DOES answer honestly is "what does this class's code in
 * THIS file look like, and where", which is what was asked for.
 *
 * TEMPLATES, NAMESPACES, ACCESS LABELS. A `template <...>` line is folded into whatever declaration
 * follows it by the same multi-line accumulation java.ts uses — it has no brace of its own, so it never
 * needs special-casing beyond being tolerated as a prefix. `namespace ns { ... }` opens a stack frame
 * with NO `DeclaredType` (there is no `TypeKind` for a namespace, and nothing here treats one as a
 * design unit — the same call `csharp.ts` makes for C# namespaces) but the frame still has to exist so
 * the depth counter closes it correctly; a type nested inside is reported by its bare name, un-prefixed,
 * matching every other language file here. `public:`/`private:`/`protected:` are STATEMENTS that change
 * the default for everything after them until the next label or the class's own close — tracked as
 * mutable state on the innermost type frame, defaulting to `private` for `class` and `public` for
 * `struct`/`union` per the language's own rule.
 *
 * PREPROCESSOR CONDITIONALS ARE THE ACCEPTED GAP. `#include`/`#define`/`#pragma` lines are skipped
 * outright — they carry no braces in the normal case, so skipping them changes nothing else. But
 * `#ifdef X … #else … #endif` branches are NOT evaluated; both are scanned as if unconditional. A branch
 * that is individually brace-balanced costs nothing. A branch that opens a brace closed only in the
 * OTHER branch — a platform-specific partial body — defeats the depth counter exactly the way an
 * un-skipped Python docstring did, and there is no cheap fix: picking a branch requires knowing which
 * macros are defined, which this file does not evaluate and will not guess at. Named here rather than
 * discovered later.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeclaredMember, DeclaredType, Domain, SurfaceLanguage, TypeKind, Visibility } from '../types.js';

const TYPE_DECL = /^(?:template\s*<[^()]*>\s*)?(?<kind>class|struct|union|enum(?:\s+class)?)\s+(?<name>[A-Za-z_]\w*)/;

/**
 * `NS::Class<T>::method(...)` — the out-of-line form. `qual` is one-or-more `Name(<T>)?::` segments;
 * the LAST segment before the final `::` is the type this member belongs to. `rtype` is optional for the
 * same reason java.ts's is: `Bankaccount::Bankaccount()` (a constructor) has no return type, and only a
 * name directly abutting `::` with no separating space forces the engine to retry without one — the same
 * backtrack that tells a Java constructor from a method.
 */
const OUT_OF_LINE = /^(?:template\s*<[^()]*>\s*)?(?<mods>(?:(?:inline|static|virtual|explicit|constexpr|friend|extern)\s+)*)(?:(?<rtype>[A-Za-z_~][\w:<>,\*&\s]*?)\s+)?(?<qual>(?:[A-Za-z_]\w*(?:<[^()]*>)?::)+)(?<name>~?[A-Za-z_]\w*|operator\s*\S+)\s*\(/;

/** A method or constructor declared IN-CLASS — no `::`, which is what tells it apart from `OUT_OF_LINE`. */
const METHOD_OR_CTOR = /^(?:template\s*<[^()]*>\s*)?(?<mods>(?:(?:virtual|static|explicit|inline|constexpr|friend)\s+)*)(?:(?<rtype>[A-Za-z_~][\w:<>,\*&\s]*?)\s+)?(?<name>~?[A-Za-z_]\w*|operator\s*\S+)\s*\(/;

/** A field: type, name (optionally behind `*`/`&`), then `=`, `{` (brace-init), or `;`. */
const FIELD = /^(?<mods>(?:(?:static|mutable|const|constexpr|inline|extern)\s+)*)(?<ftype>[A-Za-z_][\w:<>,\[\]]*(?:\s*[A-Za-z_]\w*(?:<[^()]*>)?)*?)\s*[*&]*\s*(?<name>[A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*(?:=|\{|;|:)/;

const ACCESS_LABEL = /^(?<vis>public|private|protected)\s*:$/;
const NAMESPACE_DECL = /^(?:inline\s+)?namespace(?:\s+(?<name>[A-Za-z_]\w*))?\s*$/;

/**
 * Same bias as every other language file here: TRUE when unsure. Bare STL names are included alongside
 * their `std::` forms because `using namespace std;` — present in most of the real material this was
 * checked against — makes the bare form the common case, not the exception.
 */
const CPP_BUILTIN = new Set([
  'void', 'bool', 'char', 'char8_t', 'char16_t', 'char32_t', 'wchar_t', 'int', 'short', 'long', 'signed',
  'unsigned', 'float', 'double', 'auto', 'nullptr_t', 'size_t', 'ptrdiff_t', 'int8_t', 'int16_t', 'int32_t',
  'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'string', 'wstring', 'string_view', 'vector', 'array', 'map', 'unordered_map', 'multimap', 'set',
  'unordered_set', 'multiset', 'list', 'deque', 'queue', 'stack', 'priority_queue', 'pair', 'tuple',
  'optional', 'variant', 'any', 'function', 'shared_ptr', 'unique_ptr', 'weak_ptr', 'reference_wrapper',
  'initializer_list', 'iterator', 'ostream', 'istream', 'stringstream', 'ostringstream', 'istringstream',
  'exception', 'runtime_error', 'logic_error', 'invalid_argument', 'out_of_range', 'domain_error',
  'range_error', 'length_error', 'overflow_error', 'underflow_error', 'thread', 'mutex', 'lock_guard',
  'unique_lock', 'atomic', 'condition_variable', 'chrono', 'duration', 'time_point',
  'std', 'boost',
]);

function findManifest(from: string): string | null {
  let dir = dirname(from);
  for (;;) {
    const p = join(dir, 'CMakeLists.txt');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * `project(name ...)` for the unit's name, `find_package(Pkg ...)` and `target_link_libraries(... Lib
 * ...)` for what it may reference. CMakeLists.txt is a full scripting language — the same reason
 * python.ts refuses `setup.py` — so this is a light TEXTUAL extraction, not evaluation: a name built from
 * `${a_variable}` is read as-is (a literal `${exercise}` helps nobody, but pretending to resolve it would
 * be worse — it would need a CMake interpreter this is not). `target_link_libraries` keywords
 * (`PUBLIC`/`PRIVATE`/`INTERFACE`) and the target itself (`${exercise}`, matched by leading `$`) are
 * filtered out; `Pkg::Component` link names are cut at `::` since `find_package` states the bare name.
 */
function parseCMake(text: string): { name: string; allows: string[] } {
  const name = /\bproject\s*\(\s*([^\s)]+)/.exec(text)?.[1] ?? '';
  const allows = new Set<string>();
  for (const m of text.matchAll(/\bfind_package\s*\(\s*([A-Za-z_][\w.-]*)/g)) allows.add(m[1]);
  for (const m of text.matchAll(/\btarget_link_libraries\s*\(([^)]*)\)/gs)) {
    // The FIRST token is always the target being linked, never a dependency — `target_link_libraries(
    // widgets PRIVATE Boost::date_time)` names its own unit first, literally or via `${a_variable}`.
    const [target, ...rest] = m[1].trim().split(/\s+/);
    for (const tok of rest) {
      const t = tok.split('::')[0];
      if (!t || t === target || t.startsWith('$') || /^(PUBLIC|PRIVATE|INTERFACE)$/.test(t)) continue;
      if (/^[A-Za-z_][\w.-]*$/.test(t)) allows.add(t);
    }
  }
  return { name, allows: [...allows] };
}

/**
 * Comments, string/char literals AND raw strings blanked to whitespace of the same shape — the trap
 * named in the header doc, restated where it is actually fixed: a raw string `R"(...)"` holds literal
 * `{`/`"`/`\` with none of the escaping a plain string has, and is exactly the shape a JSON fixture or a
 * multi-line SQL/regex blob takes in real C++. `R"delim(...)delim"` (a custom delimiter, used to hold
 * text that itself contains `)"`) is honoured — the closing sequence is `)` + delim + `"`, computed per
 * literal rather than assumed to be bare `)"`.
 */
function scrub(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const two = c + (source[i + 1] ?? '');
    if (two === '//') {
      while (i < n && source[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (two === '/*') {
      out += '  '; i += 2;
      while (i < n && `${source[i]}${source[i + 1] ?? ''}` !== '*/') { out += source[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === 'R' && source[i + 1] === '"') {
      let j = i + 2;
      let delim = '';
      while (j < n && source[j] !== '(' && source[j] !== '"' && !/\s/.test(source[j])) { delim += source[j]; j++; }
      if (source[j] === '(') {
        const closer = `)${delim}"`;
        const end = source.indexOf(closer, j + 1);
        const stop = end === -1 ? n : end + closer.length;
        for (let p = i; p < stop; p++) out += source[p] === '\n' ? '\n' : ' ';
        i = stop;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += ' '; i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += ' '; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '<') depth++;
    else if (ch === ')' || ch === '>') depth--;
    if (ch === sep && depth <= 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** The type this qualifier's LAST segment names — `NS::Outer::Inner<T>::` → `Inner`. Earlier segments
 *  are namespace/outer-class path, dropped for the same reason csharp.ts never prefixes a namespace onto
 *  a type name: every consumer of `DeclaredType.name` here compares bare names. */
function classNameFromQualifier(qual: string): string {
  const parts = qual.replace(/::$/, '').split('::');
  return parts[parts.length - 1].replace(/<.*$/, '');
}

interface TypeFrame { kind: 'type'; type: DeclaredType; declDepth: number; defaultVis: Visibility; curVis: Visibility }
interface NsFrame { kind: 'namespace'; declDepth: number }
type Frame = TypeFrame | NsFrame;
interface Pending { rawBuf: string[]; scanBuf: string[]; start: number; templateDepth: number }
interface OpenBlock { member: DeclaredMember | null; closeAtDepth: number }

export const cpp: SurfaceLanguage = {
  id: 'cpp',

  handles(path) {
    return /\.(cpp|cc|cxx|c\+\+|h|hpp|hh|hxx|h\+\+)$/.test(path);
  },

  domainOf(path) {
    const manifest = findManifest(path);
    if (!manifest) return null;
    try {
      const { name, allows } = parseCMake(readFileSync(manifest, 'utf-8'));
      return { name: name || dirname(manifest), manifest, allows, sealed: allows.length === 0 };
    } catch {
      return null;
    }
  },

  surfaceOf(source) {
    const scanLines = scrub(source).split('\n');
    const rawLines = source.split('\n');
    const types: DeclaredType[] = [];
    const byName = new Map<string, DeclaredType>();
    const stack: Frame[] = [];
    let depth = 0;
    let pending: Pending | null = null;
    let openBlock: OpenBlock | null = null;

    const declType = (name: string, kind: TypeKind, line: number | undefined): DeclaredType => {
      const existing = byName.get(name);
      if (existing) return existing;
      const t: DeclaredType = { name, kind, members: [], line };
      types.push(t);
      byName.set(name, t);
      return t;
    };

    const inClass = (): TypeFrame | null => {
      const top = stack[stack.length - 1];
      return top?.kind === 'type' ? top : null;
    };
    const memberVisibility = (top: TypeFrame): Visibility => top.curVis;

    const resolveBodyOpening = (p: Pending, containerDepth: number): void => {
      const joined = p.scanBuf.join(' ');
      const raw = p.rawBuf.join(' ').replace(/\s+/g, ' ').trim();
      const t = TYPE_DECL.exec(joined);
      if (t?.groups) {
        const rawKind = t.groups.kind.replace(/\s+class$/, '');
        const kind: TypeKind = rawKind === 'union' ? 'struct' : (rawKind as TypeKind);
        const decl = declType(t.groups.name, kind, p.start);
        const defaultVis: Visibility = rawKind === 'class' ? 'private' : 'public';
        stack.push({ kind: 'type', type: decl, declDepth: containerDepth, defaultVis, curVis: defaultVis });
        return;
      }
      const ns = NAMESPACE_DECL.exec(joined);
      if (ns?.groups !== undefined || /^namespace\b/.test(joined)) {
        stack.push({ kind: 'namespace', declDepth: containerDepth });
        return;
      }
      const cls = inClass();
      if (!cls) {
        // Namespace or global scope: an out-of-line definition, or a free function/variable.
        const ool = OUT_OF_LINE.exec(joined);
        if (ool?.groups) {
          const className = classNameFromQualifier(ool.groups.qual);
          const decl = declType(className, 'class', undefined);
          const member: DeclaredMember = { name: ool.groups.name, kind: 'method', visibility: 'public', sig: raw, line: p.start };
          decl.members.push(member);
          openBlock = { member, closeAtDepth: containerDepth };
          return;
        }
        const fn = METHOD_OR_CTOR.exec(joined);
        if (fn?.groups) {
          // A free function is its OWN unit — the same self-referential trick python.ts uses for a
          // module-level `def`, so `expand_method` has a `Type.method` pair to look up even though
          // nothing here calls it a class.
          const decl = declType(fn.groups.name, 'class', undefined);
          const member: DeclaredMember = { name: fn.groups.name, kind: 'method', visibility: 'public', sig: raw, line: p.start };
          decl.members.push(member);
          openBlock = { member, closeAtDepth: containerDepth };
          return;
        }
        openBlock = { member: null, closeAtDepth: containerDepth };
        return;
      }
      // Inside a class/struct body.
      const mc = METHOD_OR_CTOR.exec(joined);
      if (mc?.groups) {
        const member: DeclaredMember = { name: mc.groups.name, kind: 'method', visibility: memberVisibility(cls), sig: raw, line: p.start };
        cls.type.members.push(member);
        openBlock = { member, closeAtDepth: containerDepth };
        return;
      }
      // A field whose initializer opens a block (an aggregate init, a lambda body) — recorded as a field
      // and handed to the shared depth tracker, which finds where the block actually closes without this
      // scanner needing to evaluate the expression. See java.ts for the identical call.
      const f = FIELD.exec(joined);
      if (f?.groups) {
        const member: DeclaredMember = { name: f.groups.name, kind: 'field', visibility: memberVisibility(cls), sig: raw, line: p.start };
        cls.type.members.push(member);
        openBlock = { member, closeAtDepth: containerDepth };
        return;
      }
      // A static/instance initializer-shaped block this scanner does not recognise — swallowed, not
      // guessed at.
      openBlock = { member: null, closeAtDepth: containerDepth };
    };

    const resolveSimpleStatement = (p: Pending, lineNo: number): void => {
      const joined = p.scanBuf.join(' ');
      const raw = p.rawBuf.join(' ').replace(/\s+/g, ' ').trim();
      const cls = inClass();
      if (!cls) {
        // `int modifier(int score);` (declaration only) or `Solution solve();` — a free-function
        // prototype at namespace scope carries no body, so it closes on the line it is fully read on.
        const fn = METHOD_OR_CTOR.exec(joined) ?? OUT_OF_LINE.exec(joined);
        if (fn?.groups) {
          const qual = (fn.groups as { qual?: string }).qual;
          const name = qual ? classNameFromQualifier(qual) : fn.groups.name;
          const decl = declType(name, 'class', undefined);
          decl.members.push({ name: fn.groups.name, kind: 'method', visibility: 'public', sig: raw, line: p.start, endLine: lineNo });
          return;
        }
        const f = FIELD.exec(joined);
        if (f?.groups) {
          const decl = declType(f.groups.name, 'class', undefined);
          decl.members.push({ name: f.groups.name, kind: 'field', visibility: 'public', sig: raw, line: p.start, endLine: lineNo });
        }
        return;
      }
      const mc = METHOD_OR_CTOR.exec(joined);
      if (mc?.groups) {
        cls.type.members.push({ name: mc.groups.name, kind: 'method', visibility: memberVisibility(cls), sig: raw, line: p.start, endLine: lineNo });
        return;
      }
      const f = FIELD.exec(joined);
      if (f?.groups) {
        cls.type.members.push({ name: f.groups.name, kind: 'field', visibility: memberVisibility(cls), sig: raw, line: p.start, endLine: lineNo });
      }
    };

    const handleEnumLine = (trimmedScan: string, trimmedRaw: string, lineNo: number, cls: TypeFrame, enumDone: { v: boolean }): void => {
      const scanParts = splitTopLevel(trimmedScan, ',');
      const rawParts = splitTopLevel(trimmedRaw, ',');
      scanParts.forEach((part, i) => {
        let p = part.trim();
        let raw = (rawParts[i] ?? part).trim();
        if (p.endsWith(';')) { p = p.slice(0, -1).trim(); raw = raw.replace(/;\s*$/, '').trim(); enumDone.v = true; }
        if (!p) return;
        const m = /^([A-Za-z_]\w*)/.exec(p);
        if (!m) return;
        cls.type.members.push({ name: m[1], kind: 'field', visibility: 'public', sig: raw, line: lineNo, endLine: lineNo });
      });
    };

    const enumState = new WeakMap<DeclaredType, { v: boolean }>();

    for (let idx = 0; idx < scanLines.length; idx++) {
      const lineNo = idx + 1;
      const scanLine = scanLines[idx];
      const rawLine = rawLines[idx] ?? '';
      const trimmed = scanLine.trim();
      const top = stack[stack.length - 1];
      const containerDepth = top ? top.declDepth + 1 : 0;

      if (openBlock === null && depth === containerDepth) {
        if (trimmed === '') { /* nothing */ }
        else if (trimmed.startsWith('#')) { /* preprocessor — see the header doc for the accepted gap */ }
        else if (pending === null && ACCESS_LABEL.test(trimmed)) {
          const cls = inClass();
          if (cls) cls.curVis = ACCESS_LABEL.exec(trimmed)!.groups!.vis as Visibility;
        }
        else if (pending === null && /^\}+[;,)]*$/.test(trimmed)) { /* the container's own close */ }
        else if (pending === null && inClass()?.type.kind === 'enum') {
          const cls = inClass()!;
          let st = enumState.get(cls.type);
          if (!st) { st = { v: false }; enumState.set(cls.type, st); }
          if (!st.v) handleEnumLine(trimmed, rawLine.trim(), lineNo, cls, st);
        } else {
          if (pending === null) pending = { rawBuf: [], scanBuf: [], start: -1, templateDepth: 0 };
          pending.rawBuf.push(rawLine.trim());
          pending.scanBuf.push(scanLine.trim());
          // `template <typename T>` — like an annotation on its own line in java.ts — is not where the
          // declaration IS, and its parameter list routinely wraps across lines (a defaulted template
          // parameter can itself contain nested `<...>`), so this tracks ANGLE-BRACKET depth across the
          // whole clause rather than requiring it to close on one line. `line` ends up on
          // `ValueType circular_buffer<...>::read()`, never on the clause above it — expand_method's own
          // sanity check (the range names the member) refuses a range that starts on a bare template line.
          if (pending.start === -1) {
            const t = scanLine.trim();
            const wasOpen = pending.templateDepth > 0;
            if (/^template\s*</.test(t)) {
              // The template line itself never sets `start`, whether its `<...>` closes on this same
              // line or not — either way the DECLARATION has not been seen yet. Re-checked on EVERY
              // line, not only the first: a member template inside a class template stacks two clauses
              // back to back (`template <typename T>` / `template <typename TParam, typename>` / the
              // actual signature), and the second is not `wasOpen` — the first already closed.
              pending.templateDepth = countChar(t, '<') - countChar(t, '>');
            } else if (wasOpen) {
              // Still inside a clause opened on an earlier line — this line only continues or closes it.
              pending.templateDepth += countChar(t, '<') - countChar(t, '>');
            } else {
              // No open clause (never had one, or it closed on a strictly earlier line) — this line is
              // the declaration itself.
              pending.start = lineNo;
            }
          }
          const joined = pending.scanBuf.join(' ');
          const parens = countChar(joined, '(') - countChar(joined, ')');
          if (parens === 0 && (joined.includes('{') || /;\s*$/.test(scanLine.trimEnd()))) {
            if (pending.start === -1) pending.start = lineNo; // defensive: every line so far was `template <...>` alone
            if (joined.includes('{')) { resolveBodyOpening(pending, containerDepth); pending = null; }
            else { resolveSimpleStatement(pending, lineNo); pending = null; }
          }
        }
      }

      depth += countChar(scanLine, '{') - countChar(scanLine, '}');

      // See java.ts for why this cast is load-bearing: TS narrows `openBlock` to `null` above and does
      // not widen it back after the closures reassign it, and a plain `openBlock !== null` here reports
      // "Property does not exist on type never".
      const closing = openBlock as OpenBlock | null;
      if (closing !== null && depth <= closing.closeAtDepth) {
        if (closing.member) closing.member.endLine = lineNo;
        openBlock = null;
      }
      while (stack.length && depth <= stack[stack.length - 1].declDepth) stack.pop();
    }
    return types;
  },

  /** Same precision choice as java.ts/python.ts: `this->x = ...` is unambiguous; a bare local write is
   *  not, and reporting it would say a method touches state it may not even have access to. */
  bodyFactsOf(bodyLines) {
    const assigns = new Set<string>();
    const calls = new Set<string>();
    let inBlockComment = false;
    for (const raw of bodyLines) {
      let line = raw;
      if (inBlockComment) {
        const end = line.indexOf('*/');
        if (end === -1) continue;
        line = line.slice(end + 2);
        inBlockComment = false;
      }
      line = line.replace(/\/\/.*$/, '');
      const start = line.indexOf('/*');
      if (start !== -1) {
        const end = line.indexOf('*/', start + 2);
        if (end === -1) { line = line.slice(0, start); inBlockComment = true; }
        else { line = line.slice(0, start) + line.slice(end + 2); }
      }
      const set = /^\s*this->(?<name>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:\[[^\]]*\])?\s*(?:[-+*/|&^%]|<<|>>)?=(?!=)/.exec(line);
      if (set?.groups) assigns.add(set.groups.name);
      for (const m of line.matchAll(/\b([A-Za-z_]\w*(?:(?:::|->|\.)[A-Za-z_]\w*)+)\s*\(/g)) calls.add(m[1]);
      for (const m of line.matchAll(/(?<![:.>\w])([A-Za-z_]\w*)\s*\(/g)) {
        // A bare call: skip C++ control-flow keywords, which read exactly like a call to this regex.
        if (!/^(if|for|while|switch|return|catch|sizeof|static_cast|dynamic_cast|const_cast|reinterpret_cast|new|delete)$/.test(m[1])) calls.add(m[1]);
      }
    }
    return { assigns: [...assigns], calls: [...calls] };
  },

  /** Angle-bracket includes with no path separator (`<vector>`, `<cstdio>`) are the standard library —
   *  never a chosen dependency. A small set of POSIX/OS directory prefixes is included for the same
   *  reason csharp.ts hardcodes `UnityEngine` as NOT platform in one direction and `System` as platform
   *  in the other: each ecosystem's own baseline, decided once here rather than by the shared rules. */
  isPlatform(ref) {
    if (!ref.includes('/') && !ref.includes('.')) return true;
    return /^(sys|arpa|netinet|bits)\//.test(ref);
  },

  isBuiltinType(name) {
    return CPP_BUILTIN.has(name);
  },

  /** Only ANGLE-BRACKET includes are references worth checking against a manifest — a quoted include
   *  (`"foo.h"`) is a relative path into the same unit, exactly as a relative import is the TS/Dart
   *  parsers' own business and never reaches `referencesOf`. */
  referencesOf(source) {
    const out = new Set<string>();
    for (const m of source.matchAll(/^\s*#\s*include\s*<([^>]+)>/gm)) out.add(m[1]);
    return [...out];
  },
};
