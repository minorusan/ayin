/**
 * indulge/discover.ts — stage 1: which files a domain touches.
 *
 * A **domain** is whatever string the operator typed at `--domains`. It maps to nothing structural
 * and it may match nothing in the repo at all. So discovery has exactly two jobs, and the second one
 * is the important one:
 *
 *   1. Find the files.
 *   2. **Never invent one.** A domain that matches nothing produces zero files, and the run says so.
 *
 * That is why this module is split the way it is. The model picks the SEEDS — "which files implement
 * checkout?" is a question only something that reads code can answer — but every path it names is
 * checked against the filesystem before it is kept, and a path that does not resolve is counted as
 * hallucinated and reported rather than stored. From there the graph is walked **deterministically**:
 * a model asked "what else is related?" returns something plausible, a reference graph returns
 * something checkable, and stage 3's citations have to be real.
 *
 * The reference graph is built from `SurfaceLanguage` (`surfaceOf` declares, `referencesOf` imports,
 * `domainOf` names the dependency unit). Those parsers live under `src/entangle/` because entangle
 * was their first caller; nothing about them is specific to it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { languageFor } from '../entangle/index.js';
import { exploreExecute } from '../tools/explore/index.js';
import { toolPrompts, type ToolPrompts } from '../tools/runtime.js';
import { ensureToolRuntime } from '../tool-wiring.js';
import { blobSha, type IndulgeStore } from './store.js';
import { isUnderVendorRoot } from './vendor.js';

// This module calls `exploreExecute` directly, so it owns the wiring. Relying on some other module
// having imported the registry first is initialization by import order, and `indulge` is a headless
// command with no TUI boot to do it — the LLM seam would be empty exactly when it is needed.
ensureToolRuntime();

const indulgePrompts = (): ToolPrompts => toolPrompts('indulge');

/**
 * Directories that never hold a repo's own source. Skipped wholesale — walking `node_modules` or a
 * Unity `Library/` costs minutes and yields nothing that belongs in a corpus.
 *
 * **`bin` is deliberately NOT here**, and that was a measured bug: it is MSBuild output in .NET but
 * the CLI entry point in a Node package, so skipping it dropped `bin/naamah.mjs` — a real source
 * file that imports the seed — out of the index entirely. `obj` stays, because MSBuild generates
 * `.cs` there (AssemblyInfo and friends) and those would otherwise be indexed as if hand-written.
 */
const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'out', 'obj',
  'Library', 'Temp', 'Logs', '.next', '.cache', 'coverage', 'vendor', '__pycache__',
]);

/**
 * Extensions that are never worth a question, whatever a model names.
 *
 * Unity writes a `.meta` beside EVERY file — a GUID and import settings, no behaviour. They are not
 * indexed (no language handles them) but a model asked for "the files that implement X" will happily
 * list `RewardService.cs.meta`, and it exists, so the path check passes. A question about a GUID
 * costs a real investigation and answers nothing.
 */
const NOISE_EXTENSIONS = new Set([
  '.meta', '.asset', '.prefab', '.unity', '.mat', '.anim', '.controller', '.shader', '.shadergraph',
  '.png', '.jpg', '.jpeg', '.tga', '.psd', '.fbx', '.wav', '.mp3', '.ogg', '.ttf', '.otf',
  '.dll', '.so', '.dylib', '.exe', '.zip', '.lock', '.map', '.min.js',
]);

function isNoise(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of NOISE_EXTENSIONS) if (lower.endsWith(ext)) return true;
  return false;
}

/** A file bigger than this is not hand-written source worth indexing (generated, minified, data). */
const MAX_SOURCE_BYTES = 512 * 1024;

/** A type name declared in more files than this is ambiguous — it cannot point at one of them. */
const MAX_DECLARERS = 3;

