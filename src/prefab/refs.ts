/**
 * prefab/refs.ts — turning `guid: b88e6cb77973a411b822859b05b20b41` into a sentence a reader can act on.
 *
 * A prefab names nothing it depends on. Every edge in it is a 32-hex GUID whose only definition is a
 * `.meta` file somewhere in the project, so a prefab read without resolution is a list of numbers — and
 * the number is exactly the part of a wiring bug nobody can see.
 *
 * NO INDEX, DELIBERATELY. A cached guid→path map would be faster on the second call and would be wrong
 * the first time someone moves an asset in Unity while a session is open; the corpus retrieval in this
 * same repo shows where that ends — a store nobody remembered to invalidate, loaded again per call.
 * Nothing here is persisted and nothing can go stale.
 *
 * ONE PASS FOR ALL OF THEM instead. `grep -E 'g1|g2|…' --include=*.meta` resolves every GUID in a prefab
 * in a single project scan, so the cost is one walk rather than one walk per reference — a prefab with
 * 105 GUIDs — a real 16,000-line UI prefab — would otherwise mean 105 walks of ~13,000 meta files. The pattern is
 * chunked so no single grep can hit the probe runner's line cap and silently return a partial answer.
 *
 * A SECOND PASS ANSWERS "WHAT IS IT". A `.asset` file is a ScriptableObject, and its class lives in its
 * own `m_Script` GUID — so the type name the reader actually wants (`SkeletonDataAsset`, not "asset")
 * costs one more batched scan over the assets the first pass found. Two scans, whatever the prefab size.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { PRUNE, parseGrepLine, runProbe } from '../tools/explore/search.js';
import { log } from '../log.js';

export interface AssetRef {
  guid: string;
  /** Project-relative, `Assets/…` — the form a person can paste into Unity's search. */
  path: string;
  /** `Hero_SkeletonData.asset` */
  name: string;
  /** `Assets/Resources/spine/Duh/` — kept separate so a renderer can say "named X at Y". */
  dir: string;
  /** What the thing IS: the ScriptableObject's class, `Prefab`, `Texture`, the script's own name. */
  type: string;
}

/** Enough GUIDs per grep to make the scan worth it, few enough to stay under the runner's 400-line cap. */
const CHUNK = 120;

/**
 * Unity's own two GUIDs. They have no `.meta` anywhere, so a scan reports them missing — and "missing"
 * about the default font or a built-in sprite reads as a broken prefab when nothing is broken at all.
 */
const BUILT_IN: Record<string, string> = {
  '0000000000000000f000000000000000': 'Unity built-in extra',
  '0000000000000000e000000000000000': 'Unity default resource',
};

/** What an extension tells us on its own, before anything is read. */
const BY_EXT: Record<string, string> = {
  '.prefab': 'Prefab', '.unity': 'Scene', '.cs': 'MonoScript', '.mat': 'Material',
  '.anim': 'AnimationClip', '.controller': 'AnimatorController', '.shader': 'Shader',
  '.png': 'Texture', '.jpg': 'Texture', '.jpeg': 'Texture', '.tga': 'Texture', '.psd': 'Texture',
  '.exr': 'Texture', '.ttf': 'Font', '.otf': 'Font', '.fbx': 'Model', '.obj': 'Model',
  '.wav': 'AudioClip', '.mp3': 'AudioClip', '.ogg': 'AudioClip', '.playable': 'PlayableAsset',
  '.spriteatlas': 'SpriteAtlas', '.mixer': 'AudioMixer', '.json': 'TextAsset', '.txt': 'TextAsset',
  '.asmdef': 'AssemblyDefinition', '.dll': 'Assembly', '.mask': 'AvatarMask', '.physicsMaterial2D': 'PhysicsMaterial2D',
};

const extOf = (p: string): string => {
  const b = basename(p);
  const dot = b.lastIndexOf('.');
  return dot <= 0 ? '' : b.slice(dot).toLowerCase();
};

function pruneArgs(): string[] {
  return PRUNE.map((d) => `--exclude-dir=${d}`);
}

/**
 * Every `.meta` holding one of these GUIDs, as guid → asset path (the `.meta` minus its suffix).
 *
 * Runs through `runProbe`, which translates a plain `grep -rnI` into `git grep` on a work tree — the
 * same door explore uses, and the reason a 12,890-file scan is milliseconds rather than seconds.
 */
