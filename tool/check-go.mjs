#!/usr/bin/env node
/**
 * check-go — the Go surface parser, verified against traps AND real source.
 *
 * `npm run check:go` (needs a build). No model, no network: handwritten fixtures target the specific
 * failure this codebase has already paid for once (a comment/raw-string brace silently truncating a
 * type), then the same parser is run against real, unmodified `.go` files so the range assertions are
 * not grading a fixture built to pass.
 *
 * A range is asserted CORRECT, not merely present: for every member with a `line`/`endLine`, the real
 * file's line at `line` is read back and must contain that member's own name (the declaration really
 * starts there), the line at `endLine` must hold the closing brace the scan claims to have found (a
 * brace-bodied member) or be the declaration's own line (a one-liner / bodyless signature), and no two
 * members in the same file may claim overlapping ranges.
 */

import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { go } = await import(`file://${join(ROOT, 'dist', 'entangle', 'languages', 'go.js')}`);

// ── handles ──────────────────────────────────────────────────────────────────────

console.log('\nhandles');
ok(go.handles('reader.go') === true, '.go files are handled');
ok(go.handles('reader.py') === false, 'a non-Go file is not');

// ── the string/comment/raw-string traps ─────────────────────────────────────────

console.log('\nstring/comment traps — the shape that dropped 32 of 75 methods elsewhere');
const TRAP = [
  /* 1*/ 'package trap',
  /* 2*/ '',
  /* 3*/ '// a brace mentioned in prose: {{.Name}} {',
  /* 4*/ '/* a block comment with a stray brace { inside it */',
  /* 5*/ 'const Doc = `',
  /* 6*/ 'a raw string with real braces { { { and no escaping at all',
  /* 7*/ 'even a line that looks like func Fake() { should not register',
  /* 8*/ '`',
  /* 9*/ '',
  /*10*/ 'type Reader struct {',
  /*11*/ '\tbuf []byte',
  /*12*/ '}',
  /*13*/ '',
  /*14*/ 'func (r *Reader) Read(p []byte) (int, error) {',
  /*15*/ '\ttag := `{"json":"tag"}`',
  /*16*/ '\t_ = tag',
  /*17*/ '\treturn 0, nil',
  /*18*/ '}',
  /*19*/ '',
  /*20*/ 'func (r *Reader) Len() int { return len(r.buf) }',
  /*21*/ '',
].join('\n');

const trapTypes = go.surfaceOf(TRAP);
ok(!trapTypes.some((t) => t.name === 'Fake'), 'a declaration living inside a raw string never registers',
  trapTypes.map((t) => t.name).join(','));
const reader = trapTypes.find((t) => t.name === 'Reader');
ok(reader?.line === 10, 'Reader struct survives the leading comment/raw-string noise ahead of it', reader?.line);
ok(reader?.members.some((m) => m.name === 'buf'), 'its field is found', reader?.members.map((m) => m.name).join(','));
const read = reader?.members.find((m) => m.name === 'Read');
ok(read?.line === 14 && read?.endLine === 18,
  'Read keeps its real range despite an embedded backtick tag inside its own body', `${read?.line}-${read?.endLine}`);
const lenM = reader?.members.find((m) => m.name === 'Len');
ok(lenM?.line === 20 && lenM?.endLine === 20,
  'a one-line method (open and close brace on the same line) gets a one-line range', `${lenM?.line}-${lenM?.endLine}`);

// ── interfaces, multiple receivers, package-level functions ────────────────────

