#!/usr/bin/env node
/**
 * check-testrun — selection, staleness, and the confirm delegate.
 *
 * `npm run check:testrun` (needs a build first). No .NET, no Unity, no network — and that is the
 * point of the split: everything that DECIDES what to run is pure and testable anywhere, while the
 * part that shells out to NUnit or Unity is deliberately thin.
 *
 * What these stand in front of:
 *
 *   1. **Ownership by path SEGMENT, not string prefix.** The real project has both
 *      `Assets/Scripts/LiveOps` and `Assets/Scripts/LiveOpsChallenges`. A `startsWith` on the raw
 *      string hands every LiveOpsChallenges file to the LiveOps assembly, and the run then tests the
 *      wrong code and passes.
 *   2. **Staleness refuses rather than reports green.** A DLL older than its sources tests code that
 *      no longer exists. A confident wrong pass is the single worst thing this feature could emit.
 *   3. **`confirm` returns null with nobody to ask, and index 0 is a real answer.** The dialog
 *      resolves an INDEX; `picked ? … : null` would silently turn "the operator chose the first
 *      option" into a refusal — and the first option is the safe one, so the bug would look like
 *      the feature simply never working.
 *   4. **NOT RUN is never folded into a pass.**
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'ayin-testrun-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const asm = await import(join(ROOT, 'dist/testrun/asmdef.js'));
const run = await import(join(ROOT, 'dist/testrun/run.js'));
const idx = await import(join(ROOT, 'dist/testrun/index.js'));

// ── a synthetic Unity project with the shapes that actually bite ─────────────────

const P = mkdtempSync(join(tmpdir(), 'ayin-unityproj-'));
const w = (rel, text) => {
  const p = join(P, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  return p;
};
// Unity guids are 32 HEX characters, and asmdef.ts matches them as such — a fixture that emits
// `rewards000…` would be rejected for containing `w` and `s`, which is the matcher being right.
const guidOf = (name) => {
  let h = 0x811c9dc5;
  let out = '';
  for (let i = 0; i < 4; i++) {
    for (const ch of `${name}#${i}`) { h = ((h ^ ch.charCodeAt(0)) * 0x01000193) >>> 0; }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 32);
};
const asmdef = (rel, name, extra = {}) => {
  w(rel, { name, references: [], includePlatforms: [], precompiledReferences: [], ...extra });
  w(`${rel}.meta`, `fileFormatVersion: 2\nguid: ${guidOf(name)}\n`);
};

w('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2020.3.38f1\n');

// The pair that breaks prefix matching.
asmdef('Assets/Scripts/LiveOps/LiveOps.asmdef', 'LiveOps');
w('Assets/Scripts/LiveOps/ScoreMaster.cs', 'class ScoreMaster {}');
asmdef('Assets/Scripts/LiveOpsChallenges/LiveOpsChallenges.asmdef', 'LiveOpsChallenges');
w('Assets/Scripts/LiveOpsChallenges/Quest.cs', 'class Quest {}');

// Production + its tests, referenced BY GUID like the real project does.
asmdef('Assets/Games/Rewards/Rewards.asmdef', 'Rewards');
w('Assets/Games/Rewards/RewardService.cs', 'class RewardService {}');
asmdef('Assets/Games/Rewards/Tests/Rewards.PlayTests.asmdef', 'Rewards.PlayTests', {
  references: [`GUID:${guidOf('Rewards')}`],
  precompiledReferences: ['nunit.framework.dll', 'Moq.dll'],
});
// Declares NO precompiledReferences and marks itself with the define constraint instead — the real
// project has six of these, and the first version of isTest classified every one as production code.
asmdef('Assets/Games/Splash/Tests/Editor/Splash.Editor.Tests.asmdef', 'Splash.Editor.Tests', {
  references: [`GUID:${guidOf('Core')}`],
  precompiledReferences: [],
  defineConstraints: ['UNITY_INCLUDE_TESTS'],
  includePlatforms: ['Editor'],
});
w('Assets/Games/Splash/Tests/Editor/SplashTests.cs', 'class SplashTests {}');
// A HUB: referenced by every test assembly, so referencing it proves nothing.
asmdef('Assets/Scripts/Core.asmdef', 'Core');
w('Assets/Scripts/Core/Thing.cs', 'class Thing {}');
// Central test directory, nowhere near the code it covers — only the NAME connects them.
asmdef('Assets/Tests/SplashScreenTests/SplashScreenTests.asmdef', 'SplashScreenTests', {
  references: [`GUID:${guidOf('Core')}`],
  precompiledReferences: ['nunit.framework.dll'],
});
w('Assets/Tests/SplashScreenTests/T.cs', 'class T {}');
w('Assets/Scripts/SplashScreen/SplashScreenLoader.cs', 'class SplashScreenLoader {}');
// Enough test assemblies leaning on the hub that it actually reads as one. The ambient rule is a
// SHARE of test assemblies, so a three-assembly fixture cannot exercise it — and a fixture too small
// to reproduce the bug is a fixture that would have shipped it.
for (const n of [1, 2, 3]) {
  asmdef(`Assets/Tests/Generic${n}/Generic${n}.asmdef`, `Generic${n}`, {
    references: [`GUID:${guidOf('Core')}`],
    precompiledReferences: ['nunit.framework.dll'],
  });
  w(`Assets/Tests/Generic${n}/G.cs`, 'class G {}');
}
w('Assets/Games/Rewards/Tests/RewardServiceTests.cs', 'class RewardServiceTests {}');

// An EditMode test assembly, and one that is NOT a test at all.
asmdef('Assets/Scripts/LiveOps/Tests/Editor/LiveOps.Tests.Editor.asmdef', 'LiveOps.Tests.Editor', {
  references: [`GUID:${guidOf('LiveOps')}`],
  precompiledReferences: ['nunit.framework.dll'],
  includePlatforms: ['Editor'],
});
w('Assets/Scripts/LiveOps/Tests/Editor/ScoreMasterTests.cs', 'class ScoreMasterTests {}');

const index = asm.buildAsmdefIndex(P);

// ── 1 · the index and the segment trap ───────────────────────────────────────────

ok(index.all.length === 11, 'every asmdef is indexed', String(index.all.length));
ok(index.byName.get('Rewards.PlayTests')?.isTest === true,
  'NUnit in precompiledReferences marks a test assembly — naming conventions do not');
ok(index.byName.get('Rewards')?.isTest === false, 'a production assembly is not a test assembly');
ok(index.byName.get('LiveOps.Tests.Editor')?.editorOnly === true, 'includePlatforms:["Editor"] is EditMode');
ok(index.byName.get('Rewards.PlayTests')?.editorOnly === false, 'includePlatforms:[] is PlayMode');

const owner = asm.owningAsmdef(index, 'Assets/Scripts/LiveOpsChallenges/Quest.cs');
ok(owner?.name === 'LiveOpsChallenges',
  'LiveOpsChallenges/Quest.cs belongs to LiveOpsChallenges, NOT to LiveOps',
  owner?.name);
ok(asm.owningAsmdef(index, 'Assets/Games/Rewards/Tests/RewardServiceTests.cs')?.name === 'Rewards.PlayTests',
  'a nested asmdef takes its subtree out of the parent — nearest ancestor wins');

// ── 2 · tests → production, in the right direction ───────────────────────────────

ok(index.byName.get('Splash.Editor.Tests')?.isTest === true,
  'UNITY_INCLUDE_TESTS marks a test assembly with EMPTY precompiledReferences — six real ones look like this');

// ── the hub, and the three admissible reasons ────────────────────────────────────

const ambient = asm.ambientAssemblies(index);
ok(ambient.has('Core'),
  'an assembly referenced by most test assemblies is AMBIENT — the real project selected 25 of 26 without this');

const viaName = asm.coverageFor(index, ['Assets/Scripts/SplashScreen/SplashScreenLoader.cs']);
ok(viaName.length === 1 && viaName[0].asmdef.name === 'SplashScreenTests' && viaName[0].reason === 'named',
  'a test assembly in a central Tests/ dir is found by NAME — nothing else on disk connects them',
  viaName.map((c) => `${c.asmdef.name}:${c.reason}`).join(' '));
ok(asm.testSubjects('Vendor.SplashScreen.Editor.Tests').includes('splashscreen'),
  'every dotted segment is a candidate subject — picking one means guessing which is the vendor prefix, and that guess breaks on the next convention',
  asm.testSubjects('Vendor.SplashScreen.Editor.Tests').join(','));

const hubOnly = asm.coverageFor(index, ['Assets/Scripts/Core/Thing.cs']);
ok(hubOnly.length === 0,
  'a file owned only by the hub, with no test named or near it, selects almost nothing — never everything',
  String(hubOnly.length));

const covering = asm.testAssembliesCovering(index, ['Assets/Games/Rewards/RewardService.cs']);
ok(covering.length === 1 && covering[0].name === 'Rewards.PlayTests',
  'a test assembly is selected because it REFERENCES the file\'s assembly (GUID-resolved)',
  covering.map((c) => c.name).join(' '));
ok(asm.testAssembliesCovering(index, ['Assets/Scripts/LiveOpsChallenges/Quest.cs']).length === 0,
  'a file nothing tests selects nothing — not everything, not the nearest name');
const self = asm.testAssembliesCovering(index, ['Assets/Games/Rewards/Tests/RewardServiceTests.cs']);
ok(self.length === 1, 'asking about a test file runs that test assembly itself');

// ── 3 · staleness — the assertion that stops a false green ───────────────────────

const target = index.byName.get('Rewards.PlayTests');
let state = asm.compiledState(P, [target]);
ok(state[0].dll === null && state[0].stale === false,
  'never compiled is reported as missing, NOT as stale — those send you looking for different things');

mkdirSync(join(P, 'Library', 'ScriptAssemblies'), { recursive: true });
const dll = join(P, 'Library', 'ScriptAssemblies', 'Rewards.PlayTests.dll');
writeFileSync(dll, 'MZ');
const past = Date.now() / 1000 - 3600;
utimesSync(dll, past, past);                                  // DLL an hour older than the sources
state = asm.compiledState(P, [target]);
ok(state[0].stale === true, 'sources newer than the DLL is STALE — running it would test code that is gone');

const future = Date.now() / 1000 + 60;
utimesSync(dll, future, future);
state = asm.compiledState(P, [target]);
ok(state[0].stale === false, 'a DLL newer than every source is current');

// ── 4 · the Unity facts ──────────────────────────────────────────────────────────

ok(asm.isUnityProject(P), 'a directory with ProjectSettings/Assets is a Unity project');
ok(asm.unityVersion(P) === '2020.3.38f1', 'the pinned Editor version is read from ProjectVersion.txt', asm.unityVersion(P));
ok(asm.unityHasProjectOpen(P) === false, 'no lockfile means the Editor does not hold it');
mkdirSync(join(P, 'Temp'), { recursive: true });
writeFileSync(join(P, 'Temp', 'UnityLockfile'), '');
ok(asm.unityHasProjectOpen(P) === true, 'Temp/UnityLockfile is how we know the Editor has it open');

// ── 5 · NUnit XML ────────────────────────────────────────────────────────────────

const xml = `<?xml version="1.0"?><test-run>
<test-case fullname="A.B.Passes" result="Passed" duration="0.012"/>
<test-case fullname="A.B.Fails" result="Failed" duration="0.5">
  <failure><message><![CDATA[Expected: 250 But was: 100]]></message></failure>
</test-case>
<test-case fullname="A.B.Skipped" result="Skipped" duration="0"/>
</test-run>`;
const cases = run.parseNUnitXml(xml);
ok(cases.length === 3, 'every test-case is parsed, self-closing and paired alike', String(cases.length));
const failed = cases.find((c) => c.outcome === 'failed');
ok(failed?.name === 'A.B.Fails', 'fullname is preferred over name — it is what you paste into a filter');
ok(/Expected: 250/.test(failed?.message ?? ''), 'the assertion message survives, CDATA and all', failed?.message);
ok(run.tally('X', cases).passed === 1 && run.tally('X', cases).failed === 1 && run.tally('X', cases).skipped === 1,
  'the tally counts each outcome exactly once');
ok(run.parseNUnitXml('not xml at all').length === 0, 'garbage parses to zero cases, never to a pass');

// ── 6 · NOT RUN is never a pass ──────────────────────────────────────────────────

const report = idx.formatReport({
  selection: { domains: ['reward service'], files: [], assemblies: [{ name: 'A' }, { name: 'B' }], guessed: false },
  mode: 'prebuilt',
  outcomes: [
    run.tally('A', cases),
    { assembly: 'B', passed: 0, failed: 0, skipped: 0, cases: [], notRun: 'could not load' },
  ],
});
ok(/NOT RUN/.test(report), 'a not-run assembly is named in the report');
ok(/1 assembly\(ies\) NOT RUN/.test(report), 'and counted in the summary line, outside the totals');
ok(/not a pass/.test(report), 'and the report says in words that it is not a pass');
ok(!/^0 failed/m.test(report), 'the summary does not read as clean while an assembly failed to load');

const guessed = idx.formatReport({
  selection: { domains: ['x'], files: [], assemblies: [], guessed: true },
  mode: 'none', outcomes: [], note: 'no test assemblies matched those domains',
});
ok(/guess/i.test(guessed), 'a name-matched selection says it guessed — a silent wrong selection that passes is the worst case');

// ── 7 · the confirm delegate ─────────────────────────────────────────────────────

const rt = await import(join(ROOT, 'dist/tools/runtime.js'));
const wiring = await import(join(ROOT, 'dist/tool-wiring.js'));
wiring.ensureToolRuntime();
const answer = await rt.toolConfirm('q?', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
ok(answer === null, 'headless confirm returns null — nobody to ask is a REFUSAL, never a default yes', String(answer));

const wiringSrc = (await import('node:fs')).readFileSync(join(ROOT, 'src/tool-wiring.ts'), 'utf-8');
ok(/picked < 0 \|\| picked >= choices\.length/.test(wiringSrc),
  'the index is range-checked, so choosing the FIRST option is not read as a refusal');
ok(!/picked \? String\(picked\)/.test(wiringSrc), 'and never truthiness-tested — index 0 is falsy and a real answer');
ok(/HEADLESS/.test(wiringSrc), 'the headless branch exists in the delegate, not in each tool');

rmSync(P, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\ntestrun check: ${fails} FAILURE(S)\n` : '\ntestrun check: ok\n');
process.exit(fails ? 1 : 0);