/**
 * A type MENTIONED by more files than this is ambient, not a dependency.
 *
 * The forward direction was capped from the start; the reverse was not, and that is where a real
 * repo blew up. Measured on a 3454-file Unity project: depth 1 added 4 files and depth 2 added 393,
 * because a widely-used type pulls in every file that names it. `ILogger` being mentioned by 300
 * files tells you nothing about which of them belong to THIS feature — the popularity is the proof
 * that it does not discriminate.
 */
const MAX_MENTIONERS = 25;

/**
 * The most files one file may contribute at a single depth.
 *
 * A structural bound on blast radius, independent of language or naming. Without it one hub file
 * decides the whole corpus, and the cap that eventually stops it is the global file cap — by which
 * point the walk has already stopped being about the domain that was asked for.
 */
const MAX_FANOUT_PER_FILE = 12;

/**
 * How many files a namespace may hold before `using` it stops being an attributable edge.
 *
 * A `using` of a 3-file namespace names almost exactly what the file depends on. A `using` of a
 * 400-file one names a wing of the building — true, and useless, the namespace equivalent of the
 * ambient identifiers `MAX_MENTIONERS` already discards.
 */
const MAX_NAMESPACE_FILES = 12;

/** Hard ceilings. Every one of them is REPORTED when hit — a silent cap reads as "covered everything". */
const DEFAULT_MAX_INDEX_FILES = 20000;
const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_DEPTH = 3;

/**
 * How far past `maxFiles` a depth may run to FINISH itself.
 *
 * `maxFiles` bounds how deep the walk goes, not how much of a level it sees. Cutting mid-depth gives
 * an arbitrary subset of one hop — measured on a real run, "depth 1" returned 27 of however many
 * direct neighbours existed, chosen by iteration order. Depth is a claim about completeness: either
 * a level is walked or it is not. So the cap is checked at the depth BOUNDARY, and this multiplier
 * is the runaway guard for a single level that turns out to be enormous.
 */
const DEPTH_OVERRUN = 4;

export interface DiscoverOptions {
  store: IndulgeStore;
  repoPath: string;
  domain: string;
  maxDepth?: number;
  maxFiles?: number;
  /** Repo-relative roots to prune wholesale — third-party code. See vendor.ts. */
  vendorRoots?: string[];
  /**
   * Repo-relative prefix this domain lives under. Nothing outside it is admitted, at any depth.
   *
   * A domain name is a CONCEPT; a repository is organised by PLACE, and the two only coincide by
   * luck. Measured on a real build: "trail mini game" derived `MiniGame`, matched a generic
   * `PickMiniGamePopupLogic` and a mock data file, and admitted 26 files of which ZERO were the trail
   * — which lives in `Assets/Games/Bingo/Gameplay/…/Trail`. No amount of term extraction fixes that,
   * because both matches are honest readings of the words. The operator knows the place; this is how
   * they say it.
   */
  scope?: string;
  maxIndexFiles?: number;
  /** Progress narration — one note per meaningful step. */
  onStatus?: (note: string) => void;
  /** Skip the LLM and use these repo-relative seeds (used by the gate; keeps discovery testable). */
  seedsOverride?: string[];
}

export interface DiscoverReport {
  domain: string;
  /** Verified seed files. `0` means the domain matched nothing — a legitimate, reportable outcome. */
  seeds: number;
  /** Files written to the store across every depth. */
  added: number;
  /** Paths the model named that do not exist in the repo. Kept for the report, never stored. */
  hallucinated: string[];
  /** Paths that exist but are not source — .csproj, .md, generated manifests. */
  skippedNonSource: string[];
  byDepth: Record<number, number>;
  /** A cap stopped the walk before it ran out of graph. */
  truncated: boolean;
  /** Source files the index scanned. */
  indexed: number;
}

/** Repo-relative, POSIX separators — the form every record and citation uses. */
const rel = (repoPath: string, abs: string): string => relative(repoPath, abs).split(sep).join('/');

/** Below this, explore is treated as having failed to find the domain and paths are matched directly. */
const MIN_SEEDS = 6;

