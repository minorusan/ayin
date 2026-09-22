/**
 * Ruby surfaces, and a Gemfile/gemspec as the dependency unit.
 *
 * THE CENTRAL PROBLEM: `end` closes a class, a module, a method, a `do` block, an `if`, an `unless`, a
 * `while`, an `until`, a `case`, a `begin` and a `for` — nine different openers share one closing word,
 * and Ruby has no brace to count instead. A scanner that only tracks `def`/`end` drifts the moment a
 * method contains a conditional or a block: the `end` that closes an inner `if` gets read as the one
 * closing the `def`, every method after it inherits the offset, and `expand_method` starts returning
 * confidently wrong bodies — which is worse than returning none (see `types.ts`). So this file keeps a
 * STACK of every opener, `if`/`do`/`case` included, and only a POP of a `def` frame ever writes an
 * `endLine`. Everything else on the stack exists purely to keep the count honest.
 *
 * THE SECOND PROBLEM, and the one that actually corrupts a real file: `end` is also just four letters,
 * and Ruby has more ways to hide four letters than most languages have ways to hide anything. A
 * `=begin`/`=end` block comment, a `<<~TAG` heredoc whose BODY is arbitrary prose until its own
 * terminator, a `%w[]`/`%q{}` literal, a quoted string spanning lines — any of them can contain the
 * literal text `end` and every one of them is real Ruby, not a contrived case: a build-tool helper
 * script found on this machine opens a squiggly heredoc to emit a generated file, and three lines into
 * that heredoc's BODY sits `Pod::Spec.new do |s| ... end` — a perfectly ordinary `end`, at ordinary
 * indentation, that is not Ruby structure at all, just text a keyword scan would swallow whole and use
 * to close whatever the scanner still thought was open. `stripLines` below blanks every one of these —
 * comments, strings, heredoc bodies, block comments, percent-literals, and (best-effort) regex literals
 * — to spaces of the SAME width before the keyword scan ever runs, so line numbers never need
 * recomputing and a false `end` never reaches the stack. See `stripLines` for exactly what it does and
 * does not catch.
 *
 * MODULE VS CLASS VS SINGLETON CLASS. A `module` is Ruby's mixin: nothing instantiates it, other types
 * absorb its methods via `include`/`extend`. That is the same shape as a Dart mixin or a Python
 * `Protocol` — "this declares a surface, not a unit" — so it gets `kind: 'interface'`, the same call
 * made for both of those. `class << self` opens the SINGLETON class, Ruby's idiom for grouping class
 * methods; it names no new type of its own; it is a scoping construct, not a declaration, so no
 * `DeclaredType` is created for it and its methods are attached to the class it is nested inside — that
 * is where a caller would actually look for `ClassName.method`. It DOES get its own visibility scope,
 * because `private` inside `class << self` governs class methods independently of the instance methods'
 * running default.
 *
 * VISIBILITY IS POSITIONAL, not a keyword on each declaration. A bare `private` changes the DEFAULT for
 * every `def` that follows, until `public`/`protected`/the body ends — so this file carries a mutable
 * default per open class/module/singleton-class scope, exactly the kind of per-language truth a generic
 * "look for a visibility keyword on this line" rule would get wrong twice: once by finding no keyword on
 * an ordinary `def foo`, once more by never noticing the `private` three lines above changed what that
 * silence means. `private def foo` and `private :foo, :bar` are the other two forms Ruby offers, and
 * neither touches the running default — one sets a single declaration's visibility inline, the other
 * retags methods already declared. Both are handled without moving the default.
 *
 * ATTR_* ARE MEMBERS. `attr_accessor :name` generates two real, callable methods (`name`, `name=`); a
 * surface diff that only sees `def` misses every accessor a Ruby class exposes, which in idiomatic Ruby
 * is most of them. Each generated method is reported as its own `property` member, reader and writer
 * separately, because that is what a caller of `expand_method` needs to ask for by name.
 *
 * ENDLESS METHODS (`def square(x) = x * x`) take no `end` at all — the entire declaration is the body,
 * on one line. Treating `def` as always requiring a matching `end` would either hang the stack waiting
 * for one that never comes, or borrow the NEXT `end` in the file and misattribute it. So an endless
 * head is recognised before anything is pushed, and gets `line === endLine`, honestly.
 *
 * THE DEPENDENCY UNIT: a `.gemspec` states a library's actual runtime dependencies in a fixed,
 * regex-friendly shape (`spec.add_dependency 'x'`); a `Gemfile` states an application's, often
 * including dev/test tooling the gem itself doesn't need, and frequently exists ALONGSIDE a gemspec
 * purely so Bundler has something to resolve locally. So when both are found in the same directory the
 * gemspec wins as the more precise manifest; walking further up the tree, whichever is found nearest
 * wins, same as every other language here. `require_relative` names a file inside this same unit — the
 * same reason a relative `from . import x` costs `python.ts` nothing — while `require 'gem'` is a real
 * edge out and is what `referencesOf` reports.
 *
 * WHAT IS DELIBERATELY NOT HANDLED, so a gap here is a decision and not a surprise later: a conditional
 * top-level `def` (one nested inside an `if` inside a class body) is skipped as a MEMBER — the stack
 * still balances so nothing downstream drifts, there is just no line to hand `expand_method`. A
 * class-level constant (`MAX = 100`) is not reported as a field: most have a one-line value, but a
 * `Hash`/`Array` literal spanning many lines would need its own end-of-value search this file does not
 * do, and a wrong range is worse than an absent one. Regex literals are recognised well enough for the
 * traps above but not for a `/` inside an unescaped `[...]` character class. String interpolation
 * (`#{...}`) is safe by construction — the `#` inside an open quote is just another character to the
 * scanner, never a comment opener — except when the interpolated expression nests a string in the SAME
 * quote style as the one it is inside, which closes the outer string early; real Ruby style avoids that
 * for readability's own reasons, and this parser inherits the same blind spot.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import type { DeclaredMember, DeclaredType, Domain, SurfaceLanguage, Visibility } from '../types.js';

/**
 * Ruby's own furniture — core and standard-library names that show up in signatures and comments
 * constantly and were never designed by anyone the tool should flag. Biased toward TRUE like every
 * sibling list here: a missed violation is a bad day, a false stop on `String` is an unusable tool.
 */
