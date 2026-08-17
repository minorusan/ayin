/**
 * Which directories hold code this team did not write — and must not pay to learn.
 *
 * A corpus exists to know THIS repository. Zenject's `IInstantiator`, DOTween's easing tables and an
 * ad SDK's callbacks are all real code, all indexable, and all worthless here: nobody asks an agent
 * why a third-party DI container does what it does, and the upstream docs answer it better anyway.
 * Measured on a real run: a corpus for "bingo gameplay" came back rooted in `Plugins/Zenject/Source/
 * Main/IInstantiator.cs` — questions generated, and paid for, about a library the team consumes.
 *
 * Two passes, cheap first:
 *
 *   1. NAMES WE ALREADY KNOW. A static list, matched case-insensitively. Free, deterministic, and it
 *      catches the overwhelming majority — vendor directories are named after their vendor.
 *   2. ONE MODEL CALL for the rest. Only the directory NAMES are sent, never contents, and only those
 *      the static pass could not decide. The answer is cached in the corpus, so this costs one call
 *      per repository rather than one per run.
 *
 * The bias is deliberate and one-directional: **when unsure, keep it.** A vendor file wrongly indexed
 * wastes a few questions. A first-party directory wrongly skipped is knowledge silently missing from
 * the corpus, and nothing downstream can tell that it is missing.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolLlm, toolPrompts } from '../tools/runtime.js';
import { ensureToolRuntime } from '../tool-wiring.js';

// This module may be the FIRST thing an `indulge` run touches, before discovery has wired anything.
// `indulge` is headless — there is no TUI boot to initialize the seam — so it owns its own wiring
// rather than relying on some other module having been imported first.
ensureToolRuntime();

/**
 * Vendor directory names, lowercased. Deliberately conservative: every entry here is a name that is
 * essentially never a team's own module. Ambiguous names ("core", "shared", "common", "utils") are
 * left out on purpose — they are first-party far more often than not.
 */
const KNOWN_VENDOR = new Set([
  // Unity, asset store and package imports
  'plugins', 'thirdparty', 'third-party', '3rdparty', 'vendor', 'vendors', 'externals', 'external',
  'zenject', 'extenject', 'dotween', 'demigiant', 'fireball', 'odin', 'sirenix', 'photon', 'fmod',
  'textmesh pro', 'textmeshpro', 'tmpro', 'unityads', 'admob', 'googlemobileads', 'facebook',
  'firebase', 'appsflyer', 'adjust', 'applovin', 'ironsource', 'unityiap', 'purchasing',
  'newtonsoft', 'protobuf', 'dotnetzip', 'lz4', 'sqlite', 'websocketsharp', 'best http',
  'amplitude', 'gameanalytics', 'singular', 'tenjin', 'playfab', 'backtrace', 'sentry',
  'spine', 'rewired', 'easysave', 'ingameDebugConsole'.toLowerCase(), 'nsubstitute', 'moq',
  // generic build/tooling roots that are never authored knowledge
  'packages', 'library', 'obj', 'bin', 'node_modules', 'streamingassets',
]);

/** A candidate directory offered to the classifier. */
/**
 * The most of the UNDECIDED set a classifier may call third-party before its answer is discarded.
 *
 * Not a tuning knob — a sanity bound. Vendor code arrives in a handful of named imports; a reply that
 * marks most of a repository is a broken reply, whatever the individual names look like.
 */
const VENDOR_SANITY_SHARE = 0.4;

export interface VendorCandidate {
  /** Repo-relative, forward slashes. */
  path: string;
  /** Directory name only, for the name-based decision. */
  name: string;
}

/** Where the decision is cached, so the model is asked once per repository, not once per run. */
function cacheFile(corpusDir: string): string {
  return join(corpusDir, 'vendor-roots.json');
}

export function loadCachedVendorRoots(corpusDir: string): string[] | null {
  const f = cacheFile(corpusDir);
  if (!existsSync(f)) return null;
  try {
    const v = JSON.parse(readFileSync(f, 'utf-8')) as { roots?: string[] };
    return Array.isArray(v.roots) ? v.roots : null;
  } catch {
    return null;
  }
}

export function saveVendorRoots(corpusDir: string, roots: string[]): void {
  try {
    writeFileSync(cacheFile(corpusDir), `${JSON.stringify({ roots, at: new Date().toISOString() }, null, 2)}\n`, 'utf-8');
  } catch { /* a corpus that cannot cache this still works, it just re-asks next run */ }
}

/**
 * Directories worth CLASSIFYING — the shallow `ls` an operator would do by eye.
 *
 * Only two levels, because vendor code is imported at the top of a tree, never buried: `Assets/
 * Plugins/Zenject`, `Assets/ThirdParty/DOTween`. Walking deeper would cost a full tree scan to find
 * things that are not there, and would start offering the model gameplay subdirectories to misjudge.
 */
