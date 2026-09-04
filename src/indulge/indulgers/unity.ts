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
import { candidateDirs, knownVendorRoots } from '../vendor.js';
import { clearWiringIndex, wiringEvidence, wiringFor, type WiringFacts } from '../unity-wiring.js';

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
// Same for the wiring facts: one file carries up to a batch of questions, and the index behind these
// is built once per run either way — but `wiringFor` still walks this file's declarations each call.
const wiringPerFile = new Map<string, WiringFacts>();

/**
 * Third-party roots, by the STATIC half of vendor detection only.
 *
 * `loadCachedVendorRoots` needs the corpus directory, which an `IndulgeContext` does not carry — and
 * threading it through for this would mean the hook contract knowing where the store lives. The
 * static list is what caught every genuine vendor root in both test repos at zero cost, so the wiring
 * index uses it directly rather than the core plumbing a model may also have contributed to.
 */
let vendorRoots: { root: string; roots: string[] } | null = null;
function rootsFor(repoPath: string): string[] {
  if (vendorRoots?.root === repoPath) return vendorRoots.roots;
  let roots: string[] = [];
  try { roots = knownVendorRoots(candidateDirs(repoPath)); } catch { roots = []; }
  vendorRoots = { root: repoPath, roots };
  return roots;
}

function factsFor(ctx: IndulgeContext): WiringFacts | null {
  if (!ctx.file.toLowerCase().endsWith('.cs')) return null;
  const cached = wiringPerFile.get(ctx.file);
  if (cached) return cached;
  let facts: WiringFacts;
  try { facts = wiringFor(ctx.repoPath, ctx.file, ctx.source, rootsFor(ctx.repoPath)); } catch { return null; }
  wiringPerFile.set(ctx.file, facts);
  return facts;
}

/**
 * The GUID scan and the wiring facts for one file, computed once per run.
 *
 * SHARED BY BOTH HOOKS, and it has to be: `evidenceFor` runs BEFORE the answer and `onChunkCreated`
 * after it, so a memo filled only by the second is always empty for the first. The scan reading
 * every prefab and scene in the project is not something to run twice per file because two callers
 * wanted the same answer at different moments.
 */
function assetFactsFor(ctx: IndulgeContext): Record<string, unknown> | null {
  if (!ctx.file.toLowerCase().endsWith('.cs')) return null;
  const cached = perFile.get(ctx.file);
  if (cached) return cached;

  const meta = join(ctx.repoPath, `${ctx.file}.meta`);
  if (!existsSync(meta)) return null;
  const guid = guidOf(meta);
  if (!guid) return null;

  const { paths, total } = referencersOf(ctx.repoPath, guid);
  const wiring = factsFor(ctx);
  const facts: Record<string, unknown> = {
    guid,
    referencedBy: paths,
    referencedByTotal: total,
    // A snapshot, and it says so. Nothing else in the chunk guards assets that reference this file.
    asOf: new Date().toISOString(),
  };
  // Carried onto the chunk as well as put in front of the model, so the ATTRIBUTOR can state it at
  // read time for free. "Which assembly is this in" is the cheap-lookup case the attributor exists
  // for, and it is not derivable from the bytes of the file it is asked about.
  if (wiring) {
    facts.assembly = wiring.assembly;
    facts.assemblyReferences = wiring.references;
    facts.boundByTotal = wiring.boundByTotal;
    facts.boundBy = wiring.boundBy.map((s) => `${s.file}:${s.line}`);
    facts.injectedIntoTotal = wiring.injectedIntoTotal;
    facts.crossAssembly = wiring.crossAssembly;
  }
  perFile.set(ctx.file, facts);
  return facts;
}

export const unityIndulger: Indulger = {
  id: 'unity',

  applies(repoPath) {
    return isUnityProject(repoPath);
  },

  onChunkCreated(_chunk: Chunk, ctx: IndulgeContext): Record<string, unknown> | null {
    return assetFactsFor(ctx);
  },

  evidenceFor(ctx: IndulgeContext): string | null {
    const facts = factsFor(ctx);
    if (!facts) return null;
    const blocks = [wiringEvidence(facts, ctx.file)].filter(Boolean);

    // THE GUID SCAN IS ALREADY PAID FOR — show it. `onChunkCreated` walks every prefab, scene and
    // asset for this file's GUID and puts the result on the chunk, and that is the only EXACT edge a
    // Unity repo has: either the GUID is in those bytes or it is not, so it cannot be a coincidence
    // the way an identifier mention can. It was being computed, stored, and then never put in front
    // of the model that had to answer "what instantiates this" — which for a MonoBehaviour is
    // answered by exactly this list and by nothing in the .cs file at all.
    const cached = assetFactsFor(ctx);
    const total = cached?.referencedByTotal as number | undefined;
    if (typeof total === 'number') {
      const paths = (cached?.referencedBy as string[] | undefined) ?? [];
      blocks.push(total === 0
        ? `REFERENCED BY NO PREFAB, SCENE OR ASSET (exact GUID scan, ${(cached?.asOf as string ?? '').slice(0, 10)})`
        : `REFERENCED BY ${total} ASSET(S) BY GUID${paths.length < total ? `, ${paths.length} shown` : ''}`
          + ` — exact, as of ${(cached?.asOf as string ?? '').slice(0, 10)}:\n`
          + paths.map((p) => `  ${p}`).join('\n'));
    }
    return blocks.length ? blocks.join('\n') : null;
  },
};

/** Between runs the memo must go, or a second night reports the first night's counts. */
export function clearIndulgerMemo(): void {
  perFile.clear();
  wiringPerFile.clear();
  vendorRoots = null;
  clearWiringIndex();
}
