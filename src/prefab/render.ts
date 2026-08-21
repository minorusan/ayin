/**
 * prefab/render.ts — the map as something a person reads in a terminal.
 *
 * The JSON is for the agent; this is for the operator looking at `/prefab`. Same map, two audiences, and
 * the difference matters: JSON keeps every property because an agent about to edit one needs to see it,
 * while a person scanning a hierarchy needs the SHAPE first and the wiring second. So the tree leads with
 * objects and components, prints references as sentences, and puts plain scalars behind a flag.
 *
 * One rule throughout: never print a GUID where a name is known. A hex string in a terminal is a dead end
 * — nobody can act on it without a second lookup, which is the whole reason this module exists.
 */

import type { ComponentMap, ObjectMap, PrefabMap, PropValue } from './map.js';

const INDENT = '  ';

/**
 * Properties the TREE leaves out because the tree already IS them.
 *
 * `m_Children` and `m_Father` are the hierarchy — printing them next to the hierarchy they produced put
 * three `→ RectTransform #5254861516704503703` lines under every object in the real paint, which is the
 * same information twice and the second copy unreadable. The JSON keeps them: an agent editing parentage
 * needs the ids, and a person scrolling a tree never does.
 */
const HIERARCHY_KEYS = new Set(['m_Children', 'm_Father', 'm_GameObject', 'm_RootOrder']);

/** `TMP_FontAsset named Montserrat-SemiBold SDF.asset at Assets/TextMesh Pro/…/` */
function refLine(prop: PropValue): string | null {
  const ref = prop.ref;
  if (!ref) return null;
  if (ref.asset) {
    const where = ref.asset.dir ? ` at ${ref.asset.dir}` : '';
    return `${ref.asset.type} named ${ref.asset.name}${where}`;
  }
  if (ref.missing) return `MISSING — nothing in the project has guid ${ref.missing}`;
  if (ref.local) return `→ ${ref.local}`;
  return null;
}

function scalarLine(prop: PropValue): string {
  if (prop.kind === 'scalar') return prop.value ?? '';
  if (prop.kind === 'list') return `[${(prop.items?.length ?? 0) + (prop.clipped ?? 0)} entries]`;
  if (prop.kind === 'map') return `{${Object.keys(prop.fields ?? {}).length} fields}`;
  return '';
}

function componentLines(c: ComponentMap, pad: string, everything: boolean): string[] {
  const out: string[] = [];
  const label = c.type === c.unityType ? c.type : `${c.type}  (${c.unityType})`;
  out.push(`${pad}· ${label}${c.enabled === '0' ? '  [disabled]' : ''}`);

  const refs: string[] = [];
  const scalars: string[] = [];
  for (const [key, prop] of Object.entries(c.properties)) {
    if (HIERARCHY_KEYS.has(key)) continue;
    const asRef = refLine(prop);
    if (asRef) { refs.push(`${pad}${INDENT}${key}: ${asRef}`); continue; }
    // A list of references is where a spine slot array or a button's targets live — worth expanding.
    if (prop.kind === 'list' && prop.items?.some((i) => i.kind === 'ref' && refLine(i))) {
      refs.push(`${pad}${INDENT}${key}:`);
      for (const item of prop.items) {
        const line = refLine(item);
        if (line) refs.push(`${pad}${INDENT}${INDENT}- ${line}`);
      }
      if (prop.clipped) refs.push(`${pad}${INDENT}${INDENT}(+${prop.clipped} more)`);
      continue;
    }
    if (everything) scalars.push(`${pad}${INDENT}${key}: ${scalarLine(prop)}`);
  }
  out.push(...refs, ...scalars);
  return out;
}

function objectLines(o: ObjectMap, depth: number, everything: boolean): string[] {
  const pad = INDENT.repeat(depth);
  const marks: string[] = [];
  if (o.active === '0') marks.push('inactive');
  if (o.nested) {
    marks.push(o.nested.source ? `nested prefab ${o.nested.source.name}` : `nested prefab (guid ${o.nested.sourceMissing ?? '?'} unresolved)`);
    if (o.nested.modifications.length) marks.push(`${o.nested.modifications.length} override(s)`);
    if (o.nested.truncated) marks.push('NOT EXPANDED — depth cap');
  }
  const out = [`${pad}${o.name || '(unnamed)'}${marks.length ? `   [${marks.join(' · ')}]` : ''}`];

  // The overrides ARE the difference between this instance and the prefab it came from, which is the
  // question anyone opening a nested instance is asking.
  if (o.nested?.modifications.length) {
    for (const m of o.nested.modifications.slice(0, 12)) {
      const obj = m.objectReference ? refLine({ kind: 'ref', ref: m.objectReference, line: 0 }) : null;
      out.push(`${pad}${INDENT}override ${m.propertyPath} = ${obj ?? m.value}`);
    }
    if (o.nested.modifications.length > 12) {
      out.push(`${pad}${INDENT}(+${o.nested.modifications.length - 12} more overrides)`);
    }
  }
  for (const c of o.components) out.push(...componentLines(c, pad + INDENT, everything));
  for (const child of o.children) out.push(...objectLines(child, depth + 1, everything));
  return out;
}

/** The whole map as a tree. `everything` also prints plain scalars, which triples the length. */
export function renderPrefabTree(map: PrefabMap, opts: { everything?: boolean } = {}): string {
  const everything = opts.everything === true;
  const head = `${map.file}  —  ${map.documents} documents`
    + (map.stripped ? `, ${map.stripped} from nested prefabs` : '')
    + (map.unresolved.length ? `, ${map.unresolved.length} unresolved reference(s)` : '');
  const out = [head, ''];
  for (const root of map.roots) out.push(...objectLines(root, 0, everything));
  if (map.loose.length) {
    out.push('', 'not part of any hierarchy:');
    for (const c of map.loose) out.push(...componentLines(c, INDENT, everything));
  }
  if (map.unresolved.length) {
    out.push('', `unresolved guids (no .meta in the project, its packages, or Unity's built-ins):`);
    for (const g of map.unresolved.slice(0, 10)) out.push(`  ${g}`);
    if (map.unresolved.length > 10) out.push(`  (+${map.unresolved.length - 10} more)`);
  }
  return out.join('\n');
}
