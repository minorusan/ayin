/**
 * Java surfaces, and the build manifest (`pom.xml` or `build.gradle[.kts]`) as the dependency unit.
 *
 * ONE PUBLIC TYPE PER FILE is the convention, not the grammar — a file can carry nested classes, a
 * package-private helper class after the public one, and (Java 16+) records and sealed interfaces. So
 * this cannot be "find the one class"; it is the same brace-depth scanner as `csharp.ts`/`typescript.ts`,
 * generalised from ONE current type to a STACK, because a nested class (`RestApi`'s `User.Builder`) has
 * to close back into its enclosing type's member list rather than discard it.
 *
 * WHY A LINE CANNOT BE THE UNIT OF DECISION, the way it is for C#. Java signatures wrap across lines
 * routinely — a multi-parameter constructor, an `Observable<Output>` return type broken before the
 * parameter list — and a scanner that only ever looks at one line at a time either misses these
 * declarations or (worse) records the WRONG line as their start. So declaration text accumulates across
 * lines until it is unambiguous: parens balanced AND either a `{` (a body has begun) or a trailing `;`
 * (the declaration is complete with no body). Only then is it classified. That single rule is also what
 * makes a multi-line signature's `line`/`endLine` correct instead of approximate.
 *
 * ENDLINE COMES FROM THE SAME BRACE COUNT THAT FINDS THE DECLARATION, not from python.ts's
 * next-declaration-start heuristic. Java (unlike Python) has an actual closing token, so the honest and
 * more precise answer is to track the depth at which a member's own body opened and report the line where
 * it returns there — this also correctly handles a one-line body (`int width() { return 2*columns+1; }`,
 * `Dimensions`'s real record accessor) without a special case, because the open and the matching close are
 * simply on the same line.
 *
 * THE TRAP THIS FILE IS BUILT AGAINST: annotations. `@Override` costs nothing, but
 * `@SuppressWarnings({"unchecked", "rawtypes"})` contains a BRACE that is not a body — count it and every
 * member after the annotation is attributed one nesting level too deep, the same class of bug the
 * docstring-`optional.` case was in Python. So annotation argument lists are blanked to whitespace (same
 * length, newlines kept) BEFORE any brace is counted, in a dedicated pass — never inline with the
 * comment/string scrub, because an annotation's parens can themselves contain a string or a nested brace
 * and the two passes would need to agree on where one another are.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeclaredMember, DeclaredType, Domain, SurfaceLanguage, TypeKind, Visibility } from '../types.js';

/** A (possibly multi-line, already-joined) type declaration. Base/interface lists are not captured — no
 *  consumer of `DeclaredType` records inheritance, so parsing it would cost lines for nothing read. */
const TYPE_DECL = /^(?:@[A-Za-z_$][\w$.]*\s*)*(?<mods>(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*)(?<kind>class|interface|enum|record)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/;

/**
 * A method OR a constructor. `rtype` is OPTIONAL and that is load-bearing: a constructor is
 * `Poker(List<String> hand)` with no return type at all, and greedy backtracking is what tells the two
 * apart — the engine tries WITH `rtype` first, and only a name directly followed by `(` (no separating
 * space, which a return type would need) forces it to retry without one. `Poker(` matches only the
 * without-`rtype` branch; `Player getTerritoryOwner(` only the with-`rtype` one.
 */
const METHOD_OR_CTOR = /^(?:@[A-Za-z_$][\w$.]*\s*)*(?<mods>(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp|transient)\s+)*)(?:<[^()]*>\s+)?(?:(?<rtype>[A-Za-z_$][\w$.]*(?:<[^()]*>)?(?:\[\])*)\s+)?(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;

/** A field: type, name, then `=` or `;`. Multiple declarators on one line (`int x, y;`) capture only the first — rare in idiomatic Java, and not worth a comma-aware splitter for. */
const FIELD = /^(?:@[A-Za-z_$][\w$.]*\s*)*(?<mods>(?:(?:public|protected|private|static|final|transient|volatile)\s+)*)(?<ftype>[A-Za-z_$][\w$.]*(?:<[^()]*>)?(?:\[\])*)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\[\])?\s*(?:=|;)/;

