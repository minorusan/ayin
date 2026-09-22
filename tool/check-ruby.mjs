#!/usr/bin/env node
/**
 * check-ruby — proves `ruby.ts` gets `end`-ambiguity right, not merely that it runs.
 *
 * `npm run check:ruby` (needs a build first). No LLM, no network.
 *
 * A line/endLine pair that LOOKS plausible but points at the wrong code is worse than no range at all —
 * `expand_method` hands it over with total confidence and the model edits the wrong body (see
 * `types.ts` on `DeclaredMember.line`). So every assertion below that checks a range does not stop at
 * "a number came back" — it SLICES the real fixture text at [line, endLine] and checks the slice starts
 * with the member's own declaration and ends inside its own body, never inside a neighbour's.
 *
 * Test material: real Ruby on this machine was checked first (a CocoaPods-style build helper script and
 * an RSpec test suite were both read). The heredoc-containing-`end` fixture below reproduces, byte for
 * byte in shape, a pattern found in real, unmodified Ruby: a squiggly heredoc (`<<~EOF`) whose body opens
 * a `do |s| ... end` block to build a generated spec file — an ordinary `end`, at ordinary indentation,
 * that is not Ruby structure at all. The real file's own path is not reproduced here (this repository is
 * public and does not carry facts about the machine it runs on) — the shape is, because the shape is
 * what broke a naive scanner.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { ruby } = await import(`file://${join(DIST, 'entangle', 'languages', 'ruby.js')}`);

/** Slice `text` at a reported [line, endLine] (1-based, inclusive) and hand back the raw lines. */
function slice(text, line, endLine) {
  const rows = text.split('\n');
  return rows.slice(line - 1, endLine);
}

function member(types, typeName, memberName) {
  const t = types.find((x) => x.name === typeName);
  return t?.members.find((m) => m.name === memberName);
}

// ── the heredoc-containing-`end` trap — the one that matters most ───────────────────────────────────

const HEREDOC_FIXTURE = [
  'class SpecWriter',
  '  def write(path)',
  '    File.open(path, "w") do |out|',
  '      out.write <<~EOF',
  '        Pod::Spec.new do |s|',
  '          s.name = "Demo"',
  '        end',
  '      EOF',
  '    end',
  '  end',
  '',
  '  def after_write',
  '    true',
  '  end',
  'end',
].join('\n');

console.log('\nheredoc body containing a bare `end` (the trap that already cost a day, in python.ts)');
{
  const types = ruby.surfaceOf(HEREDOC_FIXTURE);
  const write = member(types, 'SpecWriter', 'write');
  ok(!!write, 'write is found at all', JSON.stringify(types.map((t) => t.members.map((m) => m.name))));
  ok(write?.line === 2, 'its declaration line is right', String(write?.line));
  // The real bug this reproduces: a naive `end`-counter reads the heredoc's OWN `end` (line 7) as the
  // one closing `write`'s `do` block, then the REAL closing `end`s (lines 9, 10) as closing something
  // that already looks closed — `after_write` inherits the drift and its body swallows the rest of the
  // class, or is skipped entirely. line 10 is the true end of `write`.
  ok(write?.endLine === 10, 'its endLine is NOT the heredoc\'s internal `end`', String(write?.endLine));
  const body = slice(HEREDOC_FIXTURE, write.line, write.endLine);
  ok(body[0].trim().startsWith('def write'), 'the slice starts at the declaration', body[0].trim());
  ok(body[body.length - 1].trim() === 'end', 'and ends at write\'s OWN `end`, not the heredoc\'s', body[body.length - 1].trim());
  ok(!body.some((l) => l.includes('after_write')), 'the next method never leaks into this one\'s body');

  const after = member(types, 'SpecWriter', 'after_write');
  ok(after?.line === 12 && after?.endLine === 14, 'the NEXT method is unaffected by the heredoc drift',
    `${after?.line}-${after?.endLine}`);
  const afterBody = slice(HEREDOC_FIXTURE, after.line, after.endLine);
  ok(afterBody[0].trim().startsWith('def after_write'), 'and its own slice starts at its own declaration');
}

// ── =begin/=end block comments ───────────────────────────────────────────────────────────────────────

