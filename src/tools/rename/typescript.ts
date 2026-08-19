/**
 * rename/typescript.ts — TS/JS, where the compiler catches most mistakes and two forms silently do not.
 *
 * What makes TS the easy case: almost every reference to a renamed symbol is an identifier in code, and
 * anything the rename misses fails `tsc`. So the scanner plus word boundaries covers it, and the review
 * afterwards is a build.
 *
 * The two things that do NOT fail a build:
 *
 *   1. **Object shorthand.** `{ Foo }` means `{ Foo: Foo }` — a KEY and a value. Renaming both halves
 *      changes a data shape, which is how a rename becomes a wire-format bug; renaming neither leaves a
 *      reference to a symbol that no longer exists. So the shorthand is EXPANDED: `{ Foo }` → `{ Foo: to }`.
 *      The key is preserved, the value follows the symbol, and the object still has the field its readers
 *      look for.
 *   2. **A name in a string.** `tools['read_file']`, a registry key, a dynamic import path, a JSON config.
 *      Those are reported, never rewritten: this file cannot tell a registry key from a sentence.
 *
 * `import { Foo as Bar }` needs no special case, and that is worth stating so nobody adds one: `Foo` is
 * the imported name and `Bar` is the local, both are word-bounded identifiers in code, and renaming the
 * export means rewriting the left side only — which is exactly what a word-bounded scan of `Foo` does.
 */

import { basename, extname } from 'node:path';
import { RenameLanguage, type RenameWarning } from './base.js';

/** Marks a preserved object KEY through the generic rename pass. Never survives `afterRewrite`. */
const KEY_MARK = '__ayinRenameKeep_';

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'as', 'implements', 'interface', 'let', 'package', 'private', 'protected', 'public',
  'static', 'yield', 'await', 'async', 'type', 'namespace', 'declare', 'abstract', 'readonly', 'satisfies',
]);

export class TypeScriptRename extends RenameLanguage {
  readonly id = 'typescript';

  handles(path: string): boolean {
    return ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(path).toLowerCase());
  }

  validIdentifier(name: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
  }

  isReserved(name: string): boolean {
    return KEYWORDS.has(name);
  }

  declarationKind(source: string, symbol: string): string | null {
    const s = escapeForKind(symbol);
    if (new RegExp(`\\b(?:export\\s+)?(?:abstract\\s+)?class\\s+${s}\\b`).test(source)) return 'class';
    if (new RegExp(`\\b(?:export\\s+)?interface\\s+${s}\\b`).test(source)) return 'interface';
    if (new RegExp(`\\b(?:export\\s+)?type\\s+${s}\\b`).test(source)) return 'type';
    if (new RegExp(`\\b(?:export\\s+)?enum\\s+${s}\\b`).test(source)) return 'enum';
    if (new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${s}\\b`).test(source)) return 'function';
    if (new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${s}\\b`).test(source)) return 'variable';
    if (new RegExp(`^\\s*(?:public|private|protected|readonly|static|async|get|set|\\*|#)?[\\s#]*${s}\\s*[(<:=]`, 'm').test(source)) return 'member';
    return null;
  }

  /**
   * `{ Foo }` → `{ Foo: Foo }`, outside strings and comments, before the generic rename runs.
   *
   * The shorthand is a KEY and a value in one token. Letting the generic pass rewrite it produces
   * `{ To }` — a renamed key, which is a data-shape change nobody asked for and which no compiler
   * objects to. Expanded here, the generic pass renames the value half only and the object keeps the
   * field its readers look for.
   */
  override beforeRewrite(source: string, symbol: string, to: string): string {
    const shorthand = new RegExp(`([{,]\\s*)${escapeForKind(symbol)}(\\s*[,}])`, 'g');
    if (!shorthand.test(source)) return source;
    /**
     * `{ Foo }` IN AN IMPORT OR EXPORT CLAUSE IS NOT SHORTHAND — and treating it as one produced
     * `import { Widget: Gadget }`, which is not valid TypeScript at all. Measured by the gate on the first
     * run of this path. A named import binds a name; there is no key to preserve, and the generic rename
     * is exactly right for it. Clause spans are matched across newlines because a long import list is
     * routinely written one name per line.
     */
    const clauses: Array<[number, number]> = [];
    for (const m of source.matchAll(/\b(?:import|export)\b[^;{]*\{[^}]*\}/gs)) {
      clauses.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
    const inClause = (at: number): boolean => clauses.some(([a, b]) => at >= a && at < b);
    const codeLines = new Set(
      this.occurrences(source, symbol)
        .filter((o) => o.where === 'code' && !inClause(o.at))
        .map((o) => o.line),
    );
    // The key is written as `KEY_MARK + symbol`, which the word-bounded rename CANNOT match (the symbol is
    // preceded by `_`, an identifier character), so only the value half is renamed. `afterRewrite` strips
    // the mark. Expanding to a plain `Foo: Foo` does not work — the generic pass renames both halves and
    // the key follows the symbol after all, which is the bug this whole path exists to avoid.
    return source.split('\n').map((line, i) => (
      codeLines.has(i + 1)
        ? line.replace(new RegExp(`([{,]\\s*)${escapeForKind(symbol)}(\\s*[,}])`, 'g'), `$1${KEY_MARK}${symbol}: ${symbol}$2`)
        : line
    )).join('\n');
  }

  override afterRewrite(source: string, _symbol: string, _to: string): string {
    return source.split(KEY_MARK).join('');
  }

  /**
   * TS never REQUIRES a file rename — a file's name and its exports are unrelated to the compiler. It is a
   * strong convention though, so a file named after the symbol is REPORTED and never renamed silently:
   * moving it rewrites every import path that names it, which is a much larger change than was asked for.
   */
  consequences(path: string, before: string, _after: string, symbol: string, to: string): {
    source?: string;
    fileRenames?: Array<{ from: string; to: string }>;
    warnings?: RenameWarning[];
  } {
    const warnings: RenameWarning[] = [];
    const stem = basename(path, extname(path));
    if (stem === symbol) {
      warnings.push({
        path,
        message: `the file is named after the symbol (${stem}${extname(path)}). TS does not require them to match, so it was NOT renamed — renaming it rewrites every import path that names it.`,
      });
    }
    // The expansion itself happened in `beforeRewrite`; this only reports it, counted on the ORIGINAL.
    const clauseSpans: Array<[number, number]> = [];
    for (const m of before.matchAll(/\b(?:import|export)\b[^;{]*\{[^}]*\}/gs)) {
      clauseSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
    const shorthandLines = this.occurrences(before, symbol)
      .filter((o) => o.where === 'code'
        && !clauseSpans.some(([a, b]) => o.at >= a && o.at < b)
        && new RegExp(`([{,]\\s*)${escapeForKind(symbol)}(\\s*[,}])`).test(o.text))
      .map((o) => o.line);
    if (shorthandLines.length) {
      warnings.push({
        path,
        message: `object shorthand expanded to \`${symbol}: ${to}\` on ${shorthandLines.length} line(s) — the KEY is a data shape and must not follow a symbol rename. Check whether the key should change too.`,
      });
    }
    return { warnings };
  }
}

function escapeForKind(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const typescriptRename = new TypeScriptRename();
