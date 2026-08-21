#!/usr/bin/env node
/**
 * check-unity — the `ayin unity` namespace: four subcommands, one Unity project, no Editor.
 *
 * `npm run check:unity` (needs a build). HERMETIC: a small Unity project in a temp directory — asmdefs,
 * a prefab, a controller — so it passes on a clone with no Unity anywhere and never touches a real one.
 *
 * What has to hold:
 *   · SELECTION BY ASSEMBLY NAME. A typo must be refused with the near-misses named, never resolved to
 *     "close enough" — running the wrong tests and passing is the failure that costs a day.
 *   · PlayMode vs EditMode is reported, because it decides how long the run takes and whether the
 *     Editor has to let go of the project.
 *   · CURT. One line on success, only the failures on failure. `-v` for the full report.
 *   · The namespace is registered in the two places a subcommand must be: the flag validator (or its own
 *     flags are rejected on sight) and the no-TUI list (or it prints its answer and then opens an
 *     alternate screen to tear it down, clearing the terminal it just wrote to).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
process.argv.push('-p');   // never take the terminal

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

/** Run a subcommand with stdout/stderr captured — the output IS the interface here. */
async function run(argv) {
  const { runUnityCli } = await import(`file://${join(DIST, 'unity', 'cli.js')}`);
  const chunks = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  process.stderr.write = (s) => { chunks.push(String(s)); return true; };
  let code;
  try { code = await runUnityCli(argv); }
  finally { process.stdout.write = realOut; process.stderr.write = realErr; }
  return { code, text: chunks.join('') };
}

// ── a Unity project ──────────────────────────────────────────────────────────────

const project = mkdtempSync(join(tmpdir(), 'ayin-unity-'));
const w = (rel, text) => { mkdirSync(join(project, dirname(rel)), { recursive: true }); writeFileSync(join(project, rel), text); };
const meta = (rel, guid) => w(`${rel}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);

w('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.11f1\n');
w('Assets/Game/Game.asmdef', JSON.stringify({ name: 'Game', references: [] }));
meta('Assets/Game/Game.asmdef', 'aa000000000000000000000000000001');
w('Assets/Game/Widget.cs', 'public sealed class Widget { }\n');
meta('Assets/Game/Widget.cs', 'aa000000000000000000000000000002');
// Its own script, so the asset's CLASS is distinguishable from the component's — with one script for
// both, "resolved the guid" and "resolved the wrong guid" print the same thing.
w('Assets/Game/GameConfig.cs', 'public sealed class GameConfig { }\n');
meta('Assets/Game/GameConfig.cs', 'aa000000000000000000000000000008');

// A PlayMode test assembly: the define constraint is the marker, and no `includePlatforms`.
w('Assets/Tests/Play/Game.PlayTests.asmdef', JSON.stringify({
  name: 'Game.PlayTests', references: ['GUID:aa000000000000000000000000000001'],
  defineConstraints: ['UNITY_INCLUDE_TESTS'], includePlatforms: [],
}));
meta('Assets/Tests/Play/Game.PlayTests.asmdef', 'aa000000000000000000000000000003');
// An EditMode one: exactly `["Editor"]`.
w('Assets/Tests/Edit/Game.EditTests.asmdef', JSON.stringify({
  name: 'Game.EditTests', references: ['GUID:aa000000000000000000000000000001'],
  defineConstraints: ['UNITY_INCLUDE_TESTS'], includePlatforms: ['Editor'],
}));
meta('Assets/Tests/Edit/Game.EditTests.asmdef', 'aa000000000000000000000000000004');

// A prefab with one wired reference, and the asset it points at.
w('Assets/Game/Config.asset', `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &11400000
MonoBehaviour:
  m_Script: {fileID: 11500000, guid: aa000000000000000000000000000008, type: 3}
  m_Name: Config
`);
meta('Assets/Game/Config.asset', 'aa000000000000000000000000000005');
w('Assets/Game/Widget.prefab', `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &1
GameObject:
  serializedVersion: 6
  m_Component:
  - component: {fileID: 2}
  - component: {fileID: 3}
  m_Name: Root
  m_IsActive: 1
--- !u!224 &2
RectTransform:
  m_GameObject: {fileID: 1}
  m_Children: []
  m_Father: {fileID: 0}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &3
MonoBehaviour:
  m_GameObject: {fileID: 1}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: aa000000000000000000000000000002, type: 3}
  m_Config: {fileID: 11400000, guid: aa000000000000000000000000000005, type: 2}
  speed: 1.5
`);
meta('Assets/Game/Widget.prefab', 'aa000000000000000000000000000006');

w('Assets/Game/Cell.controller', `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1107 &1000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - serializedVersion: 1
    m_State: {fileID: 2001}
    m_Position: {x: 0, y: 0, z: 0}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_DefaultState: {fileID: 2001}
--- !u!91 &9100000
AnimatorController:
  m_Name: Cell
  m_AnimatorParameters: []
  m_AnimatorLayers:
  - serializedVersion: 5
    m_Name: Base Layer
    m_StateMachine: {fileID: 1000}
    m_DefaultWeight: 1
--- !u!1102 &2001
AnimatorState:
  serializedVersion: 6
  m_Name: Idle
  m_Speed: 1
  m_Transitions: []
  m_Motion: {fileID: 0}
  m_Tag: 
