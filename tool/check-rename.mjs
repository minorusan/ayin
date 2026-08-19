#!/usr/bin/env node
/**
 * check-rename — the rename tool against REAL trees on disk, in both languages.
 *
 * `npm run check:rename` (needs a build first). No LLM, no network: it writes a throwaway TS package and a
 * throwaway Unity-ish C# project in the OS temp dir, renames things in them, and reads the files back.
 *
 * Every assertion here is a way to corrupt a repo silently, which is why they are assertions and not a
 * paragraph in a doc:
 *
 *   · a substring rename (`Foo` inside `FooBar`) compiles about half the time
 *   · a name rewritten inside a STRING breaks a registry key with no compiler error
 *   · a Unity MonoBehaviour whose class and file names disagree stops binding — silently, in the editor
 *   · a renamed SERIALIZED field loses every value a designer set, and Unity reports nothing
 *   · a TS object shorthand `{ Foo }` is a KEY as well as a value; following the symbol changes a shape
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p'); // never open a TUI from a gate

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { renameSymbol, RenameRefusal } = await import(`file://${join(ROOT, 'dist', 'tools', 'rename', 'index.js')}`);

const write = (base, rel, body) => {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
};
const read = (p) => readFileSync(p, 'utf-8');

// ── TypeScript ───────────────────────────────────────────────────────────────────

console.log('\ntypescript');
const ts = mkdtempSync(join(tmpdir(), 'ayin-rename-ts-'));
write(ts, 'src/Widget.ts', `export class Widget {\n  spin(): void {}\n}\nexport const WidgetFactory = 1;\n`);
write(ts, 'src/use.ts', [
  `import { Widget } from './Widget.js';`,
  `import { Widget as Aliased } from './Widget.js';`,
  `const w = new Widget();`,
  `const notMe = 'Widget';          // a registry key, in a string`,
  `// Widget is also named in this comment`,
  `const widgets = { Widget, other: 1 };`,
  `class WidgetHolder { widget = new Widget(); }`,
  ``,
].join('\n'));
write(ts, 'node_modules/dep/index.ts', `export class Widget {}\n`);

const tsPlan = renameSymbol({ symbol: 'Widget', to: 'Gadget', root: ts, dryRun: false });
const decl = read(join(ts, 'src/Widget.ts'));
const use = read(join(ts, 'src/use.ts'));

ok(tsPlan.language === 'typescript', 'the language is picked from where the DECLARATION is');
ok(/export class Gadget/.test(decl), 'the class declaration is renamed');
ok(/WidgetFactory = 1/.test(decl), 'a LONGER name containing the symbol is untouched', decl.match(/Widget\w*/g)?.join(' '));
ok(/import \{ Gadget \} from/.test(use), 'a named import is renamed');
ok(/import \{ Gadget as Aliased \}/.test(use), 'the imported half of an `as` alias is renamed, the local is not');
ok(/const notMe = 'Widget'/.test(use), 'a name inside a STRING is left alone');
ok(/\/\/ Widget is also named/.test(use), 'a name inside a COMMENT is left alone');
ok(/class WidgetHolder/.test(use), 'WidgetHolder is not a reference to Widget');
ok(/\{ Widget: Gadget, other: 1 \}/.test(use),
  'object shorthand becomes `Widget: Gadget` — the KEY is a data shape and must not follow the symbol',
  use.split('\n').find((l) => l.includes('other: 1')));
ok(read(join(ts, 'node_modules/dep/index.ts')).includes('class Widget'), 'node_modules is not walked');
// FOUR, not two: the two import PATHS ('./Widget.js') are strings containing the symbol as well. Leaving
// them alone is correct — the TS file is not renamed — and reporting them is what tells the operator that
// a path, a registry key or a dynamic import may still name the old thing.
ok(tsPlan.skipped.length === 4, 'the string, the comment AND both import paths are REPORTED, not silently dropped', String(tsPlan.skipped.length));
ok(/from '\.\/Widget\.js'/.test(use), 'an import PATH is left alone — renaming a symbol is not renaming a file');
ok(tsPlan.warnings.some((w) => /named after the symbol/.test(w.message)),
  'a file named after the symbol is flagged, and NOT renamed (TS does not require it)');
ok(existsSync(join(ts, 'src/Widget.ts')) && !existsSync(join(ts, 'src/Gadget.ts')), 'so the TS file stays where it was');

// ── refusals: the decidable mistakes, before anything is written ─────────────────

console.log('\nrefusals');
const refuse = (fn) => { try { fn(); return null; } catch (e) { return e; } };
ok(refuse(() => renameSymbol({ symbol: 'Gadget', to: 'class', root: ts, dryRun: true })) instanceof RenameRefusal,
  'a keyword is refused');
ok(refuse(() => renameSymbol({ symbol: 'Gadget', to: '2fast', root: ts, dryRun: true })) instanceof RenameRefusal,
  'an invalid identifier is refused');
ok(refuse(() => renameSymbol({ symbol: 'Gadget', to: 'Gadget', root: ts, dryRun: true })) instanceof RenameRefusal,
  'renaming something to itself is refused');
write(ts, 'src/collide.ts', `export class Gadget {}\nexport class Existing {}\n`);
ok(refuse(() => renameSymbol({ symbol: 'Existing', to: 'Gadget', root: ts, dryRun: true })) instanceof RenameRefusal,
  'renaming INTO a name already declared in that file is refused — that is a merge, and it compiles');

