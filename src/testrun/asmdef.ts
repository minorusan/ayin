/**
 * testrun/asmdef.ts — a Unity project's assembly map, built without Unity.
 *
 * Everything `/testrun` needs to decide WHAT to run is already on disk in plain JSON, so none of it
 * is a question for a model:
 *
 *   - which assemblies exist            every `*.asmdef`
 *   - which are TEST assemblies         `precompiledReferences` carries `nunit.framework.dll`
 *   - EditMode or PlayMode              `includePlatforms: ["Editor"]` vs `[]`
 *   - which assembly owns a file        the nearest ancestor directory holding an `.asmdef`
 *   - what an assembly depends on       `references`, which are GUIDs, resolved through `.meta`
 *
 * The GUID indirection is the only awkward part and it is the same one the Unity indulger already
 * deals with: an asmdef names its dependencies as `GUID:9467e2…`, and the mapping lives in the
 * `.asmdef.meta` beside each file. Resolve it once into a map; everything after is a lookup.
 *
 * NOTHING HERE RUNS ANYTHING. Selection and execution are separated on purpose — selection is pure
 * and testable on any machine, execution needs a .NET toolchain that most machines do not have.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { log } from '../log.js';

/**
 * Unity's own marker for "this assembly is tests": the define constraint it uses to keep them out of
 * player builds. Every test asmdef in the real project carries it.
 *
 * This replaced two weaker guesses. `nunit.framework.dll` in `precompiledReferences` misses
 * assemblies that declare an EMPTY `precompiledReferences` and pull NUnit through the package — six
 * such assemblies in one real project were classified as production code and silently never run. Matching known TestRunner GUIDs missed it too: those GUIDs vary by package
 * version and are not a contract. The define constraint is.
 */
const TEST_DEFINE = 'UNITY_INCLUDE_TESTS';

/** Directories that never hold project source, and would cost minutes to walk. */
const SKIP_DIRS = new Set(['Library', 'Temp', 'Obj', 'obj', 'Build', 'Builds', 'Logs', 'UserSettings', '.git', 'node_modules']);

export interface Asmdef {
  /** Assembly name — also the DLL stem in `Library/ScriptAssemblies`. */
  name: string;
  /** Repo-relative path of the `.asmdef`. */
  path: string;
  /** Directory it governs. */
  dir: string;
  guid: string | null;
  references: string[];        // raw: `GUID:…` or a plain assembly name
  precompiled: string[];
  includePlatforms: string[];
  noEngineReferences: boolean;
  /**
   * `autoReferenced` (default TRUE): the PREDEFINED assemblies (Assembly-CSharp and friends) reference
   * this one without saying so. It does NOT make the assembly visible to other asmdefs — those still need
   * an explicit entry — which is exactly the distinction a "you forgot the reference" check must get right.
   */
  autoReferenced: boolean;
  /** `rootNamespace` (Unity 2020.2+): the namespace this assembly declares for its own scripts. */
  rootNamespace: string | null;
  /** Carries NUnit — the only reliable marker of a test assembly. */
  isTest: boolean;
  /** `includePlatforms` is exactly `["Editor"]`. PlayMode assemblies list nothing. */
  editorOnly: boolean;
}

export interface AsmdefIndex {
  all: Asmdef[];
  byName: Map<string, Asmdef>;
  byGuid: Map<string, Asmdef>;
  /** Directories holding an asmdef, longest first — so ownership is a prefix walk. */
  dirsLongestFirst: Array<{ dir: string; asmdef: Asmdef }>;
  /**
   * Asmdefs found on disk that could not be parsed.
   *
   * Reported rather than dropped, because a missing asmdef silently reassigns every type it owns to
   * the predefined assembly — which reads as a real reachability error in code that is fine.
   */
  unparsed: string[];
}

function walk(root: string, rel: string, out: string[]): void {
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.git') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const child = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) walk(root, child, out);
    else if (e.name.endsWith('.asmdef')) out.push(child);
  }
}

