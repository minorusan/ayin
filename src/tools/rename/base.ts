/**
 * rename/base.ts — everything a rename needs that is NOT language-specific, and the contract for what is.
 *
 * WHY A TOOL AT ALL, WHEN `str_replace` EXISTS. A rename is not an edit, it is N edits that must all land
 * or none should: the declaration, every reference, and — in some languages — the FILE NAME and a
 * serialization annotation. An agent doing that with `str_replace` renames what it can see, misses the
 * call in a file it never opened, and leaves a tree that does not compile. Doing it by `sed` is worse: it
 * matches inside `FooBar`, inside strings, and inside comments.
 *
 * WHAT THIS IS NOT. There is no compiler here and no language server. Scope resolution — "is this `count`
 * the same `count`?" — is genuinely undecidable with a scanner, so this tool is honest about its unit:
 * **a word-bounded identifier, in code, in the files it was pointed at.** That is exactly right for the
 * names people actually rename (a class, a method, a serialized field, an exported function) and wrong
 * for a local variable in one function of a file that uses that name for three different things. The
 * report says how many occurrences in how many files, so the operator can see whether the number is the
 * number they expected — which is the check a language server would have done for them.
 *
 * THREE RULES THE SCANNER MUST GET RIGHT, because each one is a way to corrupt a repo silently:
 *
 *   1. WORD BOUNDARIES. Renaming `Foo` must not touch `FooBar`, `MyFoo` or `foo_bar`. A substring rename
 *      compiles about half the time, which is worse than not compiling.
 *   2. STRINGS AND COMMENTS ARE NOT CODE — but they are not nothing either. They are left alone AND
 *      REPORTED, because a name in a string is often a registry key, a reflection lookup or a serialized
 *      field name, and that is precisely the reference a rename breaks with no compiler error anywhere.
 *   3. AN EDIT IS ALL-OR-NOTHING PER FILE. Every occurrence in a file is applied in one write, so a crash
 *      mid-run leaves whole files, never half-renamed ones.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** One occurrence of the identifier, located precisely enough to edit and to report. */
export interface Occurrence {
  /** 0-based offset in the file. */
  at: number;
  /** 1-based line, for the report. */
  line: number;
  /** The line's text, for the report. */
  text: string;
  /** `code` is renamed; `string` and `comment` are reported and left alone. */
  where: 'code' | 'string' | 'comment';
}

export interface RenameWarning {
  /** What the operator has to decide or check by hand. */
  message: string;
  /** Where, when there is a where. */
  path?: string;
}

export interface FileEdit {
  path: string;
  /** How many code occurrences were rewritten in this file. */
  count: number;
  /** The lines, before → after, for the report. */
  lines: Array<{ line: number; before: string; after: string }>;
}

export interface RenamePlan {
  language: string;
  symbol: string;
  to: string;
  edits: FileEdit[];
  /** Occurrences deliberately NOT touched: strings, comments, and anything the language refused. */
  skipped: Array<{ path: string; line: number; text: string; where: 'string' | 'comment' }>;
  /** File renames the language considers mandatory (Unity binds a MonoBehaviour to its file name). */
  fileRenames: Array<{ from: string; to: string }>;
  warnings: RenameWarning[];
}

/** A language's answers. Subclasses override only what differs; the scanning lives here. */
export abstract class RenameLanguage {
  abstract readonly id: string;

  /** By extension, like every other language split in this repo. */
  abstract handles(path: string): boolean;

  /**
   * A valid identifier in this language — checked on the NEW name before anything is written.
   *
   * Refusing early is the difference between "no" and a tree full of syntax errors: `class 2fast` is not
   * a rename that half-worked, it is a repo that does not parse.
   */
  abstract validIdentifier(name: string): boolean;

  /** Language keywords that must never be a new name. `class int` is not a rename either. */
  abstract isReserved(name: string): boolean;

  /**
   * What is being renamed, as far as this file can tell: `class`, `method`, `field`, `function`, … or
   * null when the symbol is only referenced here. Drives the warnings, never the edit.
   */
  abstract declarationKind(source: string, symbol: string): string | null;

  /**
   * A rewrite the LANGUAGE must do before the generic one, on the original source.
   *
   * Exists for TS object shorthand: `{ Foo }` is a key AND a value, so it is expanded to `{ Foo: Foo }`
   * here and the generic pass then renames only the value half. Doing it afterwards is impossible — by
   * then the shorthand reads `{ To }` and the original key is gone. Identity by default.
   */
  beforeRewrite(source: string, _symbol: string, _to: string): string {
    return source;
  }

  /**
   * The other half of `beforeRewrite`: undo whatever placeholder it used, after the generic pass.
   *
   * Needed because the generic pass cannot be told "not this one". TS expands `{ Foo }` to a marked KEY so
   * the rename cannot touch it, then restores the key here — the alternative was teaching the scanner
   * about object-literal context, which is the same as writing a parser. Identity by default.
   */
  afterRewrite(source: string, _symbol: string, _to: string): string {
    return source;
  }