const BLOCKCOMMENT_FIXTURE = [
  'class Documented',
  '=begin',
  'This class does a thing.',
  'class FakeClass',
  '  def fake; end',
  'end',
  '=end',
  '  def real',
  '    1',
  '  end',
  'end',
].join('\n');

console.log('\n=begin/=end block comment hides class/def/end text from the scan');
{
  const types = ruby.surfaceOf(BLOCKCOMMENT_FIXTURE);
  ok(!types.some((t) => t.name === 'FakeClass'), 'the commented-out class is invisible', types.map((t) => t.name).join(','));
  const real = member(types, 'Documented', 'real');
  ok(real?.line === 8 && real?.endLine === 10, 'the real method after the comment block has the right range',
    `${real?.line}-${real?.endLine}`);
}

// ── positional visibility: private/public change the DEFAULT, not the declaration ──────────────────

const VIS_FIXTURE = [
  'class Widget',
  '  def pub_one',
  '  end',
  '',
  '  private',
  '',
  '  def priv_one',
  '  end',
  '',
  '  def priv_two',
  '  end',
  '',
  '  public',
  '',
  '  def pub_two',
  '  end',
  '',
  '  private def inline_private',
  '  end',
  '',
  '  def marked_after',
  '  end',
  '  private :marked_after',
  'end',
].join('\n');

console.log('\npositional private/public — a bare keyword changes every def AFTER it, not just one');
{
  const types = ruby.surfaceOf(VIS_FIXTURE);
  const w = types.find((t) => t.name === 'Widget');
  const vis = (name) => w.members.find((m) => m.name === name)?.visibility;
  ok(vis('pub_one') === 'public', 'before any `private`, the default is public', vis('pub_one'));
  ok(vis('priv_one') === 'private' && vis('priv_two') === 'private',
    'both methods after a bare `private` are private, not just the first', `${vis('priv_one')},${vis('priv_two')}`);
  ok(vis('pub_two') === 'public', 'a later bare `public` flips the default back', vis('pub_two'));
  ok(vis('inline_private') === 'private', '`private def x` sets ONE declaration without moving the default',
    vis('inline_private'));
  ok(vis('marked_after') === 'private', '`private :sym` retroactively marks an already-declared method',
    vis('marked_after'));
}

// ── attr_accessor / attr_reader / attr_writer are real members ─────────────────────────────────────

const ATTR_FIXTURE = [
  'class Config',
  '  attr_accessor :name, :size',
  '  attr_reader :id',
  '  attr_writer :secret',
  'end',
].join('\n');

console.log('\nattr_accessor/reader/writer generate real, nameable methods');
{
  const types = ruby.surfaceOf(ATTR_FIXTURE);
  const c = types.find((t) => t.name === 'Config');
  const names = c.members.map((m) => m.name).sort();
  ok(names.includes('name') && names.includes('name='), 'attr_accessor gives BOTH a reader and a writer', names.join(','));
  ok(names.includes('size') && names.includes('size='), 'for every symbol listed, not just the first');
  ok(names.includes('id') && !names.includes('id='), 'attr_reader gives ONLY a reader', names.join(','));
  ok(!names.includes('secret') && names.includes('secret='), 'attr_writer gives ONLY a writer', names.join(','));
}

// ── class << self, def self.x, def X.x — class methods without inventing a phantom type ────────────

const SCLASS_FIXTURE = [
  'class Factory',
  '  def self.build_one',
  '    new',
  '  end',
  '',
  '  class << self',
  '    private',
  '    def build_two',
  '      new',
  '    end',
  '',
  '    def build_three',
  '      new',
  '    end',
  '  end',
  '',
  '  def instance_method',
  '  end',
  'end',
].join('\n');

console.log('\n`class << self` attaches its methods to the ENCLOSING class, not a phantom type');
{
  const types = ruby.surfaceOf(SCLASS_FIXTURE);
  ok(types.length === 1 && types[0].name === 'Factory', 'no extra type was invented for the singleton class',
    types.map((t) => t.name).join(','));
  const f = types[0];
  const b1 = f.members.find((m) => m.name === 'build_one');
  ok(b1?.sig?.includes('self.build_one'), 'def self.x keeps the receiver in `sig`', b1?.sig);
  ok(b1?.line === 2 && b1?.endLine === 4, 'and gets a correct range', `${b1?.line}-${b1?.endLine}`);
  const b2 = f.members.find((m) => m.name === 'build_two');
  ok(b2?.visibility === 'private', '`private` INSIDE class << self applies there', b2?.visibility);
  const inst = f.members.find((m) => m.name === 'instance_method');
  ok(inst?.visibility === 'public', 'and does not leak out to make instance methods private afterward', inst?.visibility);
}