`);
meta('Assets/Game/Cell.controller', 'aa000000000000000000000000000007');

const cwd = process.cwd();
process.chdir(project);

// ── the namespace itself ─────────────────────────────────────────────────────────

console.log('\nthe namespace');
const bare = await run([]);
ok(bare.code === 1 && /ayin unity prefab <file>/.test(bare.text), 'a bare invocation prints the curt usage and fails', String(bare.code));
ok(/ayin --help unity/.test(bare.text), 'and points at the verbose page rather than printing it');
const nonsense = await run(['frobnicate']);
ok(nonsense.code === 1 && /no subcommand "frobnicate"/.test(nonsense.text), 'an unknown subcommand is named, not guessed at');

const indexSrc = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf-8');
ok(/SUBCOMMANDS = new Set\(\[[^\]]*'unity'/s.test(indexSrc),
  'unity is in the flag validator\'s subcommand set — otherwise its own flags are rejected on sight');
const headlessSrc = readFileSync(join(ROOT, 'src', 'ui', 'headless.ts'), 'utf-8');
ok(/NO_TUI_COMMANDS[\s\S]*'unity'/.test(headlessSrc),
  'and in the no-TUI list — otherwise it prints its answer, then opens a screen that clears it');

// ── prefab ───────────────────────────────────────────────────────────────────────

console.log('\nunity prefab');
const tree = await run(['prefab', 'Assets/Game/Widget.prefab']);
ok(tree.code === 0 && /^Assets\/Game\/Widget\.prefab/m.test(tree.text), 'it prints the tree by default', tree.text.split('\n')[0]);
ok(/Widget {2}\(MonoBehaviour\)/.test(tree.text), 'a component appears under its script\'s class name');
ok(/m_Config: GameConfig named Config\.asset at Assets\/Game\//.test(tree.text),
  'and a guid is resolved to what it points at — the ScriptableObject\'s own class, not the component\'s',
  (tree.text.match(/^ *m_Config:.*$/m) ?? [''])[0].trim());
ok(!/[0-9a-f]{32}/.test(tree.text), 'no guid leaks into the tree at all');
const asJson = await run(['prefab', 'Assets/Game/Widget.prefab', '--json']);
ok(asJson.code === 0 && JSON.parse(asJson.text).roots[0].name === 'Root', '--json gives the full map');
const notPrefab = await run(['prefab', 'Assets/Game/Widget.cs']);
ok(notPrefab.code === 1 && /not a \.prefab/.test(notPrefab.text), 'a .cs is refused with the reason');
const missing = await run(['prefab', 'Assets/Game/Nope.prefab']);
ok(missing.code === 1 && /not found/.test(missing.text), 'a missing file is refused');

// ── animator ─────────────────────────────────────────────────────────────────────

console.log('\nunity animator');
const anim = await run(['animator', 'Assets/Game/Cell.controller']);
ok(anim.code === 0 && /Base Layer {2}1 state\(s\) {2}default=Idle/.test(anim.text),
  'the layer, its state count and its default state', anim.text.split('\n')[0]);
ok(/▶ Idle/.test(anim.text), 'the default state is marked');
const notController = await run(['animator', 'Assets/Game/Widget.prefab']);
ok(notController.code === 1 && /not a \.controller/.test(notController.text), 'a prefab is refused here');

// ── prefab_edit ──────────────────────────────────────────────────────────────────

console.log('\nunity prefab_edit');
const edited = await run(['prefab_edit', 'Assets/Game/Widget.prefab',
  '--object', 'Root', '--component', 'Widget', '--property', 'speed', '--value', '9']);
ok(edited.code === 0 && /speed/.test(edited.text), 'a scalar is set and the diff printed', edited.text.split('\n')[0]);
ok(/speed: 9/.test(readFileSync(join(project, 'Assets/Game/Widget.prefab'), 'utf-8')), 'the file really changed');
const noProperty = await run(['prefab_edit', 'Assets/Game/Widget.prefab', '--value', '1']);
ok(noProperty.code === 1 && /--property/.test(noProperty.text), 'a missing --property prints the shape of the call');
const badTarget = await run(['prefab_edit', 'Assets/Game/Widget.prefab',
  '--object', 'Nope', '--component', 'Widget', '--property', 'speed', '--value', '1']);
ok(badTarget.code === 1 && /no GameObject at/.test(badTarget.text), 'an unknown object is refused with the paths that exist');

// ── test ─────────────────────────────────────────────────────────────────────────

console.log('\nunity test');
const list = await run(['test', '--assemblies']);
ok(list.code === 0 && /2 test assemblies/.test(list.text), 'the test assemblies are found by their define constraint', list.text.split('\n')[0]);
ok(/PlayMode {2}Game\.PlayTests/.test(list.text) && /EditMode {2}Game\.EditTests/.test(list.text),
  'each one says whether it is PlayMode or EditMode — that decides how the run happens');
ok(/never compiled/.test(list.text), 'and whether its DLL exists, so a stale pass is not mistaken for a real one');
ok(!/Game {2}never compiled/.test(list.text), 'a production assembly is not offered as a test assembly');
const bareTest = await run(['test']);
ok(bareTest.text === list.text, 'a bare `unity test` lists them too — nobody remembers an assembly name on demand');

const typo = await run(['test', 'Game.PlayTest']);
ok(typo.code === 1 && /no test assembly named "Game\.PlayTest"/.test(typo.text),
  'a near-miss is REFUSED, never resolved to close enough');
ok(/did you mean: Game\.PlayTests/.test(typo.text), 'with the near-misses named');
const unknown = await run(['test', 'Nothing.Like.This']);
ok(unknown.code === 1 && /--assemblies to list them/.test(unknown.text), 'and an unknown name points at the list');

process.chdir(cwd);
rmSync(project, { recursive: true, force: true });
console.log(fails ? `\nunity check: ${fails} FAILURE(S)\n` : '\nunity check: ok\n');
process.exit(fails ? 1 : 0);
