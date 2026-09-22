#!/usr/bin/env node
/**
 * check-java — asserts the Java surface parser's line ranges are CORRECT, not merely present.
 *
 * `npm run check:java` (needs a build first; not yet wired into package.json — see the report handed to
 * the operator). No LLM, no network.
 *
 * WHY THIS SHAPE OF CHECK. `skeleton.ts`/`expand_method.ts` trust `line`/`endLine` completely: a wrong
 * range is worse than a missing one, because `expand_method` returns it with total confidence and the
 * model edits code it never actually looked at. So this does not just assert a member was FOUND — for
 * every member with a recorded range it (a) slices the REAL file at `[line, endLine]`, (b) checks the
 * first line names the member (the same sanity check `expand_method.ts` itself runs before trusting a
 * range), and (c) checks the slice is brace-BALANCED, which is the general property "the range covers a
 * complete declaration and nothing past it" reduces to — including multi-line initializers with no bare
 * `}` on their last line at all (a double-brace-init field closes on `}};`, a paren-only `Arrays.asList(`
 * call closes on `);`), so the check does not assume a shape the source is free to not have.
 *
 * `java` is imported directly from `dist/entangle/languages/java.js` rather than through `languageFor()`
 * — it is not registered in `entangle/index.ts` yet (see the handoff note); this gate exercises the
 * module on its own merits.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { java } = await import(`file://${join(ROOT, 'dist', 'entangle', 'languages', 'java.js')}`);

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

/**
 * Brace-balance over a raw slice, comments and string/char literals stripped first — a deliberately
 * SIMPLER scrub than the parser's own (this is the test oracle, and an oracle sharing the parser's own
 * scrubbing code could share the parser's own scrubbing BUGS and never catch them).
 */
function stripish(text) {
  return text
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}
function isBalanced(text) {
  const s = stripish(text);
  return (s.match(/\{/g) ?? []).length === (s.match(/\}/g) ?? []).length;
}

/** Every member with a range, checked against the file it actually came from. */
function assertRanges(label, source, path) {
  const rows = source.split('\n');
  const types = java.surfaceOf(source);
  let checked = 0;
  for (const t of types) {
    for (const m of t.members) {
      if (m.line === undefined) continue;
      checked++;
      ok(m.line >= 1 && m.line <= rows.length, `${label}: ${t.name}.${m.name} line ${m.line} is inside the file`);
      const declText = rows[m.line - 1] ?? '';
      ok(declText.includes(m.name), `${label}: ${t.name}.${m.name} — line ${m.line} names it`, JSON.stringify(declText.trim()));
      if (m.endLine === undefined) continue;
      ok(m.endLine >= m.line && m.endLine <= rows.length, `${label}: ${t.name}.${m.name} endLine ${m.endLine} is inside the file and after line`);
      const slice = rows.slice(m.line - 1, m.endLine).join('\n');
      ok(isBalanced(slice), `${label}: ${t.name}.${m.name} [${m.line},${m.endLine}] is brace-balanced`, JSON.stringify(rows[m.endLine - 1]?.trim()));
    }
  }
  return checked;
}

// ── handwritten fixture: every named trap in one file ──────────────────────────────

const FIXTURE = `package demo.traps;

import java.util.List;
import java.util.Map;

/**
 * A javadoc block with a brace in prose: {@code Map<String,Integer>} must not open a scope.
 */
@Deprecated
public class Traps {

    // one-line comment holding a brace { that must not count
    private final String name = "a brace in a string: {";
    private char quote = '{';

    @SuppressWarnings({
        "unchecked",
        "rawtypes"
    })
    public Traps(
            String name,
            int unused) {
        this.name2 = name;
    }

    private String name2;

    static {
        System.out.println("static init block");
    }

    public Map<String, List<Integer>> nested() {
        return null;
    }

    public <T extends Comparable<T>> T max(List<T> list) {
        return list.get(0);
    }

    public static class Inner {
        private int x;

        public int getX() { return x; }
    }

    public interface Greeter {
        String NAME = "world";

        String greet();

        default String greetLoudly() {
            return greet().toUpperCase();
        }
    }

    public enum Phase {
        IDLE,
        RUNNING,
        DONE;

        public boolean isTerminal() {
            return this == DONE;
        }
    }

    private record Point(int x, int y) {
        int sum() { return x + y; }
    }
}
`;

