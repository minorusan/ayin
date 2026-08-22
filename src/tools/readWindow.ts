/**
 * WHICH SLICE OF A FILE TO RETURN — the arithmetic of a READ window, as pure functions.
 *
 * Named `readWindow`, not `window`: in this codebase "the window" already means the CONTEXT window (see
 * `trimToContext` and `tool/check-window.mjs`, which guards its KV-cache headroom). Two unrelated things
 * called the same thing is how the wrong file gets edited.
 *
 * `read_file` caps a read at `READ_MAX_LINES`, and for a big file the first N lines are almost never
 * the answer: they are imports and licence headers. The model then has to learn the file's length, do
 * subtraction, and ask again — two calls and a computation to look at one function. Worse, asking the
 * same question twice returns the same top-of-file slice, so a repeated read is a wasted round.
 *
 * Three things fix that, and they are separated out here because window arithmetic is exactly the kind
 * of code that is wrong at the edges (off-by-one at line 1, at `total`, at a window wider than the file)
 * and right in the middle, where a hand test looks fine.
 *
 *  1. **Centre on a line** (`centeredWindow`) — a `grep` hit is a line number, and what you want around
 *     it is context on BOTH sides. Starting *at* the hit throws away everything that leads to it.
 *  2. **Slide past what was already read** (`unreadRanges`) — a second param-free read returns the next
 *     unseen window instead of the same first one.
 *  3. **Stop at a structural break** (`snapEnd`, `snapStart`) — a window that ends mid-function hands the
 *     model a fragment it will reason about as if it were whole. Snapping is language-agnostic on
 *     purpose: a blank line separates constructs in every language anyone reads here, and a bracket
 *     alone at column 0 closes one. No parser, no per-language table, nothing to keep in sync.
 *
 * Every function is total and clamped: no throwing, no negative indices, and a window is always at least
 * one line inside `1..total`.
 */

/** An inclusive, 1-based line span. Line numbers, never array indices — the whole file speaks 1-based. */
export type Span = [number, number];

/** How far a window boundary may move to reach a structural break. */
export const BOUNDARY_SLACK = 20;

/** How much of the previously-read region a slid window repeats, so a straddling construct survives. */
export const SLIDE_OVERLAP = 12;

/**
 * Default size for an `around` window — deliberately far smaller than `READ_MAX_LINES`.
 *
 * `around` exists to look AT something, so its default is a focused window, not a capped one. Defaulting
 * it to the full cap made `around=1003` of a 1004-line file return lines 205-1004: correct arithmetic,
 * useless answer, and 800 lines of context spent to see one constant. Measured on a live run — the model
 * immediately issued a second, narrower read, which is the tell. `limit` still overrides.
 */
export const AROUND_DEFAULT = 100;

export function clampSpan([from, to]: Span, total: number): Span {
  if (total <= 0) return [1, 1];
  const f = Math.max(1, Math.min(from, total));
  const t = Math.max(f, Math.min(to, total));
  return [f, t];
}

/** Merge into sorted, non-overlapping spans. Adjacent spans join: 1-800 + 801-900 = 1-900. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const all = [...spans].filter(([f, t]) => f <= t).sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/** What is left of `1..total` after `spans`. The complement — this is what "unread" means. */
export function unreadRanges(spans: readonly Span[], total: number): Span[] {
  if (total <= 0) return [];
  const merged = mergeSpans(spans);
  const out: Span[] = [];
  let cursor = 1;
  for (const [f, t] of merged) {
    if (f > cursor) out.push([cursor, Math.min(f - 1, total)]);
    cursor = Math.max(cursor, t + 1);
  }
  if (cursor <= total) out.push([cursor, total]);
  return out.filter(([f, t]) => f <= t && f >= 1 && t <= total);
}

/**
 * A window of `size` lines centred on `target`.
 *
 * Clamped by SHIFTING, never by shrinking: asking for 40 lines around line 3 gives lines 1-40, not
 * 1-23. A window that silently returns less than asked is the failure this whole file exists to avoid.
 */