/**
 * Files whose PATH contains the domain's words RUN TOGETHER — `solitaire streak` → `solitairestreak`,
 * matching `Codebase/GameModes/SolitaireStreak/…`.
 *
 * Deterministic and unhallucinable: the file is on disk or it is not. It exists because explore is
 * wrong often — on a real run it named 22 candidates for one domain of which 14 did not exist,
 * leaving two seeds.
 *
 * CONCATENATION ONLY, and that narrowness is the point. The first version required each word
 * separately with common ones ("service", "manager") dropped as noise, and matched **67 files** for
 * "reward service" — `RewardAdsState.cs`, `CheckAlbumClaimableRewardsOperation.cs` — because it had
 * quietly reduced to "anything with reward in the path". Sixty-seven loose seeds are worse than two
 * good ones: every seed is a night of questions about it.
 *
 * So this adds files only when the operator named a domain the way the tree is actually laid out, and
 * silently adds nothing otherwise. A domain named after a Jira ticket rather than a folder gets no
 * help from here, which is honest — nothing in the code is called that.
 */
function seedsByPathWords(repoPath: string, domain: string, limit: number, vendorRoots: string[] = []): string[] {
  const joined = domain.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (joined.length < 6) return [];
  const out: string[] = [];
  for (const rel of walkSources(repoPath, 20000, vendorRoots).files) {
    if (rel.toLowerCase().replace(/[^a-z0-9]/g, '').includes(joined)) out.push(rel);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Resolve a model-named path against the repo, or return null.
 *
 * Three refusals, all of them load-bearing: a path that escapes the repo (`../../etc/passwd` — the
 * model's output is untrusted input), a path that does not exist (the hallucination case this whole
 * module exists to catch), and a path that is a directory rather than a file.
 */
export function resolveInRepo(repoPath: string, candidate: string): string | null {
  const cleaned = candidate.trim().replace(/^[`'"(\[]+|[`'")\],.;:]+$/g, '').replace(/^\.\//, '');
  if (!cleaned || cleaned.length > 400) return null;
  const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(repoPath, cleaned);
  const root = resolve(repoPath);
  if (abs !== root && !abs.startsWith(root + sep)) return null; // escapes the repo
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  } catch { return null; }
  if (isNoise(cleaned)) return null;   // exists, but a `.meta` GUID answers no question
  return rel(root, abs);
}

/**
 * Pull candidate paths out of the investigation's prose.
 *
 * The prompt asks for a `FILES:` block, and that is preferred — but a model that answers well and
 * formats badly should not read as "matched nothing", so the whole answer is scanned for path-like
 * tokens as a fallback. Nothing here decides a file exists; `resolveInRepo` does that.
 */
export function extractPaths(answer: string): string[] {
  const out: string[] = [];
  const marker = answer.lastIndexOf('FILES:');
  const body = marker >= 0 ? answer.slice(marker + 'FILES:'.length) : answer;
  for (const m of body.matchAll(/[A-Za-z0-9_./\\@-]+\.[A-Za-z0-9]{1,6}\b/g)) {
    const p = m[0].split('\\').join('/');
    if (p.includes('/') || marker >= 0) out.push(p);
  }
  return [...new Set(out)];
}

/** Every source file a language handles, bounded and with the skip-list applied. */
function walkSources(repoPath: string, cap: number, vendorRoots: string[] = []): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const stack = [repoPath];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (files.length >= cap) return { files, truncated: true };
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        // THIRD-PARTY IS PRUNED AT THE DIRECTORY, not filtered per file. A vendor tree is where the
        // file count explodes — indexing it costs the walk, the reference resolution and, worst, real
        // questions generated about a library the team only consumes.
        if (vendorRoots.length && isUnderVendorRoot(relative(repoPath, abs).split(sep).join('/'), vendorRoots)) continue;
        stack.push(abs);
        continue;
      }
      if (!e.isFile() || !languageFor(abs)) continue;
      try { if (statSync(abs).size > MAX_SOURCE_BYTES) continue; } catch { continue; }
      files.push(abs);
    }
  }
  return { files, truncated: false };
}