const MANIFESTS = ['pom.xml', 'build.gradle.kts', 'build.gradle'];

/** Same bias as every other language file: TRUE when in doubt. `java.lang`/`java.util`/common test and
 *  collection furniture, so a design check does not stop on `List` or `Optional`. */
const JAVA_BUILTIN = new Set([
  'void', 'int', 'long', 'short', 'byte', 'char', 'boolean', 'float', 'double', 'var',
  'Object', 'String', 'Integer', 'Long', 'Short', 'Byte', 'Character', 'Boolean', 'Float', 'Double',
  'Number', 'CharSequence', 'StringBuilder', 'StringBuffer', 'Comparable', 'Comparator', 'Iterable',
  'Iterator', 'Runnable', 'Callable', 'Cloneable', 'Serializable', 'AutoCloseable', 'Exception',
  'RuntimeException', 'Error', 'Throwable', 'IllegalArgumentException', 'IllegalStateException',
  'NullPointerException', 'IndexOutOfBoundsException', 'UnsupportedOperationException',
  'ClassCastException', 'ArithmeticException', 'NumberFormatException',
  'List', 'ArrayList', 'LinkedList', 'Set', 'HashSet', 'LinkedHashSet', 'TreeSet', 'Map', 'HashMap',
  'LinkedHashMap', 'TreeMap', 'Queue', 'Deque', 'ArrayDeque', 'Stack', 'Vector', 'Collection',
  'Collections', 'Arrays', 'Optional', 'OptionalInt', 'OptionalLong', 'OptionalDouble', 'Stream',
  'IntStream', 'LongStream', 'DoubleStream', 'Collectors', 'Function', 'BiFunction', 'Supplier',
  'Consumer', 'BiConsumer', 'Predicate', 'BiPredicate', 'UnaryOperator', 'BinaryOperator',
  'Entry', 'AbstractMap', 'Objects', 'Math', 'System', 'Thread', 'Class', 'Enum', 'Record',
]);

function scanForManifest(from: string): string | null {
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

/**
 * Import namespaces and Maven groupIds are DIFFERENT vocabularies — `org.json.JSONObject` is imported
 * from an artifact whose groupId is `org.json` only because that project happens to follow the
 * reverse-DNS convention groupIds are named after. There is no registry here mapping one to the other,
 * so `allows` is the groupId list and `referencesOf` returns the full dotted import path; the prefix
 * match in `check.ts` (`ref.startsWith(a + '.')`) is what makes `org.json.JSONObject` land on an
 * `org.json` groupId. A groupId that does not follow the convention is a miss this file cannot fix
 * without a network call it is not going to make.
 */
function parsePom(text: string): { name: string; groupIds: string[] } {
  const artifactId = /<project[^>]*>[\s\S]*?<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(text)?.[1];
  const groupIds = new Set<string>();
  for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(m[1])?.[1];
    if (g) groupIds.add(g);
  }
  return { name: artifactId ?? '', groupIds: [...groupIds] };
}

/** `implementation 'group:artifact:version'`, `implementation("group:artifact:version")`, or the
 *  map form `implementation group: 'g', name: 'a'`. Version catalogs (`libs.foo`) name nothing this
 *  scanner can resolve and are silently skipped — no worse than the manifest not existing at all. */