async function metaPaths(root: string, guids: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < guids.length; i += CHUNK) {
    const chunk = guids.slice(i, i + CHUNK);
    const argv = ['grep', '-rnI', ...pruneArgs(), '--include=*.meta', '-E', chunk.join('|'), '.'];
    const r = await runProbe(argv, root);
    if (!r.ok) { log('WARN', 'prefab_guid_scan_failed', { probe: r.printable }); continue; }
    // The cap is the runner's, not ours. Hitting it means some GUID silently has no answer, which would
    // read as "nothing references this" — say so instead.
    if (r.lines.length >= 400) log('WARN', 'prefab_guid_scan_truncated', { guids: String(chunk.length) });
    for (const line of r.lines) {
      const parsed = parseGrepLine(line);
      const text = parsed?.text ?? line;
      const file = parsed?.file ?? '';
      const g = /([0-9a-fA-F]{32})/.exec(text);
      if (!g || !file.endsWith('.meta')) continue;
      const guid = g[1].toLowerCase();
      if (!found.has(guid)) found.set(guid, file.replace(/\.meta$/, '').replace(/^\.\//, ''));
    }
  }
  return found;
}

/**
 * The leftovers, looked for where a PACKAGE keeps its metas.
 *
 * `PRUNE` excludes `Library/`, correctly — it is a 4 GB build cache. But `Library/PackageCache` is where
 * every Package Manager asset's `.meta` lives, so a prefab wired to TextMeshPro or uGUI reports its most
 * ordinary references as unresolved: measured on one real prefab, 14 of 15 unresolved GUIDs were
 * package scripts, one of them `TextMeshProUGUI`. Naming the type is the whole point of this file.
 *
 * Scanned with the package directory ITSELF as cwd, which is what keeps this on the same door: the probe
 * runner translates `grep` into `git grep` whenever its cwd is a work tree, and that translation drops
 * path arguments — so a scan of an ignored directory from the repo root would silently find nothing.
 * Rooted inside the package tree there is no `.git`, the plain grep runs, and 6,778 metas cost ~0.2s.
 */
async function packageMetaPaths(root: string, guids: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (guids.length === 0) return found;
  for (const sub of ['Library/PackageCache', 'Packages']) {
    const base = join(root, sub);
    if (!existsSync(base)) continue;
    for (let i = 0; i < guids.length; i += CHUNK) {
      const chunk = guids.slice(i, i + CHUNK);
      const r = await runProbe(['grep', '-rnI', '--include=*.meta', '-E', chunk.join('|'), '.'], base);
      if (!r.ok) continue;
      for (const line of r.lines) {
        const parsed = parseGrepLine(line);
        const text = parsed?.text ?? line;
        const file = parsed?.file ?? '';
        const g = /([0-9a-fA-F]{32})/.exec(text);
        if (!g || !file.endsWith('.meta')) continue;
        const guid = g[1].toLowerCase();
        if (!found.has(guid)) {
          found.set(guid, `${sub}/${file.replace(/\.meta$/, '').replace(/^\.\//, '')}`);
        }
      }
    }
  }
  return found;
}

/** How much of a `.asset` is read looking for its class. A prefix, because the file can be enormous. */
const HEAD_BYTES = 4 * 1024 * 1024;

/**
 * The `m_Script` GUID a ScriptableObject is an instance of, or ''.
 *
 * NOT the first few kilobytes. A TMP font asset serializes its atlas Texture2D first and puts its own
 * `m_Script` two megabytes in — measured on `Montserrat-SemiBold SDF.asset`, byte 2,098,479 — so a head
 * read reported every TMP font in the project as a bare "ScriptableObject". A bounded prefix read is the
 * compromise: enough to reach the real object, capped so a 50 MB atlas is not pulled into memory for one
 * word of label.
 */
function scriptGuidOf(abs: string): string {
  if (!existsSync(abs)) return '';
  let fd = -1;
  try {
    fd = openSync(abs, 'r');
    const size = Math.min(statSync(abs).size, HEAD_BYTES);
    const buf = Buffer.allocUnsafe(size);
    readSync(fd, buf, 0, size, 0);
    const m = /m_Script:\s*\{[^}]*guid:\s*([0-9a-fA-F]{32})/.exec(buf.toString('utf-8'));
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
  finally { if (fd !== -1) try { closeSync(fd); } catch { /* nothing to do */ } }
}

/**
 * Resolve GUIDs to described assets. Unknown GUIDs are simply absent from the map — a reference into a
 * package or a deleted asset is a real state of the file, and inventing a name for it would be worse
 * than the caller saying "unresolved".
 */
export async function resolveGuids(root: string, guids: Iterable<string>): Promise<Map<string, AssetRef>> {
  const wanted = [...new Set([...guids].map((g) => g.toLowerCase()))].filter((g) => /^[0-9a-f]{32}$/.test(g));
  const out = new Map<string, AssetRef>();
  if (wanted.length === 0) return out;

  for (const guid of wanted) {
    const builtIn = BUILT_IN[guid];
    if (builtIn) out.set(guid, { guid, path: '', name: builtIn, dir: '', type: 'built-in' });
  }

  const paths = await metaPaths(root, wanted.filter((g) => !out.has(g)));
  // Anything the project itself does not define is a package asset before it is a mystery.
  const leftover = wanted.filter((g) => !paths.has(g) && !out.has(g));
  const fromPackages = await packageMetaPaths(root, leftover);
  for (const [guid, rel] of fromPackages) paths.set(guid, rel);

  // Phase two: the ScriptableObjects among them need their class name, and their class is another GUID.
  const scriptGuids = new Map<string, string>();      // asset guid → its m_Script guid
  for (const [guid, rel] of paths) {
    if (extOf(rel) !== '.asset') continue;
    const sg = scriptGuidOf(join(root, rel));
    if (sg) scriptGuids.set(guid, sg);
  }
  let scriptPaths = new Map<string, string>();
  if (scriptGuids.size) {
    const ids = [...new Set(scriptGuids.values())];
    scriptPaths = await metaPaths(root, ids);
    const missing = ids.filter((g) => !scriptPaths.has(g));
    for (const [guid, rel] of await packageMetaPaths(root, missing)) scriptPaths.set(guid, rel);
  }

  for (const [guid, rel] of paths) {
    const ext = extOf(rel);
    let type = BY_EXT[ext] ?? (ext ? ext.slice(1) : 'unknown');
    if (ext === '.asset') {
      const sg = scriptGuids.get(guid);
      const scriptRel = sg ? scriptPaths.get(sg) : undefined;
      // The class name is the script's file name — Unity requires the two to match for a MonoBehaviour,
      // and for a plain ScriptableObject it is what a person recognises.
      type = scriptRel ? basename(scriptRel).replace(/\.cs$/, '') : 'ScriptableObject';
    }
    if (ext === '.cs') type = basename(rel).replace(/\.cs$/, '');
    out.set(guid, {
      guid, path: rel, name: basename(rel), dir: `${dirname(rel)}/`, type,
    });
  }
  return out;
}

/**
 * The GUID of one asset, found by NAME — how `prefab_edit` accepts `Hero_SkeletonData.asset`
 * instead of a hex string nobody has memorised.
 *
 * Ambiguity is refused, never guessed: two assets with the same file name are two different wirings, and
 * picking one would produce a change that looks applied and points somewhere nobody chose. Every
 * candidate is returned so the caller can say which ones it found.
 */
export async function findAssetByName(root: string, name: string): Promise<{ matches: AssetRef[] }> {
  const wanted = basename(name.trim());
  if (!wanted) return { matches: [] };
  const argv = ['find', '.', '-name', wanted, '-not', '-path', '*/Library/*', '-not', '-path', '*/Temp/*'];
  const r = await runProbe(argv, root);
  const files = r.lines.map((l) => l.replace(/^\.\//, '')).filter((l) => !l.endsWith('.meta'));
  const matches: AssetRef[] = [];
  for (const rel of files) {
    const meta = join(root, `${rel}.meta`);
    if (!existsSync(meta)) continue;
    const g = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(readFileSync(meta, 'utf-8'));
    if (!g) continue;
    const resolved = await resolveGuids(root, [g[1]]);
    const ref = resolved.get(g[1].toLowerCase());
    if (ref) matches.push(ref);
    else matches.push({ guid: g[1], path: rel, name: basename(rel), dir: `${dirname(rel)}/`, type: BY_EXT[extOf(rel)] ?? 'unknown' });
  }
  return { matches };
}

/** The project root a prefab belongs to, as a path relative to which every asset path is reported. */
export function relToRoot(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel.startsWith('..') ? abs : rel;
}