/** `namespace Game.Rewards;` or `namespace Game.Rewards {` — C#'s unit of visibility. */
function namespaceOf(source: string): string {
  const m = source.match(/^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)/m);
  return m ? m[1] : '';
}

/**
 * Can `from` actually reach `to`, or do the two files merely share a word?
 *
 * For a namespaced language the answer is exact: `to`'s namespace must be one `from` declares with
 * `using`, or `from`'s own (same-namespace types need no `using` in C#). Files without a namespace
 * are unconstrained — import edges already carry the weight there.
 *
 * Measured on a real 3454-file Unity repo: without this, a shared identifier among 5270 declared
 * types made every hop transitive and depth 2 swallowed 337 files for a 40-type feature.
 */
function reachable(index: RefIndex, from: string, to: string): boolean {
  const target = index.namespace.get(to) ?? '';
  if (!target) return true;
  const seen = index.visible.get(from);
  return seen ? seen.has(target) : true;
}

interface RefIndex {
  /** Declared type name → the repo-relative files declaring it. */
  declaredIn: Map<string, string[]>;
  /** Repo-relative file → the declared names it mentions (any file's, not just its own). */
  mentions: Map<string, Set<string>>;
  /** declared name → the files that mention it. Popularity is what makes a name useless as an edge. */
  mentionedBy: Map<string, Set<string>>;
  /** file → its own namespace (C#; '' elsewhere). */
  namespace: Map<string, string>;
  /** file → the namespaces it can see: its own plus everything it `using`s. */
  visible: Map<string, Set<string>>;
  /** Repo-relative file → the repo-relative files it imports by relative specifier. */
  imports: Map<string, string[]>;
  /** The same edges reversed. */
  importedBy: Map<string, string[]>;
  indexed: number;
  truncated: boolean;
}

/** Extensions an extensionless relative specifier may resolve to, in resolution order. */
const IMPORT_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Files this source imports by RELATIVE specifier, resolved to paths that exist.
 *
 * The strongest edge available in JS/TS and the one the rest of this module was missing: measured on
 * a real 5-file repo, `referencesOf` returned `[]` and `surfaceOf` found one class, so the reference
 * walk added nothing — while `weave.mjs` plainly imports `./extract.mjs` and `./page.mjs`. That is
 * because `referencesOf` answers entangle's question (which MANIFEST unit does this cross), and a
 * bare-specifier import names a package, not a file. A relative specifier names the file directly.
 *
 * Bare specifiers are dropped on purpose — `node:fs` and `react` are not files in this repo.
 * Every resolution is checked against the filesystem, so an import of something deleted adds nothing.
 */
export function importEdges(repoPath: string, file: string, source: string): string[] {
  const dir = join(repoPath, file, '..');
  const out: string[] = [];
  const specs = [
    ...source.matchAll(/(?:^|\s)(?:import|export)[\s\S]{0,200}?from\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/(?:^|\s)import\s+['"](\.[^'"]+)['"]/g),
  ];
  for (const m of specs) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // a package, not a file in this repo
    const target = resolveSpecifier(repoPath, dir, spec);
    if (target && target !== file && !out.includes(target)) out.push(target);
  }
  return out;
}

/**
 * A relative specifier → the file it actually names, or null.
 *
 * The `.js → .ts` rewrite is not a nicety: under NodeNext, TypeScript source imports its sibling as
 * `./store.js` and only `store.ts` exists on disk. ayin's own source is written that way throughout,
 * so without this the index would find zero edges in the very repo most likely to be indexed first.
 */
