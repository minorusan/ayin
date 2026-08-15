/**
 * indulge/indulgers/unity.ts — the expensive half, paid overnight.
 *
 * **GUID references are the only exact edge a Unity repo has.** Every file carries a `.meta` with a
 * GUID, and every reference between assets is by that GUID — a prefab attaching a MonoBehaviour, a
 * `.asset` naming the ScriptableObject class it instantiates, a scene wiring a component. Nothing is
 * inferred: either the GUID appears in that file or it does not. It beats every heuristic in
 * `discover.ts` (namespace reachability, identifier mentions) because it cannot be a coincidence.
 *
 * It is also far too expensive to compute while someone waits — the scan covers prefabs, scenes and
 * assets, which in a real project outnumber the scripts several times over. So it runs here, once
 * per file per night, and the answer travels on the chunk.
 *
 * What lands is a SNAPSHOT. A count taken tonight says nothing about a prefab added tomorrow, and
 * `sourceSha` does not cover it — that guards the .cs, not the assets referencing it. Hence `asOf`,
 * and hence a reader who discounts it rather than trusting it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Chunk } from '../store.js';
import type { Indulger, IndulgeContext } from '../hooks/types.js';
import { isUnityProject } from '../attributors/unity.js';

/** Referencing files kept per chunk. The TOTAL is recorded separately — a cut that hides its size
 *  reads as the whole answer. */
const MAX_REFS = 10;
/** Asset files scanned. A project with more than this has bigger problems than an imprecise count. */
const MAX_ASSETS = 40_000;
/** Directories that hold no authored assets. `Library` alone can hold hundreds of thousands. */
const SKIP = new Set(['Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', '.git', 'node_modules']);
/** Where a GUID reference can appear. */
const ASSET_EXT = /\.(prefab|unity|asset|mat|anim|controller|playable|shadergraph)$/i;

/** `guid: 1234abcd…` out of a `.meta`. */
export function guidOf(metaPath: string): string | null {
  try {
    const m = readFileSync(metaPath, 'utf-8').match(/^guid:\s*([0-9a-f]{32})/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * Every asset file that could carry a reference. Walked ONCE per run and memoised — a night that
 * re-walks the asset tree per chunk spends it on directory listings.
 */
let assetCache: { root: string; files: string[] } | null = null;
export function assetFiles(repoPath: string): string[] {
  if (assetCache && assetCache.root === repoPath) return assetCache.files;
  const files: string[] = [];
  const stack = [join(repoPath, 'Assets')];
  while (stack.length && files.length < MAX_ASSETS) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(abs); continue; }
      if (!e.isFile() || !ASSET_EXT.test(e.name)) continue;
      try { if (statSync(abs).size > 8 * 1024 * 1024) continue; } catch { continue; }
      files.push(abs);
    }
  }
  assetCache = { root: repoPath, files };
  return files;
}

/** Reset between runs/tests — the tree changes between nights. */
export function clearAssetCache(): void { assetCache = null; }

/** Assets whose text contains this GUID. Exact: a GUID is either present or it is not. */
export function referencersOf(repoPath: string, guid: string): { paths: string[]; total: number } {
  const hits: string[] = [];
  let total = 0;
  for (const abs of assetFiles(repoPath)) {
    let text: string;
    try { text = readFileSync(abs, 'utf-8'); } catch { continue; }
    if (!text.includes(guid)) continue;
    total++;
    if (hits.length < MAX_REFS) hits.push(relative(repoPath, abs).split(sep).join('/'));
  }
  return { paths: hits, total };
}

// One file is usually the subject of several chunks; the GUID scan must not run once per chunk.
const perFile = new Map<string, Record<string, unknown>>();

export const unityIndulger: Indulger = {
  id: 'unity',

  applies(repoPath) {
    return isUnityProject(repoPath);
  },

  onChunkCreated(_chunk: Chunk, ctx: IndulgeContext): Record<string, unknown> | null {
    if (!ctx.file.toLowerCase().endsWith('.cs')) return null;
    const cached = perFile.get(ctx.file);
    if (cached) return cached;

    const meta = join(ctx.repoPath, `${ctx.file}.meta`);
    if (!existsSync(meta)) return null;
    const guid = guidOf(meta);
    if (!guid) return null;

    const { paths, total } = referencersOf(ctx.repoPath, guid);
    const facts: Record<string, unknown> = {
      guid,
      referencedBy: paths,
      referencedByTotal: total,
      // A snapshot, and it says so. Nothing else in the chunk guards assets that reference this file.
      asOf: new Date().toISOString(),
    };
    perFile.set(ctx.file, facts);
    return facts;
  },
};

/** Between runs the memo must go, or a second night reports the first night's counts. */
export function clearIndulgerMemo(): void { perFile.clear(); }