/** The `guid:` line of a `.meta`. Read as text — these files are YAML, and a parser is not worth it. */
function guidOf(metaPath: string): string | null {
  try {
    const m = /^guid:\s*([0-9a-f]{32})/m.exec(readFileSync(metaPath, 'utf-8'));
    return m ? m[1] : null;
  } catch { return null; }
}

export function buildAsmdefIndex(repo: string): AsmdefIndex {
  const paths: string[] = [];
  walk(repo, '', paths);

  const all: Asmdef[] = [];
  const unparsed: string[] = [];
  for (const p of paths) {
    let json: Record<string, unknown>;
    // STRIP THE BOM BEFORE PARSING, and say so when a parse still fails.
    //
    // `JSON.parse` throws on a leading U+FEFF, and Unity ships asmdefs that have one — Zenject's does.
    // The old `catch { continue }` dropped it silently, which is the worst possible failure here: an
    // asmdef missing from this index does not merely go unchecked, it makes every type it owns look
    // like it lives in the predefined assembly. Measured on a real project: four asmdefs (Zenject,
    // IngameDebugConsole, NativeGallery, UIEffect) were dropped for a BOM, so `SignalBus` resolved to
    // Assembly-CSharp, the asmdef-reference check called Core.asmdef broken, and the QA loop wrote
    // "Assembly-CSharp" into its references array — a thing Unity does not allow.
    try {
      json = JSON.parse(readFileSync(join(repo, p), 'utf-8').replace(/^\uFEFF/, ''));
    } catch (err) {
      unparsed.push(p);
      log('WARN', 'asmdef_unparseable', { path: p, error: String(err).slice(0, 160) });
      continue;
    }
    const name = typeof json.name === 'string' ? json.name : '';
    if (!name) continue;
    const precompiled = Array.isArray(json.precompiledReferences) ? json.precompiledReferences.map(String) : [];
    const includePlatforms = Array.isArray(json.includePlatforms) ? json.includePlatforms.map(String) : [];
    const references = Array.isArray(json.references) ? json.references.map(String) : [];
    const defineConstraints = Array.isArray(json.defineConstraints) ? json.defineConstraints.map(String) : [];
    all.push({
      name,
      path: p,
      dir: dirname(p),
      guid: guidOf(join(repo, `${p}.meta`)),
      references,
      precompiled,
      includePlatforms,
      noEngineReferences: json.noEngineReferences === true,
      // Unity's default is true, so ABSENT means true — reading it as false would make every unannotated
      // assembly look invisible to Assembly-CSharp.
      autoReferenced: json.autoReferenced !== false,
      rootNamespace: typeof json.rootNamespace === 'string' && json.rootNamespace.trim() ? json.rootNamespace.trim() : null,
      // NUnit is the marker. Naming is not: this project has `*.Tests.Editor`, `*.Tests.Play`,
      // `*.PlayTests`, `*Tests` and `*TestsEditor` — five conventions, and a sixth is one commit away.
      isTest: defineConstraints.includes(TEST_DEFINE)
        || precompiled.some((r) => r.toLowerCase().startsWith('nunit.framework')),
      editorOnly: includePlatforms.length === 1 && includePlatforms[0] === 'Editor',
    });
  }

  const byName = new Map(all.map((a) => [a.name, a]));
  const byGuid = new Map<string, Asmdef>();
  for (const a of all) if (a.guid) byGuid.set(a.guid, a);
  const dirsLongestFirst = all
    .map((a) => ({ dir: a.dir, asmdef: a }))
    .sort((x, y) => y.dir.length - x.dir.length);

  return { all, byName, byGuid, dirsLongestFirst, unparsed };
}

/**
 * Which assembly compiles this file.
 *
 * Nearest ancestor wins, which is Unity's own rule: a nested asmdef takes its subtree out of the
 * parent's. Comparing whole path SEGMENTS, not string prefixes — `Assets/Scripts/LiveOps` must not
 * claim a file in `Assets/Scripts/LiveOpsChallenges`, and this project has exactly that pair.
 */
