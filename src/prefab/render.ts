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

/**
 * ONE COMPONENT, EVERY PROPERTY — references resolved, nested maps and lists expanded.
 *
 * The tree above deliberately prints references and hides scalars, because a person scanning a
 * hierarchy wants the shape. This is the opposite question: "what is m_AnchorMin on THIS RectTransform",
 * and there the scalars are the whole answer.
 */
function propLines(key: string, prop: PropValue, pad: string): string[] {
  const asRef = refLine(prop);
  if (asRef) return [`${pad}${key}: ${asRef}`];
  if (prop.kind === 'ref') return [`${pad}${key}: ${prop.ref?.raw ?? '(unresolved reference)'}`];
  if (prop.kind === 'scalar') return [`${pad}${key}: ${prop.value ?? ''}`];
  if (prop.kind === 'list') {
    const items = prop.items ?? [];
    if (!items.length && !prop.clipped) return [`${pad}${key}: []`];
    /**
     * AN INLINE MAP IS NOT A LIST OF ONE.
     *
     * The YAML reader classifies `{x: 0.5, y: 0}` as a ref — it opens with a brace, like a fileID does
     * — and wraps it in a one-item list. So every vector on a RectTransform printed as `m_AnchorMin:`
     * and then `[0]: {x: 0.5, y: 0}` underneath: two lines and an index to carry one value, on the
     * eleven properties a person opens a RectTransform to read.
     *
     * Collapsed only when the single item has nothing resolved behind it, which is exactly the inline
     * case; a one-element array of real references still prints as a list, because there the index is
     * information. Display side only — the map is untouched and `format=json` is unchanged.
     */
    const only = items.length === 1 && !prop.clipped ? items[0] : null;
    if (only && (only.kind === 'scalar' || (only.kind === 'ref' && !refLine(only)))) {
      return [`${pad}${key}: ${only.kind === 'scalar' ? only.value ?? '' : only.ref?.raw ?? ''}`];
    }
    const out = [`${pad}${key}:`];
    items.forEach((item, i) => out.push(...propLines(`[${i}]`, item, pad + INDENT)));
    if (prop.clipped) out.push(`${pad}${INDENT}(+${prop.clipped} more)`);
    return out;
  }
  if (prop.kind === 'map') {
    const fields = Object.entries(prop.fields ?? {});
    if (!fields.length) return [`${pad}${key}: {}`];
    const out = [`${pad}${key}:`];
    for (const [k, v] of fields) out.push(...propLines(k, v, pad + INDENT));
    return out;
  }
  return [`${pad}${key}: ${scalarLine(prop)}`];
}

/** The names a caller could have meant, so a miss teaches the address instead of just refusing it. */
function choicesAt(objects: ObjectMap[], obj: ObjectMap | null): string {
  const kids = objects.map((o) => o.name || '(unnamed)');
  const comps = obj ? obj.components.map((c) => c.type) : [];
  const parts: string[] = [];
  if (kids.length) parts.push(`children: ${[...new Set(kids)].join(', ')}`);
  if (comps.length) parts.push(`components: ${[...new Set(comps)].join(', ')}`);
  return parts.join('   |   ') || '(nothing below this point)';
}

/**
 * `GameOverLayer/Panel/RectTransform` — one address into the map.
 *
 * WHY THIS EXISTS. Without it the only way to see one component's properties was `scalars=true` on the
 * whole file, and a model asked to check one icon did exactly that: 69,141 characters of every property
 * of every component of a 45-object prefab, to read four numbers. The map already knows the shape; what
 * was missing was a way to ask it a question.
 *
 * Segments are GameObject names, walked from the roots, and the LAST one may instead name a component
 * on the object reached — which is what makes the address read the way a person says it. Ending on an
 * object prints that subtree; ending on a component prints every property it has.
 *
 * A MISS NAMES THE ALTERNATIVES. A bare "not found" costs a round and teaches nothing, and the caller
 * here is usually a model that guessed at a name it has not seen.
 */
