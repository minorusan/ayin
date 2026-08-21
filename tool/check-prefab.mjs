#!/usr/bin/env node
/**
 * check-prefab — the Unity asset reader and the one route that WRITES.
 *
 * `npm run check:prefab` (needs a build). HERMETIC: it builds a tiny Unity project in a temp directory —
 * `Assets/`, `ProjectSettings/`, a prefab, a nested prefab, a script and their `.meta` files — so it passes
 * on a clone with no Unity project anywhere near it, and it never touches a real one.
 *
 * The assertions are the four things that cost real time to get wrong:
 *   · the PARSE. Unity writes sequence dashes at the parent key's indent and wraps long flow maps
 *     mid-value. Both were bugs here, and both fail silently: a mis-parsed reference reads as "this
 *     prefab has no dependencies" rather than as an error.
 *   · the RESOLUTION. A guid resolved to the wrong thing, or a sub-asset named as its file, is a
 *     confident lie about what is wired to what.
 *   · the WRITE. It must change ONE line, keep a reference's fileID and type, and refuse — never guess —
 *     an ambiguous name or a class that does not match the field.
 *   · the SURFACES. `/prefab` shows a document in an overlay, and only these three extensions parse.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const { parseUnityYaml, at, entry, parseRef } = await import(`file://${join(DIST, 'prefab', 'yaml.js')}`);
const { buildPrefabMap, isInspectable } = await import(`file://${join(DIST, 'prefab', 'map.js')}`);
const { renderPrefabTree } = await import(`file://${join(DIST, 'prefab', 'render.js')}`);
const { setPrefabProperty, projectRootFor } = await import(`file://${join(DIST, 'prefab', 'edit.js')}`);

// ── a Unity project, small enough to read in one screen ──────────────────────────

const GUID = {
  widget: '11111111111111111111111111111111',   // Widget.cs      (a MonoBehaviour script)
  font: '22222222222222222222222222222222',     // TheFont.asset  (a ScriptableObject)
  font2: '33333333333333333333333333333333',    // OtherFont.asset
  cfg: '44444444444444444444444444444444',      // Config.asset   (a DIFFERENT ScriptableObject class)
  inner: '55555555555555555555555555555555',    // Inner.prefab   (nested)
  fontScript: '66666666666666666666666666666666',
  cfgScript: '77777777777777777777777777777777',
  gone: '99999999999999999999999999999999',     // referenced, never defined
};

const project = mkdtempSync(join(tmpdir(), 'ayin-prefab-'));
mkdirSync(join(project, 'ProjectSettings'), { recursive: true });
mkdirSync(join(project, 'Assets', 'Scripts'), { recursive: true });
mkdirSync(join(project, 'Assets', 'Fonts'), { recursive: true });
writeFileSync(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n');

const write = (rel, text) => writeFileSync(join(project, rel), text);
const meta = (rel, guid) => write(`${rel}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);

write('Assets/Scripts/Widget.cs', 'public sealed class Widget {}\n');
meta('Assets/Scripts/Widget.cs', GUID.widget);
write('Assets/Scripts/TheFontAsset.cs', 'public sealed class TheFontAsset {}\n');
meta('Assets/Scripts/TheFontAsset.cs', GUID.fontScript);
write('Assets/Scripts/GameConfig.cs', 'public sealed class GameConfig {}\n');
meta('Assets/Scripts/GameConfig.cs', GUID.cfgScript);

// Two ScriptableObjects of the same class, and one of another — the class check's whole point.
const scriptableAsset = (scriptGuid, name) => `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &11400000
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_Script: {fileID: 11500000, guid: ${scriptGuid}, type: 3}
  m_Name: ${name}
  size: 42
`;
write('Assets/Fonts/TheFont.asset', scriptableAsset(GUID.fontScript, 'TheFont'));
meta('Assets/Fonts/TheFont.asset', GUID.font);
write('Assets/Fonts/OtherFont.asset', scriptableAsset(GUID.fontScript, 'OtherFont'));
meta('Assets/Fonts/OtherFont.asset', GUID.font2);
write('Assets/Config.asset', scriptableAsset(GUID.cfgScript, 'Config'));
meta('Assets/Config.asset', GUID.cfg);

// The nested prefab: one GameObject with a RectTransform.
write('Assets/Inner.prefab', `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 101}
  m_Layer: 5
  m_Name: InnerRoot
  m_TagString: Untagged
  m_IsActive: 1
--- !u!224 &101
RectTransform:
  m_GameObject: {fileID: 100}
  m_Children: []
  m_Father: {fileID: 0}
  m_Pivot: {x: 0.5, y: 0.5}
`);
meta('Assets/Inner.prefab', GUID.inner);

// The prefab under test. Deliberately includes: a sequence at the parent's indent, a WRAPPED flow map,
// a stripped document, a nested PrefabInstance, and a reference to a guid that does not exist.
write('Assets/Widget.prefab', `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &1
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 2}
  - component: {fileID: 3}
  m_Layer: 5
  m_Name: Root
  m_TagString: Untagged
  m_IsActive: 1
--- !u!224 &2
RectTransform:
  m_GameObject: {fileID: 1}
  m_Children:
  - {fileID: 5}
  - {fileID: 900}
  m_Father: {fileID: 0}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &3
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 1}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: ${GUID.widget}, type: 3}
  m_Name: 
  m_FontAsset: {fileID: 11400000, guid: ${GUID.font},
    type: 2}
  m_Missing: {fileID: 11400000, guid: ${GUID.gone}, type: 2}
  speed: 1.5
--- !u!1 &4
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 5}
  m_Layer: 5
  m_Name: Child
  m_TagString: Untagged
  m_IsActive: 0
--- !u!224 &5
RectTransform:
  m_GameObject: {fileID: 4}
  m_Children: []
  m_Father: {fileID: 2}
  m_Pivot: {x: 0.25, y: 1}
--- !u!224 &900 stripped
RectTransform:
  m_CorrespondingSourceObject: {fileID: 101, guid: ${GUID.inner},
    type: 3}
  m_PrefabInstance: {fileID: 901}
  m_PrefabAsset: {fileID: 0}
--- !u!1001 &901
PrefabInstance:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_Modification:
    m_TransformParent: {fileID: 2}
    m_Modifications:
    - target: {fileID: 101, guid: ${GUID.inner},
        type: 3}
      propertyPath: m_Pivot.x
      value: 0.75
      objectReference: {fileID: 0}
    m_RemovedComponents: []
  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.inner}, type: 3}
`);
meta('Assets/Widget.prefab', '88888888888888888888888888888888');

const PREFAB = join(project, 'Assets', 'Widget.prefab');

// ── the parse ────────────────────────────────────────────────────────────────────

console.log('\nthe parse (the two shapes that fail silently)');
const y = parseUnityYaml(PREFAB, readFileSync(PREFAB, 'utf-8'));
ok(y.documents.length === 7, 'every document is found', String(y.documents.length));
ok(y.documents.filter((d) => d.stripped).length === 1, 'a `stripped` header is marked, not treated as an object');

const mono = y.documents.find((d) => d.fileId === '3');
const wrapped = entry(mono.body, 'm_FontAsset');
ok(parseRef(wrapped.raw)?.guid === GUID.font,
  'a flow map WRAPPED across two lines is one reference — the guid survives the line break', wrapped.raw);
ok(wrapped.endLine === wrapped.line + 1, 'and its span covers both lines', `${wrapped.line}-${wrapped.endLine}`);
ok(entry(mono.body, 'speed')?.raw === '1.5', 'the key AFTER a wrapped value is still a key');

const go = y.documents.find((d) => d.fileId === '1');
const comps = entry(go.body, 'm_Component');
ok(comps.kind === 'seq' && comps.children.length === 2,
  'a sequence whose dashes sit at the PARENT key\'s indent is a sequence', `${comps.kind}/${comps.children.length}`);
ok(entry(go.body, 'm_Name')?.raw === 'Root',
  'and the key after that sequence belongs to the GameObject, not to the list');
const mods = at(y.documents.find((d) => d.classId === 1001).body, 'm_Modification.m_Modifications');
ok(mods?.children.length === 1 && entry(mods.children[0].value.children, 'propertyPath')?.raw === 'm_Pivot.x',
  'a prefab instance\'s overrides parse, including the target that wrapped');

// ── the map ──────────────────────────────────────────────────────────────────────

console.log('\nthe map');
ok(projectRootFor(PREFAB) === project, 'the project root is found from the file', projectRootFor(PREFAB));
const map = await buildPrefabMap(PREFAB, { root: project, depth: 2 });
ok(map.roots.length === 1 && map.roots[0].name === 'Root', 'one root, named', map.roots.map((r) => r.name).join(','));
const root = map.roots[0];
ok(root.components.map((c) => c.type).join(',') === 'RectTransform,Widget',
  'a MonoBehaviour is named by its SCRIPT — the class a person sees in the Inspector',
  root.components.map((c) => c.type).join(','));
const widget = root.components.find((c) => c.type === 'Widget');
ok(widget.properties.m_FontAsset?.ref?.asset?.name === 'TheFont.asset',
  'a guid resolves to the asset it names', JSON.stringify(widget.properties.m_FontAsset?.ref?.asset ?? {}));
ok(widget.properties.m_FontAsset?.ref?.asset?.type === 'TheFontAsset',
  'and a ScriptableObject is typed by its own script, not called "asset"',
  widget.properties.m_FontAsset?.ref?.asset?.type);
ok(widget.properties.m_Missing?.ref?.missing === GUID.gone,
  'a guid nothing defines is reported MISSING rather than dropped — that is a real defect');
ok(map.unresolved.includes(GUID.gone) && map.unresolved.length === 1,
  'and it is the only unresolved one', map.unresolved.join(','));

const child = root.children.find((c) => c.name === 'Child');
ok(child && child.path === 'Root/Child' && child.active === '0',
  'children carry their hierarchy path and their active flag', `${child?.path} active=${child?.active}`);
const nested = root.children.find((c) => c.nested);
ok(nested?.nested?.source?.name === 'Inner.prefab', 'a PrefabInstance names its source prefab');
ok(nested?.children.length === 1 && nested.children[0].name === 'InnerRoot',
  'and is EXPANDED — the other file\'s hierarchy appears inline', String(nested?.children.length));
ok(nested?.nested?.modifications[0]?.propertyPath === 'm_Pivot.x',
  'with the overrides that make this instance different from its source');

const capped = await buildPrefabMap(PREFAB, { root: project, depth: 0 });
const cappedNested = capped.roots[0].children.find((c) => c.nested);
ok(cappedNested?.nested?.truncated === true && cappedNested.children.length === 0,
  'depth=0 stops at the instance and SAYS it stopped, rather than looking like an empty prefab');

const tree = renderPrefabTree(map);
ok(/TheFontAsset named TheFont\.asset at Assets\/Fonts\//.test(tree),
  'the tree prints a reference as a sentence, never as a guid');
// The two places a guid is legitimately printed: naming a MISSING reference, and the footer that lists
// them. Anywhere else means a resolution silently fell through to raw text.
const treeBody = tree.split('unresolved guids')[0].replace(/nothing in the project has guid [0-9a-f]{32}/g, '');
ok(!/[0-9a-f]{32}/.test(treeBody), 'and no guid leaks into the hierarchy itself',
  (treeBody.match(/^.*[0-9a-f]{32}.*$/m) ?? [''])[0].slice(0, 70));
ok(/MISSING/.test(tree), 'a missing reference is visible in the tree too');

// ── the write ────────────────────────────────────────────────────────────────────

console.log('\nthe write (one line, or a refusal)');
const lineCount = (t) => t.split('\n').length;
const original = readFileSync(PREFAB, 'utf-8');

let r = await setPrefabProperty({ file: PREFAB, root: project, object: 'Root', component: 'Widget', property: 'speed', value: '9' });
ok(r.ok, 'a scalar is set', r.ok ? r.rule : r.error);
let now = readFileSync(PREFAB, 'utf-8');
ok(/speed: 9/.test(now), 'the value is in the file');
ok(lineCount(now) === lineCount(original), 'and the file is the same length — nothing was re-serialized');
ok((r.diff.match(/^-[^-]/gm) || []).length === 1, 'the diff is ONE line', String((r.diff.match(/^-[^-]/gm) || []).length));

r = await setPrefabProperty({ file: PREFAB, root: project, object: 'Root', component: 'Widget', property: 'm_FontAsset', asset: 'OtherFont.asset' });
ok(r.ok && /kept fileID 11400000 and type 2/.test(r.rule), 'a reference swap KEEPS the fileID and type', r.ok ? r.rule : r.error);
now = readFileSync(PREFAB, 'utf-8');
ok(now.includes(`{fileID: 11400000, guid: ${GUID.font2}, type: 2}`), 'the new guid is written as one line');
ok(!now.includes(GUID.font), 'and the old one is gone');

r = await setPrefabProperty({ file: PREFAB, root: project, object: 'Root', component: 'Widget', property: 'm_FontAsset', asset: 'Config.asset' });
ok(!r.ok && /would read that field as null/.test(r.error),
  'a reference whose CLASS does not match the field is refused — same extension is not the same type', r.ok ? '(accepted!)' : r.error.slice(0, 60));

r = await setPrefabProperty({ file: PREFAB, root: project, object: 'Root/Child', component: 'RectTransform', property: 'm_Pivot.x', value: '0.5' });
ok(r.ok, 'one field of a vector can be set', r.ok ? r.rule : r.error);
ok(/m_Pivot: \{x: 0.5, y: 1\}/.test(readFileSync(PREFAB, 'utf-8')), 'and the rest of the vector is untouched');

r = await setPrefabProperty({ file: PREFAB, root: project, object: 'Nope', component: 'Widget', property: 'speed', value: '1' });
ok(!r.ok && /no GameObject at/.test(r.error), 'an unknown object is refused, with the paths that exist');
r = await setPrefabProperty({ file: PREFAB, root: project, object: 'Root', component: 'Widget', property: 'nope', value: '1' });
ok(!r.ok && /has no property/.test(r.error), 'an unknown property is refused, with the ones it has');
r = await setPrefabProperty({ file: PREFAB, root: project, object: 'Root', component: 'Widget', property: 'm_FontAsset', value: '1', asset: 'x.asset' });
ok(!r.ok && /not both/.test(r.error), 'value= and asset= together is refused rather than one silently winning');
r = await setPrefabProperty({ file: PREFAB, root: project, object: 'Root', component: 'Widget', property: 'speed', value: '9999', asset: undefined });
const same = await setPrefabProperty({ file: PREFAB, root: project, object: 'Root', component: 'Widget', property: 'speed', value: '9999' });
ok(r.ok && !same.ok && /already reads/.test(same.error),
  'setting a value it already holds is refused rather than writing an empty diff');

// ── the surfaces ─────────────────────────────────────────────────────────────────

console.log('\nthe surfaces');
ok(isInspectable('a.prefab') && isInspectable('b.unity') && isInspectable('c.asset'),
  'the three extensions that share Unity\'s dialect are accepted');
ok(!isInspectable('d.cs') && !isInspectable('e.png') && !isInspectable('f.controller'),
  'and nothing else is — a different format would parse into confident nonsense');

const inspect = (await import(`file://${join(DIST, 'tools', 'defs', 'prefab_inspect.js')}`)).tool;
const edit = (await import(`file://${join(DIST, 'tools', 'defs', 'prefab_edit.js')}`)).tool;
ok(inspect.slash?.command === 'prefab' && inspect.slash?.param === 'path', '/prefab runs prefab_inspect');
ok(inspect.slash?.overlay === true, 'and shows its answer in an overlay — a tree is a document, not a chat line');
ok(inspect.slash?.defaults?.format === 'tree',
  'the operator gets the readable tree while the agent gets JSON from the same tool');
ok(!edit.slash, 'prefab_edit has NO slash: a write is the agent\'s move, made from an inspect it just read');
const refused = await inspect.execute({ path: join(project, 'Assets', 'Scripts', 'Widget.cs') });
ok(/not a \.prefab/.test(refused), 'inspecting a .cs is refused by the tool, not by the parser');
const asJson = JSON.parse(await inspect.execute({ path: PREFAB, depth: '1' }));
ok(asJson.roots[0].components.some((c) => c.type === 'Widget'), 'the tool returns the map as JSON by default');
const asTree = await inspect.execute({ path: PREFAB, format: 'tree' });
ok(asTree.startsWith('Assets/Widget.prefab'), 'and a tree when asked', asTree.split('\n')[0]);

rmSync(project, { recursive: true, force: true });

console.log(fails ? `\nprefab check: ${fails} FAILURE(S)\n` : '\nprefab check: ok\n');
process.exit(fails ? 1 : 0);
