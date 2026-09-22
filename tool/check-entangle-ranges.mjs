#!/usr/bin/env node
/**
 * check-entangle-ranges — TypeScript, C# and Dart declarations carry a LINE RANGE, and the range is
 * RIGHT, not merely present.
 *
 * `npm run check:entangle-ranges` (needs a build). No LLM, no network.
 *
 * WHY THIS EXISTS. `python.ts` is the only surface parser that ever set `DeclaredMember.line`/`endLine`
 * — the other three recorded a declaration and threw its extent away, because entangle only asked "what
 * is declared". `tools/skeleton.ts` asks a second question, "where do I look", and without an answer it
 * refuses to run at all (`skeletonOf` returns null the moment no member in the file carries a `line`),
 * and `tools/defs/expand_method.ts` refuses per member with "has no recorded line range". A big
 * TypeScript, C# or Dart file therefore fell back to a byte window exactly as before this change.
 *
 * ASSERTING PRESENCE IS NOT ENOUGH. A parser that counts braces without first skipping strings and
 * comments produces a range that LOOKS right and is wrong — worse than no range, because
 * `expand_method` then hands back the wrong code with full confidence. Python's own history is the
 * proof: an unskipped docstring convinced it a class had ended, and 32 of its 75 methods vanished
 * silently. Every check below reads the SOURCE FILE and the reported `[line, endLine]` together and
 * confirms the extracted text actually starts with that member's declaration and stays inside that
 * member — never trusting a range because it merely exists.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'entangle', 'languages');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { typescript } = await import(`file://${join(DIST, 'typescript.js')}`);
const { csharp } = await import(`file://${join(DIST, 'csharp.js')}`);
const { dart } = await import(`file://${join(DIST, 'dart.js')}`);

/**
 * The one check every member with a range must pass: the declaration line names the member, the range
 * is well-formed, and it stays inside the file. This is exactly what `expand_method.ts` checks before
 * trusting a range (`head.includes(member.name)`) — mirrored here so a parser bug is caught before that
 * tool ever runs against it.
 */
function rangeIsHonest(rows, member) {
  if (member.line === undefined) return { ok: true, why: 'absent, honestly' };
  if (member.line < 1 || member.line > rows.length) return { ok: false, why: `line ${member.line} outside 1..${rows.length}` };
  const head = rows[member.line - 1] ?? '';
  if (!head.includes(member.name)) return { ok: false, why: `line ${member.line} does not mention ${member.name}: "${head.trim().slice(0, 60)}"` };
  if (member.endLine === undefined) return { ok: true, why: 'line only, no endLine — still honest' };
  if (member.endLine < member.line) return { ok: false, why: `endLine ${member.endLine} < line ${member.line}` };
  if (member.endLine > rows.length) return { ok: false, why: `endLine ${member.endLine} outside file (${rows.length} lines)` };
  return { ok: true, why: '' };
}

/** Every member of every type gets `rangeIsHonest`, plus: two members of the same type never overlap. */
function checkFile(lang, path, source, label) {
  const rows = source.split('\n');
  let types;
  try { types = lang.surfaceOf(source); } catch (e) { ok(false, `${label} parses without throwing`, e.message); return; }
  for (const t of types) {
    for (const m of t.members) {
      const r = rangeIsHonest(rows, m);
      ok(r.ok, `${label}: ${t.name}.${m.name} range is honest`, r.why);
    }
    const withLines = t.members.filter((m) => m.line !== undefined).sort((a, b) => a.line - b.line);
    for (let i = 0; i < withLines.length - 1; i++) {
      const a = withLines[i];
      const b = withLines[i + 1];
      if (a.endLine === undefined) continue;
      ok(a.endLine < b.line, `${label}: ${t.name}.${a.name} does not run into ${b.name}`,
        `${a.name} ends ${a.endLine}, ${b.name} starts ${b.line}`);
    }
  }
}

/** A member found by name, for the fixture assertions below — same lookup shape as `skeleton.ts#locate`. */
function member(types, typeName, memberName) {
  const t = types.find((x) => x.name === typeName);
  return t?.members.find((m) => m.name === memberName);
}

// ── TypeScript ──────────────────────────────────────────────────────────────────

console.log('\nTypeScript — the required trap: a template literal holding braces');
{
  const src = [
    'class Widget {',
    '  css = `',
    '    .button {',
    '      color: red;',
    '    }',
    '  `;',
    '  render(): string {',
    '    return `<div>${1}</div>`;',
    '  }',
    '}',
  ].join('\n');
  const types = typescript.surfaceOf(src);
  const css = member(types, 'Widget', 'css');
  const render = member(types, 'Widget', 'render');
  ok(css?.line === 2 && css?.endLine === 6, 'the literal braces inside the template do not end the field early', `${css?.line}-${css?.endLine}`);
  ok(render?.line === 7 && render?.endLine === 9, 'and the next member is still found, with its own real range', `${render?.line}-${render?.endLine}`);
  checkFile(typescript, 'fixture', src, 'template-literal fixture');
}

