#!/usr/bin/env node
/**
 * check-animator — the two facts an AnimatorController hides, and the arithmetic behind them.
 *
 * `npm run check:animator` (needs a build). HERMETIC: a five-file Unity project in a temp directory, with
 * clip lengths chosen so every number below can be checked by hand.
 *
 * What has to hold:
 *   · `m_HasExitTime: 0` is reported as "no exit time" — the transition cuts the clip mid-play, which is
 *     the most common cause of an animation that looks like it is skipping.
 *   · CLIPS OVERLAP is answered in SECONDS. A duration is normalized to the SOURCE clip unless
 *     `m_HasFixedDuration` is set, so 0.25 means "a quarter of the clip I am leaving" — and that clip's
 *     length is in a different file. Getting this wrong prints a number that means something else.
 *   · conditions are spelled, not enumerated: `m_ConditionMode: 1` on a trigger is "is set".
 *   · the findings are the graph's, not a style opinion: unreachable, dead-end, fires-immediately, muted.
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

const { buildAnimatorMap, isAnimatorController } = await import(`file://${join(DIST, 'animator', 'map.js')}`);

const G = {
  intro: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',   // 2.000s, does not loop
  idle: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',    // 1.000s, loops
  gone: 'cccccccccccccccccccccccccccccccc',    // referenced by a state, defined nowhere
};

const project = mkdtempSync(join(tmpdir(), 'ayin-animator-'));
mkdirSync(join(project, 'ProjectSettings'), { recursive: true });
mkdirSync(join(project, 'Assets', 'Anim'), { recursive: true });
writeFileSync(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n');
const write = (rel, text) => writeFileSync(join(project, rel), text);
const meta = (rel, guid) => write(`${rel}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);

const clip = (name, stop, loop) => `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!74 &7400000
AnimationClip:
  m_Name: ${name}
  m_SampleRate: 60
  m_AnimationClipSettings:
    serializedVersion: 2
    m_StartTime: 0
    m_StopTime: ${stop}
    m_LoopTime: ${loop ? 1 : 0}
`;
write('Assets/Anim/Intro.anim', clip('Intro', 2, false));
meta('Assets/Anim/Intro.anim', G.intro);
write('Assets/Anim/Idle.anim', clip('Idle', 1, true));
meta('Assets/Anim/Idle.anim', G.idle);

// Intro --(exit 0.5 of a 2s clip, normalized fade 0.25 = 0.5s)--> Idle       overlap 0.5s, ends at 1.5s
// Idle  --(no exit time, trigger "go", fixed 0.1s)-------------> Intro       cuts the clip
// Idle  --(no conditions, no exit time)------------------------> Orphan      fires immediately
// Orphan: nothing enters it except that one; Ghost: nothing enters, nothing leaves, missing clip.
write('Assets/Anim/Test.controller', `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1107 &1000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - serializedVersion: 1
    m_State: {fileID: 2001}
    m_Position: {x: 50, y: 50, z: 0}
  - serializedVersion: 1
    m_State: {fileID: 2002}
    m_Position: {x: 250, y: 50, z: 0}
  - serializedVersion: 1
    m_State: {fileID: 2003}
    m_Position: {x: 450, y: 50, z: 0}
  - serializedVersion: 1
    m_State: {fileID: 2004}
    m_Position: {x: 650, y: 50, z: 0}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineTransitions: {}
  m_DefaultState: {fileID: 2001}
--- !u!91 &9100000
AnimatorController:
  m_Name: Test
  serializedVersion: 5
  m_AnimatorParameters:
  - m_Name: go
    m_Type: 9
    m_DefaultFloat: 0
    m_DefaultInt: 0
    m_DefaultBool: 0
    m_Controller: {fileID: 9100000}
  - m_Name: speed
    m_Type: 1
    m_DefaultFloat: 1.5
    m_DefaultInt: 0
    m_DefaultBool: 0
    m_Controller: {fileID: 9100000}
  m_AnimatorLayers:
  - serializedVersion: 5
    m_Name: Base Layer
    m_StateMachine: {fileID: 1000}
    m_Mask: {fileID: 0}
    m_BlendingMode: 0
    m_SyncedLayerIndex: -1
    m_DefaultWeight: 1
    m_IKPass: 0
--- !u!1102 &2001
AnimatorState:
  serializedVersion: 6
  m_Name: Intro
  m_Speed: 1
  m_CycleOffset: 0
  m_Transitions:
  - {fileID: 3001}
  m_WriteDefaultValues: 1
  m_Motion: {fileID: 7400000, guid: ${G.intro}, type: 2}
  m_Tag: 
--- !u!1102 &2002
AnimatorState:
  serializedVersion: 6
  m_Name: Idle
  m_Speed: 1
  m_CycleOffset: 0
  m_Transitions:
  - {fileID: 3002}
  - {fileID: 3003}
  m_WriteDefaultValues: 1
  m_Motion: {fileID: 7400000, guid: ${G.idle}, type: 2}
  m_Tag: 
--- !u!1102 &2003
AnimatorState:
  serializedVersion: 6
  m_Name: Orphan
  m_Speed: 2
  m_CycleOffset: 0
  m_Transitions: []
  m_WriteDefaultValues: 1
  m_Motion: {fileID: 7400000, guid: ${G.idle}, type: 2}
  m_Tag: exit-here
--- !u!1102 &2004
AnimatorState:
  serializedVersion: 6
  m_Name: Ghost
  m_Speed: 1
  m_CycleOffset: 0
  m_Transitions: []
  m_WriteDefaultValues: 1
  m_Motion: {fileID: 7400000, guid: ${G.gone}, type: 2}
  m_Tag: 
--- !u!1101 &3001
AnimatorStateTransition:
  m_Name: 
  m_Conditions: []
  m_DstStateMachine: {fileID: 0}
  m_DstState: {fileID: 2002}
  m_Solo: 0
  m_Mute: 0
  m_IsExit: 0
  serializedVersion: 3
  m_TransitionDuration: 0.25
  m_TransitionOffset: 0
  m_ExitTime: 0.5
  m_HasExitTime: 1
  m_HasFixedDuration: 0
  m_InterruptionSource: 0
  m_OrderedInterruption: 1
  m_CanTransitionToSelf: 1
--- !u!1101 &3002
AnimatorStateTransition:
  m_Name: 
  m_Conditions:
  - m_ConditionMode: 1
    m_ConditionEvent: go
    m_EventTreshold: 0
  m_DstStateMachine: {fileID: 0}
  m_DstState: {fileID: 2001}
  m_Solo: 0
  m_Mute: 1
  m_IsExit: 0
  serializedVersion: 3
  m_TransitionDuration: 0.1
  m_TransitionOffset: 0
  m_ExitTime: 0.75
  m_HasExitTime: 0
  m_HasFixedDuration: 1
  m_InterruptionSource: 2
  m_OrderedInterruption: 1
  m_CanTransitionToSelf: 0
--- !u!1101 &3003
AnimatorStateTransition:
  m_Name: 
  m_Conditions: []
  m_DstStateMachine: {fileID: 0}
  m_DstState: {fileID: 2003}
  m_Solo: 0
  m_Mute: 0
  m_IsExit: 0
  serializedVersion: 3
  m_TransitionDuration: 0
  m_TransitionOffset: 0
  m_ExitTime: 1
  m_HasExitTime: 0
  m_HasFixedDuration: 1
  m_InterruptionSource: 0
  m_OrderedInterruption: 1
  m_CanTransitionToSelf: 1
`);
meta('Assets/Anim/Test.controller', 'dddddddddddddddddddddddddddddddd');

const CONTROLLER = join(project, 'Assets', 'Anim', 'Test.controller');
const map = await buildAnimatorMap(CONTROLLER, { root: project });
const layer = map.layers[0];
const state = (n) => layer.states.find((s) => s.name === n);
const outOf = (n, to) => state(n).transitions.find((t) => t.to === to);

console.log('\nparameters and states');
ok(map.parameters.map((p) => `${p.name}:${p.type}=${p.default}`).join(' ') === 'go:Trigger=0 speed:Float=1.5',
  'parameters carry their TYPE and default, not an enum number',
  map.parameters.map((p) => `${p.name}:${p.type}=${p.default}`).join(' '));
ok(layer.name === 'Base Layer' && layer.defaultState === 'Intro' && layer.weight === 1,
  'the layer names its default state', `${layer.name}/${layer.defaultState}/${layer.weight}`);
ok(layer.states.length === 4, 'every child state is present', String(layer.states.length));
ok(state('Intro').isDefault && !state('Idle').isDefault, 'and only one is the default');
ok(state('Intro').clip.asset?.name === 'Intro.anim' && state('Intro').clip.lengthSeconds === 2
  && state('Intro').clip.loops === false,
  'a state\'s clip is resolved with its LENGTH and loop flag — both from the clip\'s own file',
  JSON.stringify(state('Intro').clip));
ok(state('Idle').clip.loops === true, 'a looping clip says so');
ok(state('Ghost').clip.missing === G.gone, 'a motion guid nothing defines is reported, not left empty');
ok(state('Orphan').speed === 2 && state('Orphan').tag === 'exit-here', 'speed and tag are carried');

console.log('\nexit time, and whether the clips overlap');
const introOut = outOf('Intro', 'Idle');
ok(introOut.hasExitTime === true && introOut.exitTime === 0.5 && introOut.exitTimeSeconds === 1,
  'an exit time is given in SECONDS as well as normalized — 0.5 of a 2s clip is 1s',
  `${introOut.exitTime} → ${introOut.exitTimeSeconds}s`);
ok(introOut.durationIsFixed === false && introOut.duration === 0.25 && introOut.durationSeconds === 0.5,
  'a NORMALIZED duration is resolved against the source clip: 0.25 of 2s is 0.5s, not 0.25s',
  `${introOut.duration} → ${introOut.durationSeconds}s`);
ok(introOut.overlap.clipsOverlap === true && introOut.overlap.seconds === 0.5,
  'so the clips overlap for half a second');
ok(introOut.overlap.exceedsSourceClip === false,
  'and the fade fits inside the clip (1s + 0.5s < 2s), so nothing is flagged');

const idleMuted = outOf('Idle', 'Intro');
ok(idleMuted.hasExitTime === false, 'a transition with m_HasExitTime 0 is reported as having none');
ok(/cutting the source clip/.test(idleMuted.overlap.note), 'and says what that MEANS for the clip', idleMuted.overlap.note.slice(0, 60));
ok(idleMuted.durationIsFixed === true && idleMuted.durationSeconds === 0.1,
  'a FIXED duration is already seconds and is not multiplied by anything', String(idleMuted.durationSeconds));
ok(idleMuted.conditions.length === 1 && idleMuted.conditions[0].parameter === 'go'
  && idleMuted.conditions[0].mode === 'is set',
  'a condition is spelled — mode 1 on a trigger is "is set"', JSON.stringify(idleMuted.conditions[0]));
ok(idleMuted.muted === true && idleMuted.interruptionSource === 'destination' && idleMuted.canTransitionToSelf === false,
  'the flags that decide interruption are carried and named',
  `${idleMuted.muted}/${idleMuted.interruptionSource}/${idleMuted.canTransitionToSelf}`);

const instant = outOf('Idle', 'Orphan');
ok(instant.overlap.clipsOverlap === false && /one frame/.test(instant.overlap.note),
  'a zero duration is NOT an overlap — the destination replaces the source in one frame');

console.log('\nwhat only the assembled graph shows');
const has = (re) => map.findings.some((f) => re.test(f));
ok(has(/nothing transitions INTO "Ghost"/), 'a state nothing enters is reported — it can never play');
ok(has(/nothing leaves "Ghost"/) && has(/nothing leaves "Orphan"/), 'a dead-end state is reported');
ok(has(/NO conditions and NO exit time/), 'a transition that fires the frame the state is entered is reported');
ok(has(/is MUTED/), 'a muted transition is reported — it is in the file and never fires');
ok(has(/motion guid nothing in the project defines/), 'and a state that plays nothing');
ok(!has(/cross-fades past the end/), 'nothing false: the one fade in this graph fits its clip',
  map.findings.filter((f) => /past the end/.test(f)).join(' | '));

console.log('\nthe surface');
ok(isAnimatorController('a.controller') && !isAnimatorController('a.prefab'),
  'only a .controller holds an AnimatorController');
const tool = (await import(`file://${join(DIST, 'tools', 'defs', 'animator_inspect.js')}`)).tool;
ok(!tool.slash, 'no slash: it answers a question the agent asks, in JSON');
ok(tool.parameters.length === 1, 'one parameter — a path', String(tool.parameters.length));
const wrong = await tool.execute({ path: join(project, 'Assets', 'Anim', 'Intro.anim') });
ok(/not a \.controller/.test(wrong), 'a .anim is refused with the reason');
const out = JSON.parse(await tool.execute({ path: CONTROLLER }));
ok(out.layers[0].states.length === 4 && out.findings.length >= 4, 'the tool returns the map as JSON');

rmSync(project, { recursive: true, force: true });
console.log(fails ? `\nanimator check: ${fails} FAILURE(S)\n` : '\nanimator check: ok\n');
process.exit(fails ? 1 : 0);