function parseGradle(text: string): string[] {
  const groups = new Set<string>();
  for (const m of text.matchAll(/['"]([A-Za-z0-9_.-]+):[A-Za-z0-9_.-]+:[^'":]+['"]/g)) groups.add(m[1]);
  for (const m of text.matchAll(/\bgroup\s*:\s*['"]([A-Za-z0-9_.-]+)['"]/g)) groups.add(m[1]);
  return [...groups];
}

/**
 * Comments, string/char literals and text blocks blanked to whitespace of the SAME shape — line count
 * and column positions survive, so every line number computed downstream still points at the real file.
 * Done BEFORE annotation-argument stripping and BEFORE any brace counting: a string containing `{` (a
 * log message, a JSON literal passed to a builder) is exactly the docstring trap in a different costume.
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
    if (source.slice(i, i + 3) === '"""') {
      out += '   '; i += 3;
      while (i < n && source.slice(i, i + 3) !== '"""') { out += source[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '   '; i += 3; }
      continue;
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

/**
 * Blanks `@Name(...)` argument lists — parens AND any braces inside them — on the already comment/string
 * scrubbed text. A bracket-depth walk, not a regex, because `@SuppressWarnings({"unchecked", "rawtypes"})`
 * nests a brace inside the parens and a multi-line `@RequestMapping(\n  value = "/x"\n)` nests a newline.
 * The `@Name` token itself is left in place — it never matches a brace-counting or declaration pattern,
 * so leaving it costs nothing and preserves it for whoever reads `sig`.
 */
function stripAnnotationArgs(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '@') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.]/.test(text[j])) j++;
      let k = j;
      while (k < n && /\s/.test(text[k])) k++;
      if (text[k] === '(') {
        let depth = 1;
        let m = k + 1;
        while (m < n && depth > 0) {
          if (text[m] === '(') depth++;
          else if (text[m] === ')') depth--;
          m++;
        }
        out += text.slice(i, k);
        for (let p = k; p < m; p++) out += text[p] === '\n' ? '\n' : ' ';
        i = m;
        continue;
      }
    }
    out += text[i]; i++;
  }
  return out;
}

/** Splits on a separator at bracket depth 0 — an enum constant's constructor args
 *  (`RED(255, 0, 0), GREEN(...)`) must not be split on their own internal commas. */
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

function mapKind(g: { kind?: string; mods?: string }): TypeKind {
  if (g.mods?.includes('abstract')) return 'abstract';
  if (g.kind === 'record') return 'class'; // a record is a class by any other name — same call csharp.ts makes
  return (g.kind as TypeKind) ?? 'class';
}

/**
 * Java's no-modifier default is PACKAGE-PRIVATE, which is neither `public` nor quite any of the other
 * three — `internal` ("visible within its own unit, not the public API") is the closest fit and, more to
 * the point, the only thing that matters to a consumer: `check.ts` only ever asks "is this `public`?", so
 * anything else being `internal` rather than invented as a fifth value is a distinction without a
 * difference to the one caller that reads this field.
 */
