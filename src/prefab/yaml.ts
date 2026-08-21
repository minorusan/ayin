/**
 * prefab/yaml.ts — Unity's serialization dialect, parsed for EDITING as much as for reading.
 *
 * Unity writes a YAML 1.1 subset and reads back only what it writes, so a general parser is both more
 * than this needs and less: what matters here is not a clean object graph but knowing WHERE each value
 * sits, because a prefab edit must replace those bytes and leave every other byte alone. A re-serialized
 * prefab is a whole-file diff, drops any key the parser did not model, and hands Unity's own merge tool
 * a conflict on a file nobody meaningfully changed. So every node carries its line span.
 *
 * THE FOUR SHAPES THAT BREAK A NAIVE LINE READER, all present in real project files:
 *
 *   1. `--- !u!114 &2975037696087673090` — the document header: class id, then the fileID everything
 *      else in the file points at. A trailing ` stripped` marks an object that lives in a nested
 *      prefab and appears here only to be referenced.
 *   2. `m_Script: {fileID: 11500000, guid: f4688…, type: 3}` — a flow map, and the ONLY thing that
 *      makes a prefab a graph rather than a list.
 *   3. That same flow map WRAPPED mid-value when the line grows too long:
 *          m_CorrespondingSourceObject: {fileID: 8074767456764353886, guid: b88e6cb779…,
 *            type: 3}
 *      Measured in a real 16,000-line prefab. A parser reading one line per key gets `type: 3` as a key of
 *      its own and a truncated reference — the reference then resolves to nothing, which reads as "this
 *      prefab has no dependencies" rather than as a parse failure.
 *   4. `- component: {fileID: 1}` — a sequence whose items are maps with their first key on the dash.
 *
 * Nothing here interprets meaning. Class ids, GameObjects, hierarchy and references are `map.ts`'s job;
 * this file only says what the file contains and where.
 */

/** A value, and the lines it occupies. `line`/`endLine` are 1-based and inclusive. */
export interface YValue {
  kind: 'scalar' | 'flow' | 'map' | 'seq';
  /** Scalar and flow: the text as written, joined onto one line if it wrapped. Empty otherwise. */
  raw: string;
  line: number;
  endLine: number;
  /** Column (0-based) where the value text starts on `line` — the anchor a surgical edit replaces. */
  column: number;
  /** map: keyed entries. seq: items, each with an empty key. */
  children: YEntry[];
}

export interface YEntry { key: string; value: YValue }

/** One `--- !u!<classId> &<fileID>` document. */
export interface YDocument {
  /** Unity's class id: 1 GameObject, 4 Transform, 114 MonoBehaviour, 224 RectTransform, 1001 PrefabInstance. */
  classId: number;
  /** The local id other objects in this file reference. Unique per file. */
  fileId: string;
  /** `GameObject`, `RectTransform`, `MonoBehaviour`, … — the type line under the header. */
  typeName: string;
  /** An object defined in a nested prefab, present here only as a reference target. */
  stripped: boolean;
  /** The document's own line span, header included. */
  line: number;
  endLine: number;
  body: YEntry[];
}

export interface YFile {
  path: string;
  documents: YDocument[];
  /** Lines as read, so an editor can splice by index without re-reading the file. */
  lines: string[];
}

const HEADER = /^---\s+!u!(\d+)\s+&(-?\d+)(\s+stripped)?\s*$/;
const KEY = /^(\s*)((?:[A-Za-z_$][\w.\-$]*|"(?:[^"\\]|\\.)*"))\s*:(.*)$/;

/** How many opening braces/brackets are still unclosed. Quotes are respected — a `}` inside a string
 *  is not a close, and Unity does write quoted values containing braces. */
function openDepth(text: string, from = 0): number {
  let depth = from;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && depth === 0) break;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** A line that carries no structure: blank, a comment, or a directive. */
const skippable = (line: string): boolean => line.trim() === '' || /^\s*#/.test(line) || /^%/.test(line);

interface Cursor { i: number }

const isDash = (line: string): boolean => line.trimStart().startsWith('- ') || line.trim() === '-';

/**
 * Parse the block at `indent`, stopping at the first line that leaves it.
 *
 * THE MODE IS NOT A LUXURY. Unity writes a sequence's dashes at the PARENT KEY'S indent, not deeper:
 *
 *     m_Component:
 *     - component: {fileID: 10219720271899080}
 *     m_Layer: 5
 *
 * so `m_Component`'s items and its next SIBLING all sit at the same column. A single-mode parser reads
 * `m_Layer` as another item of the component list — measured: every GameObject came back with its layer,
 * name and active flag nested inside `m_Component`. A sequence block therefore ends at the first line
 * that is not a dash, and a map block ends at the first line that is.
 */
