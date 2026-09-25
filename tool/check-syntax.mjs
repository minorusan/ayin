/**
 * check-syntax.mjs — the write gate refuses an edit that breaks the file, and ONLY that.
 *
 * The three properties worth asserting, because each one failing is a different disaster: a gate that
 * misses the break is the bug it was built for; a gate that fires on a valid edit teaches the model to
 * route around it; and a gate that fires on a file that was ALREADY unparseable is a wall nobody can
 * get past by doing anything right.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const { syntaxBroken, _resetSyntax } = await import(join(REPO, 'dist/syntax/check.js'));

const failures = [];
const ok = (cond, m, detail = '') => {
  if (cond) console.log(`  ok   ${m}`);
  else { failures.push(m); console.log(`  FAIL ${m}${detail ? ` — ${detail}` : ''}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'ayin-syntax-'));
const GOOD = 'public class Foo\n{\n    private int _n;\n    public void Bar() { _n = 1; }\n}\n';
const BROKEN = 'public class Foo\n{\n    private int _n;\n    public void Bar() { { _n = 1; }\n}\n';

console.log('syntax gate: a break is refused, a valid edit is not');
const cs = join(dir, 'Foo.cs');
writeFileSync(cs, GOOD);

const broke = await syntaxBroken(cs, GOOD, BROKEN);
ok(typeof broke === 'string' && /new syntax error/i.test(broke), 'an edit that unbalances a brace is refused', String(broke).slice(0, 80));
ok(typeof broke === 'string' && /line \d+, column \d+/.test(broke), 'the refusal names a line and column, so the model can fix it without hunting');
ok(typeof broke === 'string' && /NOTHING WAS WRITTEN/.test(broke), 'and says the file is untouched, so nothing is undone by hand');

const fine = await syntaxBroken(cs, GOOD, `// a comment\n${GOOD}`);
ok(fine === null, 'a valid edit passes', String(fine).slice(0, 80));

/**
 * THE DIFFERENTIAL RULE. tree-sitter reports ERROR nodes in files nobody is about to touch, so the
 * measure is before-vs-after. Editing a file that is already unparseable must stay possible — that is
 * usually the edit that FIXES it.
 */
const stillBroken = await syntaxBroken(cs, BROKEN, `${BROKEN}// another line\n`);
ok(stillBroken === null, 'a file that was already broken stays editable — the count did not increase');
const repaired = await syntaxBroken(cs, BROKEN, GOOD);
ok(repaired === null, 'and the edit that REPAIRS it is never refused');

console.log('\nsyntax gate: absent is not failed');
ok((await syntaxBroken(join(dir, 'notes.txt'), 'a', '} } } {')) === null, 'a file type no grammar claims is not checked');
ok((await syntaxBroken(join(dir, 'x.sql'), 'select 1', 'select ((')) === null, 'nor is one ayin does not declare');

console.log('\nsyntax gate: every declared language has a grammar shipped');
const { existsSync, readdirSync } = await import('node:fs');
const grammars = readdirSync(join(REPO, 'assets/grammars')).filter((f) => f.endsWith('.wasm'));
ok(grammars.length >= 9, `the grammars are in the package — ${grammars.length} found`, grammars.join(' '));
const src = await import('node:fs').then((m) => m.readFileSync(join(REPO, 'src/syntax/check.ts'), 'utf8'));
const wanted = [...src.matchAll(/wasm: '([^']+)'/g)].map((m) => m[1]);
const missing = wanted.filter((w) => !existsSync(join(REPO, 'assets/grammars', w)));
ok(missing.length === 0, 'every grammar the code names is actually shipped', missing.join(', '));

console.log(`\nsyntax check: ${failures.length ? `${failures.length} FAILED` : 'ok'}`);
process.exit(failures.length ? 1 : 0);
