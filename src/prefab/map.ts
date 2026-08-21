/**
 * prefab/map.ts — the prefab as a tree a reader can follow, with every GUID already turned into a name.
 *
 * WHAT A PREFAB FILE IS NOT. It is a flat list of documents in arbitrary order, joined by numeric
 * fileIDs: a GameObject names its components by id, a Transform names its parent and children by id,
 * and nothing states the hierarchy. Reading one top to bottom tells you almost nothing about the object
 * it describes — which is why an agent asked "why does this icon spin forever" reads 250 lines of YAML
 * and still cannot say which component drives it.
 *
 * So this builds the thing the file implies: roots, children in their serialized order, each GameObject's
 * components under it, each component's real class (a `MonoBehaviour` is only ever as useful as the
 * script GUID it carries), and every reference rendered as what it points at.
 *
 * NESTED PREFABS ARE FOLLOWED, to a cap. A `PrefabInstance` is the point where the file stops describing
 * the object and starts pointing at another file, so stopping there means the map goes quiet exactly
 * where a UI prefab gets interesting. Expansion is depth-limited (default 3) and cycle-guarded by asset
 * path — a prefab that contains itself is a Unity error, but a map that recurses forever is ours.
 *
 * EVERY PROPERTY IS KEPT. Filtering to "the interesting ones" means deciding for the reader which field
 * their bug is in; the boilerplate costs a line each and a long array is clipped with its count, which is
 * the only place anything is dropped.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { at, collectRefs, entry, parseRef, parseUnityYaml, type YDocument, type YEntry, type YFile, type YValue } from './yaml.js';
import { relToRoot, resolveGuids, type AssetRef } from './refs.js';

/** Unity class ids this module reasons about by number rather than by type name. */
const GAME_OBJECT = 1;
const PREFAB_INSTANCE = 1001;
const TRANSFORMS = new Set([4, 224]);          // Transform, RectTransform

/** A long array is summarised rather than printed — the count is the fact, the 400 entries are not. */
const ARRAY_CLIP = 12;

/**
 * SUB-ASSETS SHARE THEIR FILE'S GUID, and are told apart only by the fileID.
 *
 * A TMP font is one `.asset` holding several objects: the font at 11400000, its material at 2100000, its
 * atlas texture at 2800000. Resolving by GUID alone therefore reported `m_sharedMaterial` as
 * "ScriptableObject named Montserrat-SemiBold SDF.asset" — the right file, the wrong thing inside it, and
 * a reader chasing a material would conclude the font was wired into the material slot.
 *
 * Unity builds those ids as `classId * 100000`, so the class is recoverable without opening the file.
 */
const SUB_ASSET_CLASS: Record<number, string> = {
  21: 'Material', 28: 'Texture2D', 43: 'Mesh', 48: 'Shader', 49: 'TextAsset', 74: 'AnimationClip',
  83: 'AudioClip', 114: 'ScriptableObject', 115: 'MonoScript', 128: 'Font', 213: 'Sprite',
  1001: 'Prefab', 91: 'AnimatorController', 1101: 'AnimatorStateTransition', 1102: 'AnimatorState',
};

/**
 * The class a sub-asset fileID names.
 *
 * Two shapes, because Unity writes both. The old one is arithmetic — `classId * 100000`, so 2100000 is a
 * Material and no file needs opening. The new one is a HASH: TMP writes its font's material as
 * `{fileID: 5641143137588812837, guid: <the font's guid>}`, which decodes to nothing. That id only means
 * something inside the target file, so the target file is where it is looked up — the document header
 * `--- !u!21 &5641143137588812837` is the answer, and finding it is one regex over text already on disk.
 *
 * Bounded on purpose: a font atlas asset can be tens of megabytes, and no label is worth reading that to
 * print one word. Results are memoised per call, since one prefab references the same font 40 times.
 */
