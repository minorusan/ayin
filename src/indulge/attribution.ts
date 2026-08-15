/**
 * indulge/attribution.ts — the caller side of the attribution hook.
 *
 * Packs own their wording; this owns the BUDGET and the discipline:
 *
 *   - **The session preamble is emitted once.** "This is a Unity project" on every tool result is the
 *     preamble this mechanism exists to replace, injected more often. Once per session, then never.
 *   - **One line per file, hard-capped.** An attributor that returns a paragraph gets truncated. The
 *     value is that it is short enough to read in the middle of a file listing.
 *   - **A throwing pack costs its own output, nothing else.** `read_file` keeps reading files.
 *   - **The corpus count is always shown, including zero.** Silence and "not covered" look identical
 *     otherwise, and the whole point of the number is deciding whether to indulge this file more.
 */

import type { AttributionContext } from './hooks/types.js';
import { attributorsFor } from './hooks/registry.js';

/** Long enough for a real fact, short enough to sit inside a file listing. */
const MAX_LINE = 240;

/** Preambles already spent this session, by attributor id. */
const preambleShown = new Set<string>();

/** Test seam — a session is a process, but a gate runs many "sessions" in one. */
export function resetAttributionSession(): void {
  preambleShown.clear();
}

/**
 * The block prefixed to a tool result: an optional one-time preamble, the per-file facts, and the
 * corpus count. Returns '' when there is nothing to say and no corpus to report.
 */
export function attributeFile(ctx: AttributionContext): string {
  const lines: string[] = [];

  for (const a of attributorsFor(ctx.repoPath)) {
    try {
      if (!preambleShown.has(a.id) && a.sessionPreamble) {
        const pre = a.sessionPreamble(ctx.repoPath);
        if (pre) { lines.push(pre.slice(0, MAX_LINE * 2)); preambleShown.add(a.id); }
      }
      const line = a.attribute(ctx);
      if (line) lines.push(`[${a.id}] ${line.slice(0, MAX_LINE)}`);
    } catch {
      // A pack the operator wrote is allowed to be broken; the tool is not allowed to care.
    }
  }

  // Flat int, always. `corpus: 0` is the actionable signal — that file has never been indulged.
  lines.push(`[corpus] ${ctx.chunks.length} chunk(s) about this file`);

  return `${lines.join('\n')}\n`;
}