console.log('\nTypeScript — ASI: a field with no semicolon must not swallow the rest of the class');
{
  const src = ['class Foo {', '  count = 0', '  bar() {', '    return 1;', '  }', '}'].join('\n');
  const types = typescript.surfaceOf(src);
  ok(member(types, 'Foo', 'count')?.endLine === 2, 'the semicolon-less field ends at its own line');
  ok(member(types, 'Foo', 'bar')?.endLine === 5, 'and the method after it is not dropped — the exact shape of the docstring bug', JSON.stringify(types[0]?.members.map((m) => m.name)));
}

console.log('\nTypeScript — a default value\'s own braces are not the method body opening early');
{
  const src = ['class Foo {', '  method(', '    opts: { a: number } = { a: 1 },', '  ) {', '    return opts.a;', '  }', '}'].join('\n');
  const m = member(typescript.surfaceOf(src), 'Foo', 'method');
  ok(m?.line === 2 && m?.endLine === 6, 'the whole signature-plus-body is one range, not cut at the default value', `${m?.line}-${m?.endLine}`);
}

console.log('\nTypeScript — an interface\'s multi-line, body-less signature still ends honestly');
{
  const src = ['interface Foo {', '  bar(', '    a: number,', '    b: string,', '  ): void;', '  baz(): void;', '}'].join('\n');
  const types = typescript.surfaceOf(src);
  ok(member(types, 'Foo', 'bar')?.endLine === 5, 'bar ends at its own closing `;`, not at the next signature');
  ok(member(types, 'Foo', 'baz')?.line === 6, 'and baz is not swallowed by bar\'s multi-line signature');
}

console.log('\nTypeScript — a `//` example containing a stray `}` is not a real brace');
{
  const src = ['class Foo {', '  // if (x) { return; }', '  real() {', '    return 1;', '  }', '}'].join('\n');
  const types = typescript.surfaceOf(src);
  ok(!member(types, 'Foo', 'if'), 'the commented-out brace creates no member');
  ok(member(types, 'Foo', 'real')?.endLine === 5, 'and the real method after it keeps its own correct range');
}

console.log('\nTypeScript — a single-line getter opens and closes its own body on one line');
ok(member(typescript.surfaceOf('class Foo {\n  get title() { return "x"; }\n}'), 'Foo', 'title')?.endLine === 2,
  'net-zero brace delta on one line is still a real body, not "never opened"');

// ── C# ──────────────────────────────────────────────────────────────────────────

console.log('\nC# — the required trap: a verbatim string holding braces');
{
  const src = [
    'public class Config {',
    '  public string Template = @"{',
    '    ""name"": ""value""',
    '  }";',
    '  public void Run() {',
    '    DoWork();',
    '  }',
    '}',
  ].join('\n');
  const types = csharp.surfaceOf(src);
  const t = member(types, 'Config', 'Template');
  const run = member(types, 'Config', 'Run');
  ok(t?.line === 2 && t?.endLine === 4, 'the verbatim string\'s own braces do not end the field early', `${t?.line}-${t?.endLine}`);
  ok(run?.line === 5 && run?.endLine === 7, 'and the next member is found with its own real range', `${run?.line}-${run?.endLine}`);
  checkFile(csharp, 'fixture', src, 'verbatim-string fixture');
}

console.log('\nC# — a raw string literal (`"""`) is the same trap, unescaped');
{
  const src = ['public class Config {', '  public string Json = """', '  { "a": 1 }', '  """;', '  public int Count => 5;', '}'].join('\n');
  const types = csharp.surfaceOf(src);
  ok(member(types, 'Config', 'Json')?.endLine === 4, 'the raw string\'s braces stay inside the field\'s own range');
  ok(member(types, 'Config', 'Count')?.line === 5, 'and the expression-bodied member after it is still found');
}

console.log('\nC# — an auto-property opens and closes on one line, a nested get/set spans several');
{
  const oneLine = member(csharp.surfaceOf('public class W {\n  public int Foo { get; set; }\n}'), 'W', 'Foo');
  ok(oneLine?.line === 2 && oneLine?.endLine === 2, 'get;set; on one line is a closed body, not an open one', `${oneLine?.line}-${oneLine?.endLine}`);
  const nested = member(csharp.surfaceOf([
    'public class W {', '  public int Foo {', '    get { return _f; }', '    set { _f = value; }', '  }', '  public void Bar() { Real(); }', '}',
  ].join('\n')), 'W', 'Foo');
  ok(nested?.line === 2 && nested?.endLine === 5, 'nested accessor bodies do not close the property early', `${nested?.line}-${nested?.endLine}`);
}

console.log('\nC# — a `//` example containing a stray `}` is not a real brace');
{
  const src = ['public class Widget {', '  // public void Old() { Legacy(); }', '  public void Bar() {', '    Real();', '  }', '}'].join('\n');
  const types = csharp.surfaceOf(src);
  ok(!member(types, 'Widget', 'Old'), 'the commented-out method creates no member');
  ok(member(types, 'Widget', 'Bar')?.endLine === 5, 'and the real method after it keeps its own correct range');
}