export function candidateDirs(repoPath: string, maxDepth = 2): VendorCandidate[] {
  const out: VendorCandidate[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(join(repoPath, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      out.push({ path: childRel, name: e.name });
      walk(childRel, depth + 1);
    }
  };
  walk('', 1);
  return out;
}

/** The free pass: names we already know, no model involved. */
export function knownVendorRoots(candidates: VendorCandidate[]): string[] {
  return candidates.filter((c) => KNOWN_VENDOR.has(c.name.toLowerCase())).map((c) => c.path);
}

/**
 * Candidates the static pass could not decide — the only ones worth a model call.
 *
 * Anything already inside a known vendor root is dropped rather than asked about: `Plugins/Zenject/
 * Source` adds nothing once `Plugins` is skipped, and sending it would spend prompt on a decision
 * already made.
 */
export function undecided(candidates: VendorCandidate[], known: string[]): VendorCandidate[] {
  return candidates.filter((c) => !known.some((k) => c.path === k || c.path.startsWith(`${k}/`)));
}

/** True when `rel` sits inside any skipped root. */
export function isUnderVendorRoot(rel: string, roots: string[]): boolean {
  const p = rel.split('\\').join('/');
  return roots.some((r) => p === r || p.startsWith(`${r}/`));
}

/**
 * The whole decision, cheap pass then model pass, cached.
 *
 * `ask` is injected rather than imported so this module stays testable without a backend, and so the
 * caller decides which model pays for it — during `indulge` that is the build provider, which may be
 * OpenAI while the interactive agent stays local.
 */
export async function detectVendorRoots(opts: {
  repoPath: string;
  corpusDir: string;
  /** Injected for tests; defaults to one call through the indulge prompt bundle. */
  ask?: (dirs: string[]) => Promise<string>;
  onStatus?: (s: string) => void;
  /** Re-decide even when a cached answer exists. */
  refresh?: boolean;
}): Promise<{ roots: string[]; fromCache: boolean; asked: number }> {
  const { repoPath, corpusDir, onStatus } = opts;
  const ask = opts.ask ?? (async (dirs: string[]): Promise<string> =>
    toolLlm().ask([{ role: 'user', content: toolPrompts('indulge').get('vendorRoots', { DIRS: dirs.join('\n') }) }]));
  if (!opts.refresh) {
    const cached = loadCachedVendorRoots(corpusDir);
    if (cached) {
      onStatus?.(`skipping ${cached.length} third-party root(s) (cached)`);
      return { roots: cached, fromCache: true, asked: 0 };
    }
  }

  const candidates = candidateDirs(repoPath);
  const known = knownVendorRoots(candidates);
  const rest = undecided(candidates, known);
  onStatus?.(`${candidates.length} director(ies) scanned · ${known.length} known third-party by name`);

  let modelPicked: string[] = [];
  if (rest.length) {
    // Names only, never contents. Bounded so a sprawling repo cannot turn this into a huge prompt.
    const names = rest.map((c) => c.path).slice(0, 200);
    onStatus?.(`asking the model about ${names.length} undecided director(ies)`);
    let reply = '';
    try {
      reply = await ask(names);
    } catch (e) {
      // A failed classification must not fail the build: the static list still applies.
      onStatus?.(`third-party classification failed (${e instanceof Error ? e.message : String(e)}) — keeping only the known names`);
    }
    const offered = new Set(names);
    modelPicked = reply
      .split('\n')
      .map((l) => l.trim().replace(/^[-*\s]+/, '').replace(/^["'`]|["'`]$/g, ''))
      .filter(Boolean)
      // ONLY paths we offered. A model naming a directory that was not on the list is guessing, and a
      // guess here silently deletes real knowledge from the corpus.
      .filter((l) => offered.has(l));
  }

  // NEVER SKIP THE WORLD.
  //
  // `Assets` is offered to the classifier like any other directory, and a model that calls it
  // third-party would prune the entire repository — producing an empty corpus that looks like a
  // successful run. No answer about vendor code is worth that, so a pick that swallows most of the
  // tree is refused on arithmetic rather than trusted. The static list is exempt: those names are
  // known, not inferred.
  const safePicked = modelPicked.filter((r) => {
    const swallowed = candidates.filter((c) => c.path === r || c.path.startsWith(`${r}/`)).length;
    const tooBig = swallowed > candidates.length / 2;
    if (tooBig) onStatus?.(`refusing to skip "${r}" — it covers ${swallowed}/${candidates.length} directories`);
    return !tooBig;
  });

  // AND REFUSE THE WHOLE ANSWER WHEN IT IS OBVIOUSLY NOT AN ANSWER.
  //
  // The per-pick guard above is necessary and NOT sufficient: it caught a classifier naming `Assets`,
  // and then a classifier said "third-party" to 54 of 63 directories — each one individually small,
  // together the entire repository, including `Assets/BingoGame`, the very subject of the build. The
  // walk then indexed ONE file and reported success. No real repository is four-fifths vendor code, so
  // a reply that claims it is has told us about the classifier, not about the repository.
  const share = safePicked.length / Math.max(1, rest.length);
  let accepted = safePicked;
  if (share > VENDOR_SANITY_SHARE) {
    onStatus?.(
      `refusing the whole classification — ${safePicked.length}/${rest.length} directories called third-party; `
      + 'keeping only the names already known',
    );
    accepted = [];
  }

  const roots = [...new Set([...known, ...accepted])].sort();
  saveVendorRoots(corpusDir, roots);
  onStatus?.(`skipping ${roots.length} third-party root(s)${roots.length ? `: ${roots.slice(0, 6).join(', ')}${roots.length > 6 ? ', …' : ''}` : ''}`);
  return { roots, fromCache: false, asked: rest.length };
}
