#!/usr/bin/env node
/**
 * check-rust — the Rust surface parser, verified against traps AND real source.
 *
 * `npm run check:rust` (needs a build). No model, no network: handwritten fixtures target the two traps
 * this language is uniquely capable of springing (nesting block comments, a lifetime that starts exactly
 * like a char literal), then the same parser runs against real, unmodified `.rs` files so the range
 * assertions are not grading a fixture built to pass.
 *
 * A range is asserted CORRECT, not merely present — see check-go.mjs for the same contract: the line at
 * `line` must contain the member's own name, the line at `endLine` must hold the closing brace it claims
 * (or be the declaration's own line), and no two members in one file may overlap.
 */

import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { rust } = await import(`file://${join(ROOT, 'dist', 'entangle', 'languages', 'rust.js')}`);

// ── handles ──────────────────────────────────────────────────────────────────────

console.log('\nhandles');
ok(rust.handles('lib.rs') === true, '.rs files are handled');
ok(rust.handles('lib.go') === false, 'a non-Rust file is not');

// ── nested block comments + the char-literal/lifetime trap ─────────────────────

console.log('\nnesting block comments and the char-literal/lifetime trap');
const TRAP = [
  /* 1*/ "// a note: &'a str and 'static are lifetimes, not strings",
  /* 2*/ '/* an outer comment with /* a nested comment { a brace */ still commented, another { brace */',
  /* 3*/ 'const DOC: &str = r#"a raw string with a real brace { and "quotes" too"#;',
  /* 4*/ 'const ALSO: &str = "a string containing fn fake() { which must not register";',
  /* 5*/ '',
  /* 6*/ 'pub struct Reader {',
  /* 7*/ '    buf: Vec<u8>,',
  /* 8*/ '}',
  /* 9*/ '',
  /*10*/ 'impl Reader {',
  /*11*/ "    pub fn read<'a>(&self, tag: &'a str) -> usize {",
  /*12*/ '        let s = r#"{"json":"tag"}"#;',
  /*13*/ '        let _ = s;',
  /*14*/ '        0',
  /*15*/ '    }',
  /*16*/ '',
  /*17*/ '    pub fn len(&self) -> usize { self.buf.len() }',
  /*18*/ '}',
].join('\n');

const trapTypes = rust.surfaceOf(TRAP);
ok(!trapTypes.some((t) => t.name === 'fake'), 'a declaration living inside a string never registers',
  trapTypes.map((t) => t.name).join(','));
const reader = trapTypes.find((t) => t.name === 'Reader');
ok(reader?.line === 6, 'Reader struct survives the leading comment/raw-string noise ahead of it', reader?.line);
ok(reader?.members.some((m) => m.name === 'buf'), 'its field is found despite the nested block comment above it',
  reader?.members.map((m) => m.name).join(','));
const readM = reader?.members.find((m) => m.name === 'read');
ok(readM?.line === 11 && readM?.endLine === 15,
  'read keeps its real range despite a lifetime AND an embedded raw-string brace inside its own body',
  `${readM?.line}-${readM?.endLine}`);
const lenM = reader?.members.find((m) => m.name === 'len');
ok(lenM?.line === 17 && lenM?.endLine === 17, 'a one-line method gets a one-line range', `${lenM?.line}-${lenM?.endLine}`);

// ── struct / enum / trait / impl merging / tuple structs ────────────────────────

console.log('\nstruct, enum, trait, and impl-block merging');
const SRC = [
  /* 1*/ 'pub struct InputCellId();',
  /* 2*/ '',
  /* 3*/ 'pub enum CellId {',
  /* 4*/ '    Input(InputCellId),',
  /* 5*/ '    Compute(ComputeCellId),',
  /* 6*/ '}',
  /* 7*/ '',
  /* 8*/ 'pub enum Shape {',
  /* 9*/ '    Circle { radius: f64 },',
  /*10*/ '    Square { side: f64 },',
  /*11*/ '}',
  /*12*/ '',
  /*13*/ 'pub trait Greet {',
  /*14*/ '    fn name(&self) -> String;',
  /*15*/ '    fn greet(&self) -> String {',
  /*16*/ '        format!("Hello, {}!", self.name())',
  /*17*/ '    }',
  /*18*/ '}',
  /*19*/ '',
  /*20*/ 'pub struct Graph;',
  /*21*/ '',
  /*22*/ 'impl Graph {',
  /*23*/ '    pub fn new() -> Self { Graph }',
  /*24*/ '}',
  /*25*/ '',
  /*26*/ 'impl Default for Graph {',
  /*27*/ '    fn default() -> Self {',
  /*28*/ '        Self::new()',
  /*29*/ '    }',
  /*30*/ '}',
].join('\n');