export function owningAsmdef(index: AsmdefIndex, repoRelFile: string): Asmdef | null {
  const norm = repoRelFile.split(/[\\/]/).join(sep);
  for (const { dir, asmdef } of index.dirsLongestFirst) {
    if (!dir || dir === '.') { if (!norm.includes(sep)) return asmdef; continue; }
    const d = dir.split(/[\\/]/).join(sep);
    if (norm === d) return asmdef;
    if (norm.startsWith(d + sep)) return asmdef;
  }
  return null;
}

/** Resolve one `references` entry, whether it is a GUID or a bare name. */
export function resolveReference(index: AsmdefIndex, ref: string): Asmdef | null {
  if (ref.startsWith('GUID:')) return index.byGuid.get(ref.slice(5)) ?? null;
  return index.byName.get(ref) ?? null;
}

/**
 * An assembly so widely referenced that referencing it proves nothing.
 *
 * MEASURED, NOT ASSUMED. The first run against the real project selected **25 of 26 test
 * assemblies** for a single source file, because everything under `Assets/Scripts` lives in one
 * `Core` assembly that every test references. Transitive reachability through a hub is not evidence
 * of coverage — it is evidence that the project has a hub. Exactly the ambient-name problem
 * `indulge` hit: popularity destroys discrimination, so popularity has to disqualify.
 */
const AMBIENT_SHARE = 0.3;

/**
 * Proximity means the test assembly sits INSIDE the file's own directory — not merely under a shared
 * ancestor. Measured: an absolute floor of three segments let `Vendor.LiveOps.UI.Tests`, which lives
 * at `…/LiveOps/UI/Tests/Play`, cover a file at `…/LiveOps/ScoreMaster/` on the strength of sharing
 * `…/LiveOps`. Sibling features are not coverage.
 *
 * The absolute minimum still applies underneath, so a test assembly directly under `Assets` cannot
 * claim the entire project.
 */
const NEARBY_MIN = 3;

function isInside(testDir: string, fileDir: string): boolean {
  const depth = fileDir.split(/[\\/]/).filter(Boolean).length;
  return depth >= NEARBY_MIN && sharedDepth(testDir, fileDir) >= depth;
}

export function ambientAssemblies(index: AsmdefIndex): Set<string> {
  const tests = index.all.filter((a) => a.isTest);
  if (tests.length < 4) return new Set();
  const referencedBy = new Map<string, number>();
  for (const t of tests) {
    for (const r of new Set(t.references)) {
      const dep = resolveReference(index, r);
      if (dep) referencedBy.set(dep.name, (referencedBy.get(dep.name) ?? 0) + 1);
    }
  }
  const limit = Math.max(3, Math.floor(tests.length * AMBIENT_SHARE));
  return new Set([...referencedBy.entries()].filter(([, n]) => n >= limit).map(([name]) => name));
}

/**
 * Every subject a test assembly might be named after — its dotted segments with the test vocabulary
 * removed, plus the whole thing joined.
 *
 * `MultiQuestTests` → `[multiquest]`. `Vendor.SplashScreen.Editor.Tests` → `[vendor, splashscreen,
 * vendorsplashscreen]`. ALL of them are candidates rather than one, because picking a single
 * "subject" means guessing which segment is the vendor prefix and which is the feature — and that
 * guess is wrong the moment someone else's naming convention meets it.
 *
 * Needed because a project may keep a central `Assets/Tests/` directory: an assembly there shares one
 * path segment with the code it covers and reaches it only through a hub, so neither proximity nor
 * reference can find it. The name is the last signal standing. It is weaker, and it is labelled.
 */
