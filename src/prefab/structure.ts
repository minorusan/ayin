/**
 * prefab/structure.ts — the edits that move or remove objects, rather than changing one value.
 *
 * WHY ONLY TWO OF THEM. `prefab_edit` writes a property and nothing else, which is why it is safe; a
 * session that wanted more said so plainly — *"cannot add/remove GameObjects, components, or
 * reparent; for structural changes you still need Unity Editor or YAML surgery."* Of the operations
 * it asked for, two are pure bookkeeping over ids that already exist, and one is not:
 *
 *   reparent   move a fileID between two `m_Children` lists and set `m_Father`. Nothing is invented.
 *   delete     remove documents that exist, after proving nothing still points at them.
 *   ADD        would have to emit a component's serialized fields with their DEFAULT values, and those
 *              come from the C# class — field initializers, `[SerializeField]` on privates, nested
 *              `[Serializable]` types, Unity's own rules. Guessing them produces a file that parses
 *              and is wrong, which is exactly the failure that put `m_Color: 0.5, 0.5, 0.5, 1` into a
 *              real prefab last week. Unity would also rewrite whatever it disagreed with on next
 *              open, turning a one-component change into a thousand-line diff. It is not here.
 *
 * DELETING PROVES NOTHING POINTS AT IT FIRST. A fileID removed while another document still
 * references it leaves a dangling link: Unity reads the asset, finds nothing at that id, and silently
 * drops the reference — a missing sprite, an unwired button, discovered in the editor days later.
 * Every remaining document is scanned for the ids about to go, and a hit REFUSES with the referrers
 * named rather than warning and proceeding.
 *
 * LINE SURGERY, NOT RE-SERIALIZATION. Both operations splice the file's own lines and leave every
 * other byte alone, including its line endings — the same rule the property editor learned when a
 * single edit turned one line of a CRLF file into LF. Rewriting the whole document from a parsed
 * model would reformat a file Unity has opinions about, and the diff would bury the change.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { buildUnifiedDiff } from '../tools/lib.js';
import { entry, parseRef, parseUnityYaml, type YDocument, type YFile, type YValue } from './yaml.js';
import { relToRoot } from './refs.js';
import { log } from '../log.js';
import { ensureToolRuntime } from '../tool-wiring.js';

// Same reason as `edit.ts` beside it: this module imports a tool helper, so it must not trust import
// order to have initialised the tool runtime for it. Idempotent, and the gate checks it is here.
ensureToolRuntime();

const GAME_OBJECT = 1;
const TRANSFORMS = new Set([4, 224]);

export interface StructureRequest {
  file: string;
  root: string;
  /** The GameObject to move or remove: a hierarchy path, or a unique name. */
  object: string;
  /** reparent only: the new parent's path or name. Empty string means "to the file root". */
  to?: string;
  /** delete only: a component class on `object`, instead of the object itself. */
  component?: string;
  dryRun?: boolean;
}

export type StructureResult =
  | { ok: true; diff: string; what: string; dryRun?: boolean }
  | { ok: false; error: string };

/** Every `{fileID: N}` in a value, at any depth. */
function refsIn(v: YValue | null): string[] {
  if (!v) return [];
  const here = v.kind === 'flow' || v.kind === 'scalar' ? [parseRef(v.raw)?.fileId] : [];
  return [...here, ...v.children.flatMap((c) => refsIn(c.value))].filter((x): x is string => Boolean(x));
}

/** GameObject fileId → its Transform document, and the reverse. */
function transforms(file: YFile): { ofGo: Map<string, YDocument>; goOf: Map<string, string> } {
  const ofGo = new Map<string, YDocument>();
  const goOf = new Map<string, string>();
  for (const d of file.documents) {
    if (!TRANSFORMS.has(d.classId)) continue;
    const go = parseRef(entry(d.body, 'm_GameObject')?.raw ?? '')?.fileId;
    if (!go) continue;
    ofGo.set(go, d);
    goOf.set(d.fileId, go);
  }
  return { ofGo, goOf };
}

