/**
 * tools/grep-rank.ts — grep finds; this decides what the model reads FIRST.
 *
 * `grep` returns hits in the order the filesystem walk produced them, which is alphabetical by
 * accident and meaningless as evidence. The cap then makes that ordering load-bearing: with 50 lines
 * shown out of 300, walk order decides what the agent believes the codebase contains. Measured on a
 * Unity repo, a search for a gameplay symbol opened with `Assets/Plugins/…` and
 * `Assets/Spine/Editor/…` — third-party code the team cannot change, spending the cap before any
 * first-party file appeared.
 *
 * Two rules, and the second is why this is per project type:
 *
 *   THIRD-PARTY SINKS, ALWAYS. Not dropped — a hit in a plugin is sometimes exactly the answer, and
 *   the same bias applies here as in `indulge/vendor.ts`: when unsure, keep it. It goes last, so the
 *   cap is spent on code somebody in this repo can edit. The vendor roots come from that same module
 *   rather than a second list invented here, because that one was measured against real repos.
 *
 *   FILE KIND RANKS, AND KIND IS LANGUAGE-SPECIFIC. In a Unity repo a `.cs` is the behaviour and a
 *   `.asset` is data describing it, so a question is nearly always about the `.cs` first — while in a
 *   TypeScript repo a `.d.ts` is a declaration restating what a `.ts` already said, and ranking them
 *   equally puts the restatement above the source. There is no ordering that is right for both, which
 *   is exactly the argument the two indulge hooks make: language-agnostic is right for the loop and
 *   wrong for knowledge.
 *
 * Grouped by FILE and never re-ordered within one. Interleaving a file's lines by score would make a
 * result nobody can read against the file it came from, and consecutive lines are how the reader sees
 * that two matches are the same construct.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateDirs, isUnderVendorRoot, knownVendorRoots, loadCachedVendorRoots } from '../indulge/vendor.js';
import { openStore } from '../indulge/store.js';

export type GrepProfile = 'general' | 'typescript' | 'unity';

/**
 * Path shapes that are third-party or generated wherever they appear.
 *
 * `vendor.ts` finds vendor ROOTS — top-of-tree directories named after their vendor — which is most
 * of the answer and not all of it: a `Pods/` under a subproject, a `*.min.js`, a `*.Designer.cs`
 * emitted by a form editor. These are the shapes no repo authors by hand.
 */
const NOT_AUTHORED = [
  /(^|\/)node_modules\//, /(^|\/)Pods\//, /(^|\/)third[_-]?party\//i, /(^|\/)vendor\//i,
  /(^|\/)external\//i, /(^|\/)\.yarn\//, /(^|\/)Packages\//,
  /\.min\.(js|css)$/i, /\.designer\.cs$/i, /\.g\.cs$/i, /\.generated\.[a-z]+$/i,
  /\.pb\.(go|ts|js|cs)$/i, /_pb2\.py$/i,
];