const types = rust.surfaceOf(SRC);
const byName = new Map(types.map((t) => [t.name, t]));

ok(byName.get('InputCellId')?.kind === 'struct' && byName.get('InputCellId')?.line === 1,
  'a tuple/unit struct is recorded with no crash from its parens-then-semicolon shape');

const cellId = byName.get('CellId');
ok(cellId?.kind === 'enum', 'enum kind recorded');
ok(cellId?.members.map((m) => m.name).join(',') === 'Input,Compute', 'both variants are found', cellId?.members.map((m) => m.name).join(','));

const shape = byName.get('Shape');
ok(shape?.members.map((m) => m.name).join(',') === 'Circle,Square',
  'a struct-variant is one member, not leaking its inner fields as siblings', shape?.members.map((m) => m.name).join(','));

const greet = byName.get('Greet');
ok(greet?.kind === 'interface', 'a trait is an interface');
const nameSig = greet?.members.find((m) => m.name === 'name');
ok(nameSig?.line === 14 && nameSig?.endLine === 14, 'a signature-only trait method (no default body) ends at its own `;`', `${nameSig?.line}-${nameSig?.endLine}`);
const greetDefault = greet?.members.find((m) => m.name === 'greet');
ok(greetDefault?.line === 15 && greetDefault?.endLine === 17, 'a trait method WITH a default body gets a real brace-matched range', `${greetDefault?.line}-${greetDefault?.endLine}`);
ok(nameSig?.visibility === 'public' && greetDefault?.visibility === 'public',
  'trait methods are public by definition — Rust forbids writing `pub` on one');

const graph = byName.get('Graph');
ok(graph?.line === 20, 'Graph is declared once, as a unit struct');
const methodNames = graph?.members.map((m) => m.name).sort().join(',');
ok(methodNames === 'default,new', 'two separate impl blocks (inherent + trait) MERGE onto one type', methodNames);
const newM = graph?.members.find((m) => m.name === 'new');
ok(newM?.line === 23 && newM?.endLine === 23, 'a one-line impl method gets a one-line range', `${newM?.line}-${newM?.endLine}`);
const defaultM = graph?.members.find((m) => m.name === 'default');
ok(defaultM?.line === 27 && defaultM?.endLine === 29, 'a multi-line impl method gets the real range', `${defaultM?.line}-${defaultM?.endLine}`);

// ── Cargo.toml ───────────────────────────────────────────────────────────────────

console.log('\ndomainOf (Cargo.toml)');
const dir = mkdtempSync(join(tmpdir(), 'ayin-rust-'));
writeFileSync(join(dir, 'Cargo.toml'), [
  '[package]',
  'name = "widget"',
  'edition = "2021"',
  '',
  '[dependencies]',
  'serde = { version = "1.0", features = ["derive"] } # inline table',
  'time = "0.3"',
  '',
  '[dev-dependencies]',
  'proptest = "1.0"',
].join('\n'));
writeFileSync(join(dir, 'lib.rs'), 'pub struct X;\n');
const domain = rust.domainOf(join(dir, 'lib.rs'));
ok(domain?.name === 'widget', 'package name is the domain name', domain?.name);
ok(domain?.allows.includes('serde') && domain?.allows.includes('time'), 'dependencies are captured, inline-table form included', domain?.allows.join(','));
ok(domain?.allows.includes('proptest'), 'dev-dependencies count too — a test file may legitimately import them', domain?.allows.join(','));
ok(domain?.sealed === false, 'a Cargo.toml WITH dependencies is not sealed');
rmSync(dir, { recursive: true, force: true });

