/**
 * indulge/lexicon.ts — the cheap pass: find chunks by the NAMES in them.
 *
 * Retrieval runs coarse-to-fine, and this is the coarsest useful filter. Before anything semantic,
 * most real questions carry a handle in them — a file, a class, a method (`noteShape`,
 * `RewardService`, `extract.mjs`). Matching those exactly is free, needs no model, and beats any
 * similarity score at the one thing it does: an exact symbol match is not "probably relevant", it is
 * the thing you asked about.
 *
 * Three mechanics, each earning its place:
 *
 *   1. **Normalise for the INDEX, not for the distance.** `noteShape`, `NoteShape` and `note_shape`
 *      all become `note shape`. Edit distance already tolerates those differences — but only between
 *      strings it is asked to compare, and bucketing is what decides which pairs are ever compared.
 *      Unnormalised, `noteShape` and `NoteShape` land in different buckets and never meet.
 *   2. **All trigrams, not the leading three.** `noteShape` → `not ote tes esh sha hap ape`. Bucketing
 *      on the first three characters fails exactly when the typo is in the first three: `ntoeShape`
 *      buckets under `nto`, never meets `not`. This is what pg_trgm exists to solve.
 *   3. **Levenshtein last, on candidates only.** Edit distance is O(n·m) and useless as a scan; it is
 *      a re-ranker for the handful of names trigrams already nominated.
 *
 * What this deliberately cannot do: match meaning. "how does it decide where the bubble points"
 * shares no name with `noteShape`. That is the vector pass's job, and this one runs first to shrink
 * what the vector pass must consider.
 */

import { domainsOf } from './inject.js';
import type { Chunk } from './store.js';

/** Words that match everything and mean nothing. A trigram hit on "the" is noise, not a handle. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'this', 'that', 'with', 'from', 'what', 'when', 'where',
  'which', 'how', 'why', 'does', 'did', 'has', 'have', 'not', 'but', 'its', 'it', 'is', 'in', 'on',
  'of', 'to', 'a', 'an', 'be', 'by', 'or', 'if', 'we', 'you', 'do', 'can', 'get', 'set', 'use',
]);

/** `noteShape` → `note shape`; `Reward.Handler_v2` → `reward handler v2`. */
export function normalizeName(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // HTTPServer → HTTP Server
    .replace(/[^A-Za-z0-9]+/g, ' ')              // dots, underscores, slashes, dashes
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Every 3-character window of a string with its spaces removed. */
export function trigrams(s: string): Set<string> {
  const flat = s.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 3 <= flat.length; i++) out.add(flat.slice(i, i + 3));
  if (flat.length > 0 && flat.length < 3) out.add(flat);   // short names still get one key
  return out;
}

/** Edit distance, abandoned once it exceeds `max` — a far-off name never needs an exact number. */
export function levenshtein(a: string, b: string, max = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;   // whole row already too far — stop
    prev = row;
  }
  return prev[b.length];
}

/** A name in the corpus, and the chunks that carry it. */
export interface Handle {
  /** As written — `noteShape`, `src/extract.mjs`. */
  raw: string;
  kind: 'file' | 'entity' | 'symbol';
  normalized: string;
  grams: Set<string>;
  chunkIds: Set<string>;
  domains: Set<string>;
}

export interface Lexicon {
  handles: Handle[];
  /** trigram → handles carrying it. The inverted index that keeps lookup off a full scan. */
  byGram: Map<string, Handle[]>;
}

/**
 * Code identifiers named in a question or answer.
 *
 * `entity.name` is only populated for entity-level questions; a file-level question about
 * `noteShape` carries `entity: null` and the symbol appears only in its TEXT. Measured on a real
 * corpus: the name index held nothing but file paths, so `noteShape` matched nothing at all.
 *
 * Two sources, both high-signal:
 *   - **backticked spans** — the model marks code that way consistently, and a backtick is an
 *     explicit "this is an identifier" that costs nothing to trust;
 *   - **camelCase / PascalCase words** — shapes that prose does not produce by accident.
 *
 * Deliberately NOT every word: indexing prose would make every chunk a candidate for every query,
 * which is the same as having no index.
 */
