/**
 * prefab/edit.ts — change one property in a Unity asset and touch nothing else.
 *
 * WHY THE EDIT IS BYTE-LEVEL. The alternative — parse to a model, write the model back — loses every key
 * the parser did not think of, and turns a one-value change into a whole-file diff that no reviewer can
 * read and that Unity's own merge tool cannot resolve. So the parse is used only to LOCATE the value, and
 * the write replaces exactly the lines that value occupied. A prefab edited here differs from the
 * original in one line, which is also the proof that nothing else moved.
 *
 * ASSETS ARE NAMED, NOT HEXED. `asset=Hero_SkeletonData.asset` is how a person thinks about a
 * wiring change; `guid: 3d9f…` is how the file stores it. The name is resolved by searching the project,
 * and AMBIGUITY IS REFUSED: two files with that name are two different wirings, and picking one would
 * produce a change that looks applied and points somewhere nobody chose.
 *
 * THE fileID AND type ARE PRESERVED, NOT INVENTED. A reference is three fields, and only the guid names
 * the file; `fileID` selects which object INSIDE it (a font's material is a different id from the font)
 * and `type` is Unity's source flag. Swapping only the guid keeps a working reference working. They are
 * derived from the extension only when there was no reference there before — and the result says which
 * rule was used, because that is the part a reader would otherwise have to diff Unity's behaviour to learn.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { at, entry, parseRef, parseUnityYaml, type YDocument, type YValue } from './yaml.js';
import { findAssetByName, relToRoot, resolveGuids, type AssetRef } from './refs.js';
import { buildUnifiedDiff } from '../tools/lib.js';
import { gateWrite } from '../entangle/index.js';
import { ensureToolRuntime } from '../tool-wiring.js';
import { log } from '../log.js';

// Imports a tool module directly, so it wires the tool runtime itself rather than depending on whoever
// happened to load the registry first. Idempotent.
ensureToolRuntime();

const GAME_OBJECT = 1;
const TRANSFORMS = new Set([4, 224]);

/** What a new reference looks like when there was nothing there to copy. Unity's own main-object ids. */
const MAIN_OBJECT: Record<string, { fileId: string; type: number }> = {
  '.cs': { fileId: '11500000', type: 3 },
  '.asset': { fileId: '11400000', type: 2 },
  '.prefab': { fileId: '100100000', type: 3 },
  '.unity': { fileId: '102900000', type: 3 },
  '.mat': { fileId: '2100000', type: 2 },
  '.anim': { fileId: '7400000', type: 2 },
  '.controller': { fileId: '9100000', type: 2 },
  '.png': { fileId: '2800000', type: 3 },
  '.jpg': { fileId: '2800000', type: 3 },
  '.ttf': { fileId: '12800000', type: 3 },
  '.otf': { fileId: '12800000', type: 3 },
  '.shader': { fileId: '4800000', type: 3 },
  '.wav': { fileId: '8300000', type: 3 },
  '.ogg': { fileId: '8300000', type: 3 },
};

export interface EditRequest {
  /** Absolute path to the `.prefab`, `.unity` or `.asset`. */
  file: string;
  root: string;
  /** `Progress/Slot0`, or a unique GameObject name. Omit for a single-document `.asset`. */
  object?: string;
  /** A component class name (`SkeletonGraphic`, `RectTransform`) or `#<fileID>` from an inspect. */
  component?: string;
  /** `m_SkeletonDataAsset`, `freeze`, `m_Pivot.x`. */
  property: string;
  /** The new scalar, as it should read in the file. */
  value?: string;
  /** An asset FILE NAME to point this property at. Mutually exclusive with `value`. */
  asset?: string;
}

export type EditResult =
  | { ok: true; diff: string; rule: string; target: string }
  | { ok: false; error: string };

const extOf = (p: string): string => {
  const b = basename(p);
  const dot = b.lastIndexOf('.');
  return dot <= 0 ? '' : b.slice(dot).toLowerCase();
};

interface Located {
  doc: YDocument;
  label: string;
}