function subAssetClass(fileId: string, assetAbs: string, memo: Map<string, string>): string {
  const n = Number(fileId);
  if (Number.isSafeInteger(n) && n > 0 && n % 100000 === 0) return SUB_ASSET_CLASS[n / 100000] ?? '';
  const key = `${assetAbs}#${fileId}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let answer = '';
  try {
    if (assetAbs && existsSync(assetAbs) && statSync(assetAbs).size <= 8 * 1024 * 1024) {
      const m = new RegExp(`^--- !u!(\\d+) &${fileId}\\b`, 'm').exec(readFileSync(assetAbs, 'utf-8'));
      if (m) answer = SUB_ASSET_CLASS[Number(m[1])] ?? `class ${m[1]}`;
    }
  } catch { answer = ''; }
  memo.set(key, answer);
  return answer;
}

export interface PropRef {
  /** The raw reference as written, so a reader can still grep the file for it. */
  raw: string;
  /** Resolved asset, when the GUID had a `.meta` somewhere. */
  asset?: AssetRef;
  /** An in-file reference: the object this fileID names, described. */
  local?: string;
  /** A GUID with no asset behind it — a deleted or unreachable target, which is worth saying out loud. */
  missing?: string;
}

export interface PropValue {
  kind: 'scalar' | 'ref' | 'map' | 'list';
  /** Scalars as written. */
  value?: string;
  ref?: PropRef;
  /** Nested maps and lists. A clipped list says so in `clipped`. */
  items?: PropValue[];
  fields?: Record<string, PropValue>;
  clipped?: number;
  /** Where it lives in the file — what makes an edit possible without re-reading. */
  line: number;
}

export interface ComponentMap {
  /** The class a person would name: the script's own name for a MonoBehaviour, else the Unity type. */
  type: string;
  /** Always the Unity type, so `MonoBehaviour` is still visible when the script is missing. */
  unityType: string;
  fileId: string;
  /** The script asset behind a MonoBehaviour. */
  script?: AssetRef;
  enabled?: string;
  line: number;
  properties: Record<string, PropValue>;
}

export interface ObjectMap {
  name: string;
  fileId: string;
  active: string;
  layer?: string;
  tag?: string;
  /** `Canvas/Progress/Slot0` — the address `prefab_edit` takes. */
  path: string;
  components: ComponentMap[];
  children: ObjectMap[];
  /** Set when this node is a nested prefab instance expanded from another file. */
  nested?: NestedPrefab;
}

export interface NestedPrefab {
  /** The prefab asset this instance comes from. */
  source?: AssetRef;
  sourceMissing?: string;
  /** Overrides this instance applies to the source, exactly as serialized. */
  modifications: Array<{ target: string; propertyPath: string; value: string; objectReference?: PropRef }>;
  /** Set when the cap stopped the walk here rather than the file ending. */
  truncated?: boolean;
}

export interface PrefabMap {
  file: string;
  /** How many YAML documents the file holds, and how many of those are only reference stubs. */
  documents: number;
  stripped: number;
  roots: ObjectMap[];
  /** Documents that are not GameObjects, components or prefab instances — a `.asset` is all of these. */
  loose: ComponentMap[];
  unresolved: string[];
  depth: number;
}

interface Ctx {
  root: string;
  refs: Map<string, AssetRef>;
  depth: number;
  /** Asset paths already on this branch — a nested prefab must not re-enter itself. */
  seen: Set<string>;
  /** `<asset>#<fileID>` → class name, so one font referenced forty times is read once. */
  subAssets: Map<string, string>;
}

/** Every GUID a file mentions, so one resolution pass can cover the whole map. */
function guidsIn(file: YFile): Set<string> {
  const out = new Set<string>();
  for (const doc of file.documents) {
    for (const e of doc.body) {
      for (const ref of collectRefs(e.value)) if (ref.guid) out.add(ref.guid);
    }
  }
  return out;
}

/**
 * An in-file reference, described by what it IS rather than by its number.
 *
 * Read off a real paint: `m_TargetGraphic: → MonoBehaviour #8534225350800958343` is a line nobody can act
 * on — the class is the useless half (every script is a MonoBehaviour) and the id is unmemorable. The
 * component's own script and the GameObject it sits on are both one lookup away, and together they are an
 * address: `→ Image on AppVersion`. The fileID stays in `raw` for anyone who wants to grep the file.
 */
