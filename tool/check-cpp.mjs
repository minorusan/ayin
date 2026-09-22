#!/usr/bin/env node
/**
 * check-cpp — asserts the C++ surface parser's line ranges are CORRECT, not merely present.
 *
 * `npm run check:cpp` (needs a build first; not yet wired into package.json — see the report handed to
 * the operator). No LLM, no network. See `check-java.mjs` for why this shape of check exists at all
 * (short version: `expand_method.ts` trusts a range completely, so a wrong one is worse than none).
 *
 * `cpp` is imported directly from `dist/entangle/languages/cpp.js` — it is not registered in
 * `entangle/index.ts` yet.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { cpp } = await import(`file://${join(ROOT, 'dist', 'entangle', 'languages', 'cpp.js')}`);

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

function stripish(text) {
  return text
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/R"([A-Za-z0-9_]*)\(([\s\S]*?)\)\1"/g, '""') // raw strings, custom delimiter aware
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}
function isBalanced(text) {
  const s = stripish(text);
  return (s.match(/\{/g) ?? []).length === (s.match(/\}/g) ?? []).length;
}

function assertRanges(label, source, path) {
  const rows = source.split('\n');
  const types = cpp.surfaceOf(source);
  let checked = 0;
  for (const t of types) {
    for (const m of t.members) {
      if (m.line === undefined) continue;
      checked++;
      ok(m.line >= 1 && m.line <= rows.length, `${label}: ${t.name}.${m.name} line ${m.line} is inside the file`);
      const declText = rows[m.line - 1] ?? '';
      ok(declText.includes(m.name.replace(/^~/, '')), `${label}: ${t.name}.${m.name} — line ${m.line} names it`, JSON.stringify(declText.trim()));
      if (m.endLine === undefined) continue;
      ok(m.endLine >= m.line && m.endLine <= rows.length, `${label}: ${t.name}.${m.name} endLine ${m.endLine} is inside the file and after line`);
      const slice = rows.slice(m.line - 1, m.endLine).join('\n');
      ok(isBalanced(slice), `${label}: ${t.name}.${m.name} [${m.line},${m.endLine}] is brace-balanced`, JSON.stringify(rows[m.endLine - 1]?.trim()));
    }
  }
  return checked;
}

// ── handwritten fixture: every named trap in one header + one translation unit ─────

const HEADER = `#pragma once

#include <string>
#include <vector>

// a comment holding a brace { that must not open a scope

namespace demo {

template <typename T>
class Box {
public:
    Box() {}
    explicit Box(T value) : value_(value) {}

    T get() const { return value_; }

    void set(T v) { value_ = v; }

private:
    T value_;
};

class Account {
public:
    Account();
    void deposit(int amount);
    int balance() const;

private:
    int balance_ = 0;
};

struct Point {
    int x;
    int y;

    int sum() const { return x + y; }
};

enum class Phase {
    Idle,
    Running,
    Done,
};

}  // namespace demo
`;

const SOURCE = `#include "account.h"
#include <stdexcept>

namespace demo {

namespace {

int helper(int x) {
    return x * 2;
}

}  // namespace

Account::Account()
    : balance_(0)
{
}

void Account::deposit(int amount) {
    if (amount < 0) {
        throw std::runtime_error{"negative: {}"};
    }
    balance_ += amount;
}

int Account::balance() const
{
    return balance_;
}

int free_function(int a, int b) {
    return a + b;
}

}  // namespace demo
`;

console.log('\nhandwritten trap fixture — header (in-class declarations, templates, access labels, enum)');
{
  const types = cpp.surfaceOf(HEADER);
  const byName = new Map(types.map((t) => [t.name, t]));
  ok(byName.has('Box'), 'a template class is found');
  ok(byName.has('Account'), 'a plain class is found');
  ok(byName.has('Point'), 'a struct is found');
  ok(byName.get('Point')?.kind === 'struct', 'and reported as a struct');
  ok(byName.has('Phase'), 'an `enum class` is found');
  ok(byName.get('Phase')?.kind === 'enum', 'and reported as an enum');

  const box = new Map((byName.get('Box')?.members ?? []).map((m) => [m.name, m]));
  ok(box.get('get')?.line === box.get('get')?.endLine, 'a one-line const accessor has line === endLine');
  ok(box.get('value_')?.visibility === 'private', 'a field after the (unlabeled) private: section defaults correctly for a class');

  const account = new Map((byName.get('Account')?.members ?? []).map((m) => [m.name, m]));
  ok(account.get('Account')?.visibility === 'public', 'a constructor DECLARED (no body) under `public:` is public');
  ok(account.get('balance_')?.visibility === 'private', 'a field under `private:` is private');
  ok(account.get('deposit')?.endLine === account.get('deposit')?.line, 'a pure declaration (no body, ends `;`) closes on its own line');

  const point = new Map((byName.get('Point')?.members ?? []).map((m) => [m.name, m]));
  ok(point.get('x')?.visibility === 'public' && point.get('y')?.visibility === 'public', 'struct fields default to public with NO access label at all');
  ok(point.get('sum')?.kind === 'method', 'a struct method is a method');

  const phase = new Map((byName.get('Phase')?.members ?? []).map((m) => [m.name, m]));
  ok(phase.has('Idle') && phase.has('Running') && phase.has('Done'), 'enum class constants are members', [...phase.keys()].join(','));

  assertRanges('header', HEADER, '<header>');
}

console.log('\nhandwritten trap fixture — source (out-of-line defs, anonymous namespace, free function)');
{
  const types = cpp.surfaceOf(SOURCE);
  const byName = new Map(types.map((t) => [t.name, t]));
  ok(byName.has('Account'), 'Account::method out-of-line definitions synthesise an Account type with NO class Account in this file');
  ok(byName.get('Account')?.line === undefined, 'the synthesised type has NO declaration line here — honestly absent, not guessed from the header');
  const account = new Map((byName.get('Account')?.members ?? []).map((m) => [m.name, m]));
  ok(account.has('Account') && account.has('deposit') && account.has('balance'), 'ctor and both out-of-line methods are attached to it', [...account.keys()].join(','));
  ok(account.get('Account')?.line !== undefined && SOURCE.split('\n')[account.get('Account').line - 1].includes('Account::Account'),
    'the out-of-line CONSTRUCTOR (member-init-list on its own line, `{` on the next) is found at its signature line');
  ok(account.get('balance')?.sig?.includes('const') ?? false, 'a trailing `const` on an out-of-line definition is kept in `sig`', account.get('balance')?.sig);
  ok(byName.has('helper'), 'a free function inside an ANONYMOUS namespace is its own unit');
  ok(byName.has('free_function'), 'a free function at namespace scope (no class at all) is its own unit');
  const deposit = account.get('deposit');
  ok(deposit?.line !== undefined && deposit?.endLine !== undefined
    && SOURCE.split('\n').slice(deposit.line - 1, deposit.endLine).join('\n').includes('negative'),
    'a string literal containing `{}` inside the body does not truncate it');

  assertRanges('source', SOURCE, '<source>');
}

// ── domainOf: CMakeLists.txt ─────────────────────────────────────────────────────

console.log('\ndomainOf (CMakeLists.txt)');
{
  const repo = mkdtempSync(join(tmpdir(), 'ayin-cpp-'));
  writeFileSync(join(repo, 'CMakeLists.txt'), [
    'project(widgets CXX)',
    'find_package(Boost 1.58 REQUIRED COMPONENTS date_time)',
    'add_executable(widgets main.cpp)',
    'target_link_libraries(widgets PRIVATE Boost::date_time Threads::Threads)',
  ].join('\n'));
  const srcFile = join(repo, 'main.cpp');
  writeFileSync(srcFile, '#include <boost/date_time.hpp>\n#include <vector>\nint main() { return 0; }\n');
  const domain = cpp.domainOf(srcFile);
  ok(domain?.name === 'widgets', 'the project() name is the domain name', domain?.name);
  ok(domain?.allows.includes('Boost'), 'a find_package name is in `allows`', domain?.allows.join(','));
  ok(domain?.allows.includes('Threads'), 'a target_link_libraries name (Pkg::Component cut at ::) is in `allows`', domain?.allows.join(','));
  ok(!domain?.allows.includes('widgets'), 'the target itself (`${exercise}`-like own name) is not a reference to itself');
  const refs = cpp.referencesOf(readFileSync(srcFile, 'utf-8'));
  ok(refs.includes('boost/date_time.hpp'), 'an angle-bracket include is a reference', refs.join(','));
  ok(cpp.isPlatform('vector'), 'a no-slash standard header is platform');
  ok(!cpp.isPlatform('boost/date_time.hpp'), 'a third-party angle-bracket include is NOT platform');
  rmSync(repo, { recursive: true, force: true });
}

// ── bodyFactsOf ──────────────────────────────────────────────────────────────────

console.log('\nbodyFactsOf');
{
  const body = [
    '  this->count = 0;',
    '  int local = 5; // not a field',
    '  this->total += local;',
    '  helper(local);',
    '  std::cout << local;',
  ];
  const facts = cpp.bodyFactsOf(body);
  ok(facts.assigns.includes('count') && facts.assigns.includes('total'), '`this->`-qualified writes are assigns', facts.assigns.join(','));
  ok(!facts.assigns.includes('local'), 'a bare local variable assignment is not reported');
  ok(facts.calls.includes('helper'), 'a bare call is a call', facts.calls.join(','));
}

// ── real corpus: every real exercise file, ranges checked against the actual text ──

console.log('\nreal corpus (optional — a large tree of real C++, path from env)');
// See check-java.mjs: no path lives in this public repo. Point AYIN_CPP_CORPUS at a real C++ tree.
const CORPUS = process.env.AYIN_CPP_CORPUS;
if (CORPUS && existsSync(CORPUS)) {
  function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(cpp|cc|cxx|h|hpp|hh)$/.test(e.name)) out.push(p);
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
  ok(files.length > 20, `walked a real C++ corpus (${files.length} files)`);
  ok(crashed === 0, 'surfaceOf never throws on real source', `${crashed} crash(es)`);
  ok(totalChecked > 50, `checked a real number of ranged members (${totalChecked})`);
  console.log(`  (${fails - before} range-check failure(s) across the corpus)`);
} else {
  console.log('  skipped — set AYIN_CPP_CORPUS to a real C++ tree to run this section');
}

console.log(fails ? `\ncpp check: ${fails} FAILURE(S)\n` : '\ncpp check: ok\n');
process.exit(fails ? 1 : 0);