const RUBY_BUILTIN = new Set([
  'String', 'Integer', 'Float', 'Numeric', 'Array', 'Hash', 'Symbol', 'Regexp', 'Range', 'Proc',
  'Method', 'UnboundMethod', 'NilClass', 'TrueClass', 'FalseClass', 'Object', 'BasicObject', 'Module',
  'Class', 'Comparable', 'Enumerable', 'Kernel', 'Struct', 'Data', 'Time', 'Date', 'DateTime', 'IO',
  'File', 'Dir', 'Thread', 'Mutex', 'Fiber', 'Enumerator', 'Rational', 'Complex', 'Set', 'OpenStruct',
  'Exception', 'StandardError', 'RuntimeError', 'ArgumentError', 'TypeError', 'NameError',
  'NoMethodError', 'ZeroDivisionError', 'IndexError', 'KeyError', 'NotImplementedError', 'IOError',
  'EOFError', 'RangeError', 'StopIteration', 'FrozenError', 'ScriptError', 'LoadError', 'SyntaxError',
  'SystemExit', 'LocalJumpError', 'ThreadError', 'FiberError', 'EncodingError', 'RegexpError',
  'Encoding', 'ObjectSpace', 'GC', 'Marshal', 'Process', 'Signal', 'ENV', 'ARGV', 'RUBY_VERSION',
]);

/** The standard library — always reachable, never a project dependency. Top segments only: a
 *  `require 'net/http'` is reduced to `net` by `referencesOf`, same idea as `distName` in python.ts. */
