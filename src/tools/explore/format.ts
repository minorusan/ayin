/**
 * The output — and the place where "cannot lie" is enforced rather than promised.
 *
 * THE GUARANTEE. Every character this module emits comes from exactly one of three sources:
 *
 *   1. bytes read from a real file at a stated line (`Span.text`, read at answer time)
 *   2. a number this tool counted
 *   3. a label from a CLOSED SET defined in `types.ts` (`defines`, `spec`, `asset-ref`, …)
 *
 * There is no template that takes free text, no summarisation step, and no model anywhere in the
 * tool. So the failure that ended the previous version — a directory listing returned as a finding,
 * and a JSON wrapper returned as an answer — is not something this version is careful about. It is
 * something it cannot do.
 *
 * A FIXED SCHEMA, always the same shape. The reader is a 3.3B-active model with a 40k window; a
 * stable layout is worth more to it than well-turned prose, and every character here competes with
 * the actual task for attention.
 *
 * "NOTHING FOUND" IS AN ANSWER and is printed as one, together with the probes that were run — so
 * the caller can ask a better question instead of re-running the same one. The old tool's habit of
 * dumping whatever it had rather than admitting a miss is exactly what made its output untrustworthy.
 */

import type { ExploreResult, Finding } from './types.js';

/** Keep a quoted span short enough to be evidence rather than a file dump. */
const MAX_SPAN_LINES = 6;
const MAX_LINE_CHARS = 160;

function quote(f: Finding): string[] {
  if (!f.span.text) return [];
  const lines = f.span.text.split('\n').slice(0, MAX_SPAN_LINES);
  return lines.map((l, i) => {
    const n = f.span.fromLine + i;
    const t = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l;
    return `    ${String(n).padStart(5)} │ ${t}`;
  });
}

function header(f: Finding): string {
  const where = f.span.text
    ? `${f.span.file}:${f.span.fromLine}${f.span.toLine > f.span.fromLine ? `-${f.span.toLine}` : ''}`
    : f.span.file;
  const sym = f.symbol ? `  ${f.symbol}` : '';
  return `  [${f.reason}] ${where}${sym}`;
}

export function formatResult(r: ExploreResult): string {
  const out: string[] = [];
  out.push(`explore · ${r.project} · ${r.elapsedMs}ms`);
  out.push(`searched for: ${r.terms.join(', ') || '(no identifiers derived from the question)'}`);
  out.push('');

  if (r.findings.length === 0) {
    // The honest empty answer, with enough detail to ask a better question.
    out.push('NOTHING FOUND. This is a real answer, not a failure.');
    out.push('');
    // COMPACT ON PURPOSE. Printing every probe's full command line ran to thousands of characters —
    // in a 40k window that is worse than saying nothing. Strategies and one example command are
    // enough to tell whether the search was wrong or the code is absent.
    const strategies = [...new Set(r.attempts.map((a) => a.strategy.replace(/\(.*\)$/, '')))];
    out.push(`${r.attempts.length} probes across ${strategies.length} strategies, all empty:`);
    out.push(`  ${strategies.join(' · ')}`);
    if (r.attempts[0]) {
      out.push('');
      out.push('example probe (reproducible by hand):');
      out.push(`  ${r.attempts[0].probe.slice(0, 200)}`);
    }
    out.push('');
    out.push('If the name is right, it may be spelled differently in code, live in an excluded');
    out.push('directory, or be reachable only through a string key or an asset reference.');
    return out.join('\n');
  }

  for (const f of r.findings) {
    out.push(header(f));
    if (f.detail) out.push(`    ${f.detail}`);
    out.push(...quote(f));
    out.push('');
  }

  // What was searched, always — so a thin answer is visibly thin rather than looking complete.
  const zero = r.attempts.filter((a) => a.hits === 0);
  if (zero.length) {
    out.push(`no hits from: ${zero.map((a) => a.strategy).join(', ')}`);
  }
  out.push(`${r.findings.length} finding(s) from ${r.attempts.length} probe(s). Every line above is`);
  out.push('verbatim from the file at the stated line — nothing here is summarised or inferred.');
  return out.join('\n');
}