export function testSubjects(name: string): string[] {
  const parts = name
    .split('.')
    .map((p) => p.replace(/(play|editor|unit)?tests?$/i, ''))
    .filter((p) => p.length >= 4 && !/^(editor|play|unit)$/i.test(p))
    .map((p) => p.toLowerCase());
  if (parts.length > 1) parts.push(parts.join(''));
  return [...new Set(parts)];
}

/**
 * The most specific directory on a path — the only segment a name may match against.
 *
 * ANY-segment matching is too loose, measured: with it, `Vendor.LiveOps.UI.Tests` matched every file
 * under `…/LiveOps/`, including `…/LiveOps/ScoreMaster/`, which it does not test. The feature a test
 * assembly is named for is the leaf directory, not one of its ancestors.
 */
function deepestSegment(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/** How many leading path segments two directories share — the cheapest proximity there is. */
export function sharedDepth(a: string, b: string): number {
  const x = a.split(/[\\/]/), y = b.split(/[\\/]/);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

export interface Coverage {
  asmdef: Asmdef;
  /** Why it was selected — shown in the report, because a wrong selection that passes is the worst case. */
  reason: 'contains' | 'references' | 'nearby' | 'named';
  proximity: number;
}

/**
 * The test assemblies that COVER a set of files.
 *
 * Direction matters and is easy to get backwards: tests reference production code, never the
 * reverse, so this walks OUT from each test assembly rather than asking a production assembly who
 * tests it — nothing on disk records that.
 *
 * Three admissible reasons, strongest first:
 *   contains    the file is inside the test assembly itself
 *   references  it DIRECTLY references the owning assembly, and that assembly is not ambient
 *   nearby      the owner is ambient (a hub), so the reference proves nothing and PATH decides —
 *               this project keeps `Tests/Editor` beside the code it tests, which is real evidence
 *               where a reference to `Core` is not
 *
 * Transitive reference is deliberately gone. Through a hub it reaches everything, and without a hub
 * a direct reference already covers the real cases.
 */
export function coverageFor(index: AsmdefIndex, repoRelFiles: string[]): Coverage[] {
  const ambient = ambientAssemblies(index);
  const owners = new Map<string, string>();   // owning assembly name → the file's directory
  for (const f of repoRelFiles) {
    const owner = owningAsmdef(index, f);
    if (owner) owners.set(owner.name, dirname(f));
  }
  if (!owners.size) return [];

  const out: Coverage[] = [];
  for (const test of index.all.filter((a) => a.isTest)) {
    if (owners.has(test.name)) {
      out.push({ asmdef: test, reason: 'contains', proximity: 99 });
      continue;
    }
    const direct = new Set(
      test.references.map((r) => resolveReference(index, r)?.name).filter(Boolean) as string[],
    );
    const subjects = testSubjects(test.name);
    let best: Coverage | null = null;
    for (const [ownerName, fileDir] of owners) {
      const prox = sharedDepth(test.dir, fileDir);
      if (direct.has(ownerName) && !ambient.has(ownerName)) {
        if (!best || best.reason === 'nearby') best = { asmdef: test, reason: 'references', proximity: prox };
      } else if (ambient.has(ownerName) && subjects.includes(deepestSegment(fileDir))) {
        // Named for a directory on the file's path. Weaker than a reference and reported as such,
        // but it is the only thing that connects `Assets/Tests/MultiQuestTests` to
        // `Assets/Scripts/LiveOpsChallenges/MultiQuest/` — which nothing else on disk records.
        if (!best) best = { asmdef: test, reason: 'named', proximity: prox };
      } else if (ambient.has(ownerName) && isInside(test.dir, fileDir)) {
        // Hub-owned. The reference proves nothing, so it is not required either — demanding one on
        // top of proximity selected NOTHING for `MultiQuestController.cs` and `DynamicSplashScreen`,
        // both of which have a test assembly sitting in the next directory. When the reference
        // signal is worthless, PATH carries the whole decision or nothing does.
        if (!best) best = { asmdef: test, reason: 'nearby', proximity: prox };
      }
    }
    if (best) out.push(best);
  }

  // Nearby matches are ranked, and only the closest tier survives: with a hub, several assemblies
  // share `Assets/Scripts` and selecting all of them is the original bug wearing a different hat.
  const nearby = out.filter((c) => c.reason === 'nearby');
  if (nearby.length) {
    const bestProx = Math.max(...nearby.map((c) => c.proximity));
    return out
      .filter((c) => c.reason !== 'nearby' || c.proximity >= bestProx)
      .sort((a, b) => b.proximity - a.proximity || a.asmdef.name.localeCompare(b.asmdef.name));
  }
  return out.sort((a, b) => b.proximity - a.proximity || a.asmdef.name.localeCompare(b.asmdef.name));
}

/** Names only — the common case. */
export function testAssembliesCovering(index: AsmdefIndex, repoRelFiles: string[]): Asmdef[] {
  return coverageFor(index, repoRelFiles).map((c) => c.asmdef);
}

// ── the compiled assemblies Unity already produced ───────────────────────────────

export interface CompiledAssembly {
  asmdef: Asmdef;
  dll: string | null;
  /** Newest source mtime under the asmdef's directory. */
  sourceMs: number;
  dllMs: number;
  /** The DLL predates a source file — running it would test code that no longer exists. */
  stale: boolean;
}

const SCRIPT_ASSEMBLIES = join('Library', 'ScriptAssemblies');

function newestSourceMs(dir: string): number {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.cs')) {
        try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { /* raced */ }
      }
    }
  }
  return newest;
}