/** Extension ranking per profile, best first. Anything unlisted sorts after everything listed. */
const RANKS: Record<GrepProfile, string[]> = {
  // Behaviour, then the data that configures it, then the animation graphs that drive it — the order
  // the operator asked for, and the order a Unity question is asked in.
  unity: ['.cs', '.asset', '.controller', '.prefab', '.unity', '.shader', '.json', '.asmdef', '.meta'],
  typescript: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md'],
  general: ['.ts', '.tsx', '.js', '.cs', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.c', '.h', '.cpp', '.hpp', '.dart', '.json', '.md'],
};

/** A `.d.ts` restates a `.ts`; ranking them together puts the restatement above the source. */
const DEMOTED = [/\.d\.ts$/i, /\.meta$/i];

const ext = (p: string): string => {
  const base = p.split('/').pop() ?? p;
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
};

/**
 * Which profile a repo gets. Asked once per path and cached, like `Attributor.applies`.
 *
 * Unity is tested FIRST and by its own marker file, because a Unity project also carries
 * `package.json` in places and would otherwise read as a TypeScript one.
 */
const profileCache = new Map<string, GrepProfile>();
export function detectProfile(repoPath: string): GrepProfile {
  const hit = profileCache.get(repoPath);
  if (hit) return hit;
  let p: GrepProfile = 'general';
  if (existsSync(join(repoPath, 'ProjectSettings', 'ProjectVersion.txt'))
    || (existsSync(join(repoPath, 'Assets')) && existsSync(join(repoPath, 'ProjectSettings')))) {
    p = 'unity';
  } else if (existsSync(join(repoPath, 'tsconfig.json'))
    || existsSync(join(repoPath, 'package.json'))) {
    p = 'typescript';
  }
  profileCache.set(repoPath, p);
  return p;
}

/**
 * Third-party roots, preferring the CORPUS's cached list over the static heuristic.
 *
 * `knownVendorRoots` recognises directories NAMED after their vendor — `Plugins`, `Spine`,
 * `Packages` — which is most of a real repo and demonstrably not all of it. Measured here: `Assets/
 * UniWebView` and `Assets/InfinityScrollView` are bought plugins whose names say nothing generic, so
 * the heuristic kept them and a ranked grep put their scripts at the top of a first-party search.
 *
 * `indulge` already solved this: its vendor roots are decided once per repo, corrected by the
 * operator, and cached in the corpus. Reading that file here means one curated list serves the
 * overnight build and the grep the agent runs at lunchtime, and a root added for one is added for
 * both. When there is no corpus yet, the static heuristic still runs — a repo nobody has indulged
 * must still get a sensible grep.
 */
const vendorCache = new Map<string, string[]>();
function vendorRootsFor(repoPath: string): string[] {
  const hit = vendorCache.get(repoPath);
  if (hit) return hit;
  let roots: string[] = [];
  try {
    const store = openStore(repoPath);
    roots = (store.exists() ? loadCachedVendorRoots(store.dir) : null) ?? [];
  } catch { roots = []; }
  if (!roots.length) {
    try { roots = knownVendorRoots(candidateDirs(repoPath)); } catch { roots = []; }
  }
  vendorCache.set(repoPath, roots);
  return roots;
}

export function isThirdParty(repoPath: string, rel: string): boolean {
  if (NOT_AUTHORED.some((re) => re.test(rel))) return true;
  const roots = vendorRootsFor(repoPath);
  return roots.length > 0 && isUnderVendorRoot(rel, roots);
}

/**
 * The path a grep output line belongs to.
 *
 * Four shapes reach here and all four must parse, because a mis-read path silently ranks a file by
 * another file's score: `path:12:text` (matches), `path-12-text` (a `-C` context line), `path:3`
 * (`--count`) and a bare `path` (`--files-with-matches`). A `--` group separator carries no path and
 * stays with the group it was printed inside.
 */
export function pathOfLine(line: string): string | null {
  if (line === '--') return null;
  let m = /^(.+?):(\d+)[:-]/.exec(line);
  if (m) return m[1];
  m = /^(.+?)-(\d+)-/.exec(line);
  if (m) return m[1];
  m = /^(.+?):(\d+)$/.exec(line);
  if (m) return m[1];
  return line.trim() || null;
}

/**
 * Score one file. Higher sorts earlier. Third-party is a floor, not a tiebreak.
 *
 * The vendor penalty is larger than the whole extension range on purpose: a first-party `.md` should
 * still outrank a third-party `.cs`, because the question is about this team's code and a plugin's
 * source is the one place an answer cannot be acted on.
 */
export function scoreFile(repoPath: string, rel: string, profile: GrepProfile): number {
  const order = RANKS[profile];
  const i = order.indexOf(ext(rel));
  let score = i >= 0 ? order.length - i : 0;
  if (DEMOTED.some((re) => re.test(rel))) score -= order.length + 1;
  if (isThirdParty(repoPath, rel)) score -= 1000;
  return score;
}

export interface RankedGrep {
  /** The reordered output lines. */
  lines: string[];
  /** Files whose hits were pushed below first-party code, for the one-line note. */
  thirdParty: string[];
  /** First-party files that carried a hit, best first — the GUID annotation reads this. */
  files: string[];
}

/**
 * Reorder grep output by file score, preserving each file's own line order.
 *
 * A STABLE sort, so files of equal score keep the walk order grep gave them: inventing an order
 * between two equally relevant files would be a claim this has no basis for.
 */
export function rankGrepLines(repoPath: string, out: string[], profile: GrepProfile): RankedGrep {
  const groups: Array<{ path: string; lines: string[] }> = [];
  const byPath = new Map<string, { path: string; lines: string[] }>();
  let current: { path: string; lines: string[] } | null = null;

  for (const line of out) {
    const p = pathOfLine(line);
    if (p === null) { current?.lines.push(line); continue; }   // `--` separator
    let g = byPath.get(p);
    if (!g) { g = { path: p, lines: [] }; byPath.set(p, g); groups.push(g); }
    g.lines.push(line);
    current = g;
  }

  const scored = groups.map((g, i) => ({ g, s: scoreFile(repoPath, g.path, profile), i }));
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));

  return {
    lines: scored.flatMap((x) => x.g.lines),
    thirdParty: scored.filter((x) => isThirdParty(repoPath, x.g.path)).map((x) => x.g.path),
    files: scored.filter((x) => !isThirdParty(repoPath, x.g.path)).map((x) => x.g.path),
  };
}

/** `guid: 1234abcd…` out of a `.meta`. The same read `indulge/indulgers/unity.ts` does. */
function guidOf(metaPath: string): string | null {
  try {
    const m = readFileSync(metaPath, 'utf-8').match(/^guid:\s*([0-9a-f]{32})/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/** How many scripts get a GUID line. Past this the block is longer than the result it annotates. */
const MAX_GUIDS = 12;

/**
 * GUIDs for the scripts a Unity result names, as a block AFTER the lines.
 *
 * **A GUID is the only exact handle a Unity script has.** Every reference from a prefab, scene or
 * `.asset` is by GUID and nothing about it is inferred, so it is what turns "this class exists" into
 * "and here is what I can search the asset tree for". Without it the next step is a `.meta` read per
 * file, which is what the agent was doing by hand.
 *
 * APPENDED, NEVER INLINE. `path:line:text` is a shape the model parses to decide what to read next,
 * and widening it to `path:line:guid:text` would break every reader of it for an annotation that is
 * about the file rather than the line.
 */
export function guidBlock(repoPath: string, files: string[]): string {
  const scripts = files.filter((f) => f.toLowerCase().endsWith('.cs')).slice(0, MAX_GUIDS);
  if (!scripts.length) return '';
  const rows: string[] = [];
  for (const f of scripts) {
    const guid = guidOf(join(repoPath, `${f}.meta`));
    // A script with no .meta is a real state — not yet imported by the editor — and saying so beats
    // omitting the row, because "no GUID" is why an asset search for it will find nothing.
    rows.push(`  ${f}  ${guid ?? '(no .meta — not imported yet)'}`);
  }
  return `\nguids (search the asset tree for these):\n${rows.join('\n')}`;
}