function describeLocal(byId: Map<string, YDocument>, fileId: string, ctx: Ctx): string | undefined {
  if (fileId === '0') return undefined;
  const doc = byId.get(fileId);
  if (!doc) return undefined;
  const suffix = doc.stripped ? ' (from a nested prefab)' : '';
  if (doc.classId === GAME_OBJECT) {
    const name = entry(doc.body, 'm_Name')?.raw ?? '';
    return `GameObject ${name || '(unnamed)'}${suffix}`;
  }
  const scriptGuid = parseRef(entry(doc.body, 'm_Script')?.raw ?? '')?.guid;
  const script = scriptGuid ? ctx.refs.get(scriptGuid) : undefined;
  const cls = script ? script.name.replace(/\.cs$/, '') : doc.typeName;
  const ownerId = parseRef(entry(doc.body, 'm_GameObject')?.raw ?? '')?.fileId;
  const owner = ownerId ? byId.get(ownerId) : undefined;
  const ownerName = owner ? entry(owner.body, 'm_Name')?.raw ?? '' : '';
  return ownerName ? `${cls} on ${ownerName}${suffix}` : `${cls}${suffix} #${fileId}`;
}

function toRef(raw: string, ctx: Ctx, byId: Map<string, YDocument>): PropRef {
  const parsed = parseRef(raw);
  const out: PropRef = { raw };
  if (!parsed) return out;
  if (parsed.guid) {
    const asset = ctx.refs.get(parsed.guid);
    if (asset) {
      const sub = subAssetClass(parsed.fileId, asset.path ? join(ctx.root, asset.path) : '', ctx.subAssets);
      // The file's own type stays when the reference names its main object; a sub-object says which one
      // it is, since `type` is the only field that can distinguish them.
      out.asset = sub && sub !== 'ScriptableObject' && sub !== asset.type ? { ...asset, type: sub } : asset;
    } else out.missing = parsed.guid;
    return out;
  }
  const local = describeLocal(byId, parsed.fileId, ctx);
  if (local) out.local = local;
  return out;
}

function toProp(value: YValue, ctx: Ctx, byId: Map<string, YDocument>): PropValue {
  if (value.kind === 'flow') {
    const single = parseRef(value.raw);
    if (single) return { kind: 'ref', ref: toRef(value.raw, ctx, byId), line: value.line };
    // `[]`, or a flow list of references.
    const inner = [...value.raw.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]);
    if (inner.length) {
      return {
        kind: 'list', line: value.line,
        items: inner.slice(0, ARRAY_CLIP).map((one) => ({ kind: 'ref', ref: toRef(one, ctx, byId), line: value.line })),
        clipped: inner.length > ARRAY_CLIP ? inner.length - ARRAY_CLIP : undefined,
      };
    }
    return { kind: 'scalar', value: value.raw, line: value.line };
  }
  if (value.kind === 'seq') {
    const items = value.children.slice(0, ARRAY_CLIP).map((c) => toProp(c.value, ctx, byId));
    return {
      kind: 'list', items, line: value.line,
      clipped: value.children.length > ARRAY_CLIP ? value.children.length - ARRAY_CLIP : undefined,
    };
  }
  if (value.kind === 'map') {
    const fields: Record<string, PropValue> = {};
    for (const c of value.children) fields[c.key || `#${Object.keys(fields).length}`] = toProp(c.value, ctx, byId);
    return { kind: 'map', fields, line: value.line };
  }
  return { kind: 'scalar', value: value.raw, line: value.line };
}

/** The keys every component carries and nobody reads: kept out of the property map, named here so the
 *  omission is a decision rather than an accident. They are recoverable from the file itself. */
const STRUCTURAL = new Set(['m_ObjectHideFlags', 'm_GameObject', 'm_Script', 'm_Enabled',
  'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset', 'm_EditorHideFlags',
  'm_EditorClassIdentifier']);

function componentOf(doc: YDocument, ctx: Ctx, byId: Map<string, YDocument>): ComponentMap {
  const scriptRaw = entry(doc.body, 'm_Script')?.raw ?? '';
  const scriptRef = scriptRaw ? parseRef(scriptRaw) : null;
  const script = scriptRef?.guid ? ctx.refs.get(scriptRef.guid) : undefined;
  const properties: Record<string, PropValue> = {};
  for (const e of doc.body) {
    if (STRUCTURAL.has(e.key)) continue;
    properties[e.key] = toProp(e.value, ctx, byId);
  }
  return {
    // A script's file name IS its class name in Unity, so this is the name that appears in the Inspector.
    type: script ? script.name.replace(/\.cs$/, '') : doc.typeName,
    unityType: doc.typeName,
    fileId: doc.fileId,
    script,
    enabled: entry(doc.body, 'm_Enabled')?.raw,
    line: doc.line,
    properties,
  };
}