/** Every GameObject in the file with its hierarchy path — the address an operator can name. */
function objectPaths(docs: YDocument[]): Map<string, YDocument[]> {
  const byId = new Map(docs.map((d) => [d.fileId, d]));
  const transformOf = new Map<string, YDocument>();
  const goOfTransform = new Map<string, string>();
  for (const doc of docs) {
    if (!TRANSFORMS.has(doc.classId)) continue;
    const go = parseRef(entry(doc.body, 'm_GameObject')?.raw ?? '')?.fileId;
    if (!go) continue;
    transformOf.set(go, doc);
    goOfTransform.set(doc.fileId, go);
  }
  const pathOf = new Map<string, string>();
  const resolve = (goId: string, guard: Set<string>): string => {
    const cached = pathOf.get(goId);
    if (cached !== undefined) return cached;
    if (guard.has(goId)) return '';
    guard.add(goId);
    const doc = byId.get(goId);
    const name = doc ? entry(doc.body, 'm_Name')?.raw ?? '' : '';
    const father = parseRef(entry(transformOf.get(goId)?.body ?? [], 'm_Father')?.raw ?? '')?.fileId ?? '0';
    const parentGo = father !== '0' ? goOfTransform.get(father) : undefined;
    const full = parentGo ? `${resolve(parentGo, guard)}/${name}` : name;
    pathOf.set(goId, full);
    return full;
  };
  const out = new Map<string, YDocument[]>();
  for (const doc of docs) {
    if (doc.classId !== GAME_OBJECT || doc.stripped) continue;
    const path = resolve(doc.fileId, new Set());
    const list = out.get(path) ?? [];
    list.push(doc);
    out.set(path, list);
  }
  return out;
}

const componentIdsOf = (go: YDocument): string[] => {
  const comps = entry(go.body, 'm_Component');
  if (!comps) return [];
  return comps.children
    .map((c) => parseRef(entry(c.value.children, 'component')?.raw ?? c.value.raw)?.fileId)
    .filter((id): id is string => Boolean(id) && id !== '0');
};

/**
 * The document a request names.
 *
 * A `.asset` usually has one document and needs no object or component at all; a prefab needs both, and
 * both may be ambiguous. Every ambiguity is answered with the candidates rather than a choice: the whole
 * point of naming a component by class is that the operator sees what they hit.
 */
