/**
 * Dart / Flutter surfaces, with `pubspec.yaml` as the dependency unit.
 *
 * WHY THIS EXISTS, and what was impossible without it. `languageFor()` is not only entangle's: the corpus
 * builder walks a repo through it (`indulge/discover.ts#walkSources`), asks it for the entities a file
 * declares, and follows its import edges. A language it does not know is a language the corpus CANNOT
 * SEE — measured on a real Flutter app: every domain scoped to `client/lib` discovered zero files, not
 * because the words missed but because 121 `.dart` files were invisible to the walk, including the
 * scope-seeding fallback that exists precisely to rescue a domain whose words missed. The build reported
 * "matched nothing", which reads as "there is no such feature".
 *
 * NO PARSER, same as the other two: line-based declaration scanning, deterministic, and honest about the
 * shapes it recognises. Dart's grammar makes this less painful than it sounds — a declaration is a line,
 * `_` is the whole visibility system, and there are no namespaces to track.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Dart's `part`/`part of` splits one library across files; a `part`
 * file's members belong to the library, not to the file. That is fine here: every consumer of this
 * interface asks per FILE, and a `part` file's declarations are still declarations in it. Flutter's
 * generated `*.g.dart` / `*.freezed.dart` are excluded from `handles`, because a question about generated
 * code answers nothing and the generator's output is not the surface anyone maintains.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeclaredMember, DeclaredType, Domain, SurfaceLanguage, TypeKind, Visibility } from '../types.js';

/**
 * `class X`, `abstract class X`, `mixin X`, `enum X`, `extension X on Y`.
 *
 * Dart 3's class modifiers (`base`, `final`, `sealed`, `interface`) may appear in any order before
 * `class`, so they are consumed as a set rather than in sequence. `final class` is a real declaration and
 * a naive `(abstract\s+)?class` misses it.
 */
const DECL = new RegExp(
  '^\\s*(?:@\\w+\\s+)*'
  + '(?<mods>(?:abstract|base|final|sealed|interface|mixin)\\s+)*'
  + '(?<kind>class|mixin|enum|extension|typedef)\\s+'
  + '(?<name>[A-Za-z_$][A-Za-z0-9_$]*)',
);

/**
 * A member line: a method, a getter/setter, or a field.
 *
 * Ordered alternatives, because Dart puts the type BEFORE the name and the type may itself be generic
 * (`Future<List<Session>> load()`), nullable (`String? id`) or absent (`var x`, `final x`). The name is
 * whatever immediately precedes `(`, `=>`, `=` or `;`.
 */
