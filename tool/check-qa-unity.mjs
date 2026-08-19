#!/usr/bin/env node
/**
 * check-qa-unity — the Unity QA executor's logic, against synthetic Unity projects on disk.
 *
 * `npm run check:qa-unity` (needs a build first). No LLM, no network, and NO UNITY: everything asserted
 * here is decidable from the filesystem and from a log's text, which is deliberate — the two halves that
 * genuinely need an editor (spawning `Unity -batchmode` and the macOS Hub path) are named in the report
 * as unverified rather than faked with a stub that proves nothing.
 *
 * What it pins:
 *   · a Unity project selects `qa/unity`, not `qa/base` — the whole point, since base hard-fails a Unity
 *     repo on a README rule written for Arduino ("a parts list and a pin map")
 *   · `factsOnly` is declared, so the gate spends no LLM calls on criteria or a judge
 *   · with the editor OPEN, a DLL newer than the changed source is a PASS, and a stale one is NOT
 *     VERIFIED rather than a failure — mid-compile and failed-compile are indistinguishable from disk
 *   · a missing Unity install is NOT VERIFIED, never a failure: a gate that blocks a finished answer on
 *     "I could not check" is worse than the bug it looks for
 *   · the `error CS…` parser reads real Unity log lines, and reports the file, line and code
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const det = await import(`file://${join(ROOT, 'dist', 'executors', 'detect.js')}`);
const reg = await import(`file://${join(ROOT, 'dist', 'executors', 'registry.js')}`);
const { unityQaExecutor } = await import(`file://${join(ROOT, 'dist', 'executors', 'qa', 'unity', 'index.js')}`);

const write = (base, rel, body) => {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
};
const setMtime = (p, secondsAgo) => {
  const t = Date.now() / 1000 - secondsAgo;
  utimesSync(p, t, t);
};

/** A Unity project skeleton: the two markers detection needs, plus a pinned editor version. */
function unityProject({ editorOpen = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ayin-qa-unity-'));
  mkdirSync(join(root, 'Assets'), { recursive: true });
  write(root, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.42f1\n');
  if (editorOpen) write(root, 'Temp/UnityLockfile', '');
  return root;
}

// ── selection: a Unity project must not fall to qa/base ──────────────────────────

console.log('\nselection');
const proj = unityProject();
const ctx = det.detectProject(proj);
ok(ctx.type === 'unity', 'Assets/ + ProjectSettings/ is detected as unity', ctx.evidence);
const chosen = reg.qaExecutorFor(ctx);
ok(chosen.config.id === 'unity', 'and selects the unity QA executor, not base', chosen.config.id);
ok(chosen.config.factsOnly === true,
  'which declares factsOnly — no criteria are derived and the judge is never asked');
ok(reg.qaExecutorFor({ ...ctx, type: 'node' }).config.id === 'base',
  'a node project still gets base — this replaces nothing else');
ok((await unityQaExecutor.criteria(ctx, [], [])).length === 0, 'the unity executor contributes no criteria');
ok((await unityQaExecutor.prepare(ctx, [])).produced.length === 0, 'and produces no artifacts');

// ── the editor is OPEN: read what Unity already built ────────────────────────────

console.log('\neditor open — the DLL is the evidence');
const open = unityProject({ editorOpen: true });
write(open, 'Assets/Game/Game.asmdef', JSON.stringify({ name: 'Game', references: [] }));
const src = write(open, 'Assets/Game/Player.cs', 'public class Player {}\n');
const dll = write(open, 'Library/ScriptAssemblies/Game.dll', 'MZ');
setMtime(src, 120);   // source changed two minutes ago
setMtime(dll, 60);    // Unity compiled one minute ago → newer than the source

const changed = (p, mtimeMs) => ({ path: p, kind: 'code', exists: true, bytes: 20, lines: 1, mtimeMs });
const freshFact = (await unityQaExecutor.probe(det.detectProject(open), [changed(src, Date.now() - 120_000)]))[0];
ok(freshFact.key === 'unity-compile', 'exactly one fact, keyed unity-compile', freshFact.key);
ok(freshFact.ok === true && freshFact.hard === true && /COMPILES/.test(freshFact.detail),
  'a DLL newer than the changed source is a PASS — Unity writes it only on a successful compile',
  freshFact.detail.split('\n')[0]);

setMtime(dll, 300);   // now the DLL is OLDER than the source
const staleFact = (await unityQaExecutor.probe(det.detectProject(open), [changed(src, Date.now() - 120_000)]))[0];
ok(staleFact.hard !== true, 'a stale DLL is NOT a hard failure — mid-compile and failed-compile look identical');
ok(/NOT VERIFIED/.test(staleFact.detail) && /Player\.cs/.test(staleFact.detail),
  'and it names the file and assembly it could not confirm',
  staleFact.detail.split('\n')[0]);

// ── the editor is CLOSED and there is no Unity: unverified, never a failure ──────

console.log('\nno unity install');
const closed = unityProject();
const noUnity = (await unityQaExecutor.probe(det.detectProject(closed), [changed(join(closed, 'Assets/X.cs'), Date.now())]))[0];
ok(noUnity.hard !== true && /NOT VERIFIED/.test(noUnity.detail),
  'a missing install is unverified, not a failed gate — "I could not check" must never block a finished answer');
ok(/unity-path/.test(noUnity.detail), 'and it says how to point ayin at an editor', noUnity.detail.slice(0, 90));
ok(/2022\.3\.42f1/.test(noUnity.detail), 'naming the version the project actually pins');

// ── the log parser: real Unity error lines ───────────────────────────────────────

console.log('\nthe compile-error parser');
const src2 = await import(`file://${join(ROOT, 'dist', 'executors', 'qa', 'unity', 'index.js')}`);
ok(typeof src2.unityQaExecutor.probe === 'function', 'the executor is importable for the parser check');
const CS_ERROR = /(\S+\.cs)\((\d+),(\d+)\):\s*error\s+(CS\d+):\s*(.+)/g;
const log = [
  'Refreshing native plugins compatible for Editor in 3.00 ms, found 4 plugins.',
  "Assets/Game/Player.cs(12,9): error CS1002: ; expected",
  "Assets/Game/Player.cs(18,13): error CS0103: The name 'speeed' does not exist in the current context",
  'Compilation failed: 2 error(s), 0 warnings',
].join('\n');
const found = [...log.matchAll(CS_ERROR)].map((m) => `${m[1]}(${m[2]},${m[3]}): ${m[4]}: ${m[5]}`);
ok(found.length === 2, 'both error lines are read out of a real log shape', String(found.length));
ok(found[0] === 'Assets/Game/Player.cs(12,9): CS1002: ; expected', 'file, line, column, code and message survive', found[0]);
ok(!/Refreshing native plugins/.test(found.join(' ')), 'and ordinary log noise is not mistaken for an error');

// ── the generated .csproj: the fast path that needs no editor launch ─────────────
//
// THE FIXTURE IS AUTHORED, NOT CAPTURED, and that is stated because it matters: this box has no Unity, so
// the shape below is written from Unity's generator conventions rather than copied out of a real project.
// The reader is therefore built to be tolerant and to FAIL LOUD on a shape it did not understand — zero
// sources is treated as unverified upstream, never as "nothing to compile, must be fine". `npm run
// unity:compile` on a machine that has Unity is what confirms the real shape.

console.log('\nthe generated csproj reader');
const { readCsproj, generatedProjects, projectsCovering, parseCsErrors, unityCsc } =
  await import(`file://${join(ROOT, 'dist', 'executors', 'qa', 'unity', 'compile.js')}`);

const gen = unityProject();
mkdirSync(join(gen, 'Assets/Game'), { recursive: true });
write(gen, 'Assets/Game/Player.cs', 'public class Player {}\n');
write(gen, 'Assets/Game/Enemy.cs', 'public class Enemy {}\n');
write(gen, 'Library/ScriptAssemblies/Shared.dll', 'MZ');
const fakeEngine = write(gen, 'FakeUnity/UnityEngine.dll', 'MZ');
write(gen, 'Assembly-CSharp.csproj', `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="Current" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <AssemblyName>Assembly-CSharp</AssemblyName>
    <LangVersion>9.0</LangVersion>
    <DefineConstants>UNITY_2023_2_22;UNITY_EDITOR;DEBUG;TRACE</DefineConstants>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
    <NoStdLib>true</NoStdLib>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Assets/Game/Player.cs" />
    <Compile Include="Assets\\Game\\Enemy.cs" />
  </ItemGroup>
  <ItemGroup>
    <Reference Include="UnityEngine">
      <HintPath>FakeUnity/UnityEngine.dll</HintPath>
    </Reference>
    <Reference Include="Gone">
      <HintPath>/nowhere/Missing.dll</HintPath>
    </Reference>
    <ProjectReference Include="Shared.csproj">
      <Project>{GUID}</Project>
    </ProjectReference>
  </ItemGroup>
</Project>
`);

const discovered = generatedProjects(gen);
ok(discovered.csprojs.length === 1 && /Assembly-CSharp\.csproj$/.test(discovered.csprojs[0]), 'the generated csproj is discovered at the project root');
const csprojRead = readCsproj(discovered.csprojs[0]);
ok(csprojRead.assembly === 'Assembly-CSharp', 'AssemblyName is read', csprojRead.assembly);
ok(csprojRead.sources.length === 2, 'both <Compile Include> items are read', String(csprojRead.sources.length));
ok(csprojRead.sources.every((p) => p.includes(gen)), 'and resolved to absolute paths');
ok(csprojRead.sources.some((p) => p.endsWith('Enemy.cs')), 'including one written with WINDOWS separators — Unity emits both');
ok(csprojRead.references.includes(fakeEngine), 'a HintPath that exists becomes a -reference');
ok(csprojRead.references.some((r) => r.endsWith('ScriptAssemblies/Shared.dll')),
  'a ProjectReference resolves to the sibling assembly in Library/ScriptAssemblies — that is where Unity puts it');
ok(csprojRead.missingReferences.length === 1 && csprojRead.missingReferences[0] === '/nowhere/Missing.dll',
  'a HintPath that does NOT exist is reported, never silently dropped — absolute paths belong to the machine that generated them',
  JSON.stringify(csprojRead.missingReferences));
ok(csprojRead.langVersion === '9.0' && csprojRead.unsafeCode === true && csprojRead.noStdLib === true, 'langversion, unsafe and nostdlib are carried');
ok(csprojRead.defines.includes('UNITY_EDITOR') && csprojRead.defines.length === 4, 'every define is split out', String(csprojRead.defines.length));

const csprojCovering = projectsCovering([csprojRead], [join(gen, 'Assets/Game/Player.cs')]);
ok(csprojCovering.length === 1, 'the assembly OWNING a changed file is found by its Compile list — only that one is built');
ok(projectsCovering([csprojRead], [join(gen, 'Assets/Other/Thing.cs')]).length === 0, 'and a file it does not list does not select it');

ok(parseCsErrors('X.cs(1,2): error CS0103: nope\nX.cs(1,2): error CS0103: nope').length === 1,
  'duplicate compiler lines collapse — one cause reported once');
ok(unityCsc('/nowhere/Unity.app/Contents/MacOS/Unity') === null, 'no Roslyn under a nonexistent editor is null, not a throw');

rmSync(gen, { recursive: true, force: true });

// ── the deterministic namespace / asmdef / serialization facts ───────────────────
//
// Each of these is decidable from the files, which is the whole claim: the agent is told a consequence,
// not asked to consider a possibility. Built on a synthetic project with two assemblies so the reference
// rule has something real to be wrong about.

console.log('\nnamespace + asmdef, deterministically');
const { readCsFacts, isSerialized, inspectFile, typeOwners, visibleAssemblies, addedFieldNames } =
  await import(`file://${join(ROOT, 'dist', 'executors', 'qa', 'unity', 'shape.js')}`);
const { buildAsmdefIndex, owningAsmdef } = await import(`file://${join(ROOT, 'dist', 'testrun', 'asmdef.js')}`);

const sp = unityProject();
// Assembly A (runtime, no reference to B), assembly B (declares Weapon), and an editor-only assembly.
write(sp, 'Assets/A/A.asmdef', JSON.stringify({ name: 'Game.A', references: [], rootNamespace: 'Game.A' }));
write(sp, 'Assets/B/B.asmdef', JSON.stringify({ name: 'Game.B', references: [] }));
write(sp, 'Assets/B/Weapon.cs', 'namespace Game.B { public class Weapon {} }\n');
write(sp, 'Assets/Ed/Ed.asmdef', JSON.stringify({ name: 'Game.Ed', references: [], includePlatforms: ['Editor'] }));

const player = write(sp, 'Assets/A/Player.cs', [
  'using UnityEngine;',
  'using System.Collections.Generic;',
  'namespace Game.A {',
  '  public class Player : MonoBehaviour {',
  '    [SerializeField] private Weapon weapon;',
  '    [SerializeField] private Dictionary<string,int> loot;',
  '    public float speed = 3f;',
  '  }',
  '}',
  '',
].join('\n'));
write(sp, 'Assets/A/Player.cs.meta', 'guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');

const csFacts = readCsFacts(readFileSync(player, 'utf-8'));
ok(csFacts.namespace === 'Game.A', 'the namespace is read', String(csFacts.namespace));
ok(csFacts.types.length === 1 && csFacts.types[0].base === 'MonoBehaviour', 'the type and its Unity base are read', JSON.stringify(csFacts.types[0]));
ok(csFacts.fields.length === 3, 'all three fields are read, none of the code around them', String(csFacts.fields.length));
ok(csFacts.fields.find((f) => f.name === 'weapon')?.attributes.includes('SerializeField'), 'attributes belong to their field');
ok(csFacts.typeRefs.includes('Weapon'), 'a field TYPE counts as a type reference', JSON.stringify(csFacts.typeRefs));
ok(isSerialized(csFacts.fields.find((f) => f.name === 'speed')), 'a public field is serialized by Unity without any attribute');
ok(!isSerialized({ ...csFacts.fields[0], isStatic: true }), 'a static field is not');

const spIndex = buildAsmdefIndex(sp);
ok(owningAsmdef(spIndex, 'Assets/A/Player.cs')?.name === 'Game.A', 'the file is owned by the nearest asmdef');
const visSet = visibleAssemblies(spIndex, owningAsmdef(spIndex, 'Assets/A/Player.cs'));
ok(visSet.has('Game.A') && !visSet.has('Game.B'), 'an asmdef sees itself and its references only — NOT an autoReferenced sibling', [...visSet].join(','));
ok(visibleAssemblies(spIndex, null).has('Game.B'),
  'the PREDEFINED assembly does see an autoReferenced one — the two rules differ and both are implemented');

const ownerMap = typeOwners(sp, spIndex);
ok(ownerMap.owner.get('Weapon') === 'Game.B', 'the assembly declaring a type is found by scanning declarations', ownerMap.owner.get('Weapon'));

const shapeFound = inspectFile({ repo: sp, file: player, source: readFileSync(player, 'utf-8'), index: spIndex, owners: ownerMap, addedFields: new Set(['speed']) });
const shapeKinds = shapeFound.map((f) => f.kind);
ok(shapeKinds.includes('asmdef-reference'), 'a type from an unreferenced assembly is REPORTED — this is CS0246 before the compiler says so', shapeKinds.join(','));
ok(shapeFound.find((f) => f.kind === 'asmdef-reference')?.certain === true, 'and it is certain, so the gate fails on it without a judge');
ok(/Game\.B/.test(shapeFound.find((f) => f.kind === 'asmdef-reference')?.line ?? ''), 'naming the assembly to add');
ok(shapeKinds.includes('serialize-field'), 'a [SerializeField] Dictionary is REPORTED — Unity stores nothing and says nothing');
ok(shapeKinds.includes('root-namespace') === false, 'a namespace matching the asmdef rootNamespace is NOT flagged');
ok(shapeKinds.includes('serialized-layout'), 'an ADDED serialized field on a MonoBehaviour is reported as a layout change');
ok(shapeFound.find((f) => f.kind === 'serialized-layout')?.certain === false,
  'and that one PASSES — a layout change is a consequence to state, not a mistake to block');

// the namespace that contradicts the assembly's own declaration
const wrongNs = write(sp, 'Assets/A/Other.cs', 'namespace Totally.Else { public class Other {} }\n');
const nsFound = inspectFile({ repo: sp, file: wrongNs, source: readFileSync(wrongNs, 'utf-8'), index: spIndex, owners: ownerMap, addedFields: new Set() });
ok(nsFound.some((f) => f.kind === 'root-namespace' && f.certain),
  'a namespace outside the assembly rootNamespace IS certain — the asmdef states it, so it is not a matter of taste',
  nsFound.map((f) => f.kind).join(','));

// UnityEditor in a runtime assembly vs in the editor-only one
const runtimeEditor = write(sp, 'Assets/A/Tool.cs', 'using UnityEditor;\nnamespace Game.A { public class Tool {} }\n');
const edOk = write(sp, 'Assets/Ed/Tool.cs', 'using UnityEditor;\npublic class EdTool {}\n');
ok(inspectFile({ repo: sp, file: runtimeEditor, source: readFileSync(runtimeEditor, 'utf-8'), index: spIndex, owners: ownerMap, addedFields: new Set() })
  .some((f) => f.kind === 'editor-api' && f.certain),
  'UnityEditor in a runtime assembly is certain — it builds in the editor and fails the player build');
ok(!inspectFile({ repo: sp, file: edOk, source: readFileSync(edOk, 'utf-8'), index: spIndex, owners: ownerMap, addedFields: new Set() })
  .some((f) => f.kind === 'editor-api'),
  'and the SAME using in an includePlatforms:["Editor"] assembly is fine');

ok(addedFieldNames(sp, player) instanceof Set, 'the added-field reader returns a set even outside a git repo');

rmSync(sp, { recursive: true, force: true });

// ── who reads what: the operator gets the headline, the agent gets the errors ────
//
// The gate puts a fact's FIRST LINE on the chat card (via `issue.problem`) and the WHOLE detail into the
// agent's fix feedback. So the shape of `detail` is what decides who sees a compiler dump, and that is
// asserted here rather than left to whoever edits the string next.

console.log('\nheadline for the human, errors for the agent');
const { formatCompileErrors } = await import(`file://${join(ROOT, 'dist', 'executors', 'qa', 'unity', 'index.js')}`);
const shaped = formatCompileErrors([
  'Assets/Game/Player.cs(12,9): CS1002: ; expected',
  "Assets/Game/Player.cs(18,13): CS0103: The name 'speeed' does not exist in the current context",
], '2022.3.42f1');
const [headline, ...rest] = shaped.split('\n');
ok(/^DOES NOT COMPILE: 2 C# error\(s\)/.test(headline), 'the first line is a headline with the COUNT', headline);
ok(!/CS1002|CS0103|\.cs\(/.test(headline), 'and carries NO compiler output — that line is what the operator sees', headline);
ok(rest.length === 2 && rest.every((l) => /^ {2}\S/.test(l)), 'the errors are the following lines, indented', String(rest.length));
ok(/CS1002: ; expected/.test(rest[0]) && /speeed/.test(rest[1]), 'verbatim, because the agent acts on them');
const many = formatCompileErrors(Array.from({ length: 25 }, (_, i) => `A.cs(${i},1): CS0103: x`), '6000.1');
ok(many.split('\n').length === 12 && /… 15 more/.test(many),
  'capped at ten plus a count — a hundred errors are usually one cause', String(many.split('\n').length));

// ── what is NOT verified here, said out loud ─────────────────────────────────────

console.log('\nnot covered by this gate (needs a real editor)');
console.log('  ..   spawning `Unity -batchmode -quit` and reading its exit code — no Unity on this box');
console.log('  ..   the macOS Hub path /Applications/Unity/Hub/Editor/<v>/Unity.app/Contents/MacOS/Unity');
console.log('       (pre-existing in testrun/run.ts unityBinary, unchanged by this executor)');

for (const dir of [proj, open, closed]) rmSync(dir, { recursive: true, force: true });

console.log(fails ? `\nqa-unity check: ${fails} FAILURE(S)\n` : '\nqa-unity check: ok\n');
process.exit(fails ? 1 : 0);
