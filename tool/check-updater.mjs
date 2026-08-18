#!/usr/bin/env node
/**
 * check-updater — the update must not be blocked by its own output.
 *
 * `ayin update` runs `npm install`, and npm rewrites the lockfile routinely (different npm version,
 * different platform, an optional dependency resolving differently). A successful update therefore
 * left the tree dirty in exactly one file, and the NEXT update refused to run — every time, until the
 * operator learned to pass --force. A guard that trains people to bypass it is worse than no guard,
 * because the day it has something real to say they will bypass that too.
 */

import { readFileSync } from 'node:fs';

let fails = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!c) fails++;
};

const src = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf-8');

console.log('the dirty check ignores what the update itself writes');
ok(/const SELF_WRITTEN = new Set\(\['package-lock\.json', 'npm-shrinkwrap\.json'\]\);/.test(src),
  'the lockfile is named explicitly as self-written');
ok(/\.filter\(\(line\) => !SELF_WRITTEN\.has\(line\.slice\(3\)\.trim\(\)\)\)/.test(src),
  'it is filtered out of the porcelain lines before the refusal is decided');
ok(/if \(blocking\.length && !opts\.force\)/.test(src),
  'the refusal is on the FILTERED list, not the raw one');

console.log('\nbut the guard still guards');
{
  const set = /const SELF_WRITTEN = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? '';
  const names = set.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  ok(names.length === 2 && names.every((n) => /lock|shrinkwrap/.test(n)),
    'ONLY lockfiles are exempt — "ignore anything generated" is how a guard stops guarding',
    names.join(', '));
}
ok(/for \(const line of blocking\.slice\(0, 5\)\)/.test(src),
  'when it does refuse it NAMES the files, so the operator can act instead of guessing');

console.log('\nand it says when it decided for you');
ok(/Ignoring local changes to the lockfile/.test(src),
  'a pull over a modified lockfile is announced, not silently swallowed');

// The porcelain format is `XY path`, so the slice(3) above must line up with real git output.
console.log('\nthe porcelain parse matches real git output');
{
  const line = ' M package-lock.json';
  ok(line.slice(3).trim() === 'package-lock.json',
    'a modified-unstaged line yields the bare path', line.slice(3).trim());
  const staged = 'M  package-lock.json';
  ok(staged.slice(3).trim() === 'package-lock.json', 'a staged line does too');
  const renamed = 'R  old.json -> package-lock.json';
  ok(renamed.slice(3).trim() !== 'package-lock.json',
    'a RENAME is not treated as the lockfile — it is a real change and must still block');
}

console.log(fails ? `\nupdater check: ${fails} FAILED` : '\nupdater check: all good');
process.exit(fails ? 1 : 0);