function resolveSpecifier(repoPath: string, dir: string, spec: string): string | null {
  const rewrites = [
    spec,
    spec.replace(/\.js$/, '.ts'), spec.replace(/\.jsx$/, '.tsx'),
    spec.replace(/\.mjs$/, '.mts'), spec.replace(/\.cjs$/, '.cts'),
  ];
  for (const base of [...new Set(rewrites)]) {
    for (const ext of IMPORT_EXTS) {
      const direct = resolveInRepo(repoPath, resolve(dir, base + ext));
      if (direct) return direct;
    }
  }
  for (const ext of IMPORT_EXTS) {
    if (!ext) continue;
    const idx = resolveInRepo(repoPath, resolve(dir, spec, 'index' + ext));
    if (idx) return idx;
  }
  return null;
}

/**
 * Build the reference graph.
 *
 * Two passes over the source set, because pass 2 needs the complete type table pass 1 produces.
 * Sources are read twice rather than cached: a repo's whole source text does not belong in memory
 * for the sake of one walk, and the OS page cache makes the second read nearly free.
 *
 * Edges come from IDENTIFIER MENTIONS rather than from import statements alone. `referencesOf` is
 * the right answer for "does this cross a manifest boundary", which is entangle's question — but a
 * C# `using` names a namespace and a TS import names a module, so neither one tells you which FILE
 * you ended up depending on. Tokenising and intersecting with the declared-type table does, and it
 * is still deterministic and checkable.
 */
function buildIndex(repoPath: string, cap: number, onStatus?: (n: string) => void, vendorRoots: string[] = []): RefIndex {
  const { files, truncated } = walkSources(repoPath, cap, vendorRoots);
  onStatus?.(`indexing ${files.length} source files${truncated ? ` (capped at ${cap})` : ''}`);

  const declaredIn = new Map<string, string[]>();
  for (const abs of files) {
    const lang = languageFor(abs);
    if (!lang) continue;
    let source: string;
    try { source = readFileSync(abs, 'utf-8'); } catch { continue; }
    const r = rel(repoPath, abs);
    for (const t of lang.surfaceOf(source)) {
      if (!t.name || t.name.length < 3) continue; // 1-2 char names collide with everything
      // Platform furniture is not a reference. Measured: `session-record.ts` declares `type Event`,
      // and every file mentioning the DOM/Node `Event` was linked to it — a plausible edge that is
      // simply false, and false edges are what this module exists to not produce. The language
      // already knows its own furniture, and its predicate errs toward saying yes.
      if (lang.isBuiltinType(t.name)) continue;
      const list = declaredIn.get(t.name);
      if (list) { if (!list.includes(r)) list.push(r); } else declaredIn.set(t.name, [r]);
    }
  }
  // A name declared in many files cannot attribute an edge to any one of them.
  for (const [name, fs] of [...declaredIn]) if (fs.length > MAX_DECLARERS) declaredIn.delete(name);
  onStatus?.(`${declaredIn.size} declared types → resolving references`);

  const mentions = new Map<string, Set<string>>();
  const imports = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();
  const mentionedBy = new Map<string, Set<string>>();
  const namespace = new Map<string, string>();
  const visible = new Map<string, Set<string>>();
  for (const abs of files) {
    let source: string;
    try { source = readFileSync(abs, 'utf-8'); } catch { continue; }
    const r = rel(repoPath, abs);
    const hit = new Set<string>();
    for (const m of source.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
      const name = m[0];
      if (!declaredIn.has(name)) continue;
      // A file declaring the type is not "referencing" it.
      if (declaredIn.get(name)!.includes(r) && declaredIn.get(name)!.length === 1) continue;
      hit.add(name);
    }
    mentions.set(r, hit);
    for (const name of hit) {
      const who = mentionedBy.get(name);
      if (who) who.add(r); else mentionedBy.set(name, new Set([r]));
    }

    // C# has no relative imports, so `using` + namespace IS its edge information. Without this the
    // language contributed no import edges at all — measured on a real 3454-file Unity repo: "0 import
    // edge(s) resolved", so every hop fell through to mention edges and depth 2 pulled in 337 files
    // for a 40-type feature.
    const lang2 = languageFor(abs);
    const ns = namespaceOf(source);
    namespace.set(r, ns);
    const seen = new Set<string>(ns ? [ns] : []);
    if (lang2) for (const u of lang2.referencesOf(source)) seen.add(u);
    visible.set(r, seen);

    const targets = importEdges(repoPath, r, source);
    if (targets.length) imports.set(r, targets);
    for (const t of targets) {
      const list = importedBy.get(t);
      if (list) list.push(r); else importedBy.set(t, [r]);
    }
  }
  // ── why this is 0 on a C# repo, and why that is correct ───────────────────────
  //
  // `importEdges` understands JS/TS module specifiers and requires a leading `.`, so on a C# repo it
  // resolves nothing — not a failure to resolve, but a language without the thing being resolved. C#
  // says `using Some.Namespace`, never `./file`.
  //
  // C#'s edges therefore come from the MENTION path below, gated by `reachable()`: a file must both
  // name a declared type AND be able to see its namespace. That pairing is what makes the edge
  // attributable.
  //
  // TRIED AND REVERTED: promoting `using` of a small namespace to a first-class edge. The edges are
  // true — a `using` IS a declared dependency — but they are not selective: one `using` links a file
  // to EVERY file in that namespace. Measured on this repo, 22,639 such edges took "bingo gameplay"
  // from 80 files to 194 and "trail mini game" from 165 to 1,600, hitting the hard ceiling with depth
  // 2 incomplete. Breadth without precision is the wrong trade at depth 2: a `using` names a wing of
  // the building where a mention names a room.
  const totalEdges = [...imports.values()].reduce((n, v) => n + v.length, 0);
  onStatus?.(`${totalEdges} import edge(s) resolved${totalEdges === 0 ? ' (C#: none by design — edges come from mentions + namespace visibility)' : ''}`);
  const ambient = [...mentionedBy.entries()].filter(([, who]) => who.size > MAX_MENTIONERS).length;
  if (ambient) onStatus?.(`${ambient} name(s) are mentioned everywhere — ignored as edges`);
  return { declaredIn, mentions, mentionedBy, imports, importedBy, namespace, visible, indexed: files.length, truncated };
}