console.log('\nC# — enum members are single-line, and get a range too');
{
  const types = csharp.surfaceOf(['public enum Suit {', '  Hearts,', '  Spades,', '}'].join('\n'));
  ok(member(types, 'Suit', 'Hearts')?.line === 2 && member(types, 'Suit', 'Hearts')?.endLine === 2, 'an enum value never has a body to walk');
}

// ── Dart ────────────────────────────────────────────────────────────────────────

console.log('\nDart — the required trap: a raw string holding braces');
{
  const src = ['class Config {', "  String pattern = r'a{2,3}\\b';", '  void run() {', '    doWork();', '  }', '}'].join('\n');
  const types = dart.surfaceOf(src);
  const p = member(types, 'Config', 'pattern');
  const run = member(types, 'Config', 'run');
  ok(p?.line === 2 && p?.endLine === 2, 'a raw string has no escapes, and its own braces stay in its own line', `${p?.line}-${p?.endLine}`);
  ok(run?.line === 3 && run?.endLine === 5, 'and the method after it is found with its own real range', `${run?.line}-${run?.endLine}`);
  checkFile(dart, 'fixture', src, 'raw-string fixture');
}

console.log('\nDart — a triple-quoted string spans lines and holds braces');
{
  const src = ['class Config {', "  String json = '''", '  { "a": 1 }', "  ''';", '  int count() => 5;', '}'].join('\n');
  const types = dart.surfaceOf(src);
  ok(member(types, 'Config', 'json')?.endLine === 4, 'the triple-quoted body stays inside the field\'s own range');
  ok(member(types, 'Config', 'count')?.line === 5, 'and the method after it is still found');
}

console.log('\nDart — block comments NEST, and a `//` example with a stray `}` is not a real brace');
{
  const src = [
    'class Widget {',
    '  /* outer /* inner */ still commented */',
    '  // void old() { legacy(); }',
    '  void real() {',
    '    doStuff();',
    '  }',
    '}',
  ].join('\n');
  const types = dart.surfaceOf(src);
  ok(!member(types, 'Widget', 'old'), 'neither the nested comment nor the commented-out brace creates a member');
  ok(member(types, 'Widget', 'real')?.line === 4 && member(types, 'Widget', 'real')?.endLine === 6,
    'the real method is found with its correct range', `${member(types, 'Widget', 'real')?.line}-${member(types, 'Widget', 'real')?.endLine}`);
}

console.log('\nDart — a default map literal inside parens is not the method body opening early');
{
  const src = ['class Widget {', '  void foo({Map<String,int> opts = const {}}) {', '    use(opts);', '  }', '  int bar() => 1;', '}'].join('\n');
  const types = dart.surfaceOf(src);
  ok(member(types, 'Widget', 'foo')?.endLine === 4, 'the default value\'s own braces do not close the method early');
  ok(member(types, 'Widget', 'bar')?.line === 5, 'and the method after it is found');
}

// ── honest absence: a truncated file must not be GUESSED a range ────────────────

console.log('\nhonest absence — a method whose body never closes gets no endLine, never a guessed one');
{
  const src = ['class Foo {', '  bar() {', '    return 1;', '  // the file is cut off mid-body, no closing brace ever arrives'].join('\n');
  const bar = member(typescript.surfaceOf(src), 'Foo', 'bar');
  ok(bar?.line === 2, 'the declaration is still found');
  ok(bar?.endLine === undefined, 'but with nothing to close it honestly, endLine stays absent rather than guessed', String(bar?.endLine));
}

// ── real, uncontrolled TypeScript: ayin's own source ─────────────────────────────

console.log("\nreal corpus — ayin's own src/ (TypeScript), every member's range checked against the file");
{
  function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, out);
      else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) out.push(p);
    }
    return out;
  }
  const files = walk(join(ROOT, 'src'));
  let members = 0;
  let withLine = 0;
  for (const f of files) {
    const source = readFileSync(f, 'utf-8');
    const before = fails;
    checkFile(typescript, f.slice(ROOT.length + 1), source, f.slice(ROOT.length + 1));
    if (fails > before) break; // one bad file is enough to investigate; do not flood the log
    const rows = source.split('\n');
    for (const t of typescript.surfaceOf(source)) {
      for (const m of t.members) { members++; if (m.line !== undefined) withLine++; }
      void rows;
    }
  }
  ok(files.length > 50, `swept a real corpus, not a token gesture`, `${files.length} files`);
  ok(withLine === members && members > 500, 'every member in real, unseen source carries an honest, verified range', `${withLine}/${members}`);
}

console.log(fails ? `\nentangle-ranges check: ${fails} FAILURE(S)\n` : '\nentangle-ranges check: ok\n');
process.exit(fails ? 1 : 0);