const refIdsOf = (value: YValue | null): string[] => {
  if (!value) return [];
  if (value.kind === 'flow') {
    return [...value.raw.matchAll(/fileID:\s*(-?\d+)/g)].map((m) => m[1]).filter((id) => id !== '0');
  }
  return value.children.flatMap((c) => refIdsOf(c.value));
};

/** The GameObject a transform belongs to, and the transform a GameObject uses — the two lookups the
 *  hierarchy is built from. */
function transformIndex(file: YFile): { transformOf: Map<string, YDocument>; goOfTransform: Map<string, string> } {
  const transformOf = new Map<string, YDocument>();
  const goOfTransform = new Map<string, string>();
  for (const doc of file.documents) {
    if (!TRANSFORMS.has(doc.classId)) continue;
    const go = parseRef(entry(doc.body, 'm_GameObject')?.raw ?? '')?.fileId;
    if (!go) continue;
    transformOf.set(go, doc);
    goOfTransform.set(doc.fileId, go);
  }
  return { transformOf, goOfTransform };
}

function modificationsOf(doc: YDocument, ctx: Ctx, byId: Map<string, YDocument>): NestedPrefab['modifications'] {
  const mods = at(doc.body, 'm_Modification.m_Modifications');
  if (!mods) return [];
  return mods.children.map((item) => {
    const target = entry(item.value.children, 'target')?.raw ?? '';
    const objRaw = entry(item.value.children, 'objectReference')?.raw ?? '';
    const objRef = objRaw && objRaw !== '{fileID: 0}' ? toRef(objRaw, ctx, byId) : undefined;
    return {
      target,
      propertyPath: entry(item.value.children, 'propertyPath')?.raw ?? '',
      value: entry(item.value.children, 'value')?.raw ?? '',
      objectReference: objRef,
    };
  });
}

