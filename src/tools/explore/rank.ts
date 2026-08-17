/**
 * Ranking — mechanical, and the weights are stated so the ordering can be argued with.
 *
 * The tool is called often and answers narrowly, so ranking is what makes it useful: the caller sees
 * the top handful, not everything. Every input to the score is a fact computed from the search, not
 * a judgement — which is what keeps the whole tool free of a model.
 *
 * ONE WEIGHT IS A CORRECTION. Tests were originally going to rank LOW as noise. On a real question
 * the clearest statement of the rule in the entire repository was a test assertion —
 * `TotalScore == base * (int)ScoreMultiplierType.Double` — and no production line said it as plainly.
 * Tests are executable specifications; they rank HIGH and carry their own `spec` label.
 */

import type { Finding, Reason } from './types.js';

/** Base weight per reason. `defines` and `spec` lead: one says what a thing IS, the other what it DOES. */
const REASON_WEIGHT: Record<Reason, number> = {
  defines: 1.0,
  filename: 0.45,   // a name is a hint; a quoted declaration is evidence
  spec: 0.9,
  'anim-event': 0.85,   // a string-bound call no compiler checks — always worth surfacing
  'string-key': 0.8,    // ditto, in TypeScript
  'asset-ref': 0.75,
  follows: 0.7,
  registered: 0.65,
  mentions: 0.4,
  assembly: 0.2,
};

/** Generated, vendored or build output — real files, but never the answer to "how does this work". */
const LOW_VALUE = /(^|\/)(Library|Temp|obj|Build|Builds|dist|node_modules|\.git)\//;
/** A path that reads like a sample rather than the system. */
const SAMPLE = /(^|\/)(Samples?|Examples?|Demos?|Third-?Party|Plugins)\//i;

export function scoreFinding(f: Finding, termHitsInFile: number): number {
  let s = REASON_WEIGHT[f.reason] ?? 0.3;

  // NO TEXT, NO PRECEDENCE. A finding without a quoted span tells the caller a path and nothing more,
  // so it can never be worth more than one that shows the line. Without this, bare `find` results
  // outranked every real hit and the answer contained no code at all.
  if (!f.span.text) s -= 0.35;

  // Density: a file mentioning the term repeatedly is more likely to own it. Capped so one enormous
  // file cannot dominate purely by being enormous.
  s += Math.min(termHitsInFile, 8) * 0.04;

  if (LOW_VALUE.test(f.span.file)) s -= 0.6;
  if (SAMPLE.test(f.span.file)) s -= 0.25;

  // A short path is usually closer to the core than a deeply nested one.
  const depth = f.span.file.split('/').length;
  s -= Math.min(depth, 10) * 0.012;

  return Math.max(0, Number(s.toFixed(3)));
}

/**
 * Rank, then keep the answer SMALL.
 *
 * Small is the requirement, not a nicety: the result competes for a 40k window against the system
 * prompt, the history and the actual task, and this tool is designed to be called repeatedly rather
 * than exhaustively once. One span per (file, symbol) — repeats of the same method add nothing.
 */
export function rankAndTrim(findings: Finding[], limit = 8): Finding[] {
  const perFile = new Map<string, number>();
  for (const f of findings) perFile.set(f.span.file, (perFile.get(f.span.file) ?? 0) + 1);

  /**
   * SPECIFICITY: a term that matches everywhere discriminates nothing.
   *
   * Asking "how does the solitaire streak score multiplier get applied" derives both `SolitaireStreak`
   * — which appears across an entire subsystem — and `scoreMultiplier`, which is the term the question
   * is actually about. Weighting them equally filled the answer with config-binding tests that merely
   * mention streaks. This is inverse document frequency, computed from the search that just ran: hits
   * from a rare term outrank hits from a common one, with no model and no corpus.
   */
  const perTerm = new Map<string, number>();
  for (const f of findings) if (f.term) perTerm.set(f.term, (perTerm.get(f.term) ?? 0) + 1);
  const maxTerm = Math.max(1, ...perTerm.values());

  const scored = findings.map((f) => {
    if (f.fixedScore) return f;
    let s = scoreFinding(f, perFile.get(f.span.file) ?? 1);
    if (f.term) {
      const share = (perTerm.get(f.term) ?? 1) / maxTerm; // 1 = the most common term in this search
      s += 0.35 * (1 - share);
    }
    return { ...f, score: Number(s.toFixed(3)) };
  });
  scored.sort((a, b) => b.score - a.score || a.span.file.localeCompare(b.span.file) || a.span.fromLine - b.span.fromLine);

  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of scored) {
    const key = `${f.span.file}::${f.symbol ?? f.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}