  /**
   * Language-specific consequences of the rename in ONE file: a mandatory file rename, a serialization
   * annotation, a caveat the operator must check.
   *
   * TAKES BOTH TEXTS, and that is the whole subtlety: DETECTION has to read the ORIGINAL (after the
   * rewrite there is no `class Foo` left to recognise, which is exactly the bug this signature fixes —
   * the Unity file rename silently never fired), while any EDIT it returns must be built on the REWRITTEN
   * text, or it would undo the rename it is annotating.
   */
  abstract consequences(path: string, before: string, after: string, symbol: string, to: string): {
    /** A rewritten source, when the language must also EDIT something (e.g. add an attribute). */
    source?: string;
    fileRenames?: Array<{ from: string; to: string }>;
    warnings?: RenameWarning[];
  };

  /**
   * Where the strings and comments are. Overridden per language for the forms that differ — C# verbatim
   * strings, TS template literals — and correct for the common case here.
   *
   * Returns spans as [start, end) offsets with their kind. Deliberately a scanner rather than a regex:
   * a regex cannot know that the `"` it just matched is inside a comment.
   */
  protected spans(source: string): Array<{ from: number; to: number; kind: 'string' | 'comment' }> {
    const out: Array<{ from: number; to: number; kind: 'string' | 'comment' }> = [];
    let i = 0;
    while (i < source.length) {
      const c = source[i];
      const next = source[i + 1];
      if (c === '/' && next === '/') {
        const end = source.indexOf('\n', i);
        out.push({ from: i, to: end < 0 ? source.length : end, kind: 'comment' });
        i = end < 0 ? source.length : end;
        continue;
      }
      if (c === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        out.push({ from: i, to: end < 0 ? source.length : end + 2, kind: 'comment' });
        i = end < 0 ? source.length : end + 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        const from = i;
        i++;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === c) { i++; break; }
          // A newline ends a single-quoted or double-quoted literal in every language here; only a
          // backtick (or a verbatim string, which the C# subclass handles) spans lines.
          if (source[i] === '\n' && c !== '`') break;
          i++;
        }
        out.push({ from, to: i, kind: 'string' });
        continue;
      }
      i++;
    }
    return out;
  }

  /** Word-bounded occurrences of `symbol`, each labelled code / string / comment. */
  occurrences(source: string, symbol: string): Occurrence[] {
    const spans = this.spans(source);
    const kindAt = (at: number): 'code' | 'string' | 'comment' => {
      for (const s of spans) if (at >= s.from && at < s.to) return s.kind;
      return 'code';
    };
    // Line starts, computed once: a per-occurrence `split('\n')` on a 5000-line file is how a rename of a
    // common name turns into minutes.
    const lineStarts: number[] = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
    const lineOf = (at: number): number => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= at) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    const lineText = (n: number): string => {
      const from = lineStarts[n - 1];
      const to = n < lineStarts.length ? lineStarts[n] - 1 : source.length;
      return source.slice(from, to);
    };

    const out: Occurrence[] = [];
    const re = new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(symbol)}(?![A-Za-z0-9_$])`, 'g');
    for (let m = re.exec(source); m; m = re.exec(source)) {
      const line = lineOf(m.index);
      out.push({ at: m.index, line, text: lineText(line), where: kindAt(m.index) });
    }
    return out;
  }

  /**
   * Rewrite one file's code occurrences. Returns null when nothing in it is code.
   *
   * Offsets are applied BACK TO FRONT so earlier edits cannot shift later ones — the classic way a
   * multi-occurrence rewrite corrupts a line.
   */
  rewrite(source: string, symbol: string, to: string): { source: string; edit: FileEdit | null; skipped: Occurrence[] } {
    const occ = this.occurrences(source, symbol);
    const code = occ.filter((o) => o.where === 'code');
    const skipped = occ.filter((o) => o.where !== 'code');
    if (!code.length) return { source, edit: null, skipped };
    let out = source;
    for (const o of [...code].reverse()) {
      out = out.slice(0, o.at) + to + out.slice(o.at + symbol.length);
    }
    const byLine = new Map<number, string>();
    for (const o of code) byLine.set(o.line, o.text);
    const afterLines = out.split('\n');
    return {
      source: out,
      edit: {
        path: '',
        count: code.length,
        lines: [...byLine.entries()].map(([line, before]) => ({ line, before, after: afterLines[line - 1] ?? '' })),
      },
      skipped,
    };
  }

  /** Read → rewrite → write, one file, one write. */
  applyToFile(path: string, symbol: string, to: string, dryRun: boolean): { edit: FileEdit | null; skipped: Occurrence[]; source: string } {
    const before = readFileSync(path, 'utf-8');
    const r = this.rewrite(before, symbol, to);
    if (r.edit) r.edit.path = path;
    if (r.edit && !dryRun) writeFileSync(path, r.source, 'utf-8');
    return { edit: r.edit, skipped: r.skipped, source: r.source };
  }
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