// ── C# / Unity ───────────────────────────────────────────────────────────────────

console.log('\nc# and unity');
const cs = mkdtempSync(join(tmpdir(), 'ayin-rename-cs-'));
const scriptPath = write(cs, 'Assets/Scripts/PlayerMover.cs', [
  `using UnityEngine;`,
  `using UnityEngine.Serialization;`,
  ``,
  `public class PlayerMover : MonoBehaviour {`,
  `    public float moveSpeed = 3f;`,
  `    [SerializeField] private int steps = 2;`,
  `    private string label = @"PlayerMover verbatim \\ not an escape";`,
  `    public PlayerMover() {}`,
  `    void Update() { Debug.Log(nameof(PlayerMover) + moveSpeed); }`,
  `}`,
  ``,
].join('\n'));
write(cs, 'Assets/Scripts/PlayerMover.cs.meta', `guid: 1234567890abcdef\nMonoImporter:\n  serializedVersion: 2\n`);
write(cs, 'Assets/Scripts/Other.cs', `public class Other {\n    PlayerMover mover;\n    // PlayerMover in a comment\n}\n`);
write(cs, 'Library/ScriptAssemblies/generated.cs', `public class PlayerMover {}\n`);

const csPlan = renameSymbol({ symbol: 'PlayerMover', to: 'HeroMover', root: cs, dryRun: false });
ok(csPlan.language === 'csharp', 'C# is picked for a .cs declaration');
ok(existsSync(join(cs, 'Assets/Scripts/HeroMover.cs')), 'a MonoBehaviour class is renamed WITH its file — Unity binds by file name');
ok(!existsSync(scriptPath), 'and the old file is gone, not left as a duplicate declaration');
ok(existsSync(join(cs, 'Assets/Scripts/HeroMover.cs.meta')), 'the .meta moves with it');
ok(read(join(cs, 'Assets/Scripts/HeroMover.cs.meta')).includes('guid: 1234567890abcdef'),
  'the .meta CONTENTS are untouched — its GUID is what every prefab and scene points at');
const moved = read(join(cs, 'Assets/Scripts/HeroMover.cs'));
ok(/public class HeroMover : MonoBehaviour/.test(moved), 'the class is renamed');
ok(/public HeroMover\(\)/.test(moved), 'the constructor follows the type (same identifier, no special case needed)');
ok(/nameof\(HeroMover\)/.test(moved), 'nameof() is code and is renamed');
ok(/@"PlayerMover verbatim/.test(moved), 'a VERBATIM string is left alone, and its backslash does not eat the terminator');
ok(read(join(cs, 'Assets/Scripts/Other.cs')).includes('HeroMover mover'), 'a reference in another file is renamed');
ok(read(join(cs, 'Assets/Scripts/Other.cs')).includes('// PlayerMover in a comment'), 'the comment is left alone');
ok(read(join(cs, 'Library/ScriptAssemblies/generated.cs')).includes('class PlayerMover'), 'Unity\'s Library/ is not walked');
ok(csPlan.warnings.some((w) => /file name is load-bearing|refuses to bind/.test(w.message)),
  'the Unity file-name rule is stated in the report, not just acted on');

// the serialized field: the case that loses a designer's work with no error anywhere
console.log('\nserialized fields');
const field = renameSymbol({ symbol: 'moveSpeed', to: 'speed', root: cs, dryRun: false });
const afterField = read(join(cs, 'Assets/Scripts/HeroMover.cs'));
ok(/public float speed = 3f/.test(afterField), 'the field is renamed');
ok(/FormerlySerializedAs\("moveSpeed"\)/.test(afterField),
  '[FormerlySerializedAs] is added — without it Unity finds nothing under the new key and silently uses the default',
  afterField.split('\n').find((l) => l.includes('speed = 3f')));
ok(field.warnings.some((w) => /losing every value a designer set|serialized/i.test(w.message)),
  'and the report says why');

const twice = renameSymbol({ symbol: 'speed', to: 'velocity', root: cs, dryRun: false });
const afterTwice = read(join(cs, 'Assets/Scripts/HeroMover.cs'));
ok((afterTwice.match(/FormerlySerializedAs/g) ?? []).length === 2,
  'renaming twice adds a SECOND FormerlySerializedAs rather than replacing the first — the oldest key still has to resolve',
  String((afterTwice.match(/FormerlySerializedAs/g) ?? []).length));
ok(twice.warnings.length > 0, 'the second rename warns as well');

// ── dry run writes nothing ───────────────────────────────────────────────────────

console.log('\ndry run');
const before = read(join(cs, 'Assets/Scripts/Other.cs'));
const dry = renameSymbol({ symbol: 'Other', to: 'Another', root: cs, dryRun: true });
ok(dry.edits.length > 0, 'a dry run still produces the plan');
ok(read(join(cs, 'Assets/Scripts/Other.cs')) === before, 'and writes NOTHING');
ok(existsSync(join(cs, 'Assets/Scripts/Other.cs')), 'and moves nothing');

rmSync(ts, { recursive: true, force: true });
rmSync(cs, { recursive: true, force: true });

console.log(fails ? `\nrename check: ${fails} FAILURE(S)\n` : '\nrename check: ok\n');
process.exit(fails ? 1 : 0);