console.log('\nhandwritten trap fixture');
{
  const types = java.surfaceOf(FIXTURE);
  const byName = new Map(types.map((t) => [t.name, t]));
  ok(byName.has('Traps'), 'the outer class is found');
  ok(byName.has('Inner'), 'a nested static class is its OWN DeclaredType, not lost inside the outer one');
  ok(byName.has('Greeter'), 'an interface nested in a class is found');
  ok(byName.has('Phase'), 'an enum WITH A BODY (constants + a method) is found');
  ok(byName.get('Phase')?.kind === 'enum', 'and reported as an enum');
  ok(byName.has('Point'), 'a record is found');

  const traps = byName.get('Traps');
  const tm = new Map((traps?.members ?? []).map((m) => [m.name, m]));
  ok(tm.get('name')?.kind === 'field', 'a field survives a same-line comment holding a brace');
  ok(tm.get('quote')?.sig?.includes("'{'") ?? false, 'a char literal holding a brace is kept in `sig` untouched', tm.get('quote')?.sig);
  ok(tm.has('Traps'), 'the multi-line, annotated constructor is found');
  ok(tm.get('Traps')?.line !== undefined && FIXTURE.split('\n')[tm.get('Traps').line - 1].includes('Traps('),
    'and its `line` is the SIGNATURE line, not the `@SuppressWarnings({...})` line above it — the annotation-brace trap',
    `line ${tm.get('Traps')?.line}`);
  ok(tm.get('name2')?.kind === 'field', 'a field declared AFTER the constructor is still found — no early cutoff');
  ok(tm.get('nested')?.sig?.includes('Map<String, List<Integer>>') ?? false,
    'nested generics with a comma inside the outer angle brackets are kept whole', tm.get('nested')?.sig);
  ok(tm.get('max')?.kind === 'method', 'a generic METHOD (`<T extends Comparable<T>>`) is found, `>>`-adjacent generics included');

  const inner = byName.get('Inner');
  const im = new Map((inner?.members ?? []).map((m) => [m.name, m]));
  ok(im.get('getX')?.line === im.get('getX')?.endLine, 'a one-line method (open and close on the same line) has line === endLine');

  const greeter = byName.get('Greeter');
  const gm = new Map((greeter?.members ?? []).map((m) => [m.name, m]));
  ok(gm.get('greet')?.visibility === 'public', 'an interface method with NO modifier is public by definition');
  ok(gm.get('greetLoudly')?.sig?.startsWith('default') ?? false, 'a `default` method is a method, not skipped');
  ok(gm.get('NAME')?.visibility === 'public', 'an interface field is public by definition too');

  const phase = byName.get('Phase');
  const pm = new Map((phase?.members ?? []).map((m) => [m.name, m]));
  ok(pm.has('IDLE') && pm.has('RUNNING') && pm.has('DONE'), 'all three enum constants are members', [...pm.keys()].join(','));
  ok(pm.get('isTerminal')?.kind === 'method', 'a method AFTER the enum constants` `;` is still found');

  const point = byName.get('Point');
  ok((point?.members ?? []).some((m) => m.name === 'sum'), "a record's own declared method is found");

  assertRanges('fixture', FIXTURE, '<fixture>');
}

// ── domain: pom.xml groupIds and build.gradle dependency notation ──────────────────

