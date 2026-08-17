/**
 * TypeScript — where the glue is a string key.
 *
 * TS has no GUIDs, and at first glance nothing like Unity's hidden wiring: symbols have names, names
 * are greppable, imports are explicit. That is true for the *import graph* and false for how these
 * codebases actually connect. Counted on one real backend:
 *
 *     116 socket event names · 92 tool names · 88 resource ops · 41 habit names
 *
 * Every one of those is a bare string literal that ties two distant files together and appears in NO
 * import graph — `"chat:send"` is emitted in one file and handled in another with no symbol shared
 * between them. Rename it and nothing fails to compile, exactly like renaming a Unity method that an
 * animation clip calls by name. Same failure, different alphabet.
 *
 * Two more string→file bindings behave identically:
 *   getPrompt('id')  → prompts/<namespace>/<id>.txt   (a string key into a FILE — the GUID pattern)
 *   getConfig('key') → the settings store
 *
 * And one structural fact with no analogue in Unity: **membership in a registry**. A tool exists
 * because it is listed in `tasks/registry.ts`; a route exists because it is in `HTTP_ROUTES`. The
 * declaration alone tells you nothing about whether the thing is reachable — the list does.
 *
 * So the probes below look for: declaration, import sites, string-literal keys, registry membership,
 * tests, and dynamic imports (which a naive import-graph walk misses but a text search does not).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, ProjectExplorer, Reason } from '../types.js';
import { PRUNE, runProbe } from '../search.js';

function pruneArgs(): string[] {
  return PRUNE.map((d) => `--exclude-dir=${d}`);
}
/**
 * THE TERM IS OFTEN A SUFFIX, NOT THE WHOLE NAME.
 *
 * "where is the time bonus calculated" yields the term `TimeBonus`, but the method is
 * `GetTimeBonus()`. `\bTimeBonus` cannot match it: both `t` and `T` are word characters, so there is
 * no word boundary inside `GetTimeBonus`, and the declaration is unreachable no matter how many
 * probes run. Measured on the real repository: explore found the CALL SITE of the time bonus and
 * never its definition — one hop short of the defect, which lived in the method body.
 *
 * Code names things with accessor and verb prefixes. Allowing that set (and the `_private`
 * convention already handled) is what makes a suffix term find its declaration.
 */
const PREFIX = '(?:_|get|set|on|handle|try|compute|calculate|apply|update|add|remove|is|has|do|make|build|create|fetch|read|write|find|resolve|Get|Set|On|Handle|Try|Compute|Calculate|Apply|Update|Add|Remove|Is|Has|Do|Make|Build|Create|Fetch|Read|Write|Find|Resolve)?';

const SRC = ['--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.mjs'];