/** Resolve a hierarchy path or a unique name to one GameObject document. */
function locate(file: YFile, want: string): { doc: YDocument } | { error: string } {
  const wanted = want.trim();
  const gos = file.documents.filter((d) => d.classId === GAME_OBJECT && !d.stripped);
  const leaf = wanted.includes('/') ? wanted.slice(wanted.lastIndexOf('/') + 1) : wanted;
  const named = gos.filter((d) => (entry(d.body, 'm_Name')?.raw ?? '').trim() === leaf);
  if (!named.length) {
    const all = [...new Set(gos.map((d) => (entry(d.body, 'm_Name')?.raw ?? '').trim()).filter(Boolean))];
    return { error: `no GameObject named "${leaf}" in this file. It has: ${all.slice(0, 20).join(', ')}` };
  }
  if (named.length > 1) {
    return {
      error: `"${leaf}" names ${named.length} GameObjects here. Say which by passing one of these as `
        + `object=:\n  ${named.map((d) => `#${d.fileId}`).join('\n  ')}`,
    };
  }
  return { doc: named[0] };
}

/** `#123` addresses a document directly; anything else is a name or path. */
function byIdOrName(file: YFile, want: string): { doc: YDocument } | { error: string } {
  const w = want.trim();
  if (w.startsWith('#')) {
    const hit = file.documents.find((d) => d.fileId === w.slice(1));
    return hit ? { doc: hit } : { error: `no document with fileID ${w.slice(1)} in this file` };
  }
  return locate(file, w);
}

/** The GameObject's own documents: itself, its components, its transform. */
function ownedIds(file: YFile, go: YDocument): Set<string> {
  const byId = new Map(file.documents.map((d) => [d.fileId, d]));
  const out = new Set<string>([go.fileId]);
  for (const id of refsIn(entry(go.body, 'm_Component'))) out.add(id);
  const { ofGo, goOf } = transforms(file);
  const t = ofGo.get(go.fileId);
  if (t) {
    out.add(t.fileId);
    // Descendants go with it: a child left behind is a subtree Unity cannot reach and will not draw.
    const queue = refsIn(entry(t.body, 'm_Children'));
    while (queue.length) {
      const childTransformId = queue.shift()!;
      const childGo = goOf.get(childTransformId);
      if (!childGo) continue;
      const childDoc = byId.get(childGo);
      if (!childDoc) continue;
      for (const id of ownedIds(file, childDoc)) out.add(id);
    }
  }
  return out;
}

/**
 * THE TWO LISTS THAT ARE STRUCTURE, NOT REFERENCE.
 *
 * A Transform's `m_Children` and a GameObject's `m_Component` are how the hierarchy is spelled: every
 * object is named in its parent's children, every component in its owner's list. Deleting anything
 * removes its entry from them BY DEFINITION, and the splice below does exactly that.
 *
 * Counting those as dangling references made the guard refuse everything — a component was blocked by
 * its own GameObject listing it, and a leaf object by the parent it hangs from. Measured on a real
 * prefab: every delete refused, one of the referrers always being the owner. The scan and the splice
 * now agree on the same two keys, which is the only way a guard about consistency can itself be
 * consistent.
 */
const STRUCTURAL_LISTS = new Set(['m_Children', 'm_Component']);

/** Documents outside `going` that still point into it — the reason a delete must refuse. */
function danglers(file: YFile, going: Set<string>): Array<{ from: YDocument; id: string }> {
  const out: Array<{ from: YDocument; id: string }> = [];
  for (const d of file.documents) {
    if (going.has(d.fileId)) continue;
    for (const e of d.body) {
      if (STRUCTURAL_LISTS.has(e.key)) continue;
      for (const id of refsIn(e.value)) {
        if (going.has(id)) out.push({ from: d, id });
      }
    }
  }
  return out;
}

const label = (d: YDocument): string =>
  `${d.typeName}${entry(d.body, 'm_Name')?.raw?.trim() ? ` "${entry(d.body, 'm_Name')!.raw.trim()}"` : ''} #${d.fileId}`;

function finish(req: StructureRequest, before: string, lines: string[], what: string): StructureResult {
  const after = lines.join('\n');
  if (after === before) return { ok: false, error: `${what} — nothing to change` };
  const diff = buildUnifiedDiff(relToRoot(req.root, req.file), before, after);
  if (req.dryRun) return { ok: true, dryRun: true, diff, what };
  writeFileSync(req.file, after, 'utf-8');
  log('INFO', 'prefab_structure', { file: relToRoot(req.root, req.file), what });
  return { ok: true, diff, what };
}