export function centeredWindow(target: number, size: number, total: number): Span {
  if (total <= 0) return [1, 1];
  const n = Math.max(1, Math.min(size, total));
  const half = Math.floor((n - 1) / 2);
  let from = target - half;
  if (from < 1) from = 1;
  let to = from + n - 1;
  if (to > total) {
    to = total;
    from = Math.max(1, total - n + 1);
  }
  return [from, to];
}

/** How good a line is as the END of a window. 0 = not a break. */
function endScore(lines: readonly string[], n: number): number {
  const line = lines[n - 1];
  if (line === undefined) return 0;
  if (line.trim() === '') return 3; // a blank line separates constructs in every language read here
  if (/^[)}\]]+[;,]?\s*$/.test(line)) return 2; // a bracket alone at column 0 closes one
  return 0;
}

/** A bracket is a weaker break than a blank line — worth going this many lines further to find one. */
const BRACE_PENALTY = 3;

/**
 * Move `end` to the nearest structural break, up to `slack` lines either way.
 *
 * The candidate is chosen by DISTANCE, not by quality: a blank line wins over a bracket only when it is
 * within `BRACE_PENALTY` lines of the same range. Ranking by quality alone picked a blank line seven
 * lines back over a bracket one line forward, shrinking the window and dropping six lines — the opposite
 * of the point. At equal cost the window EXTENDS rather than shrinks, because a few extra lines cost
 * nothing while cutting a construct short costs the model its reasoning.
 *
 * Never moves to or before `from`, and never past `total` — a window ending on the last line needs no
 * snapping at all.
 */
export function snapEnd(
  lines: readonly string[], from: number, end: number, total: number, slack = BOUNDARY_SLACK,
): number {
  if (end >= total) return total;
  let best = end;
  let bestCost = Infinity;
  for (let d = 0; d <= slack; d++) {
    // `end + d` first, so an equal-cost tie extends the window rather than shrinking it.
    for (const cand of d === 0 ? [end] : [end + d, end - d]) {
      if (cand <= from || cand > total) continue;
      const score = endScore(lines, cand);
      if (score === 0) continue;
      // Cost is DISTANCE, with a blank line preferred over a bracket only at comparable range. Scoring
      // by quality alone chose a blank line seven lines back over a brace one line forward, shrinking
      // the window and dropping six lines of the file — the opposite of what this is for.
      const cost = d + (score === 3 ? 0 : BRACE_PENALTY);
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
  }
  return best;
}

/**
 * Move `start` back to just after a blank line, up to `slack` lines.
 *
 * Only ever moves BACKWARDS: the point is to include the head of the construct the window lands inside,
 * and moving forward would drop the very lines the caller is sliding towards.
 */
export function snapStart(lines: readonly string[], start: number, slack = BOUNDARY_SLACK): number {
  for (let d = 0; d <= slack; d++) {
    const cand = start - d;
    if (cand <= 1) return 1;
    const prev = lines[cand - 2];
    if (prev !== undefined && prev.trim() === '') return cand;
  }
  return start;
}

/** `1-800, 950` — spans for a human and a model to read. */
export function describeSpans(spans: readonly Span[]): string {
  const merged = mergeSpans(spans);
  if (!merged.length) return 'none';
  return merged.map(([f, t]) => (f === t ? `${f}` : `${f}-${t}`)).join(', ');
}

export function spanLines(spans: readonly Span[]): number {
  return mergeSpans(spans).reduce((n, [f, t]) => n + (t - f + 1), 0);
}

/**
 * The window a param-free read should return, given what has already been seen.
 *
 * `null` means "there is nothing new" — the caller then shows the top, because returning nothing at all
 * would be a read tool that answers a read with a refusal.
 */
export function slideWindow(
  lines: readonly string[], seen: readonly Span[], size: number, total: number,
): Span | null {
  const unread = unreadRanges(seen, total);
  if (!unread.length) return null;
  const target = unread[0][0];
  const from = snapStart(lines, Math.max(1, target - SLIDE_OVERLAP));
  const to = snapEnd(lines, from, Math.min(total, from + size - 1), total);
  return clampSpan([from, to], total);
}
