/**
 * The fallback — no ecosystem knowledge, so no invented ecosystem knowledge.
 *
 * It searches text and reports what it finds. It does NOT attempt to derive glue, because glue is
 * exactly the thing that differs per ecosystem: guessing at it in an unknown repository would
 * manufacture edges that are not there, which is the one failure this tool is built to make
 * impossible.
 */

import type { Finding, ProjectExplorer, Reason } from '../types.js';
import { PRUNE } from '../search.js';

function pruneArgs(): string[] {
  return PRUNE.map((d) => `--exclude-dir=${d}`);
}

export const generic: ProjectExplorer = {
  id: 'generic',
  matches() { return true; },
  sourceIncludes: ['*'],

  plan(term) {
    const base = ['grep', '-rnI', ...pruneArgs()];
    return [
      {
        strategy: 'definition',
        reason: 'defines' as Reason,
        argv: [...base, '-E', `(function|class|def|struct|interface|type|const|var|let)\\s+${term}\\b`, '.'],
      },
      // `-w` would MISS the `_privateField` convention: underscore is a word character, so
      // `grep -w scoreMultiplier` does not match `_scoreMultiplier`. That convention is ubiquitous in
      // C# and common in TypeScript, and missing it means missing the field the question is about.
      { strategy: 'mentions', reason: 'mentions' as Reason, argv: [...base, '-E', `\\b_?${term}\\b`, '.'] },
      {
        strategy: 'spec',
        reason: 'spec' as Reason,
        argv: [...base, '-E', `(test|Test|assert|Assert|expect|describe|it\\().*${term}`, '.'],
      },
      { strategy: 'filename', reason: 'filename' as Reason, argv: ['find', '.', '-name', `*${term}*`, '-type', 'f', '-not', '-path', './.git/*', '-not', '-path', './node_modules/*'] },
    ];
  },

  /** No ecosystem, no derived edges. Returning nothing is the honest answer. */
  async glue(): Promise<Finding[]> {
    return [];
  },

  symbolAt(lines, line) {
    const DECL = /^\s*(?:export\s+)?(?:public|private|protected|static|async|def|func|fn|function|class|struct|interface|type|const|let|var)\s+(\w+)/;
    for (let i = Math.min(line, lines.length); i > 0 && line - i < 60; i--) {
      const m = DECL.exec(lines[i - 1] ?? '');
      if (m) return m[1];
    }
    return undefined;
  },
};
