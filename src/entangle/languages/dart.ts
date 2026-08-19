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
    let current: DeclaredType | null = null;
    let depth = 0;
    let typeDepth = -1;
    for (const raw of source.split('\n')) {
      // Strip line comments and string bodies: a `//` example or a string containing `{` would move the
      // brace depth and lose every member after it.
      const line = raw.replace(/\/\/.*$/, '').replace(/'[^']*'|"[^"]*"/g, "''");
      const decl = DECL.exec(line);
      if (decl?.groups && !current) {
        current = { name: decl.groups.name, kind: kindOf(decl.groups), members: [] };
        types.push(current);
        typeDepth = depth;
      } else if (current && depth === typeDepth + 1) {
        const m = GETTER.exec(line) ?? SETTER.exec(line) ?? METHOD.exec(line) ?? FIELD.exec(line);
        const name = m?.groups?.name;
        if (name && !NOT_A_MEMBER.has(name)) {
          const isCall = GETTER.test(line) ? false : METHOD.test(line) || SETTER.test(line);
          current.members.push({
            name,
            kind: isCall ? 'method' : 'field',
            visibility: visibility(name),
            sig: line.trim(),
          });
        }
      }
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (current && depth <= typeDepth) { current = null; typeDepth = -1; }
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