// ── endless methods ──────────────────────────────────────────────────────────────────────────────────

const ENDLESS_FIXTURE = [
  'class Geometry',
  '  def square(x) = x * x',
  '  def self.origin = new',
  '  def normal_method',
  '    1',
  '  end',
  'end',
].join('\n');

console.log('\nendless methods take no `end` — line === endLine, and the NEXT method is not swallowed');
{
  const types = ruby.surfaceOf(ENDLESS_FIXTURE);
  const g = types.find((t) => t.name === 'Geometry');
  const sq = g.members.find((m) => m.name === 'square');
  ok(sq?.line === 2 && sq?.endLine === 2, 'square is a one-line member', `${sq?.line}-${sq?.endLine}`);
  const origin = g.members.find((m) => m.name === 'origin');
  ok(origin?.line === 3 && origin?.endLine === 3, 'so is a self. endless method', `${origin?.line}-${origin?.endLine}`);
  const normal = g.members.find((m) => m.name === 'normal_method');
  ok(normal?.line === 4 && normal?.endLine === 6, 'and the following real method keeps its own correct range',
    `${normal?.line}-${normal?.endLine}`);
}

// ── a `do` block, an `if`, and nested conditionals inside a method body ─────────────────────────────

const DO_BLOCK_FIXTURE = [
  'class Runner',
  '  def process(items)',
  '    items.each do |item|',
  '      if item.valid?',
  '        puts item',
  '      elsif item.nil?',
  '        next',
  '      else',
  '        raise "bad"',
  '      end',
  '    end',
  '    return unless items.any?',
  '  end',
  '',
  '  def after_process',
  '    2',
  '  end',
  'end',
].join('\n');

console.log('\na `do` block and a nested if/elsif/else inside a method — the ordinary case, deliberately');
{
  const types = ruby.surfaceOf(DO_BLOCK_FIXTURE);
  const r = types.find((t) => t.name === 'Runner');
  const proc = r.members.find((m) => m.name === 'process');
  ok(proc?.line === 2 && proc?.endLine === 13, 'the do/if/elsif/else nesting resolves to the right endLine',
    `${proc?.line}-${proc?.endLine}`);
  const body = slice(DO_BLOCK_FIXTURE, proc.line, proc.endLine);
  ok(body[0].trim().startsWith('def process'), 'starts at the declaration');
  ok(body[body.length - 1].trim() === 'end', 'ends at its own `end`', body[body.length - 1].trim());
  const after = r.members.find((m) => m.name === 'after_process');
  ok(after?.line === 15 && after?.endLine === 17, 'the trailing `return unless x` modifier opened nothing extra',
    `${after?.line}-${after?.endLine}`);
}

// ── string/regex/percent-literal traps that are NOT structure ───────────────────────────────────────

const LITERAL_FIXTURE = [
  'class Parser',
  '  WORDS = %w[class def end module]',
  '  PATTERN = /^end\\b.*#\\{x\\}/',
  '',
  '  def greet(name)',
  '    "hello #{name}, the word \'end\' is not a keyword here"',
  '  end',
  '',
  '  def after_literals',
  '    1',
  '  end',
  'end',
].join('\n');

console.log('\n%w[], a regex literal, and string interpolation must not be read as structure');
{
  const types = ruby.surfaceOf(LITERAL_FIXTURE);
  const p = types.find((t) => t.name === 'Parser');
  ok(!!p, 'the class itself is still found despite `class`/`def`/`end` appearing inside %w[] and a regex');
  const greet = p.members.find((m) => m.name === 'greet');
  ok(greet?.line === 5 && greet?.endLine === 7, 'a string containing the word `end` does not close the method early',
    `${greet?.line}-${greet?.endLine}`);
  const after = p.members.find((m) => m.name === 'after_literals');
  ok(after?.line === 9 && after?.endLine === 11, 'and the next real method is unaffected', `${after?.line}-${after?.endLine}`);
}