function visibilityOf(mods: string | undefined, isInterfaceMember: boolean): Visibility {
  if (isInterfaceMember) return 'public'; // an interface member has no modifier and is public BY DEFINITION
  if (!mods) return 'internal';
  if (mods.includes('public')) return 'public';
  if (mods.includes('private')) return 'private';
  if (mods.includes('protected')) return 'protected';
  return 'internal';
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

interface Frame { type: DeclaredType; declDepth: number; enumDone: boolean }
interface Pending { rawBuf: string[]; scanBuf: string[]; start: number }

/** True for a line that, once its annotation-argument parens are blanked, is nothing but `@Name` — an
 *  annotation on its OWN line above the real declaration. `line` records the SIGNATURE, never the
 *  annotation above it, matching every other language here: a decorator/attribute on its own line is
 *  not where `def foo`/`class Foo` is, and a model told to expand line N wants code at N, not `@Test`. */
const PURE_ANNOTATION_LINE = /^@[A-Za-z_$][\w$.]*$/;

export const java: SurfaceLanguage = {
  id: 'java',

  handles(path) {
    return path.endsWith('.java');
  },

  domainOf(path) {
    const manifest = scanForManifest(path);
    if (!manifest) return null;
    try {
      const text = readFileSync(manifest, 'utf-8');
      if (manifest.endsWith('pom.xml')) {
        const { name, groupIds } = parsePom(text);
        return { name: name || dirname(manifest), manifest, allows: groupIds, sealed: groupIds.length === 0 };
      }
      const allows = parseGradle(text);
      return { name: dirname(manifest), manifest, allows, sealed: allows.length === 0 };
    } catch {
      return null;
    }
  },

  surfaceOf(source) {
    const scanText = stripAnnotationArgs(scrub(source));
    const rawLines = source.split('\n');
    const scanLines = scanText.split('\n');
    const types: DeclaredType[] = [];
    const stack: Frame[] = [];
    let depth = 0;
    let pending: Pending | null = null;
    let openBlock: { member: DeclaredMember | null; closeAtDepth: number } | null = null;

    const resolveBodyOpening = (p: Pending, containerDepth: number): void => {
      const joined = p.scanBuf.join(' ');
      const raw = p.rawBuf.join(' ').replace(/\s+/g, ' ').trim();
      const t = TYPE_DECL.exec(joined);
      if (t?.groups) {
        const decl: DeclaredType = { name: t.groups.name, kind: mapKind(t.groups), members: [], line: p.start };
        types.push(decl);
        stack.push({ type: decl, declDepth: containerDepth, enumDone: false });
        return;
      }
      const top = stack[stack.length - 1];
      if (!top) { openBlock = { member: null, closeAtDepth: containerDepth }; return; } // malformed input — swallow, don't guess
      const mc = METHOD_OR_CTOR.exec(joined);
      if (mc?.groups) {
        const member: DeclaredMember = {
          name: mc.groups.name, kind: 'method',
          visibility: visibilityOf(mc.groups.mods, top.type.kind === 'interface'),
          sig: raw, line: p.start,
        };
        top.type.members.push(member);
        openBlock = { member, closeAtDepth: containerDepth };
        return;
      }
      // A field/variable whose INITIALIZER contains a block — a lambda body or an array literal that
      // itself spans lines. The brace still belongs to something; recording it as a field and letting the
      // shared depth tracker find where the block actually closes keeps ranges honest even though this
      // scanner does not evaluate the expression.
      const f = FIELD.exec(joined);
      if (f?.groups) {
        const member: DeclaredMember = {
          name: f.groups.name, kind: 'field',
          visibility: visibilityOf(f.groups.mods, top.type.kind === 'interface'),
          sig: raw, line: p.start,
        };
        top.type.members.push(member);
        openBlock = { member, closeAtDepth: containerDepth };
        return;
      }
      // A static/instance initializer block, or a shape this scanner does not recognise. Swallowed rather
      // than guessed at — an invented member with a plausible-looking name is worse than reporting none.
      openBlock = { member: null, closeAtDepth: containerDepth };
    };

    const resolveSimpleStatement = (p: Pending, lineNo: number): void => {
      const top = stack[stack.length - 1];
      if (!top) return; // no free statements at Java top level — nothing legitimate reaches here
      const joined = p.scanBuf.join(' ');
      const raw = p.rawBuf.join(' ').replace(/\s+/g, ' ').trim();
      const mc = METHOD_OR_CTOR.exec(joined);
      if (mc?.groups) {
        top.type.members.push({
          name: mc.groups.name, kind: 'method',
          visibility: visibilityOf(mc.groups.mods, top.type.kind === 'interface'),
          sig: raw, line: p.start, endLine: lineNo,
        });
        return;
      }
      const f = FIELD.exec(joined);
      if (f?.groups) {
        top.type.members.push({
          name: f.groups.name, kind: 'field',
          visibility: visibilityOf(f.groups.mods, top.type.kind === 'interface'),
          sig: raw, line: p.start, endLine: lineNo,
        });
      }
    };

    const handleEnumLine = (trimmedScan: string, trimmedRaw: string, lineNo: number, top: Frame): void => {
      const scanParts = splitTopLevel(trimmedScan, ',');
      const rawParts = splitTopLevel(trimmedRaw, ',');
      let done = false;
      scanParts.forEach((part, i) => {
        let p = part.trim();
        let raw = (rawParts[i] ?? part).trim();
        if (p.endsWith(';')) { p = p.slice(0, -1).trim(); raw = raw.replace(/;\s*$/, '').trim(); done = true; }
        if (!p) return;
        const m = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(p);
        if (!m) return;
        top.type.members.push({ name: m[1], kind: 'field', visibility: 'public', sig: raw, line: lineNo, endLine: lineNo });
      });
      if (done) top.enumDone = true;
    };

    for (let idx = 0; idx < scanLines.length; idx++) {
      const lineNo = idx + 1;
      const scanLine = scanLines[idx];
      const rawLine = rawLines[idx] ?? '';
      const trimmed = scanLine.trim();
      const top = stack[stack.length - 1];
      const containerDepth = top ? top.declDepth + 1 : 0;

      if (openBlock === null && depth === containerDepth) {
        if (trimmed === '') { /* nothing */ }
        else if (/^(?:package|import)\s/.test(trimmed)) { pending = null; }
        else if (pending === null && /^\}+;?$/.test(trimmed)) { /* the container's own close — see below */ }
        else if (pending === null && top?.type.kind === 'enum' && !top.enumDone) {
          handleEnumLine(trimmed, rawLine.trim(), lineNo, top);
        } else {
          if (pending === null) pending = { rawBuf: [], scanBuf: [], start: -1 };
          pending.rawBuf.push(rawLine.trim());
          pending.scanBuf.push(scanLine.trim());
          if (pending.start === -1 && !PURE_ANNOTATION_LINE.test(scanLine.trim())) pending.start = lineNo;
          const joined = pending.scanBuf.join(' ');
          const parens = countChar(joined, '(') - countChar(joined, ')');
          if (parens === 0 && (joined.includes('{') || /;\s*$/.test(scanLine.trimEnd()))) {
            if (pending.start === -1) pending.start = lineNo; // defensive: every line so far was `@Foo` alone
            if (joined.includes('{')) { resolveBodyOpening(pending, containerDepth); pending = null; }
            else { resolveSimpleStatement(pending, lineNo); pending = null; }
          }
        }
      }

      depth += countChar(scanLine, '{') - countChar(scanLine, '}');

      // The cast is load-bearing, not decoration: TS's flow analysis, having narrowed `openBlock` to
      // `null` inside the `if` above, does not widen it back after the closures reassign it — reading
      // through a plain `openBlock !== null` here reports "Property does not exist on type never".
      const closing = openBlock as { member: DeclaredMember | null; closeAtDepth: number } | null;
      if (closing !== null && depth <= closing.closeAtDepth) {
        if (closing.member) closing.member.endLine = lineNo;
        openBlock = null;
      }
      while (stack.length && depth <= stack[stack.length - 1].declDepth) stack.pop();
    }
    return types;
  },

  /**
   * `this.` is the same precision choice python.ts makes for `self.`: a bare `count = 0` inside a method
   * is a local variable, and only the `this.`-qualified form is unambiguously a field write.
   */
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
      // A block comment opened and not yet closed on this line — drop the rest of it and remember.
      const start = line.indexOf('/*');
      if (start !== -1) {
        const end = line.indexOf('*/', start + 2);
        if (end === -1) { line = line.slice(0, start); inBlockComment = true; }
        else { line = line.slice(0, start) + line.slice(end + 2); }
      }
      const set = /^\s*this\.(?<name>[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*(?:\[[^\]]*\])?\s*(?:[-+*/|&^%]|<<|>>>?)?=(?!=)/.exec(line);
      if (set?.groups) assigns.add(set.groups.name);
      for (const m of line.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)\s*\(/g)) calls.add(m[1]);
      for (const m of line.matchAll(/(?<![.\w])([A-Z][A-Za-z0-9_$]*)\s*\(/g)) calls.add(m[1]);
    }
    return { assigns: [...assigns], calls: [...calls] };
  },

  isPlatform(ref) {
    return /^(?:java|javax)\./.test(ref);
  },

  isBuiltinType(name) {
    return JAVA_BUILTIN.has(name);
  },

  referencesOf(source) {
    const out = new Set<string>();
    for (const m of source.matchAll(/^\s*import\s+(?:static\s+)?([A-Za-z_$][\w$.]*?)(?:\.\*)?\s*;/gm)) out.add(m[1]);
    return [...out];
  },
};