console.log('\nstructs, interfaces, receivers, free functions');
const SRC = [
  /* 1*/ 'package counter',
  /* 2*/ '',
  /* 3*/ 'type Counter interface {',
  /* 4*/ '\tAddString(string)',
  /* 5*/ '\tLines() int',
  /* 6*/ '}',
  /* 7*/ '',
  /* 8*/ 'type Impl1 struct {',
  /* 9*/ '\tlines, characters, letters int',
  /*10*/ '}',
  /*11*/ '',
  /*12*/ 'func (c *Impl1) AddString(s string) {',
  /*13*/ '\tfor _, char := range s {',
  /*14*/ '\t\tif char == \'\\n\' {',
  /*15*/ '\t\t\tc.lines++',
  /*16*/ '\t\t}',
  /*17*/ '\t}',
  /*18*/ '}',
  /*19*/ '',
  /*20*/ 'func (c Impl1) Lines() int      { return c.lines }',
  /*21*/ '',
  /*22*/ 'func New() *Impl1 { return &Impl1{} }',
  /*23*/ '',
  /*24*/ '// a method on a type declared in ANOTHER file of this package — honest per-file reporting.',
  /*25*/ 'func (o *OtherFile) Method() bool {',
  /*26*/ '\treturn true',
  /*27*/ '}',
].join('\n');

const types = go.surfaceOf(SRC);
const byName = new Map(types.map((t) => [t.name, t]));

ok(byName.get('Counter')?.kind === 'interface', 'interface kind recorded');
const addString = byName.get('Counter')?.members.find((m) => m.name === 'AddString');
ok(addString?.line === 4 && addString?.endLine === 4, 'a bodyless interface signature gets a one-line range', `${addString?.line}-${addString?.endLine}`);

ok(byName.get('Impl1')?.kind === 'struct', 'struct kind recorded');
const fields = byName.get('Impl1')?.members.filter((m) => m.kind === 'field').map((m) => m.name) ?? [];
ok(fields.join(',') === 'lines,characters,letters', 'a comma-shared type line yields three separate fields', fields.join(','));

const addImpl = byName.get('Impl1')?.members.find((m) => m.name === 'AddString');
ok(addImpl?.line === 12 && addImpl?.endLine === 18, 'a receiver method spanning several lines gets the real range', `${addImpl?.line}-${addImpl?.endLine}`);
const linesGetter = byName.get('Impl1')?.members.find((m) => m.name === 'Lines');
ok(linesGetter?.line === 20 && linesGetter?.endLine === 20, 'the one-line accessor is one line', `${linesGetter?.line}-${linesGetter?.endLine}`);

ok(byName.get('New')?.kind === 'class' && byName.get('New')?.members[0]?.line === 22,
  'a package-level function stands for itself, one type with one member');

const other = byName.get('OtherFile');
ok(!!other, 'a receiver type never declared in THIS file still gets a placeholder — the honest cross-file case');
ok(other?.kind === 'struct', 'the placeholder guesses struct, the common case, and says so in the source comment');
const otherMethod = other?.members.find((m) => m.name === 'Method');
ok(otherMethod?.line === 25 && otherMethod?.endLine === 27, 'and its range is exactly as real as any other', `${otherMethod?.line}-${otherMethod?.endLine}`);

// ── go.mod ───────────────────────────────────────────────────────────────────────

console.log('\ndomainOf (go.mod)');
const dir = mkdtempSync(join(tmpdir(), 'ayin-go-'));
writeFileSync(join(dir, 'go.mod'), [
  'module github.com/example/widget',
  '',
  'go 1.21',
  '',
  'require github.com/pkg/errors v0.9.1',
  '',
  'require (',
  '\tgolang.org/x/net v0.10.0',
  '\tgolang.org/x/sync v0.3.0 // indirect',
  ')',
].join('\n'));
mkdirSync(join(dir, 'pkg'));
writeFileSync(join(dir, 'pkg', 'widget.go'), 'package pkg\n');
const domain = go.domainOf(join(dir, 'pkg', 'widget.go'));
ok(domain?.name === 'github.com/example/widget', 'module path is the domain name', domain?.name);
ok(domain?.allows.includes('github.com/pkg/errors'), 'a single-line require is captured', domain?.allows.join(','));
ok(domain?.allows.includes('golang.org/x/net') && domain?.allows.includes('golang.org/x/sync'),
  'both requires inside the block form are captured, the trailing // indirect comment ignored', domain?.allows.join(','));