async function buildFile(abs: string, ctx: Ctx): Promise<PrefabMap> {
  const file = parseUnityYaml(abs, readFileSync(abs, 'utf-8'));
  const byId = new Map(file.documents.map((d) => [d.fileId, d]));
  const { transformOf, goOfTransform } = transformIndex(file);
  const consumed = new Set<string>();

  const objectAt = async (goId: string, parentPath: string): Promise<ObjectMap | null> => {
    const doc = byId.get(goId);
    if (!doc || doc.classId !== GAME_OBJECT) return null;
    consumed.add(goId);
    const name = entry(doc.body, 'm_Name')?.raw ?? '';
    const path = parentPath ? `${parentPath}/${name}` : name;
    const components: ComponentMap[] = [];
    for (const id of refIdsOf(entry(doc.body, 'm_Component'))) {
      const comp = byId.get(id);
      if (!comp) continue;
      consumed.add(id);
      components.push(componentOf(comp, ctx, byId));
    }
    const transform = transformOf.get(goId);
    if (transform) consumed.add(transform.fileId);
    const children: ObjectMap[] = [];
    for (const childTransformId of refIdsOf(transform ? entry(transform.body, 'm_Children') : null)) {
      const childGo = goOfTransform.get(childTransformId);
      if (childGo) {
        const child = await objectAt(childGo, path);
        if (child) children.push(child);
        continue;
      }
      // A child transform that is `stripped` belongs to a nested prefab instance living in this file.
      const stripped = byId.get(childTransformId);
      if (stripped?.stripped) {
        const instanceId = parseRef(entry(stripped.body, 'm_PrefabInstance')?.raw ?? '')?.fileId;
        const instance = instanceId ? byId.get(instanceId) : undefined;
        if (instance && instance.classId === PREFAB_INSTANCE && !consumed.has(instance.fileId)) {
          consumed.add(instance.fileId);
          const nested = await nestedAt(instance, path);
          if (nested) children.push(nested);
        }
      }
    }
    return {
      name, fileId: goId, path,
      active: entry(doc.body, 'm_IsActive')?.raw ?? '',
      layer: entry(doc.body, 'm_Layer')?.raw,
      tag: entry(doc.body, 'm_TagString')?.raw,
      components, children,
    };
  };

  const nestedAt = async (instance: YDocument, parentPath: string): Promise<ObjectMap | null> => {
    const sourceRaw = entry(instance.body, 'm_SourcePrefab')?.raw ?? '';
    const sourceGuid = parseRef(sourceRaw)?.guid;
    const source = sourceGuid ? ctx.refs.get(sourceGuid) : undefined;
    const nested: NestedPrefab = {
      source,
      sourceMissing: source ? undefined : sourceGuid,
      modifications: modificationsOf(instance, ctx, byId),
    };
    const name = source ? source.name.replace(/\.prefab$/, '') : `PrefabInstance #${instance.fileId}`;
    const path = parentPath ? `${parentPath}/${name}` : name;
    const node: ObjectMap = {
      name, fileId: instance.fileId, active: '', path,
      components: [], children: [], nested,
    };

    const sourceAbs = source?.path ? join(ctx.root, source.path) : '';
    if (!sourceAbs || !existsSync(sourceAbs)) return node;
    if (ctx.depth <= 0 || ctx.seen.has(source!.path)) {
      nested.truncated = true;
      return node;
    }
    const inner = await buildPrefabMap(sourceAbs, {
      root: ctx.root, depth: ctx.depth - 1, seen: new Set([...ctx.seen, source!.path]),
      subAssets: ctx.subAssets,
    });
    // The source's own roots become this instance's children: what the operator sees in the hierarchy is
    // one tree, not "an instance" with a separate document hanging off it.
    node.children = inner.roots.map((r) => ({ ...r, path: `${path}/${r.name}` }));
    for (const g of inner.unresolved) if (!nested.sourceMissing) nested.sourceMissing = undefined, void g;
    return node;
  };

  const roots: ObjectMap[] = [];
  for (const doc of file.documents) {
    if (doc.classId !== GAME_OBJECT || doc.stripped) continue;
    const transform = transformOf.get(doc.fileId);
    const father = parseRef(entry(transform?.body ?? [], 'm_Father')?.raw ?? '')?.fileId ?? '0';
    if (father !== '0') continue;
    const built = await objectAt(doc.fileId, '');
    if (built) roots.push(built);
  }

  // A root-level PrefabInstance — a prefab whose top object comes from another file.
  for (const doc of file.documents) {
    if (doc.classId !== PREFAB_INSTANCE || consumed.has(doc.fileId)) continue;
    const parent = parseRef(at(doc.body, 'm_Modification.m_TransformParent')?.raw ?? '')?.fileId ?? '0';
    if (parent !== '0') continue;
    consumed.add(doc.fileId);
    const nested = await nestedAt(doc, '');
    if (nested) roots.push(nested);
  }

  // Whatever is left is not part of a hierarchy: a ScriptableObject `.asset` has exactly one such
  // document, and a prefab with orphans has a real problem worth seeing rather than hiding.
  const loose = file.documents
    .filter((d) => !consumed.has(d.fileId) && !d.stripped && d.classId !== PREFAB_INSTANCE)
    .filter((d) => d.classId !== GAME_OBJECT)
    .map((d) => componentOf(d, ctx, byId));

  const unresolved = [...guidsIn(file)].filter((g) => !ctx.refs.has(g));

  return {
    file: relToRoot(ctx.root, abs),
    documents: file.documents.length,
    stripped: file.documents.filter((d) => d.stripped).length,
    roots, loose, unresolved, depth: ctx.depth,
  };
}

/**
 * The map for one asset file, GUIDs resolved.
 *
 * References are resolved in ONE pass per file rather than per reference (see refs.ts) — including the
 * nested prefabs' own GUIDs, which is why each recursion level resolves again rather than sharing a
 * cache: a cache here is a staleness question, and the scan is a scan either way.
 */
export async function buildPrefabMap(
  abs: string,
  opts: { root: string; depth?: number; seen?: Set<string>; subAssets?: Map<string, string> },
): Promise<PrefabMap> {
  const file = parseUnityYaml(abs, readFileSync(abs, 'utf-8'));
  const refs = await resolveGuids(opts.root, guidsIn(file));
  return buildFile(abs, {
    root: opts.root,
    refs,
    depth: opts.depth ?? 3,
    seen: opts.seen ?? new Set([relToRoot(opts.root, abs)]),
    subAssets: opts.subAssets ?? new Map(),
  });
}

/** `.prefab`, `.unity`, `.asset` — one dialect, and the only three this accepts. */
export function isInspectable(path: string): boolean {
  return /\.(prefab|unity|asset)$/i.test(basename(path));
}