// ── module — a mixin declares a surface, not a unit ─────────────────────────────────────────────────

console.log('\nmodule → interface, the same call made for a Dart mixin / Python Protocol');
{
  const types = ruby.surfaceOf(['module Greetable', '  def hello', '  end', 'end'].join('\n'));
  ok(types[0]?.kind === 'interface', 'module gets kind interface, not class', types[0]?.kind);
}

// ── require vs require_relative ─────────────────────────────────────────────────────────────────────

console.log('\nreferencesOf: require crosses the unit boundary, require_relative does not');
{
  const refs = ruby.referencesOf([
    "require 'json'",
    "require 'net/http'",
    "require_relative '../lib/helper'",
    "require_relative './sibling'",
  ].join('\n'));
  ok(refs.includes('json'), 'a plain gem/stdlib require is reported', refs.join(','));
  ok(refs.includes('net'), 'a multi-segment require reduces to its top segment', refs.join(','));
  ok(!refs.some((r) => r.includes('helper') || r.includes('sibling')), 'require_relative is never reported', refs.join(','));
}

// ── domainOf: gemspec wins over a Gemfile in the SAME directory ─────────────────────────────────────

console.log('\ndomainOf: a gemspec beats a Gemfile at the same directory; either alone still works');
{
  const repo = mkdtempSync(join(tmpdir(), 'ayin-ruby-'));
  const write = (rel, body) => {
    const p = join(repo, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return p;
  };

  write('both/demo.gemspec', [
    'Gem::Specification.new do |spec|',
    '  spec.name = "demo_gem"',
    '  spec.add_dependency "activesupport"',
    '  spec.add_development_dependency "rspec"',
    'end',
  ].join('\n'));
  write('both/Gemfile', "source 'https://rubygems.org'\ngemspec\ngem 'rubocop'\n");
  const bothFile = write('both/lib/thing.rb', 'class Thing\nend\n');
  const dBoth = ruby.domainOf(bothFile);
  ok(dBoth?.name === 'demo_gem', 'the gemspec\'s own name wins over the Gemfile', dBoth?.name);
  ok(dBoth?.allows.includes('activesupport') && dBoth?.allows.includes('rspec'),
    'and its runtime + dev dependencies are both read', dBoth?.allows.join(','));
  ok(!dBoth?.allows.includes('rubocop'), 'the sibling Gemfile\'s own gems are NOT pulled in once the gemspec wins',
    dBoth?.allows.join(','));

  // A real Gemfile found on this machine (an RSpec test suite's), reproduced verbatim in shape.
  write('gemfile-only/Gemfile', "source 'https://rubygems.org'\n\ngem 'rspec'\ngem 'rspec-wait'\ngem 'pry-byebug'\n");
  const gemfileOnlyFile = write('gemfile-only/spec/thing_spec.rb', 'RSpec.describe("x") {}\n');
  const dGemfile = ruby.domainOf(gemfileOnlyFile);
  ok(dGemfile?.allows.includes('rspec') && dGemfile?.allows.includes('pry-byebug'),
    'with no gemspec present, the Gemfile alone is read correctly', dGemfile?.allows.join(','));

  rmSync(repo, { recursive: true, force: true });
}

// ── isPlatform / isBuiltinType do not false-stop on ordinary Ruby furniture ─────────────────────────

console.log('\nisPlatform / isBuiltinType');
{
  ok(ruby.isPlatform('json'), 'json is the standard library, never a chosen dependency');
  ok(ruby.isPlatform('net'), 'a multi-segment stdlib require reduces to a platform top segment');
  ok(!ruby.isPlatform('activesupport'), 'a real gem is not waved through as platform', String(ruby.isPlatform('activesupport')));
  ok(ruby.isBuiltinType('String') && ruby.isBuiltinType('Hash') && ruby.isBuiltinType('StandardError'),
    'core furniture is builtin — a false stop on String makes the tool unusable');
}

console.log(fails ? `\nruby check: ${fails} FAILURE(S)\n` : '\nruby check: ok\n');
process.exit(fails ? 1 : 0);
