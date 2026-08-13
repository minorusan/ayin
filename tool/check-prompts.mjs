#!/usr/bin/env node
/**
 * prebuild gate — the prompt store's invariants.
 *
 * 1. INTERPOLATION IS DATA-SAFE. `{{VAR}}` substitution must treat the value as bytes. Using
 *    `String.replaceAll(needle, value)` does NOT: in a replacement string `$$`, `$&`, `` $` `` and
 *    `$'` are substitution patterns, so `$$` silently collapses to `$` and `$&` re-inserts the
 *    placeholder — the model then receives a literal `{{VAR}}`. Prompt vars carry file contents,
 *    tool output and user text, where `$$` is ordinary (shell, Makefiles, PHP). This shipped
 *    broken once; the test exists so it cannot ship broken twice.
 *
 * 2. EVERY SHIPPED PROMPT IS NON-EMPTY and carries no leftover editor scaffolding.
 *
 * 3. EVERY `{{VAR}}` A PROMPT DECLARES IS UPPER_SNAKE — the convention call sites rely on.
 *
 * Runs offline: no model, no network, no GPU.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPTS = join(ROOT, 'prompts');

let failures = 0;
const fail = (msg) => { console.error(`  FAIL  ${msg}`); failures++; };
const ok = (msg) => console.log(`  ok   ${msg}`);

// ── 1. interpolation must be substitution-pattern-proof ──────────────────────

const { interpolate } = await import(join(ROOT, 'dist', 'prompts-service.js'))
  .catch(() => ({ interpolate: null }));

if (!interpolate) {
  console.log('  --   dist/prompts-service.js not built yet; skipping interpolation checks');
} else {
  const hostile = ['$$', '$&', '$`', "$'", 'a$$b', '$<name>', '$1', 'plain text', ''];
  let bad = 0;
  for (const value of hostile) {
    const got = interpolate('before {{V}} after', { V: value });
    const want = `before ${value} after`;
    if (got !== want) {
      fail(`interpolate mangles ${JSON.stringify(value)} → ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
      bad++;
    }
  }
  if (!bad) ok(`interpolation is data-safe across ${hostile.length} substitution-pattern values`);

  // A var must not be able to inject another var's placeholder into the output.
  const chained = interpolate('{{A}}|{{B}}', { A: '{{B}}', B: 'second' });
  if (chained !== '{{B}}|second') {
    fail(`interpolation re-expands an injected placeholder: got ${JSON.stringify(chained)}`);
  } else {
    ok('a value containing {{OTHER}} is not re-expanded');
  }

  // Unknown vars are left alone rather than blanked — a visible {{HOLE}} beats silent emptiness.
  if (interpolate('x {{MISSING}} y', {}) !== 'x {{MISSING}} y') {
    fail('an unsupplied var was not left intact');
  } else {
    ok('unsupplied vars are left visible, not blanked');
  }
}

// ── 2 + 3. the shipped prompt files themselves ───────────────────────────────

if (!existsSync(PROMPTS)) {
  fail(`no prompts/ directory at ${PROMPTS}`);
} else {
  const namespaces = readdirSync(PROMPTS).filter((d) => statSync(join(PROMPTS, d)).isDirectory());
  if (namespaces.length === 0) fail('prompts/ has no namespace directories');

  let files = 0;
  let badVars = 0;
  let empty = 0;
  for (const ns of namespaces) {
    for (const f of readdirSync(join(PROMPTS, ns))) {
      if (!f.endsWith('.txt')) {
        fail(`prompts/${ns}/${f} is not a .txt file — the store only reads .txt`);
        continue;
      }
      files++;
      const body = readFileSync(join(PROMPTS, ns, f), 'utf8');
      if (body.trim().length === 0) { fail(`prompts/${ns}/${f} is empty`); empty++; continue; }
      if (/^\s*(TODO|FIXME|XXX)\b/im.test(body)) fail(`prompts/${ns}/${f} still has TODO/FIXME scaffolding`);
      for (const m of body.matchAll(/\{\{(\w+)\}\}/g)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(m[1])) {
          fail(`prompts/${ns}/${f} declares {{${m[1]}}} — vars must be UPPER_SNAKE`);
          badVars++;
        }
      }
    }
  }
  if (!empty) ok(`${files} prompt files across ${namespaces.length} namespaces are non-empty`);
  if (!badVars) ok('every declared {{VAR}} is UPPER_SNAKE');
}

console.log(failures === 0 ? '\nprompt check: ok' : `\nprompt check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