const RUBY_STDLIB = new Set([
  'json', 'yaml', 'psych', 'set', 'uri', 'net', 'open3', 'open-uri', 'fileutils', 'pathname', 'tmpdir',
  'time', 'date', 'logger', 'optparse', 'ostruct', 'singleton', 'forwardable', 'delegate',
  'securerandom', 'digest', 'base64', 'erb', 'csv', 'stringio', 'socket', 'thread', 'monitor',
  'timeout', 'benchmark', 'pp', 'irb', 'rake', 'bundler', 'English', 'abbrev', 'shellwords', 'tempfile',
  'zlib', 'rexml', 'rubygems', 'weakref', 'objspace', 'fiddle', 'pty', 'etc', 'find', 'ipaddr',
  'resolv', 'drb', 'observer', 'prettyprint', 'rdoc', 'rinda',
]);

// ── literal / comment stripping ─────────────────────────────────────────────────────────────────────

type QuoteState =
  | { kind: 'squote' | 'dquote' }
  | { kind: 'percent'; open: string; close: string; depth: number };

/** `%w(...)`/`%i[...]`/`%q{...}` and friends nest on bracket delimiters; `%w|...|`/`/regex/` do not. */
const MIRROR: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Blank every non-structural byte to a space of the same width — never remove it — so every line
 * number downstream is exactly the one a human counting from the top of the file would give. See the
 * file header for WHY each of these is a trap and not a nicety.
 */
