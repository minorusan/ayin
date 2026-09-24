/**
 * The Unity finder — a script is referenced by a GUID that appears nowhere in the script.
 *
 * THIS IS THE CASE NO TEXT SEARCH ANSWERS. Grep `PlayerHud` across a Unity project and you find the
 * C# that mentions the name. The prefab that ACTUALLY INSTANTIATES it contains no such string: it
 * carries `m_Script: {fileID: 11500000, guid: 7b1c…, type: 3}`, and the only place that guid is
 * written down is the `.meta` sidecar next to the file. So "which prefabs use this component" — the
 * daily Unity question — required knowing that, resolving it by hand, and grepping the hex. Reported
 * as friction by the model working in this project, twice.
 *
 * It works for ANY asset with a `.meta`, not only scripts: a sprite, a material, a controller, a
 * ScriptableObject. The question "what would break if I moved this" is the same question.
 *
 * AND IT TAKES A BARE GUID, which is the other half of the same problem. Reading a prefab hands you
 * 32 hex characters and no name; `find_references <guid>` answers what the asset IS as well as who
 * points at it, so the round trip through a manual grep of every `.meta` disappears.
 *
 * HOW A HIT IS DESCRIBED is the part that earns its place. "This prefab contains the guid" is barely
 * better than the grep; the key on the line — `m_Script`, `_iconSprite`, `m_Sprite` — says whether
 * the asset is the component being instantiated or a field somebody dragged in, and those are
 * different answers to "can I delete this".
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Finder, ReferenceHit } from '../hooks/types.js';

/** Unity writes a 32-char lowercase hex guid into every `.meta`. */
const GUID = /^[0-9a-f]{32}$/;
const GUID_IN_META = /^\s*guid:\s*([0-9a-f]{32})\s*$/m;

/** The serialized text formats that can carry a reference. Binary ones cannot be grepped and are out. */
const ASSET_GLOBS = ['*.prefab', '*.unity', '*.asset', '*.mat', '*.controller', '*.anim', '*.playable', '*.spriteatlas', '*.overrideController'];

/** Bounded like every other search here: a project has hundreds of thousands of files. */
const TIMEOUT_MS = 25_000;
const MAX_BUFFER = 24 * 1024 * 1024;

function isUnityRepo(repoPath: string): boolean {
  return existsSync(join(repoPath, 'Assets')) && existsSync(join(repoPath, 'ProjectSettings'));
}

/** The guid Unity assigned to this asset, from its sidecar. Null when there is no `.meta`. */
export function guidOf(repoPath: string, target: string): string | null {
  const abs = target.startsWith('/') ? target : join(repoPath, target);
  for (const meta of [`${abs}.meta`, abs.endsWith('.meta') ? abs : '']) {
    if (!meta || !existsSync(meta)) continue;
    try {
      const m = GUID_IN_META.exec(readFileSync(meta, 'utf8'));
      if (m) return m[1];
    } catch { /* unreadable sidecar — the caller reports no guid */ }
  }
  return null;
}

/**
 * Which asset owns this guid — the reverse lookup, and the reason a bare guid is a valid target.
 *
 * Searched over `.meta` files only, which is where a guid is DEFINED; every other occurrence is a
 * reference to it. Without that distinction the answer to "what is this guid" is the list of things
 * pointing at it, which is the question after the one being asked.
 */
export function assetForGuid(repoPath: string, guid: string): string | null {
  const out = sh(repoPath, ['-rl', '--include=*.meta', `guid: ${guid}`, 'Assets', 'Packages', 'ProjectSettings']);
  const first = out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!first) return null;
  // The asset is the sidecar minus `.meta` — that is the whole convention.
  return first.replace(/\.meta$/, '');
}

/** grep, bounded, never throwing. Empty output and "no matches" are the same answer here. */
function sh(repoPath: string, args: string[]): string {
  try {
    return execFileSync('grep', args, {
      cwd: repoPath, encoding: 'utf-8', timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/**
 * The YAML key that owns this line — `m_Script`, `_iconSprite`, or the sequence it sits in.
 *
 * A reference is written either inline after its key (`m_Script: {fileID: …, guid: …}`) or as a
 * list item under one (`- {fileID: …, guid: …}`). Both are answered by reading leftwards and, for
 * the list case, upwards to the nearest key at a lower indent. Cheap: a handful of lines, never the
 * document.
 */
function keyFor(lines: string[], idx: number): string {
  const line = lines[idx] ?? '';
  const inline = /^\s*([A-Za-z_][\w]*):/.exec(line);
  if (inline) return inline[1];
  if (/^\s*-\s/.test(line)) {
    const indent = line.search(/\S/);
    for (let i = idx - 1; i >= 0 && i > idx - 40; i--) {
      const up = lines[i];
      const k = /^(\s*)([A-Za-z_][\w]*):\s*$/.exec(up);
      if (k && k[1].length < indent) return `${k[2]}[]`;
    }
    return 'list item';
  }
  return 'reference';
}

export const unityFinder: Finder = {
  id: 'unity',

  applies(repoPath: string): boolean {
    return isUnityRepo(repoPath);
  },

  handles(target: string, repoPath: string): boolean {
    if (GUID.test(target.trim())) return true;
    return guidOf(repoPath, target) !== null;
  },

  describe(target: string, repoPath: string): string {
    const guid = GUID.test(target.trim()) ? target.trim() : guidOf(repoPath, target);
    return guid
      ? `Unity: guid ${guid}, searched across ${ASSET_GLOBS.join(' ')} under Assets/ and Packages/`
      : 'Unity: no .meta beside this file, so nothing references it by guid';
  },

  find(target: string, repoPath: string, limit: number): ReferenceHit[] {
    const bare = target.trim();
    const guid = GUID.test(bare) ? bare : guidOf(repoPath, target);
    if (!guid) return [];

    const args = ['-rn', ...ASSET_GLOBS.map((g) => `--include=${g}`), guid, 'Assets', 'Packages', 'ProjectSettings'];
    const raw = sh(repoPath, args);
    if (!raw.trim()) return [];

    // One read per FILE, not per hit: a prefab referencing an asset six times is one file open.
    const byFile = new Map<string, number[]>();
    for (const row of raw.split('\n')) {
      const m = /^([^:]+):(\d+):/.exec(row);
      if (!m) continue;
      const list = byFile.get(m[1]) ?? [];
      list.push(Number(m[2]));
      byFile.set(m[1], list);
    }

    const hits: ReferenceHit[] = [];
    for (const [file, numbers] of byFile) {
      let lines: string[] = [];
      try { lines = readFileSync(join(repoPath, file), 'utf8').split('\n'); } catch { /* keep the path */ }
      for (const n of numbers) {
        if (hits.length >= limit) return hits;
        hits.push({ path: relative(repoPath, join(repoPath, file)), line: n, how: keyFor(lines, n - 1) });
      }
    }
    return hits;
  },
};