async function locate(req: EditRequest, docs: YDocument[]): Promise<Located | { error: string }> {
  const byId = new Map(docs.map((d) => [d.fileId, d]));

  if (req.component?.startsWith('#')) {
    const doc = byId.get(req.component.slice(1));
    return doc ? { doc, label: `${doc.typeName} ${req.component}` } : { error: `no document with fileID ${req.component.slice(1)}` };
  }

  const real = docs.filter((d) => !d.stripped);
  if (!req.object) {
    const candidates = real.filter((d) => d.classId !== GAME_OBJECT && !TRANSFORMS.has(d.classId));
    if (!req.component && candidates.length === 1) return { doc: candidates[0], label: candidates[0].typeName };
    if (!req.component) {
      return { error: `this file has ${candidates.length} documents — name the component: ${candidates.map((d) => d.typeName).slice(0, 8).join(', ')}` };
    }
  }

  let pool: YDocument[] = [];
  let where = '';
  if (req.object) {
    const paths = objectPaths(real);
    let hits = paths.get(req.object) ?? [];
    if (hits.length === 0) {
      // A bare name is accepted when it is unique — an operator reading a tree should not have to type
      // the whole path, but two objects called "Icon" must not silently resolve to the first one.
      const byName = [...paths.entries()].filter(([p]) => p === req.object || p.endsWith(`/${req.object}`));
      if (byName.length === 0) {
        const known = [...paths.keys()].filter(Boolean).slice(0, 10).join(', ');
        return { error: `no GameObject at "${req.object}". Known paths include: ${known}` };
      }
      if (byName.length > 1) {
        return { error: `"${req.object}" matches ${byName.length} objects: ${byName.map(([p]) => p).slice(0, 8).join(', ')} — give the full path` };
      }
      hits = byName[0][1];
      where = byName[0][0];
    } else where = req.object;
    if (hits.length > 1) return { error: `"${req.object}" names ${hits.length} GameObjects in this file — use #<fileID>` };
    pool = componentIdsOf(hits[0]).map((id) => byId.get(id)).filter((d): d is YDocument => Boolean(d));
  } else {
    pool = real.filter((d) => d.classId !== GAME_OBJECT);
  }

  if (!req.component) {
    return { error: `name the component. On ${where || 'this file'}: ${pool.map((d) => d.typeName).join(', ')}` };
  }

  // A MonoBehaviour answers to its SCRIPT's name, which is the only name a person sees in the Inspector.
  const scriptGuids = new Map<string, string>();
  for (const doc of pool) {
    const g = parseRef(entry(doc.body, 'm_Script')?.raw ?? '')?.guid;
    if (g) scriptGuids.set(doc.fileId, g);
  }
  const resolved = scriptGuids.size ? await resolveGuids(req.root, scriptGuids.values()) : new Map<string, AssetRef>();
  const nameOf = (doc: YDocument): string => {
    const g = scriptGuids.get(doc.fileId);
    const script = g ? resolved.get(g) : undefined;
    return script ? script.name.replace(/\.cs$/, '') : doc.typeName;
  };

  const wanted = req.component.toLowerCase();
  const matches = pool.filter((d) => nameOf(d).toLowerCase() === wanted || d.typeName.toLowerCase() === wanted);
  if (matches.length === 0) {
    return { error: `no component "${req.component}" on ${where || 'this file'} — it has: ${pool.map(nameOf).join(', ')}` };
  }
  if (matches.length > 1) {
    return { error: `${matches.length} components named "${req.component}" on ${where || 'this file'} — use #<fileID>: ${matches.map((d) => `#${d.fileId}`).join(', ')}` };
  }
  return { doc: matches[0], label: `${nameOf(matches[0])} on ${where || basename(req.file)}` };
}

/** The replacement text for a reference property, and the rule that produced it. */
async function refText(req: EditRequest, existing: YValue | null): Promise<{ text: string; rule: string } | { error: string }> {
  const found = await findAssetByName(req.root, req.asset!);
  if (found.matches.length === 0) return { error: `no asset named "${req.asset}" under ${relToRoot(req.root, req.root)}` };
  if (found.matches.length > 1) {
    return { error: `"${req.asset}" matches ${found.matches.length} files — pass the one you mean by its full name: ${found.matches.map((m) => m.path).join(', ')}` };
  }
  const target = found.matches[0];
  const old = existing ? parseRef(existing.raw) : null;

  if (old?.guid && old.type !== undefined) {
    const oldRef = (await resolveGuids(req.root, [old.guid])).get(old.guid);
    /**
     * THE CLASS MUST MATCH, not merely the extension.
     *
     * Both a TMP font and a game-config ScriptableObject are `.asset` files, so an extension check
     * accepted `asset=GameConfig.asset` into `m_fontAsset` and reported success — the exact
     * mis-wiring this tool exists to fix, produced by the tool. Unity would then read that field as null
     * and the text would silently render with no font.
     *
     * A field typed as a base class is the case this refuses wrongly, so the refusal names the way
     * through: `value=` writes a literal reference for an operator who knows what they are doing.
     */
    if (oldRef && oldRef.type !== target.type) {
      return {
        error: `${req.property} currently holds a ${oldRef.type} (${oldRef.name}) and "${target.name}" is a ${target.type}`
          + ` — Unity would read that field as null. If the field really accepts it, write the reference yourself with`
          + ` value={fileID: ${old.fileId}, guid: ${target.guid}, type: ${old.type}}`,
      };
    }
    // Same kind of asset: the existing fileID and type are already correct for it, and inventing new ones
    // is how a working reference becomes a broken one.
    if (oldRef && extOf(oldRef.path) === extOf(target.path)) {
      return {
        text: `{fileID: ${old.fileId}, guid: ${target.guid}, type: ${old.type}}`,
        rule: `kept fileID ${old.fileId} and type ${old.type} from the reference already there`,
      };
    }
  }
  const main = MAIN_OBJECT[extOf(target.path)];
  if (!main) return { error: `${target.name}: no known main-object id for a ${extOf(target.path) || 'file with no extension'} — set it with value= if you know the reference` };
  return {
    text: `{fileID: ${main.fileId}, guid: ${target.guid}, type: ${main.type}}`,
    rule: `new reference to a ${extOf(target.path)} main object (fileID ${main.fileId}, type ${main.type})`,
  };
}

/**
 * Set one property. Nothing structural: no components added, no objects created, no hierarchy moved.
 *
 * The value's own line span is what gets replaced, so a reference that Unity had wrapped across two lines
 * collapses to one — which is a form Unity writes itself and reads back identically.
 */
export async function setPrefabProperty(req: EditRequest): Promise<EditResult> {
  if (!existsSync(req.file)) return { ok: false, error: `file not found: ${req.file}` };
  if (req.value !== undefined && req.asset !== undefined) {
    return { ok: false, error: 'pass value= or asset=, not both — one is a scalar, the other is a reference' };
  }
  if (req.value === undefined && req.asset === undefined) {
    return { ok: false, error: 'nothing to set: pass value=<scalar> or asset=<file name>' };
  }

  const before = readFileSync(req.file, 'utf-8');
  const file = parseUnityYaml(req.file, before);
  const located = await locate(req, file.documents);
  if ('error' in located) return { ok: false, error: located.error };

  let value = at(located.doc.body, req.property);
  /**
   * A VECTOR FIELD IS ONE FLOW MAP, and `m_Pivot.x` addresses inside it.
   *
   * `m_Pivot: {x: 0.5, y: 0.5}` is the single most common thing anyone edits in a prefab, and it has no
   * child nodes to find — the whole vector is one value. So the leaf is rewritten inside that text and the
   * flow map is replaced as a unit, which is also how Unity writes it back.
   */
  let flowField = '';
  if (!value && req.property.includes('.')) {
    const cut = req.property.lastIndexOf('.');
    const parent = at(located.doc.body, req.property.slice(0, cut));
    const leaf = req.property.slice(cut + 1);
    if (parent?.kind === 'flow' && new RegExp(`[{,]\\s*${leaf}\\s*:`).test(parent.raw)) {
      if (req.asset !== undefined) {
        return { ok: false, error: `"${req.property}" is a field inside ${req.property.slice(0, cut)} — a reference cannot go there; pass value=` };
      }
      const rewrittenFlow = parent.raw.replace(
        new RegExp(`([{,]\\s*${leaf}\\s*:\\s*)([^,}]*)`),
        (_m, head: string) => `${head}${req.value}`,
      );
      if (rewrittenFlow === parent.raw) {
        return { ok: false, error: `could not place ${leaf} inside ${parent.raw}` };
      }
      value = { ...parent, raw: parent.raw };
      const lines0 = before.split('\n');
      const head0 = lines0[parent.line - 1].slice(0, parent.column);
      const after0 = [...lines0.slice(0, parent.line - 1), `${head0}${rewrittenFlow}`, ...lines0.slice(parent.endLine)].join('\n');
      const stop0 = gateWrite(req.file, after0);
      if (stop0) return { ok: false, error: stop0 };
      writeFileSync(req.file, after0, 'utf-8');
      log('INFO', 'prefab_property_set', {
        file: relToRoot(req.root, req.file), target: located.label, property: req.property, rule: 'field inside a flow map',
      });
      return {
        ok: true,
        diff: buildUnifiedDiff(relToRoot(req.root, req.file), before, after0),
        rule: `rewrote ${leaf} inside ${req.property.slice(0, cut)}`,
        target: located.label,
      };
    }
    void flowField;
  }
  if (!value) {
    const keys = located.doc.body.map((e) => e.key);
    return {
      ok: false,
      error: `${located.label} has no property "${req.property}". It has: ${keys.slice(0, 24).join(', ')}${keys.length > 24 ? `, +${keys.length - 24} more` : ''}`,
    };
  }
  if (value.kind === 'map' || value.kind === 'seq') {
    return { ok: false, error: `"${req.property}" is a ${value.kind}, not a single value — name a leaf inside it (e.g. ${req.property}.x)` };
  }

  let replacement: string;
  let rule: string;
  if (req.asset !== undefined) {
    const built = await refText(req, value);
    if ('error' in built) return { ok: false, error: built.error };
    replacement = built.text;
    rule = built.rule;
  } else {
    replacement = req.value!;
    rule = 'scalar written as given';
  }

  const lines = before.split('\n');
  const first = value.line - 1;
  const head = lines[first].slice(0, value.column);
  const rewritten = [...lines.slice(0, first), `${head}${replacement}`, ...lines.slice(value.endLine)];
  const after = rewritten.join('\n');
  if (after === before) return { ok: false, error: `${req.property} already reads ${replacement} — nothing to change` };

  // The same gate write_file and str_replace answer to. A prefab declares no code surface, so this is a
  // no-op today; going around it would be the kind of second door that stops being a no-op quietly.
  const stop = gateWrite(req.file, after);
  if (stop) return { ok: false, error: stop };

  writeFileSync(req.file, after, 'utf-8');
  log('INFO', 'prefab_property_set', {
    file: relToRoot(req.root, req.file), target: located.label, property: req.property, rule,
  });
  return {
    ok: true,
    diff: buildUnifiedDiff(relToRoot(req.root, req.file), before, after),
    rule,
    target: located.label,
  };
}

/** Where the project root is, for a file the caller only knows by path. */
export function projectRootFor(abs: string): string {
  let dir = abs;
  for (let i = 0; i < 10; i++) {
    const up = join(dir, '..');
    if (existsSync(join(dir, 'Assets')) && existsSync(join(dir, 'ProjectSettings'))) return dir;
    if (up === dir) break;
    dir = up;
  }
  return '';
}