/**
 * Remove a GameObject (with its components and every descendant), or one component from it.
 *
 * The document's own line span is spliced out, and so is the `- {fileID: …}` line that its parent
 * lists it under — a child removed from the file but left in `m_Children` is the same dangling link
 * this function refuses to create anywhere else.
 */
export function deleteFromPrefab(req: StructureRequest): StructureResult {
  const before = readFileSync(req.file, 'utf-8');
  const file = parseUnityYaml(req.file, before);
  const found = byIdOrName(file, req.object);
  if ('error' in found) return { ok: false, error: found.error };
  const go = found.doc;

  let going: Set<string>;
  let what: string;
  if (req.component) {
    const byId = new Map(file.documents.map((d) => [d.fileId, d]));
    const comps = refsIn(entry(go.body, 'm_Component')).map((id) => byId.get(id)).filter((d): d is YDocument => Boolean(d));
    const asked = req.component.trim();
    const want = asked.toLowerCase();
    const hits = comps.filter((d) => d.typeName.toLowerCase() === want || `#${d.fileId}` === asked);
    if (!hits.length) {
      return { ok: false, error: `no component "${req.component}" on that object — it has: ${comps.map((d) => d.typeName).join(', ')}` };
    }
    if (hits.length > 1) {
      return { ok: false, error: `${hits.length} components named "${req.component}" — pass one as component=: ${hits.map((d) => `#${d.fileId}`).join(', ')}` };
    }
    if (TRANSFORMS.has(hits[0].classId)) {
      return { ok: false, error: `${hits[0].typeName} is the object's Transform — removing it would orphan the GameObject. Delete the object instead.` };
    }
    going = new Set([hits[0].fileId]);
    what = `removed ${label(hits[0])} from "${req.object}"`;
  } else {
    going = ownedIds(file, go);
    what = `removed "${req.object}" and ${going.size - 1} document(s) it owns`;
  }

  const blocked = danglers(file, going);
  if (blocked.length) {
    const named = [...new Map(blocked.map((b) => [b.from.fileId, b])).values()].slice(0, 8);
    return {
      ok: false,
      error: `${blocked.length} reference(s) still point at what you are deleting, and Unity `
        + `drops a dangling reference silently — a missing sprite or an unwired button found in the `
        + `editor days later. Pointing at it:\n`
        + `${named.map((b) => `  ${label(b.from)} → #${b.id}`).join('\n')}\n`
        + `Clear those first, or delete the object that owns them.`,
    };
  }

  const lines = before.split('\n');
  const drop = new Set<number>();
  for (const d of file.documents) {
    if (!going.has(d.fileId)) continue;
    for (let i = d.line - 1; i < d.endLine; i++) drop.add(i);
  }
  // The parent's `- {fileID: …}` entry, and the owning GameObject's `m_Component` entry — the two
  // lists `STRUCTURAL_LISTS` names, and nothing else. A reference from any OTHER list has already
  // refused this call, so there is none left here to quietly splice away.
  for (const d of file.documents) {
    if (going.has(d.fileId)) continue;
    for (const e of d.body) {
      if (e.value.kind !== 'seq' || !STRUCTURAL_LISTS.has(e.key)) continue;
      for (const item of e.value.children) {
        const id = parseRef(item.value.raw)?.fileId;
        if (id && going.has(id)) {
          for (let i = item.value.line - 1; i < item.value.endLine; i++) drop.add(i);
        }
      }
    }
  }
  return finish(req, before, lines.filter((_, i) => !drop.has(i)), what);
}

/**
 * Move a GameObject under another parent, or to the file root.
 *
 * Three edits and no new documents: the child's `- {fileID: …}` line leaves the old parent's
 * `m_Children`, joins the new parent's, and the moving Transform's `m_Father` is repointed. An empty
 * list is written `m_Children: []`, so joining one means replacing that line with a block list.
 */
export function reparentInPrefab(req: StructureRequest): StructureResult {
  const before = readFileSync(req.file, 'utf-8');
  const file = parseUnityYaml(req.file, before);
  const found = byIdOrName(file, req.object);
  if ('error' in found) return { ok: false, error: found.error };
  const { ofGo, goOf } = transforms(file);
  const moving = ofGo.get(found.doc.fileId);
  if (!moving) return { ok: false, error: `"${req.object}" has no Transform, so it is not in the hierarchy` };

  const toRoot = !req.to?.trim();
  let newParent: YDocument | null = null;
  if (!toRoot) {
    const target = byIdOrName(file, req.to!);
    if ('error' in target) return { ok: false, error: target.error };
    newParent = ofGo.get(target.doc.fileId) ?? null;
    if (!newParent) return { ok: false, error: `"${req.to}" has no Transform, so nothing can be parented to it` };
    if (newParent.fileId === moving.fileId) return { ok: false, error: 'an object cannot be its own parent' };
    // Walking UP from the new parent: if the mover is on that path, this would detach the subtree
    // into a cycle that Unity cannot draw and cannot open.
    let up: string | undefined = parseRef(entry(newParent.body, 'm_Father')?.raw ?? '')?.fileId;
    while (up && up !== '0') {
      if (up === moving.fileId) {
        return { ok: false, error: `"${req.to}" is inside "${req.object}" — that would make a cycle` };
      }
      const parentGo: string | undefined = goOf.get(up);
      const parentTransform = parentGo ? ofGo.get(parentGo) : undefined;
      up = parentTransform ? parseRef(entry(parentTransform.body, 'm_Father')?.raw ?? '')?.fileId : undefined;
    }
  }

  const oldFatherId = parseRef(entry(moving.body, 'm_Father')?.raw ?? '')?.fileId ?? '0';
  if ((toRoot && oldFatherId === '0') || (newParent && oldFatherId === newParent.fileId)) {
    return { ok: false, error: `"${req.object}" is already there — nothing to change` };
  }

  const lines = before.split('\n');
  const eol = (i: number): string => (lines[i]?.endsWith('\r') ? '\r' : '');
  const edits: Array<{ at: number; remove: number; insert: string[] }> = [];

  // 1. out of the old parent's m_Children
  if (oldFatherId !== '0') {
    const oldGo = goOf.get(oldFatherId);
    const oldParent = oldGo ? ofGo.get(oldGo) : undefined;
    const kids = oldParent ? entry(oldParent.body, 'm_Children') : null;
    const item = kids?.children.find((c) => parseRef(c.value.raw)?.fileId === moving.fileId);
    if (item) edits.push({ at: item.value.line - 1, remove: item.value.endLine - item.value.line + 1, insert: [] });
  }

  // 2. into the new parent's m_Children (or nowhere, for the root)
  if (newParent) {
    const kids = entry(newParent.body, 'm_Children');
    if (!kids) return { ok: false, error: `"${req.to}" has no m_Children to add to` };
    const indent = (lines[kids.line - 1].match(/^\s*/)?.[0] ?? '  ');
    const line = `${indent}- {fileID: ${moving.fileId}}`;
    if (kids.kind === 'seq' && kids.children.length) {
      const last = kids.children[kids.children.length - 1].value;
      edits.push({ at: last.endLine, remove: 0, insert: [`${line}${eol(last.endLine - 1)}`] });
    } else {
      // `m_Children: []` becomes a block list; the key line is rewritten and the item follows it.
      const keyLine = lines[kids.line - 1].replace(/:\s*\[\s*\]\s*\r?$/, `:${eol(kids.line - 1)}`);
      edits.push({ at: kids.line - 1, remove: 1, insert: [keyLine, `${line}${eol(kids.line - 1)}`] });
    }
  }

  // 3. the mover's own m_Father
  const father = entry(moving.body, 'm_Father');
  if (!father) return { ok: false, error: `"${req.object}" has no m_Father field` };
  const fatherLine = lines[father.line - 1];
  const head = fatherLine.slice(0, father.column);
  edits.push({
    at: father.line - 1,
    remove: father.endLine - father.line + 1,
    insert: [`${head}{fileID: ${newParent ? newParent.fileId : 0}}${eol(father.line - 1)}`],
  });

  // Applied BOTTOM-UP so an earlier splice cannot shift a later line number out from under it.
  edits.sort((a, b) => b.at - a.at);
  const out = [...lines];
  for (const e of edits) out.splice(e.at, e.remove, ...e.insert);

  const where = newParent ? `"${req.to}"` : 'the file root';
  return finish(req, before, out, `moved "${req.object}" under ${where}`);
}