ok(domain?.sealed === false, 'a module WITH requires is not sealed');
rmSync(dir, { recursive: true, force: true });

console.log('\nisPlatform / isBuiltinType / referencesOf');
ok(go.isPlatform('fmt') && go.isPlatform('encoding/json') && go.isPlatform('net/http'),
  'a dotless first segment is the standard library');
ok(!go.isPlatform('github.com/pkg/errors'), 'a dotted first segment is a real module, never platform');
ok(go.isBuiltinType('error') && go.isBuiltinType('string') && go.isBuiltinType('int64'),
  'Go primitives and `error` are builtin — a false stop on either breaks every signature');
const refs = go.referencesOf('package p\n\nimport (\n\t"fmt"\n\t"os"\n\tmy "github.com/x/y"\n)\n');
ok(refs.includes('fmt') && refs.includes('os') && refs.includes('github.com/x/y'),
  'both single and aliased imports inside a block are read', refs.join(','));

// ── the real corpus ──────────────────────────────────────────────────────────────
//
// No path to a real Go corpus is committed here — this repo is public and a operator's checkout
// location is not portable, let alone a fact worth publishing. Point AYIN_GO_CORPUS at a tree of real
// `.go` files (e.g. any exercise/sample corpus) to run this section; without it the handwritten traps
// above still ran and this section is skipped rather than faked.

const CORPUS = process.env.AYIN_GO_CORPUS;
if (!CORPUS) {
  console.log('\nreal corpus: skipped — set AYIN_GO_CORPUS to a directory of real .go files to run it');
  console.log(fails ? `\ngo check: ${fails} FAILURE(S)\n` : '\ngo check: ok (fixtures only)\n');
  process.exit(fails ? 1 : 0);
}

console.log(`\nreal corpus: ${CORPUS}`);
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.go')) out.push(p);
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
    fileTypes = go.surfaceOf(source);
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
    // the declaration really starts where it says it does
    if (!startLine.includes(m.name)) {
      rangesWrong++;
      ok(false, `${path}: ${m.name} at line ${m.line} does not contain its own name`, JSON.stringify(startLine));
      continue;
    }
    // it ends where it says: either a one-liner (start === end), a closing brace, or (an interface
    // signature) a line whose own parens/brackets are visibly balanced.
    const oneLiner = m.line === m.endLine;
    const closesWithBrace = endLine.includes('}');
    if (!oneLiner && !closesWithBrace) {
      rangesWrong++;
      ok(false, `${path}: ${m.name} lines ${m.line}-${m.endLine} does not end on a closing brace`, JSON.stringify(endLine));
    }
  }
  // no two members in this file may overlap
  const sorted = [...ranged].sort((a, b) => a.line - b.line);
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i].endLine > sorted[i + 1].line) {
      overlaps++;
      ok(false, `${path}: ${sorted[i].name} (${sorted[i].line}-${sorted[i].endLine}) overlaps ${sorted[i + 1].name} (line ${sorted[i + 1].line})`);
    }
  }
}

ok(files > 30, `walked a real corpus`, `${files} .go file(s)`);
ok(filesWithRanges > 0, 'at least some real files produced ranged members', `${filesWithRanges} file(s)`);
ok(membersChecked > 50, 'a meaningful number of real members were range-checked', `${membersChecked} member(s)`);
ok(rangesWrong === 0, 'every checked range starts on its own declaration and ends on its own close', `${rangesWrong} wrong`);
ok(overlaps === 0, 'no two members in the same file claim overlapping lines', `${overlaps} overlap(s)`);

console.log(fails ? `\ngo check: ${fails} FAILURE(S)\n` : '\ngo check: ok\n');
process.exit(fails ? 1 : 0);