function stripLines(rows: string[]): string[] {
  const out: string[] = new Array(rows.length);
  let state: QuoteState | null = null;
  let inBlockComment = false;
  const heredocs: Array<{ term: string; indent: boolean }> = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];

    if (inBlockComment) {
      out[i] = '';
      if (/^=end\b/.test(raw)) inBlockComment = false;
      continue;
    }
    // `=begin` is only a block comment at the true start of a logical line, never mid-expression.
    if (!state && heredocs.length === 0 && /^=begin(\s|$)/.test(raw)) {
      inBlockComment = true;
      out[i] = '';
      continue;
    }
    if (heredocs.length > 0) {
      const h = heredocs[0];
      const re = h.indent
        ? new RegExp(`^[ \\t]*${escapeRe(h.term)}\\s*$`)
        : new RegExp(`^${escapeRe(h.term)}\\s*$`);
      out[i] = '';
      if (re.test(raw)) heredocs.shift();
      continue;
    }

    let res = '';
    let j = 0;
    const openedHere: Array<{ term: string; indent: boolean }> = [];
    while (j < raw.length) {
      const c = raw[j];

      if (state && (state.kind === 'squote' || state.kind === 'dquote')) {
        if (c === '\\') { res += '  '; j += 2; continue; }
        const closer = state.kind === 'squote' ? "'" : '"';
        if (c === closer) { state = null; res += ' '; j++; continue; }
        res += ' '; j++; continue;
      }
      if (state && state.kind === 'percent') {
        // percent-literal state, also used for /regex/ and %r{...} — see below.
        if (c === '\\') { res += '  '; j += 2; continue; }
        if (state.open !== state.close && c === state.open) { state.depth++; res += ' '; j++; continue; }
        if (c === state.close) {
          state.depth--;
          res += ' '; j++;
          if (state.depth <= 0) state = null;
          continue;
        }
        res += ' '; j++; continue;
      }

      if (c === '#') break; // the rest of this physical line is a comment — interpolation is handled
                             // above: a `#` reached while `state` is 'dquote' never gets here at all.
      if (c === "'") { state = { kind: 'squote' }; res += ' '; j++; continue; }
      if (c === '"') { state = { kind: 'dquote' }; res += ' '; j++; continue; }

      if (c === '<' && raw[j + 1] === '<') {
        const m = /^<<([~-]?)(["'`]?)([A-Za-z_]\w*)\2/.exec(raw.slice(j));
        // `<<~`/`<<-` are unambiguous heredoc openers regardless of what precedes them; a bare `<<TAG`
        // is only a heredoc when the char before it could not itself be an operand — otherwise it is
        // the shift operator (`1 << 8`, `arr<<x`), which real code writes with no space just as often.
        const prev = j > 0 ? raw[j - 1] : '';
        const bareOk = !isWordChar(prev) && prev !== ')' && prev !== ']';
        if (m && (m[1] || bareOk)) {
          openedHere.push({ term: m[3], indent: m[1] === '~' || m[1] === '-' });
          res += ' '.repeat(m[0].length);
          j += m[0].length;
          continue;
        }
      }

      if (c === '%') {
        const m = /^%([wWiIqQrxs]?)([([{<|!/])/.exec(raw.slice(j));
        const prev = j > 0 ? raw[j - 1] : '';
        if (m && !isWordChar(prev) && prev !== ')' && prev !== ']') {
          const open = m[2];
          const close = MIRROR[open] ?? open;
          state = { kind: 'percent', open, close, depth: 1 };
          res += ' '.repeat(m[0].length);
          j += m[0].length;
          continue;
        }
      }

      if (c === '/') {
        // Division vs. a regex literal — a regex can only open where an EXPRESSION is expected, never
        // right after a value. `res` up to here IS the clean code already scanned on this line, so it
        // is its own lookbehind; no separate token buffer is needed.
        const before = res.trimEnd();
        const regexStart = before === ''
          || /[([{,;=&|!~?:]$/.test(before)
          || /\b(when|then|return|and|or|not|if|unless|while|until|case|match|split|scan|gsub|sub|puts|print)$/.test(before);
        if (regexStart) {
          state = { kind: 'percent', open: '/', close: '/', depth: 1 };
          res += ' '; j++; continue;
        }
      }

      res += c; j++;
    }
    out[i] = res;
    for (const h of openedHere) heredocs.push(h);
  }
  return out;
}

// ── structural keyword recognition ──────────────────────────────────────────────────────────────────

const SCLASS = /^class\s*<<\s*(\S+)/;
const CLASS = /^class\s+([A-Za-z_]\w*(?:::\w+)*)/;
const MODULE = /^module\s+([A-Za-z_]\w*(?:::\w+)*)/;
const DEF = /^def\s+/;
const FOR = /^for\s+\S+\s+in\b/;
const TRAILING_DO = /\bdo\b(\s*\|[^|]*\|)?\s*$/;
/** A construct opened and closed on ONE line nets to zero and must never be pushed. */
const SELF_CLOSED = /\bend\b\s*$/;
const CLOSER = /^end\b/;
const BARE_VIS = /^(private|public|protected)\s*$/;
const VIS_SYMS = /^(private|public|protected)\s+(?::[\w?!=]+\s*,?\s*)+$/;
const VIS_DEF_PREFIX = /^(private|public|protected)\s+(def\s+.*)$/;
const ATTR = /^(attr_accessor|attr_reader|attr_writer)\s+(.+)$/;

/** The full grammar of a Ruby method name, longest/most-specific alternative first so e.g. `<=>` is
 *  never read as `<` followed by leftover text. */
const OPERATOR_NAME = /^(?:\[\]=?|<=>|===|==|!=|<=|>=|<<|>>|\*\*|[+\-*/%&|^~<>!]|[A-Za-z_]\w*[?!=]?)/;

function stripReceiver(rest: string): string {
  return rest.replace(/^(?:self\.|[A-Z]\w*(?:::\w+)*\.)/, '');
}

/** The bare method name of a `def` line (cleaned text), or null when the head cannot be read honestly. */
function defName(effective: string): string | null {
  const rest0 = effective.replace(/^def\s+/, '');
  if (rest0 === effective) return null;
  const m = OPERATOR_NAME.exec(stripReceiver(rest0));
  return m ? m[0] : null;
}

/** `def foo(x) = expr` — the whole declaration is the body; no `end` will ever follow it. */
function isEndlessDef(effective: string): boolean {
  const rest0 = effective.replace(/^def\s+/, '');
  if (rest0 === effective) return false;
  let rest = stripReceiver(rest0);
  const nameM = OPERATOR_NAME.exec(rest);
  if (!nameM) return false;
  rest = rest.slice(nameM[0].length);
  if (rest.replace(/^\s+/, '').startsWith('(')) {
    const openAt = rest.indexOf('(');
    let depth = 0;
    let k = openAt;
    for (; k < rest.length; k++) {
      if (rest[k] === '(') depth++;
      else if (rest[k] === ')') { depth--; if (depth === 0) { k++; break; } }
    }
    rest = rest.slice(k);
  }
  return /^\s*=(?!=)/.test(rest);
}

/** `if`/`unless`/`while`/`until`/`case`/`begin` OPEN a block only as the first word of the line (or
 *  right after a simple assignment, `x = if cond`) — anywhere else they are a trailing MODIFIER
 *  (`return if x`, `x = 5 if y`) and take no `end` of their own. */
function condOpener(effective: string): 'if' | 'unless' | 'while' | 'until' | 'case' | 'begin' | null {
  let rest = effective;
  const asg = /^[A-Za-z_][\w.[\]]*\s*(?:\|\||&&|[+\-*/%|&^])?=(?!=)\s*/.exec(rest);
  if (asg) rest = rest.slice(asg[0].length);
  const m = /^(if|unless|while|until|case|begin)\b/.exec(rest);
  return m ? (m[1] as 'if' | 'unless' | 'while' | 'until' | 'case' | 'begin') : null;
}

type FrameKind = 'class' | 'module' | 'sclass' | 'def' | 'if' | 'unless' | 'while' | 'until' | 'case' | 'begin' | 'for' | 'do';

/** One entry on the `end`-matching stack. Only `class`/`module`/`sclass` carry a `type`, only `def`
 *  carries a `member`, and every OTHER kind exists purely to keep the count honest — see the header. */
interface Frame {
  kind: FrameKind;
  type?: DeclaredType;
  vis?: Visibility;
  member?: DeclaredMember;
}

export const ruby: SurfaceLanguage = {
  id: 'ruby',

  handles(path) {
    return /\.rb$/.test(path);
  },

  domainOf(path) {
    const manifest = findManifest(path);
    if (!manifest) return null;
    try {
      const text = readFileSync(manifest, 'utf-8');
      if (manifest.endsWith('.gemspec')) {
        // A gemspec is Ruby code (`Gem::Specification.new do |s| ... end`) and this will not run it —
        // same refusal python.ts makes for `setup.py`. Its dependency calls are fixed-shape enough to
        // regex reliably, which is what makes it worth trusting over a Gemfile in the first place.
        const name = /\.name\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1]
          ?? parse(manifest).name.replace(/\.gemspec$/, '');
        const allows = new Set<string>();
        for (const m of text.matchAll(/\.add_(?:runtime_)?dependency\s+['"]([^'"]+)['"]/g)) allows.add(m[1]);
        for (const m of text.matchAll(/\.add_development_dependency\s+['"]([^'"]+)['"]/g)) allows.add(m[1]);
        return { name, manifest, allows: [...allows], sealed: allows.size === 0 };
      }
      const allows = new Set<string>();
      for (const m of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) allows.add(m[1]);
      // A Gemfile states no project name of its own — the directory is the honest answer, same fallback
      // python.ts uses when its own manifest is silent on the point.
      return { name: dirname(manifest), manifest, allows: [...allows], sealed: allows.size === 0 };
    } catch {
      return null;
    }
  },

  surfaceOf(source) {
    const raw = source.split('\n');
    const rows = stripLines(raw);
    const types: DeclaredType[] = [];
    const stack: Frame[] = [];

    const typeOf = (): DeclaredType | undefined => {
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].type) return stack[k].type;
      return undefined;
    };
    const visOf = (): Visibility => {
      for (let k = stack.length - 1; k >= 0; k--) {
        const v = stack[k].vis;
        if (v) return v;
      }
      return 'public';
    };
    const setVis = (v: Visibility): void => {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].vis) { stack[k].vis = v; return; }
      }
    };
    // A method registers as a MEMBER only when declared directly in a class/module/singleton-class
    // body — one nested inside an `if` or another `def` is real Ruby but not class-level surface; the
    // stack still tracks it (see `handleDef`) so nothing after it drifts.
    const directlyInBody = (): boolean => {
      const top = stack[stack.length - 1];
      return !!top && (top.kind === 'class' || top.kind === 'module' || top.kind === 'sclass');
    };

    const addMember = (
      name: string, sig: string, line: number, endLine: number | undefined, explicitVis: Visibility | undefined,
    ): DeclaredMember => {
      const member: DeclaredMember = { name, kind: 'method', visibility: explicitVis ?? visOf(), sig, line, endLine };
      if (directlyInBody()) {
        typeOf()?.members.push(member);
      } else if (stack.length === 0) {
        // A top-level function is a declaration in its own right — the same call python.ts makes, and
        // for the same reason: `expand_method` needs a type to key off, so a bare function becomes a
        // one-member type of its own.
        types.push({ name, kind: 'class', members: [member], line });
      }
      return member;
    };

    const handleDef = (effective: string, explicitVis: Visibility | undefined, sig: string, n: number): void => {
      const name = defName(effective);
      if (name === null) {
        // Cannot read this head honestly — still push a bookkeeping frame so the STACK stays balanced;
        // the alternative is every `end` after it silently closing the wrong thing.
        if (!SELF_CLOSED.test(effective)) stack.push({ kind: 'def' });
        return;
      }
      if (isEndlessDef(effective)) {
        addMember(name, sig, n, n, explicitVis);
        return;
      }
      const selfClosed = SELF_CLOSED.test(effective);
      const member = addMember(name, sig, n, selfClosed ? n : undefined, explicitVis);
      if (!selfClosed) stack.push({ kind: 'def', member });
    };

    for (let idx = 0; idx < rows.length; idx++) {
      const n = idx + 1;
      const line = rows[idx];
      const trimmed = line.trim();
      if (!trimmed) continue;
      const original = raw[idx].trim();

      const visPrefix = VIS_DEF_PREFIX.exec(trimmed);
      if (visPrefix) {
        handleDef(visPrefix[2], visPrefix[1] as Visibility, original, n);
        continue;
      }
      if (BARE_VIS.test(trimmed)) {
        if (directlyInBody()) setVis(trimmed as Visibility);
        continue;
      }
      if (VIS_SYMS.test(trimmed)) {
        const kw = /^(private|public|protected)/.exec(trimmed)?.[1] as Visibility;
        const type = typeOf();
        if (type) {
          for (const sm of trimmed.matchAll(/:([\w?!=]+)/g)) {
            for (const mem of type.members) if (mem.name === sm[1]) mem.visibility = kw;
          }
        }
        continue;
      }

      const attrM = ATTR.exec(trimmed);
      if (attrM) {
        if (directlyInBody()) {
          const type = typeOf();
          if (type) {
            const wantsReader = attrM[1] !== 'attr_writer';
            const wantsWriter = attrM[1] !== 'attr_reader';
            const vis = visOf();
            for (const sm of attrM[2].matchAll(/:([\w?!]+)/g)) {
              if (wantsReader) {
                type.members.push({ name: sm[1], kind: 'property', visibility: vis, sig: `attr_reader :${sm[1]}`, line: n, endLine: n });
              }
              if (wantsWriter) {
                type.members.push({ name: `${sm[1]}=`, kind: 'property', visibility: vis, sig: `attr_writer :${sm[1]}`, line: n, endLine: n });
              }
            }
          }
        }
        continue;
      }

      if (SCLASS.test(trimmed)) {
        if (!SELF_CLOSED.test(trimmed)) stack.push({ kind: 'sclass', vis: 'public' });
        continue;
      }
      const classM = CLASS.exec(trimmed);
      if (classM) {
        const type: DeclaredType = { name: classM[1], kind: 'class', members: [], line: n };
        types.push(type);
        if (!SELF_CLOSED.test(trimmed)) stack.push({ kind: 'class', type, vis: 'public' });
        continue;
      }
      const modM = MODULE.exec(trimmed);
      if (modM) {
        // A mixin declares a surface, not a unit — the same reasoning that makes a Dart mixin or a
        // Python Protocol/ABC an `interface` here.
        const type: DeclaredType = { name: modM[1], kind: 'interface', members: [], line: n };
        types.push(type);
        if (!SELF_CLOSED.test(trimmed)) stack.push({ kind: 'module', type, vis: 'public' });
        continue;
      }
      if (DEF.test(trimmed)) {
        handleDef(trimmed, undefined, original, n);
        continue;
      }

      const cond = condOpener(trimmed);
      if (cond) {
        if (!SELF_CLOSED.test(trimmed)) stack.push({ kind: cond });
        continue;
      }
      if (FOR.test(trimmed)) {
        if (!SELF_CLOSED.test(trimmed)) stack.push({ kind: 'for' });
        continue;
      }
      if (TRAILING_DO.test(trimmed)) {
        stack.push({ kind: 'do' }); // never self-closed on the line that opens it
        continue;
      }
      if (CLOSER.test(trimmed)) {
        const popped = stack.pop();
        if (popped && popped.kind === 'def' && popped.member) popped.member.endLine = n;
        continue;
      }
    }
    return types;
  },

  /**
   * Fields this body writes and calls it makes — syntax only, see `BodyFacts`. `bodyLines` is raw
   * source, so it is run through the same `stripLines` the surface scan uses, or a comment reading
   * `# calls(foo)` would report a call that was never made.
   */
  bodyFactsOf(bodyLines) {
    const assigns = new Set<string>();
    const calls = new Set<string>();
    for (const line of stripLines(bodyLines)) {
      // `@ivar` is Ruby's `self.` — the one piece of state a method can be seen writing without
      // following a call. The whole dotted chain, not its first segment: see python.ts's own note on
      // why `axes.dataLim.intervalx = ...` must not collapse to `axes`.
      const set = /^\s*@(?<name>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:\[[^\]]*\])?\s*(?:[-+*/|&^%]|\*\*|<<|>>)?=(?!=)/.exec(line);
      if (set?.groups) assigns.add(set.groups.name);
      for (const m of line.matchAll(/\b(@?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\s*\(/g)) calls.add(m[1]);
      for (const m of line.matchAll(/(?<![.\w])([A-Z]\w*)\s*\(/g)) calls.add(m[1]);
    }
    return { assigns: [...assigns], calls: [...calls] };
  },

  isPlatform(ref) {
    return RUBY_STDLIB.has(ref);
  },

  isBuiltinType(name) {
    return RUBY_BUILTIN.has(name);
  },

  referencesOf(source) {
    const out = new Set<string>();
    // `require_relative` names a file inside this same unit — excluded for the same reason a relative
    // `from . import x` costs python.ts nothing; the regex below cannot match it anyway (`require`
    // wants whitespace immediately after it, and `require_relative` has `_relative` there instead).
    for (const m of source.matchAll(/^\s*require\s+['"]([^'"]+)['"]/gm)) {
      const top = m[1].split('/')[0].trim();
      if (top) out.add(top);
    }
    return [...out];
  },
};

/** Nearest `.gemspec` wins over a `Gemfile` at the SAME directory — see the header for why; otherwise
 *  whichever is found first walking up wins, same "nearest" rule every sibling language uses. */
function findManifest(from: string): string | null {
  let dir = dirname(from);
  for (;;) {
    try {
      const gemspec = readdirSync(dir).find((f) => f.endsWith('.gemspec'));
      if (gemspec) return join(dir, gemspec);
    } catch { /* unreadable dir — keep walking, same as csharp.ts's nearest-manifest search */ }
    const gemfile = join(dir, 'Gemfile');
    if (existsSync(gemfile)) return gemfile;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