export function symbolsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) {
    // `noteShape(inner)` and `Widget.run()` → the name, without the call
    const inner = m[1].trim().replace(/\(.*$/, '').trim();
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(inner)) out.add(inner);
  }
  for (const m of text.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g)) {
    out.add(m[1]);
  }
  return [...out];
}

/** Build the name index from a corpus. Cheap enough to do on every query at this scale. */
export function buildLexicon(chunks: Chunk[]): Lexicon {
  const byRaw = new Map<string, Handle>();
  const add = (raw: string, kind: Handle['kind'], chunk: Chunk): void => {
    if (!raw) return;
    let h = byRaw.get(`${kind}:${raw}`);
    if (!h) {
      const normalized = normalizeName(raw);
      h = { raw, kind, normalized, grams: trigrams(normalized), chunkIds: new Set(), domains: new Set() };
      byRaw.set(`${kind}:${raw}`, h);
    }
    h.chunkIds.add(chunk.chunkId);
    for (const d of domainsOf(chunk)) h.domains.add(d);
  };

  for (const c of chunks) {
    for (const f of new Set([...(c.files ?? []), ...c.citations.map((x) => x.path)])) {
      add(f, 'file', c);                                  // full path
      const base = f.split('/').pop() ?? f;
      if (base !== f) add(base, 'file', c);               // and the basename on its own
    }
    if (c.entity?.name) {
      add(c.entity.name, 'entity', c);
      // `Widget.run` is also a question about `run` — index the tail separately.
      const tail = c.entity.name.split('.').pop();
      if (tail && tail !== c.entity.name) add(tail, 'entity', c);
    }
    // The question is where the symbol usually is; the answer names more but also drifts further
    // from what was ASKED, so it is indexed too but the question is what most queries echo.
    for (const sym of symbolsIn(`${c.question}\n${c.answer}`)) add(sym, 'symbol', c);
  }

  const byGram = new Map<string, Handle[]>();
  for (const h of byRaw.values()) {
    for (const g of h.grams) {
      const list = byGram.get(g);
      if (list) list.push(h); else byGram.set(g, [h]);
    }
  }
  return { handles: [...byRaw.values()], byGram };
}

export interface NameHit {
  handle: Handle;
  /** 1 = exact. Below ~0.45 is noise. */
  score: number;
}

/** Score one query token against one handle. Exact first, then containment, then fuzzy. */
function scoreToken(token: string, h: Handle): number {
  const t = normalizeName(token);
  if (!t) return 0;
  if (t === h.normalized) return 1;
  const flatT = t.replace(/ /g, '');
  const flatH = h.normalized.replace(/ /g, '');
  if (flatT === flatH) return 0.98;
  if (flatH.includes(flatT) || flatT.includes(flatH)) {
    // A short token inside a long name is weak evidence; a long one is strong.
    return 0.6 + 0.3 * (Math.min(flatT.length, flatH.length) / Math.max(flatT.length, flatH.length));
  }
  const tg = trigrams(t);
  let shared = 0;
  for (const g of tg) if (h.grams.has(g)) shared++;
  if (shared === 0) return 0;
  const overlap = shared / Math.max(tg.size, 1);
  // Typos: only worth measuring for names trigrams already nominated.
  const dist = levenshtein(flatT, flatH, 3);
  const fuzzy = dist <= 3 ? 1 - dist / Math.max(flatT.length, flatH.length, 1) : 0;
  return Math.max(overlap * 0.75, fuzzy * 0.8);
}

/**
 * Names in the corpus that the query appears to be about.
 *
 * Candidates come from the trigram index rather than a scan, so a query only ever meets names that
 * share at least one 3-character window with it.
 */
export function lookupNames(lex: Lexicon, query: string, min = 0.45): NameHit[] {
  const tokens = query.split(/[^A-Za-z0-9_.\/]+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t.toLowerCase()));
  const best = new Map<Handle, number>();

  for (const token of tokens) {
    const candidates = new Set<Handle>();
    for (const g of trigrams(normalizeName(token))) {
      for (const h of lex.byGram.get(g) ?? []) candidates.add(h);
    }
    for (const h of candidates) {
      const s = scoreToken(token, h);
      if (s >= min && s > (best.get(h) ?? 0)) best.set(h, s);
    }
  }
  return [...best.entries()]
    .map(([handle, score]) => ({ handle, score }))
    .sort((a, b) => b.score - a.score);
}