/** The dependency unit a file sits in, for the audit line. Never stored as the operator's domain. */
function unitOf(repoPath: string, file: string): string {
  const lang = languageFor(file);
  if (!lang) return '';
  try { return lang.domainOf(join(repoPath, file))?.name ?? ''; } catch { return ''; }
}

/**
 * Discover the files for ONE domain and write them to the store as they are found.
 *
 * Records are appended per file rather than at the end: an interrupted discovery leaves a partial
 * but truthful file list, which the next run reads back instead of re-investigating.
 */
export async function discoverDomain(opts: DiscoverOptions): Promise<DiscoverReport> {
  const { store, domain, onStatus } = opts;
  const repoPath = resolve(opts.repoPath);
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const report: DiscoverReport = {
    domain, seeds: 0, added: 0, hallucinated: [], skippedNonSource: [], byDepth: {}, truncated: false, indexed: 0,
  };

  const scope = (opts.scope ?? '').replace(/^\.?\//, '').replace(/\/$/, '');
  const inScope = (file: string): boolean =>
    !scope || file === scope || file.startsWith(`${scope}/`);

  // ── seeds ──────────────────────────────────────────────────────────────────────
  let candidates: string[];
  if (opts.seedsOverride) {
    candidates = opts.seedsOverride;
  } else {
    onStatus?.(`asking explore which files implement "${domain}"`);
    const answer = await exploreExecute({
      question: indulgePrompts().get('seedQuestion', { DOMAIN: domain }),
      cwd: repoPath,
      thorough: 'true',
    });
    candidates = extractPaths(answer);
    onStatus?.(`explore named ${candidates.length} candidate path(s) → verifying against the repo`);
  }

  const seeds: string[] = [];
  for (const c of candidates) {
    const r = resolveInRepo(repoPath, c);
    if (!r) { if (!opts.seedsOverride) report.hallucinated.push(c); continue; }
    // A SCOPED DOMAIN DISCARDS OUT-OF-SCOPE SEEDS SILENTLY — they are not hallucinations, they are
    // real files somewhere else. Counting them as bad guesses would blame explore for answering the
    // question it was asked.
    if (!inScope(r)) continue;
    // A corpus answers questions about CODE. `Core.csproj` is a generated file list, and a real run
    // even seeded on ayin's own `AYIN-REPORT-*.md` output — both produced questions, and an answer
    // about a project manifest is a spent investigation that helps nobody.
    if (!languageFor(r)) { report.skippedNonSource.push(r); continue; }
    if (!seeds.includes(r)) seeds.push(r);
  }
  if (report.skippedNonSource.length) {
    onStatus?.(`${report.skippedNonSource.length} named path(s) are not source and were skipped`
      + ` (${report.skippedNonSource.slice(0, 3).join(', ')}${report.skippedNonSource.length > 3 ? ', …' : ''})`);
  }

  // ── deterministic top-up: the domain's own words, matched against PATHS ─────────
  //
  // Explore names paths from what it read, and it is wrong a lot: on a real run it named 22
  // candidates for "reward service" of which 14 did not exist, leaving TWO seeds — and named nothing
  // at all for "mission widgets" in a repo containing `GameModes/Widgets/ProgressWidgetController.cs`.
  //
  // A path match cannot hallucinate: the file is on disk or it is not. It is a weaker signal than
  // reading the code, which is why it runs SECOND and only tops up — but a domain the operator named
  // after a folder should never come back empty because a model failed to connect the words to it.
  if (!opts.seedsOverride && seeds.length < MIN_SEEDS) {
    const before = seeds.length;
    for (const p of seedsByPathWords(repoPath, domain, MIN_SEEDS * 3, opts.vendorRoots ?? [])) {
      if (seeds.length >= MIN_SEEDS * 3) break;
      if (!inScope(p)) continue;
      if (!seeds.includes(p)) seeds.push(p);
    }
    if (seeds.length > before) {
      onStatus?.(`${seeds.length - before} more seed(s) from path names — explore verified only ${before}`);
    }
  }

  // ── last resort for a SCOPED domain: the scope itself ──────────────────────────
  //
  // A scope is the operator saying "the thing I mean is in here". If nothing else produced a seed
  // inside it, the honest reading is not "this domain does not exist" but "the words did not match,
  // and the place still does". Measured: "trail mini game" scoped to the Bingo tree found ZERO seeds
  // — explore had matched a generic mini-game popup elsewhere and every candidate was rejected by the
  // scope — so the domain silently produced nothing at all.
  //
  // Seeding from the scope's own files, PREFERRING those whose path carries a domain word, turns that
  // into a small honest corpus about the right place.
  if (!opts.seedsOverride && scope && seeds.length === 0) {
    const words = domain.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    const under = walkSources(repoPath, 20000, opts.vendorRoots ?? []).files
      .map((abs) => rel(repoPath, abs))
      .filter(inScope);
    const scored = under
      .map((f) => ({ f, hits: words.filter((w) => f.toLowerCase().includes(w)).length }))
      .sort((a, b) => b.hits - a.hits || a.f.length - b.f.length);
    for (const { f } of scored.slice(0, MIN_SEEDS * 3)) if (!seeds.includes(f)) seeds.push(f);
    if (seeds.length) {
      onStatus?.(`nothing matched "${domain}" by name — seeding from ${scope} itself (${seeds.length} file(s))`);
    }
  }

  report.seeds = seeds.length;

  // The whole point of the module: nothing matched, so nothing is written and the run says so.
  if (seeds.length === 0) {
    onStatus?.(`"${domain}" matched no file in this repo — writing no file list`);
    return report;
  }

  const seen = new Set<string>();
  // The ceiling a single depth may not cross even while completing itself.
  const hardCeiling = maxFiles * DEPTH_OVERRUN;
  const write = (file: string, depth: number, why: string): boolean => {
    if (seen.has(file) || report.added >= hardCeiling) return false;
    // THE SCOPE BINDS AT EVERY DEPTH, not only on seeds. A neighbour reached at depth 2 is exactly
    // how a scoped domain leaks back out into the rest of the repository.
    if (!inScope(file)) return false;
    seen.add(file);
    let sha = '';
    try { sha = blobSha(readFileSync(join(repoPath, file))); } catch { return false; }
    const unit = unitOf(repoPath, file);
    store.addFile({ domain, path: file, depth, why: unit ? `${why} · in ${unit}` : why, sha });
    report.added++;
    report.byDepth[depth] = (report.byDepth[depth] ?? 0) + 1;
    return true;
  };

  for (const s of seeds) write(s, 0, 'explore seed');
  onStatus?.(`${report.added} seed file(s) verified → walking references to depth ${maxDepth}`);

  // ── deterministic expansion ────────────────────────────────────────────────────
  if (maxDepth > 0) {
    const index = buildIndex(repoPath, opts.maxIndexFiles ?? DEFAULT_MAX_INDEX_FILES, onStatus, opts.vendorRoots ?? []);
    report.indexed = index.indexed;
    report.truncated = index.truncated;

    let frontier = [...seeds];
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: string[] = [];
      for (const file of frontier) {
        // Each file gets its own budget: one hub must not decide the whole corpus.
        let fanout = 0;
        // The strongest edges first: a resolved relative import names the file directly.
        for (const target of index.imports.get(file) ?? []) {
          if (write(target, depth, `imported by ${file}`)) next.push(target);
        }
        for (const importer of index.importedBy.get(file) ?? []) {
          if (write(importer, depth, `imports ${file}`)) next.push(importer);
        }
        // forward: files declaring a type this file mentions — but only ones this file can SEE.
        // A shared identifier is not a dependency: with 5270 declared types, matching on the name
        // alone made every hop transitive and the walk swallowed the repo.
        for (const name of index.mentions.get(file) ?? []) {
          if ((index.mentionedBy.get(name)?.size ?? 0) > MAX_MENTIONERS) continue;   // ambient
          for (const target of index.declaredIn.get(name) ?? []) {
            if (target === file || !reachable(index, file, target)) continue;
            if (fanout >= MAX_FANOUT_PER_FILE) break;
            if (write(target, depth, `referenced by ${file} (${name})`)) { next.push(target); fanout++; }
          }
        }
        // reverse: files mentioning a type this file declares
        const declaredHere = [...index.declaredIn.entries()]
          .filter(([, fs]) => fs.includes(file))
          // An ambient name is not a handle on this feature — see MAX_MENTIONERS.
          .filter(([n]) => (index.mentionedBy.get(n)?.size ?? 0) <= MAX_MENTIONERS)
          .map(([n]) => n);
        if (declaredHere.length) {
          for (const [other, names] of index.mentions) {
            if (other === file || seen.has(other)) continue;
            if (fanout >= MAX_FANOUT_PER_FILE) break;
            const via = declaredHere.find((n) => names.has(n));
            if (via && reachable(index, other, file) && write(other, depth, `references ${file} (${via})`)) {
              next.push(other); fanout++;
            }
          }
        }
      }
      onStatus?.(`depth ${depth}: +${report.byDepth[depth] ?? 0} file(s)`);
      // Checked HERE, at the boundary: the level just walked is complete, and the cap decides only
      // whether to go deeper. A depth that is half-walked is not a depth, it is a coin flip.
      if (report.added >= hardCeiling) {
        report.truncated = true;
        onStatus?.(`hard ceiling ${hardCeiling} hit inside depth ${depth} — that level is INCOMPLETE`);
        break;
      }
      if (report.added >= maxFiles) {
        report.truncated = true;
        onStatus?.(`${report.added} file(s) past the ${maxFiles} cap — depth ${depth} finished, not going deeper`);
        break;
      }
      frontier = next;
    }
  }

  return report;
}