/**
 * Locate what Unity already compiled, and decide whether it can be trusted.
 *
 * THE STALENESS CHECK IS THE LOAD-BEARING PART. `Library/ScriptAssemblies` is only current if the
 * Editor has compiled since the last edit, and a run against yesterday's DLL reports a green light
 * for code that was changed since. A confident wrong pass is the one output worth refusing to
 * produce — so this is measured and reported, never assumed.
 */
export function compiledState(repo: string, asmdefs: Asmdef[]): CompiledAssembly[] {
  return asmdefs.map((a) => {
    const dll = join(repo, SCRIPT_ASSEMBLIES, `${a.name}.dll`);
    const present = existsSync(dll);
    const dllMs = present ? (() => { try { return statSync(dll).mtimeMs; } catch { return 0; } })() : 0;
    const sourceMs = newestSourceMs(join(repo, a.dir));
    return {
      asmdef: a,
      dll: present ? dll : null,
      sourceMs,
      dllMs,
      // Only meaningful when both exist. A missing DLL is "never compiled", reported separately —
      // calling that "stale" would send the operator looking for an edit they did not make.
      stale: present && sourceMs > 0 && sourceMs > dllMs,
    };
  });
}

/** Does the Editor currently hold this project? Unity's own lock, and the reason batch mode fails. */
export function unityLockPath(repo: string): string {
  return join(repo, 'Temp', 'UnityLockfile');
}

export function unityHasProjectOpen(repo: string): boolean {
  return existsSync(unityLockPath(repo));
}

/** True for a directory that is a Unity project at all. */
/** Both markers: `Assets/` alone matches a plain `assets/` folder on a case-insensitive filesystem. */
export function isUnityProject(repo: string): boolean {
  return existsSync(join(repo, 'Assets')) && existsSync(join(repo, 'ProjectSettings'));
}

/** The Editor version this project pins, for locating the matching install. */
export function unityVersion(repo: string): string | null {
  try {
    const txt = readFileSync(join(repo, 'ProjectSettings', 'ProjectVersion.txt'), 'utf-8');
    const m = /^m_EditorVersion:\s*(\S+)/m.exec(txt);
    return m ? m[1] : null;
  } catch { return null; }
}

export function toRepoRelative(repo: string, file: string): string {
  return file.startsWith(repo) ? relative(repo, file) : file;
}