console.log('\nisPlatform / isBuiltinType / referencesOf');
ok(rust.isPlatform('std') && rust.isPlatform('core') && rust.isPlatform('alloc'), 'the standard-library crates are platform');
ok(!rust.isPlatform('serde'), 'a real dependency crate is never platform');
ok(rust.isBuiltinType('String') && rust.isBuiltinType('Vec') && rust.isBuiltinType('Option') && rust.isBuiltinType('usize'),
  'Rust primitives and the core std types are builtin — a false stop on Vec breaks every signature');
const refs = rust.referencesOf('use std::collections::HashMap;\nuse crate::foo::Bar;\nuse self::graph_items::Edge;\nuse serde::{Deserialize, Serialize};\n');
ok(refs.includes('std') && refs.includes('serde'), 'std and a real crate are both references', refs.join(','));
ok(!refs.includes('crate') && !refs.includes('self'), 'crate:: and self:: are internal, never a reference', refs.join(','));
ok(!refs.includes('Serialize') && !refs.includes('Deserialize'),
  'a grouped `use serde::{Deserialize, Serialize}` reports serde ONCE, not each import as its own phantom crate',
  refs.join(','));

// ── the real corpus ──────────────────────────────────────────────────────────────
//
// No path to a real Rust corpus is committed here — see check-go.mjs for why. Point AYIN_RUST_CORPUS at
// a tree of real `.rs` files to run this section.

const CORPUS = process.env.AYIN_RUST_CORPUS;
if (!CORPUS) {
  console.log('\nreal corpus: skipped — set AYIN_RUST_CORPUS to a directory of real .rs files to run it');
  console.log(fails ? `\nrust check: ${fails} FAILURE(S)\n` : '\nrust check: ok (fixtures only)\n');
  process.exit(fails ? 1 : 0);
}

console.log(`\nreal corpus: ${CORPUS}`);
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.rs')) out.push(p);
  }
  return out;
}

let files = 0;
let membersChecked = 0;
let rangesWrong = 0;
let overlaps = 0;
let filesWithRanges = 0;

for (const path of walk(CORPUS)) {
  files++;
  const source = readFileSync(path, 'utf-8');
  const rawLines = source.split('\n');
  let fileTypes;
  try {
    fileTypes = rust.surfaceOf(source);
  } catch (e) {
    ok(false, `surfaceOf threw on ${path}`, String(e));
    continue;
  }
  const ranged = fileTypes.flatMap((t) => t.members.filter((m) => m.line !== undefined && m.endLine !== undefined));
  if (ranged.length) filesWithRanges++;
  for (const m of ranged) {
    membersChecked++;
    const startLine = rawLines[m.line - 1] ?? '';
    const endLine = rawLines[m.endLine - 1] ?? '';
    if (!startLine.includes(m.name)) {
      rangesWrong++;
      ok(false, `${path}: ${m.name} at line ${m.line} does not contain its own name`, JSON.stringify(startLine));
      continue;
    }
    const oneLiner = m.line === m.endLine;
    const closesRight = endLine.includes('}') || endLine.includes(';');
    if (!oneLiner && !closesRight) {
      rangesWrong++;
      ok(false, `${path}: ${m.name} lines ${m.line}-${m.endLine} does not end on a closing brace or semicolon`, JSON.stringify(endLine));
    }
  }
  const sorted = [...ranged].sort((a, b) => a.line - b.line);
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i].endLine > sorted[i + 1].line) {
      overlaps++;
      ok(false, `${path}: ${sorted[i].name} (${sorted[i].line}-${sorted[i].endLine}) overlaps ${sorted[i + 1].name} (line ${sorted[i + 1].line})`);
    }
  }
}

ok(files > 25, 'walked a real corpus', `${files} .rs file(s)`);
ok(filesWithRanges > 0, 'at least some real files produced ranged members', `${filesWithRanges} file(s)`);
ok(membersChecked > 30, 'a meaningful number of real members were range-checked', `${membersChecked} member(s)`);
ok(rangesWrong === 0, 'every checked range starts on its own declaration and ends on its own close', `${rangesWrong} wrong`);
ok(overlaps === 0, 'no two members in the same file claim overlapping lines', `${overlaps} overlap(s)`);

console.log(fails ? `\nrust check: ${fails} FAILURE(S)\n` : '\nrust check: ok\n');
process.exit(fails ? 1 : 0);