console.log('\ndomainOf');
{
  const repo = mkdtempSync(join(tmpdir(), 'ayin-java-'));
  writeFileSync(join(repo, 'pom.xml'), [
    '<project>',
    '  <groupId>com.example</groupId>',
    '  <artifactId>demo-app</artifactId>',
    '  <dependencies>',
    '    <dependency><groupId>org.json</groupId><artifactId>json</artifactId></dependency>',
    '    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId></dependency>',
    '  </dependencies>',
    '</project>',
  ].join('\n'));
  mkdirSync(join(repo, 'src/main/java'), { recursive: true });
  const srcFile = join(repo, 'src/main/java/App.java');
  writeFileSync(srcFile, 'import org.json.JSONObject;\nclass App {}\n');
  const domain = java.domainOf(srcFile);
  ok(domain?.name === 'demo-app', 'the artifactId is the domain name', domain?.name);
  ok(domain?.allows.includes('org.json'), 'a dependency groupId is in `allows`', domain?.allows.join(','));
  ok(!domain?.sealed, 'a pom with dependencies is not sealed');
  const refs = java.referencesOf(readFileSync(srcFile, 'utf-8'));
  ok(refs.includes('org.json.JSONObject'), 'referencesOf returns the FULL dotted import path', refs.join(','));
  ok(java.isPlatform('java.util.List'), 'java.* is platform');
  ok(java.isPlatform('javax.annotation.Nonnull'), 'javax.* is platform');
  ok(!java.isPlatform('org.json.JSONObject'), 'a third-party import is NOT platform');
  rmSync(repo, { recursive: true, force: true });

  const repo2 = mkdtempSync(join(tmpdir(), 'ayin-java-gradle-'));
  writeFileSync(join(repo2, 'build.gradle'), [
    'dependencies {',
    "    implementation 'com.squareup.okhttp3:okhttp:4.12.0'",
    "    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'",
    '}',
  ].join('\n'));
  mkdirSync(join(repo2, 'src/main/java'), { recursive: true });
  const srcFile2 = join(repo2, 'src/main/java/App.java');
  writeFileSync(srcFile2, 'class App {}\n');
  const gdomain = java.domainOf(srcFile2);
  ok(gdomain?.allows.includes('com.squareup.okhttp3'), 'a gradle single-quote dependency notation is parsed', gdomain?.allows.join(','));
  rmSync(repo2, { recursive: true, force: true });
}

// ── bodyFactsOf ──────────────────────────────────────────────────────────────────

console.log('\nbodyFactsOf');
{
  const body = [
    '  this.count = 0;',
    '  int local = 5; // not a field — no this.',
    '  this.total += local;',
    '  helper(local);',
    '  Collections.emptyList();',
  ];
  const facts = java.bodyFactsOf(body);
  ok(facts.assigns.includes('count') && facts.assigns.includes('total'), 'this.-qualified writes are assigns', facts.assigns.join(','));
  ok(!facts.assigns.includes('local'), 'a bare local variable assignment is not reported — `this.` is the precision line');
  ok(facts.calls.includes('Collections.emptyList'), 'a dotted static call is a call', facts.calls.join(','));
}

// ── real corpus: every real exercise file, ranges checked against the actual text ──

console.log('\nreal corpus (optional — a large tree of real Java, path from env)');
// No path lives in this public repo: point AYIN_JAVA_CORPUS at a real Java tree (e.g. a language
// exercise/benchmark checkout) to exercise this gate against material nobody hand-picked for it. Absent,
// this section is skipped rather than failed — the handwritten fixture above still covers every trap.
const CORPUS = process.env.AYIN_JAVA_CORPUS;
if (CORPUS && existsSync(CORPUS)) {
  function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const st = e.isSymbolicLink() ? null : e;
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.java')) out.push(p);
    }
    return out;
  }
  const files = walk(CORPUS);
  let totalChecked = 0;
  let crashed = 0;
  const before = fails;
  for (const f of files) {
    let source;
    try { source = readFileSync(f, 'utf-8'); } catch { continue; }
    try {
      totalChecked += assertRanges(f.slice(CORPUS.length + 1), source, f);
    } catch (e) {
      crashed++;
      console.log('  FAIL crash on', f, '—', e.message);
    }
  }
  ok(files.length > 100, `walked a real Java corpus (${files.length} files)`);
  ok(crashed === 0, 'surfaceOf never throws on real source', `${crashed} crash(es)`);
  ok(totalChecked > 500, `checked a real number of ranged members (${totalChecked})`);
  console.log(`  (${fails - before} range-check failure(s) across the corpus)`);
} else {
  console.log('  skipped — corpus not present on this machine');
}

console.log(fails ? `\njava check: ${fails} FAILURE(S)\n` : '\njava check: ok\n');
process.exit(fails ? 1 : 0);