export const typescript: ProjectExplorer = {
  id: 'typescript',

  matches(root) {
    return existsSync(join(root, 'package.json')) &&
      (existsSync(join(root, 'tsconfig.json')) || existsSync(join(root, 'src')));
  },

  sourceIncludes: ['*.ts', '*.tsx', '*.js', '*.mjs'],

  plan(term) {
    const base = ['grep', '-rnI', ...pruneArgs(), ...SRC];
    return [
      {
        strategy: 'definition',
        reason: 'defines' as Reason,
        argv: [...base, '-E', `(export\\s+)?(async\\s+)?(function|class|interface|type|enum|const|let)\\s+${PREFIX}${term}\\b|\\b${PREFIX}${term}\\s*\\(`, '.'],
      },
      // Where it is imported FROM — the import graph edge, which is the one thing TS gives for free.
      {
        strategy: 'imports',
        reason: 'mentions' as Reason,
        argv: [...base, '-E', `import.*\\b${term}\\b|from\\s+['"][^'"]*${term}`, '.'],
      },
      // `-w` would MISS the `_privateField` convention: underscore is a word character, so
      // `grep -w scoreMultiplier` does not match `_scoreMultiplier`. That convention is ubiquitous in
      // C# and common in TypeScript, and missing it means missing the field the question is about.
      { strategy: 'mentions', reason: 'mentions' as Reason, argv: [...base, '-E', `\\b_?${term}\\b`, '.'] },
      // THE STRING KEY. `"chat:send"` in one file, handled in another, no shared symbol. This probe
      // is the TypeScript counterpart of Unity's GUID search.
      {
        strategy: 'string-key',
        reason: 'string-key' as Reason,
        argv: [...base, '-E', `['"\`][^'"\`]*${term}[^'"\`]*['"\`]`, '.'],
      },
      // Membership in a list is what makes a thing reachable at runtime.
      {
        strategy: 'registry',
        reason: 'registered' as Reason,
        argv: ['grep', '-rnI', ...pruneArgs(), ...SRC, '-E', `\\b${term}\\b`, '--include=*registry*', '--include=*index*', '.'],
      },
      {
        strategy: 'spec',
        reason: 'spec' as Reason,
        argv: [...base, '-E', `(describe|it|test|expect|assert).*${term}`, '.'],
      },
      { strategy: 'filename', reason: 'filename' as Reason, argv: ['find', '.', '-name', `*${term}*.ts`, '-not', '-path', './node_modules/*', '-not', '-path', './.git/*', '-not', '-path', './dist/*'] },
    ];
  },

  /**
   * Resolve the string→file bindings TypeScript hides: a prompt id is a filename, and a key that
   * appears in exactly two files is a dispatch pair worth naming.
   */
  async glue(findings, root) {
    const out: Finding[] = [];
    const literals = new Set<string>();
    for (const f of findings) {
      for (const m of f.span.text.matchAll(/['"`]([a-z][a-zA-Z0-9._:-]{2,40})['"`]/g)) literals.add(m[1]);
    }
    // A prompt id is a string key that names a FILE — resolve it, exactly like a Unity guid.
    for (const lit of [...literals].slice(0, 12)) {
      if (/[:.]/.test(lit)) continue;
      const r = await runProbe(['find', '.', '-name', `${lit}.txt`, '-not', '-path', './node_modules/*'], root);
      for (const p of r.lines.slice(0, 2)) {
        out.push({
          span: { file: p.replace(/^\.\//, ''), fromLine: 1, toLine: 1, text: '' },
          reason: 'string-key',
          detail: `"${lit}" names the file ${p.replace(/^\.\//, '')}`,
          score: 0.7,
        });
      }
    }
    // A key carrying a namespace separator is dispatch. Report every file it appears in — that set
    // IS the coupling, and no import connects them.
    for (const lit of [...literals].filter((l) => l.includes(':')).slice(0, 6)) {
      const r = await runProbe(['grep', '-rlI', ...pruneArgs(), ...SRC, '-F', lit, '.'], root);
      if (r.lines.length >= 2) {
        out.push({
          span: { file: r.lines[0].replace(/^\.\//, ''), fromLine: 1, toLine: 1, text: '' },
          reason: 'string-key',
          detail: `"${lit}" appears in ${r.lines.length} files with no import between them: ${r.lines.slice(0, 4).map((s) => s.replace(/^\.\//, '')).join(', ')}`,
          score: 0.8,
        });
      }
    }
    return out;
  },

  /**
   * The enclosing FUNCTION — not merely the nearest declaration.
   *
   * Walking back to any `const`/`let` returned local variables as symbols (`full`, `s`, `c` on real
   * output): each was a true fact about the line above, and each read as if the tool had identified
   * the containing routine when it had not. A symbol it cannot determine is reported as none.
   */
  symbolAt(lines, line) {
    const FN = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/;
    const ARROW = /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*[:=][^=]*?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/;
    const METH = /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*\([^)]*\)\s*[:{]/;
    const TYPE = /^(?:export\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)/;
    const KEYWORD = /^(if|for|while|switch|catch|return|do|else|try|new|typeof|await)$/;
    for (let i = Math.min(line, lines.length); i > 0 && line - i < 120; i--) {
      const t = lines[i - 1] ?? '';
      const a = FN.exec(t); if (a) return `${a[1]}()`;
      const r = ARROW.exec(t); if (r) return `${r[1]}()`;
      const b = METH.exec(t); if (b && !KEYWORD.test(b[1])) return `${b[1]}()`;
      const c = TYPE.exec(t); if (c) return c[1];
    }
    return undefined;
  },
};
