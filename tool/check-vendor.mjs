#!/usr/bin/env node
/**
 * check-vendor — third-party pruning, and the ways it must refuse to be wrong.
 *
 * The asymmetry is the whole design: a vendor file wrongly indexed wastes a few questions, while a
 * first-party directory wrongly skipped is knowledge silently missing from a corpus that still looks
 * like it succeeded. So every assertion here is about REFUSING, not about catching more.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.argv.push('-p');

let fails = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!c) fails++;
};

const {
  candidateDirs, knownVendorRoots, undecided, isUnderVendorRoot, detectVendorRoots,
} = await import('../dist/indulge/vendor.js');

// A repo shaped like a real Unity project: first-party games, vendor imports, and a decoy.
const R = mkdtempSync(join(tmpdir(), 'ayin-vendor-'));
for (const d of [
  'Assets/Games/Bingo', 'Assets/Games/Solitaire', 'Assets/Scripts/Managers',
  'Assets/Plugins/Zenject', 'Assets/Firebase/Editor', 'Assets/TextMesh Pro/Fonts',
  'Assets/Art/Sprites', 'Packages/com.unity.x', 'Library/ScriptAssemblies',
]) mkdirSync(join(R, d), { recursive: true });

console.log('the free pass: names we already know');
{
  const c = candidateDirs(R);
  const k = knownVendorRoots(c);
  ok(k.includes('Assets/Plugins'), 'Plugins is third-party');
  ok(k.includes('Assets/Firebase'), 'a named SDK is third-party');
  ok(k.includes('Assets/TextMesh Pro'), 'a name with a space still matches');
  ok(!k.some((r) => r.startsWith('Assets/Games')), 'the team\'s own games are NEVER skipped by name');
  ok(!k.includes('Assets'), 'the source root is not a vendor name');
  ok(undecided(c, k).every((u) => !u.path.startsWith('Assets/Plugins/')),
    'nothing inside a known vendor root is sent to the model — that decision is already made');
}

console.log('\nthe model pass is OFF by default');
{
  // It failed twice out of two repos: 54/63 directories on a Unity repo, and ayin's own `src/tools`,
  // `src/ui`, `tool/` and every `prompts/*`. Both times the corpus reported success while knowing
  // nothing. The static list caught every genuine vendor root in both, for free.
  let asked = 0;
  const counting = async () => { asked++; return 'Assets/Games/Bingo'; };
  const r = await detectVendorRoots({
    repoPath: R, corpusDir: mkdtempSync(join(tmpdir(), 'ayin-vendor-d-')), ask: counting,
  });
  ok(asked === 0, 'no model is asked unless --classify-vendor is passed', `${asked} call(s)`);
  ok(r.roots.includes('Assets/Plugins'), '…and the static list still applies');
  ok(!r.roots.includes('Assets/Games/Bingo'), '…so nothing first-party is pruned on a default run');
}

console.log('\nthe model pass refuses to be wrong');
{
  // A hostile classifier: names the world, names something real, and invents a path never offered.
  const hostile = async () => 'Assets\nAssets/Art\n/etc/passwd\nAssets/Games/Bingo\n';
  const r = await detectVendorRoots({
    repoPath: R, corpusDir: mkdtempSync(join(tmpdir(), 'ayin-vendor-c-')), ask: hostile, classify: true,
  });
  ok(!r.roots.includes('Assets'),
    'a pick that swallows most of the tree is REFUSED — it would empty the corpus while looking like success');
  ok(!r.roots.includes('/etc/passwd'),
    'a path that was never offered is refused — a model naming something new is guessing');
  ok(r.roots.includes('Assets/Plugins'), 'the known names still apply');
  ok(r.roots.includes('Assets/Art'), 'a legitimate pick from the offered list is honoured');
}

console.log('\nan answer that marks most of the repo is discarded WHOLESALE');
{
  // The per-pick guard is necessary and not sufficient. A real classifier said third-party to 54 of
  // 63 directories — every pick individually small, together the whole repository, including the very
  // subsystem the build was about. Discovery then indexed ONE file and reported success.
  const greedy = async (dirs) => dirs.join('\n');   // says yes to everything offered
  const r = await detectVendorRoots({
    repoPath: R, corpusDir: mkdtempSync(join(tmpdir(), 'ayin-vendor-g-')), ask: greedy, classify: true,
  });
  ok(!r.roots.includes('Assets/Games/Bingo'),
    'a wholesale yes does not prune first-party code');
  ok(r.roots.includes('Assets/Plugins'),
    '…while the statically KNOWN names still apply — those were never inferred');
  ok(r.roots.every((x) => !x.startsWith('Assets/Games')),
    'no part of the greedy answer survives — it is discarded, not sampled');
}

console.log('\na failed classification degrades, it does not fail the build');
{
  const boom = async () => { throw new Error('provider down'); };
  const r = await detectVendorRoots({
    repoPath: R, corpusDir: mkdtempSync(join(tmpdir(), 'ayin-vendor-e-')), ask: boom, classify: true,
  });
  ok(r.roots.includes('Assets/Plugins'),
    'the static list survives a dead classifier — an overnight build must not die on a nice-to-have');
}

console.log('\nthe decision is cached, so the model is asked once per repository');
{
  const dir = mkdtempSync(join(tmpdir(), 'ayin-vendor-k-'));
  let calls = 0;
  const counting = async () => { calls++; return ''; };
  await detectVendorRoots({ repoPath: R, corpusDir: dir, ask: counting, classify: true });
  const second = await detectVendorRoots({ repoPath: R, corpusDir: dir, ask: counting, classify: true });
  ok(calls === 1, 'the second run asks nothing', `${calls} call(s)`);
  ok(second.fromCache === true, '…and says it came from cache');
  const forced = await detectVendorRoots({ repoPath: R, corpusDir: dir, ask: counting, refresh: true, classify: true });
  ok(calls === 2 && forced.fromCache === false, '--rescan-vendor re-decides');
}

console.log('\npath matching');
{
  const roots = ['Assets/Plugins', 'Packages'];
  ok(isUnderVendorRoot('Assets/Plugins/Zenject/Foo.cs', roots), 'a file inside a root is pruned');
  ok(isUnderVendorRoot('Assets/Plugins', roots), 'the root itself is pruned');
  ok(!isUnderVendorRoot('Assets/PluginsOfMine/Foo.cs', roots),
    'a PREFIX match is not a path match — Assets/PluginsOfMine is not inside Assets/Plugins');
  ok(!isUnderVendorRoot('Assets/Games/Bingo/Foo.cs', roots), 'first-party files are kept');
}

console.log(fails ? `\nvendor check: ${fails} FAILED` : '\nvendor check: all good');
process.exit(fails ? 1 : 0);