function parseBlock(lines: string[], cur: Cursor, indent: number, mode: 'map' | 'seq'): YEntry[] {
  const out: YEntry[] = [];
  while (cur.i < lines.length) {
    const line = lines[cur.i];
    if (HEADER.test(line)) break;
    if (skippable(line)) { cur.i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;

    if (isDash(line)) {
      if (mode === 'map' || ind !== indent) break;
      out.push({ key: '', value: parseSeqItem(lines, cur, ind) });
      continue;
    }
    if (mode === 'seq') break;

    const m = KEY.exec(line);
    if (!m) { cur.i++; continue; }        // not a shape we model; skipping it loses no location
    const key = m[2].replace(/^"|"$/g, '');
    out.push({ key, value: parseValue(lines, cur, ind, m[1].length + m[2].length + 1, m[3]) });
  }
  return out;
}

/**
 * The value that follows `key:` on this line, plus any continuation.
 *
 * `rest` is everything after the colon. Empty means the value is a nested block — or nothing at all,
 * which Unity writes for an empty string (`m_Name: `).
 */
function parseValue(lines: string[], cur: Cursor, indent: number, colEnd: number, rest: string): YValue {
  const startLine = cur.i;
  const trimmed = rest.trim();
  const column = trimmed ? lines[startLine].length - rest.trimStart().length : colEnd + 1;

  if (trimmed === '' || trimmed === '|' || trimmed === '>') {
    cur.i++;
    // A sequence, a nested map, a block scalar and an empty string all look the same on THIS line. What
    // separates them is the next structural line: a dash at this indent or deeper is a sequence, a key
    // deeper is a map, anything else deeper is literal text, and a dedent means the value was empty.
    const next = firstStructuralLine(lines, cur.i);
    if (next !== -1) {
      const nextIndent = indentOf(lines[next]);
      if (trimmed === '' && isDash(lines[next]) && nextIndent >= indent) {
        cur.i = next;
        const children = parseBlock(lines, cur, nextIndent, 'seq');
        return { kind: 'seq', raw: '', line: startLine + 1, endLine: cur.i, column, children };
      }
      if (nextIndent > indent) {
        if (trimmed === '' && KEY.test(lines[next])) {
          cur.i = next;
          const children = parseBlock(lines, cur, nextIndent, 'map');
          return { kind: 'map', raw: '', line: startLine + 1, endLine: cur.i, column, children };
        }
        // Literal text, or a block we do not model: consume it as one scalar so its span is right.
        let end = next;
        while (end < lines.length && (skippable(lines[end]) || indentOf(lines[end]) > indent)) end++;
        const text = lines.slice(next, end).map((l) => l.trim()).join(' ');
        cur.i = end;
        return { kind: 'scalar', raw: text, line: startLine + 1, endLine: end, column, children: [] };
      }
    }
    return { kind: 'scalar', raw: '', line: startLine + 1, endLine: startLine + 1, column, children: [] };
  }

  // A flow map/seq may wrap. Keep taking lines until every brace opened on the first one is closed.
  let depth = openDepth(rest);
  let raw = trimmed;
  let end = startLine;
  while (depth > 0 && end + 1 < lines.length) {
    end++;
    const cont = lines[end].trim();
    raw += ` ${cont}`;
    depth = openDepth(lines[end], depth);
  }
  cur.i = end + 1;
  return {
    kind: /^[[{]/.test(trimmed) ? 'flow' : 'scalar',
    raw, line: startLine + 1, endLine: end + 1, column, children: [],
  };
}

/** The next line that is not blank or a comment, or -1. */
function firstStructuralLine(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (HEADER.test(lines[i])) return -1;
    if (!skippable(lines[i])) return i;
  }
  return -1;
}

/**
 * One `- …` item.
 *
 * The dash line may hold a scalar, a flow map, or the FIRST KEY of a map whose remaining keys are
 * indented under it (`- component: {fileID: 1}` is the common one). The third case is why this cannot
 * just call parseValue: the item is a map even though the line looks like a single key.
 */
function parseSeqItem(lines: string[], cur: Cursor, indent: number): YValue {
  const startLine = cur.i;
  const line = lines[startLine];
  const afterDash = line.slice(indentOf(line) + 1).replace(/^ /, '');
  const dashCol = indentOf(line) + 2;

  const m = KEY.exec(afterDash);
  if (m && !/^[[{]/.test(afterDash)) {
    // Re-read the dash line as if the dash were spaces, so the first key parses at the item's indent.
    const rewritten = [...lines];
    rewritten[startLine] = ' '.repeat(dashCol) + afterDash;
    const inner: Cursor = { i: startLine };
    const children = parseBlock(rewritten, inner, dashCol, 'map');
    cur.i = inner.i;
    return { kind: 'map', raw: '', line: startLine + 1, endLine: cur.i, column: dashCol, children };
  }

  let depth = openDepth(afterDash);
  let raw = afterDash.trim();
  let end = startLine;
  while (depth > 0 && end + 1 < lines.length) {
    end++;
    raw += ` ${lines[end].trim()}`;
    depth = openDepth(lines[end], depth);
  }
  cur.i = end + 1;
  return {
    kind: /^[[{]/.test(raw) ? 'flow' : 'scalar',
    raw, line: startLine + 1, endLine: end + 1, column: dashCol, children: [],
  };
}

/** Parse a `.prefab`, `.unity` or `.asset` — one dialect, three extensions. */
export function parseUnityYaml(path: string, text: string): YFile {
  const lines = text.split('\n');
  const documents: YDocument[] = [];
  const cur: Cursor = { i: 0 };

  while (cur.i < lines.length) {
    const h = HEADER.exec(lines[cur.i]);
    if (!h) { cur.i++; continue; }
    const headerLine = cur.i;
    cur.i++;
    // The type line: `GameObject:` with the block indented under it.
    let typeName = '';
    let body: YEntry[] = [];
    const t = firstStructuralLine(lines, cur.i);
    if (t !== -1) {
      const tm = KEY.exec(lines[t]);
      if (tm && tm[3].trim() === '') {
        typeName = tm[2];
        cur.i = t + 1;
        const next = firstStructuralLine(lines, cur.i);
        if (next !== -1 && indentOf(lines[next]) > indentOf(lines[t])) {
          cur.i = next;
          body = parseBlock(lines, cur, indentOf(lines[next]), 'map');
        }
      }
    }
    documents.push({
      classId: Number(h[1]), fileId: h[2], typeName,
      stripped: Boolean(h[3]), line: headerLine + 1, endLine: cur.i, body,
    });
  }

  return { path, documents, lines };
}

/** An entry by key, one level down. */
export function entry(entries: YEntry[], key: string): YValue | null {
  return entries.find((e) => e.key === key)?.value ?? null;
}

/** A value by dotted path (`m_Modification.m_Modifications`, `m_Pivot.x`), or null. */
export function at(entries: YEntry[], path: string): YValue | null {
  const parts = path.split('.');
  let cursorEntries = entries;
  let found: YValue | null = null;
  for (const part of parts) {
    found = entry(cursorEntries, part);
    // A dotted path can also address INSIDE a flow map — `m_Pivot.x` where the whole vector is one
    // `{x: 0.5, y: 0.5}`. That is a different edit (rewrite the flow map), so it is reported as the
    // flow value it is and the caller decides.
    if (!found) return null;
    cursorEntries = found.children;
  }
  return found;
}

export interface FlowRef { fileId: string; guid?: string; type?: number }

/** `{fileID: 11500000, guid: f4688…, type: 3}` → its parts. Null when the text is not a reference. */
export function parseRef(raw: string): FlowRef | null {
  if (!raw.startsWith('{')) return null;
  const fid = /fileID:\s*(-?\d+)/.exec(raw);
  if (!fid) return null;
  const guid = /guid:\s*([0-9a-fA-F]{32})/.exec(raw);
  const type = /type:\s*(\d+)/.exec(raw);
  return {
    fileId: fid[1],
    guid: guid ? guid[1].toLowerCase() : undefined,
    type: type ? Number(type[1]) : undefined,
  };
}

/** Every reference under a value, deep. Used to collect a document's GUIDs in one walk. */
export function collectRefs(value: YValue, into: FlowRef[] = []): FlowRef[] {
  if (value.kind === 'flow') {
    const r = parseRef(value.raw);
    if (r) into.push(r);
    // A flow SEQUENCE of references (`[{fileID: 1}, {fileID: 2}]`) carries several.
    else for (const m of value.raw.matchAll(/\{[^{}]*\}/g)) {
      const one = parseRef(m[0]);
      if (one) into.push(one);
    }
  }
  for (const child of value.children) collectRefs(child.value, into);
  return into;
}