const GETTER = /^\s*(?:@\w+\s+)*(?:static\s+|external\s+|covariant\s+)*(?:[A-Za-z_$][\w$<>,.?\[\]\s]*\s+)?get\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/;
const SETTER = /^\s*(?:@\w+\s+)*(?:static\s+|external\s+)*set\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
const METHOD = /^\s*(?:@\w+\s+)*(?:static\s+|external\s+|factory\s+|const\s+)*(?:[A-Za-z_$][\w$<>,.?\[\]\s]*?\s+)?(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>(]*>)?\s*\(/;
const FIELD = /^\s*(?:@\w+\s+)*(?:static\s+|late\s+|final\s+|const\s+|covariant\s+|var\s+)*(?:[A-Za-z_$][\w$<>,.?\[\]]*\s+)?(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=[^=>]|;)/;

/** Statements that look like declarations to a line scanner and are not. */
const NOT_A_MEMBER = new Set([
  'if', 'for', 'while', 'switch', 'return', 'assert', 'await', 'throw', 'case', 'else', 'try', 'catch',
  'finally', 'do', 'yield', 'super', 'this', 'new', 'import', 'export', 'part', 'library', 'typedef',
  'print', 'setState', 'required',
]);

/**
 * Dart's own vocabulary, plus the Flutter furniture every widget file is full of.
 *
 * Same bias as the C# and TS lists: when in doubt answer TRUE. A missed violation costs a bad day; a
 * false stop on `Widget` makes the tool unusable in the only ecosystem this file exists for.
 */
const DART_BUILTIN = new Set([
  // core
  'int', 'double', 'num', 'bool', 'String', 'void', 'dynamic', 'Object', 'Null', 'Never', 'Function',
  'List', 'Map', 'Set', 'Iterable', 'Iterator', 'Future', 'Stream', 'StreamSubscription', 'Duration',
  'DateTime', 'RegExp', 'Uri', 'Error', 'Exception', 'StateError', 'ArgumentError', 'Comparable',
  'Symbol', 'Type', 'Record', 'Enum', 'Completer', 'Timer', 'Zone', 'BigInt', 'Uint8List', 'ByteData',
  // flutter, the platform of every file this will ever read
  'Widget', 'StatelessWidget', 'StatefulWidget', 'State', 'BuildContext', 'Key', 'GlobalKey', 'ValueKey',
  'Color', 'Colors', 'TextStyle', 'ThemeData', 'Theme', 'EdgeInsets', 'Alignment', 'Offset', 'Size',
  'Rect', 'BoxDecoration', 'BorderRadius', 'Border', 'Text', 'Icon', 'Icons', 'Container', 'Column',
  'Row', 'Stack', 'Padding', 'Center', 'Expanded', 'Flexible', 'SizedBox', 'ListView', 'GridView',
  'Scaffold', 'AppBar', 'MaterialApp', 'Navigator', 'Route', 'MaterialPageRoute', 'ScrollController',
  'TextEditingController', 'FocusNode', 'AnimationController', 'Animation', 'Tween', 'Curves',
  'ChangeNotifier', 'ValueNotifier', 'ValueListenable', 'Listenable', 'StreamBuilder', 'FutureBuilder',
  'ValueListenableBuilder', 'InheritedWidget', 'MediaQuery', 'Brightness', 'IconData', 'ImageProvider',
]);

function kindOf(g: Record<string, string | undefined>): TypeKind {
  const mods = g.mods ?? '';
  if (/abstract/.test(mods)) return 'abstract';
  if (g.kind === 'mixin' || /mixin/.test(mods)) return 'interface'; // a mixin declares a surface, not a unit
  if (g.kind === 'enum') return 'enum';
  if (g.kind === 'extension' || g.kind === 'typedef') return 'interface';
  return 'class';
}

/** Dart has ONE access rule: a leading underscore is library-private. There is no `protected`. */
function visibility(name: string): Visibility {
  return name.startsWith('_') ? 'private' : 'public';
}

/**
 * NEUTRALIZE COMMENTS AND STRING BODIES BEFORE A SINGLE BRACE IS COUNTED.
 *
 * The previous stripper (`'[^']*'|"[^"]*"`) matched one line at a time and knew nothing of Dart's raw
 * strings (`r'...'`, no escaping at all — a backslash is just a backslash) or its triple-quoted strings
 * (`'''...'''`, `"""..."""`), which are the one Dart construct built to hold literal `{`/`}` across
 * several lines — a JSON fixture, a snippet of generated code. Either shape reads as class/member
 * structure to a counter that has not skipped it: the same failure as Python's docstring bug, in a
 * different quote.
 *
 * Block comments also NEST in Dart — an inner slash-star-star-slash pair inside an outer one is still
 * commented out — so a depth is kept for them rather than the single flag `//` and quoted strings get
 * away with.
 *
 * Returns the file as an array of lines, same count as the source, comments and string BODIES replaced
 * with blanks; code characters pass through untouched, so brace/paren counting on the result is exact.
 */
function stripSource(source: string): string[] {
  const lines: string[] = [];
  let out = '';
  let i = 0;
  const n = source.length;
  let lineComment = false;
  let blockDepth = 0;
  let str: { q: string; raw: boolean; triple: boolean } | null = null;
  while (i < n) {
    const c = source[i];
    if (c === '\n') {
      // A single-quoted (non-triple) string cannot legally hold a literal newline. Still thinking we
      // are inside one means it was never closed — end it here rather than consume the rest of the file.
      if (str && !str.triple) str = null;
      lines.push(out);
      out = '';
      lineComment = false;
      i++;
      continue;
    }
    if (lineComment) { i++; continue; }
    if (blockDepth > 0) {
      if (c === '/' && source[i + 1] === '*') { blockDepth++; out += '  '; i += 2; continue; }
      if (c === '*' && source[i + 1] === '/') { blockDepth--; out += '  '; i += 2; continue; }
      out += ' '; i++; continue;
    }
    if (str) {
      if (str.triple) {
        if (c === str.q && source[i + 1] === str.q && source[i + 2] === str.q) { str = null; out += '   '; i += 3; continue; }
        out += ' '; i++; continue;
      }
      if (!str.raw && c === '\\') { out += '  '; i += 2; continue; } // a raw string has no escapes at all
      if (c === str.q) { str = null; out += ' '; i++; continue; }
      out += ' '; i++; continue;
    }
    // code
    if (c === '/' && source[i + 1] === '/') { lineComment = true; i += 2; continue; }
    if (c === '/' && source[i + 1] === '*') { blockDepth = 1; i += 2; continue; }
    if (c === "'" || c === '"' || ((c === 'r' || c === 'R') && (source[i + 1] === "'" || source[i + 1] === '"'))) {
      const raw = c === 'r' || c === 'R';
      const qi = raw ? i + 1 : i;
      const q = source[qi];
      const triple = source[qi + 1] === q && source[qi + 2] === q;
      str = { q, raw, triple };
      const skip = (raw ? 1 : 0) + (triple ? 3 : 1);
      out += ' '.repeat(skip);
      i = qi + (triple ? 3 : 1);
      continue;
    }
    out += c;
    i++;
  }
  lines.push(out);
  return lines;
}

/** Nearest `pubspec.yaml` walking up — the Dart package boundary. */
function findManifest(from: string): string | null {
  let dir = dirname(from);
  for (;;) {
    const p = join(dir, 'pubspec.yaml');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * `name:` and the `dependencies:` block out of a pubspec, without a YAML parser.
 *
 * A dependency is a two-space-indented key under `dependencies:`; the block ends at the next
 * zero-indent key. That is enough for the only question asked of it — "may this package reference
 * that one" — and a YAML dependency would be a dependency added to read a dependency list.
 */
function readPubspec(path: string): { name: string; deps: string[] } | null {
  let text: string;
  try { text = readFileSync(path, 'utf-8'); } catch { return null; }
  const name = /^name:\s*([A-Za-z_][A-Za-z0-9_]*)/m.exec(text)?.[1] ?? '';
  const deps: string[] = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    if (/^(dependencies|dev_dependencies):\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      if (/^\S/.test(line)) { inBlock = false; continue; }
      const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
      if (m) deps.push(m[1]);
    }
  }
  return { name, deps };
}

export const dart: SurfaceLanguage = {
  id: 'dart',

  handles(path) {
    // Generated output is not a surface anyone maintains, and a question about it answers nothing.
    return /\.dart$/.test(path) && !/\.(g|freezed|gr|config|mocks|pb|pbenum|pbjson|pbserver)\.dart$/.test(path);
  },

  domainOf(path) {
    const manifest = findManifest(path);
    if (!manifest) return null;
    const spec = readPubspec(manifest);
    if (!spec) return null;
    return {
      name: spec.name || dirname(manifest),
      manifest,
      allows: spec.deps,
      // A pubspec with no dependencies at all is this ecosystem's sealed unit. Rare — `flutter` is
      // itself a dependency — which is exactly why it means something when it happens.
      sealed: spec.deps.length === 0,
    };
  },

  surfaceOf(source) {
    const types: DeclaredType[] = [];
    const masked = stripSource(source);
    const rawLines = source.split('\n');
    let current: DeclaredType | null = null;
    let depth = 0;
    let typeDepth = -1;
    /**
     * The member being measured for its END. `parenDepth` gates what counts as "the body opened": a
     * `{` seen while a paren from the member's own parameter list is still open is a default value's
     * map/set literal (`{Map<String,int> opts = const {}}`), never the member's own body.
     */
    let pending: { member: DeclaredMember; entered: boolean; parenDepth: number } | null = null;

    for (let idx = 0; idx < masked.length; idx++) {
      const n = idx + 1;
      const line = masked[idx];
      if (!pending) {
        const decl = DECL.exec(line);
        if (decl?.groups && !current) {
          current = { name: decl.groups.name, kind: kindOf(decl.groups), members: [], line: n };
          types.push(current);
          typeDepth = depth;
        } else if (current && depth === typeDepth + 1) {
          const m = GETTER.exec(line) ?? SETTER.exec(line) ?? METHOD.exec(line) ?? FIELD.exec(line);
          const name = m?.groups?.name;
          if (name && !NOT_A_MEMBER.has(name)) {
            const isCall = GETTER.test(line) ? false : METHOD.test(line) || SETTER.test(line);
            const member: DeclaredMember = {
              name,
              kind: isCall ? 'method' : 'field',
              visibility: visibility(name),
              sig: rawLines[idx].replace(/\/\/.*$/, '').trim(),
              line: n,
            };
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
      // No body ever opened and this line closed at the member's own level with `;` — a field, an
      // abstract/interface method signature, or a getter with no body of its own.
      if (pending && !pending.entered && pending.parenDepth === 0 && depth === typeDepth + 1 && /;\s*$/.test(line)) {
        pending.member.endLine = n;
        pending = null;
      }
      if (current && depth <= typeDepth) { pending = null; current = null; typeDepth = -1; }
    }
    return types;
  },

  /** `dart:` is the SDK and never reaches here; `flutter` is the platform, not a chosen dependency. */
  isPlatform(ref) {
    return ref === 'flutter' || ref === 'flutter_test' || ref === 'sky_engine';
  },

  isBuiltinType(name) {
    return DART_BUILTIN.has(name);
  },

  referencesOf(source) {
    const out = new Set<string>();
    for (const m of source.matchAll(/^\s*(?:import|export)\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (spec.startsWith('dart:')) continue;          // the SDK, not a dependency
      if (!spec.startsWith('package:')) continue;      // a relative path inside this package
      out.add(spec.slice('package:'.length).split('/')[0]);
    }
    return [...out];
  },
};