export function renderPrefabAt(map: PrefabMap, at: string, only: string[] = []): string {
  const segs = at.split('/').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return 'Error: at is empty — use an address like GameOverLayer/Panel/RectTransform.';

  const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  /**
   * A PATH MAY START ANYWHERE IT IS UNAMBIGUOUS, not only at the file root.
   *
   * `at=` walks from the roots, and a prefab's root is its single top GameObject — so
   * `GameFieldContainer/SafeAreaPanel/ExitButton` failed on a node that really exists, three levels
   * down, and the caller spent a round re-issuing it with `GameLayer/` on the front. Naming the
   * missing prefix in the error already helped; resolving it is better, because the address the
   * caller wrote was never wrong about WHICH NODE IT MEANT.
   *
   * ONLY WHEN ONE NODE ANSWERS TO IT. Two objects named `Icon` in different branches make
   * `Icon/Image` genuinely ambiguous, and guessing there would show the wrong component's properties
   * with nothing on screen admitting it — so that case still falls through to the error below, which
   * lists what it found. Root-anchored paths are matched first and always win, so nothing that
   * resolved before resolves differently now.
   */
  if (!map.roots.some((o) => eq(o.name, segs[0]))) {
    const found: ObjectMap[] = [];
    const seek = (nodes: ObjectMap[]): void => {
      for (const n of nodes) {
        if (eq(n.name, segs[0])) found.push(n);
        seek(n.children);
      }
    };
    seek(map.roots);
    if (found.length === 1) {
      const rest = segs.slice(1);
      const inner = rest.length ? renderPrefabAt({ ...map, roots: [found[0]] }, [found[0].name, ...rest].join('/'), only) : '';
      if (!rest.length || !inner.startsWith('Error:')) {
        const note = `(resolved from ${map.roots[0]?.name ?? 'the root'} — "${at}" names a node below it, not a root)`;
        return rest.length
          ? `${note}\n${inner}`
          : [`${map.file}`, '', note, '', ...objectLines(found[0], 0, false)].join('\n');
      }
    }
  }
  let level = map.roots;
  let obj: ObjectMap | null = null;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const matches = level.filter((o) => eq(o.name, seg));
    if (matches.length) {
      obj = matches[0];
      level = obj.children;
      if (matches.length > 1 && i === segs.length - 1) {
        return [`${matches.length} objects here are named ${seg}; showing the first.`, '',
          ...objectLines(obj, 0, false)].join('\n');
      }
      continue;
    }
    // Not an object — the last segment may name a component instead, which is where an address ends.
    const pool = obj ? obj.components : map.loose;
    const comp = pool.find((c) => eq(c.type, seg) || eq(c.unityType, seg));
    if (comp) {
      if (i !== segs.length - 1) {
        return `Error: ${seg} is a component, so the address ends there — `
          + `drop "${segs.slice(i + 1).join('/')}" from the end.`;
      }
      const where = obj ? `${obj.path || obj.name} · ` : '';
      const label = comp.type === comp.unityType ? comp.type : `${comp.type}  (${comp.unityType})`;
      const head = `${map.file}\n${where}${label}${comp.enabled === '0' ? '  [disabled]' : ''}`
        + (comp.script ? `\nscript: ${comp.script.name} at ${comp.script.dir ?? ''}` : '')
        + `\nfileID ${comp.fileId}, line ${comp.line}`;
      /**
       * ASK FOR THE PROPERTIES YOU WANTED, not the eighty this component has.
       *
       * Opening a TextMeshProUGUI to change one number printed ~80 serialized properties, and a reader
       * iterating on two or three of them re-read that blob every time. Reported verbatim: *"I wanted
       * just m_fontSize, but the tool dumped ~80 properties."*
       *
       * Matched as a case-insensitive SUBSTRING, so `fontSize` finds `m_fontSizeBase` and nobody has to
       * know Unity's `m_` convention to ask. A filter that matches nothing says so and lists what IS
       * there — the same rule as every other miss in this file: never answer a wrong guess with silence.
       */
      const entries = Object.entries(comp.properties);
      const wanted = only.map((s) => s.toLowerCase()).filter(Boolean);
      const picked = wanted.length
        ? entries.filter(([key]) => wanted.some((w) => key.toLowerCase().includes(w)))
        : entries;
      if (wanted.length && picked.length === 0) {
        return `${head}\n\nError: no property matching ${only.map((s) => JSON.stringify(s)).join(', ')} on this component. `
          + `It has: ${entries.map(([k]) => k).join(', ')}`;
      }
      const body: string[] = [];
      for (const [key, prop] of picked) body.push(...propLines(key, prop, INDENT));
      const note = wanted.length ? [`  (${picked.length} of ${entries.length} properties — filtered)`] : [];
      return [head, '', ...(body.length ? body : ['  (no properties serialized)']), ...note].join('\n');
    }
    /**
     * AT THE ROOT, SAY WHAT THE PATH MUST START WITH — the miss is almost always the same one.
     *
     * `at=` is relative to the file, and a prefab's file root is its single top GameObject, so
     * `at=ScoreIndicatorValue/TextMeshProUGUI` fails on a node that really exists three levels down.
     * The old message was correct and unhelpful: it listed the available children and left the reader
     * to infer the rule from the shape of the list. Reported verbatim — "I had to guess that the path
     * is relative to the file's single root GameObject". Naming the missing prefix turns a guess into
     * a correction, and it only fires at depth 0, where the answer is unambiguous.
     */
    if (i === 0) {
      const roots = level.map((o) => o.name).filter(Boolean);
      const lead = roots.length === 1
        ? `Error: no "${seg}" at the file root — the path starts at "${roots[0]}", `
          + `so try "${roots[0]}/${segs.join('/')}". `
        : `Error: no "${seg}" at the file root. A path starts at one of the roots below, not at a node inside it. `;
      return `${lead}Available — ${choicesAt(level, obj)}`;
    }
    return `Error: no "${seg}" under ${segs.slice(0, i).join('/') || '(the file root)'}. `
      + `Available — ${choicesAt(level, obj)}`;
  }

  if (!obj) return `Error: ${at} did not resolve to anything in ${map.file}.`;
  return [`${map.file}`, '', ...objectLines(obj, 0, false)].join('\n');
}
