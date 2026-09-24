/**
 * The source finder — who names the types this file declares, in any of the nine languages.
 *
 * MULTILINGUAL BY REUSE, NOT BY A SECOND PARSER. `languageFor()` already decides which of
 * csharp/typescript/dart/python/go/rust/ruby/java/cpp claims a path, and `surfaceOf()` already
 * returns the types it declares — that pair is what the corpus walk and entangle are built on. This
 * asks them the one extra question and greps the answers. A tenth language is one entry in that
 * list, as it already was, and this finder gains it for free rather than needing its own case.
 *
 * WHY THE TYPE NAME AND NOT THE FILE NAME. A file is referenced through the identifiers it declares,
 * and in most of these languages the file name is not one of them — `utils.ts` exports `formatDate`,
 * and nobody writes `utils`. Asking the language what the file DECLARES is the only portable way to
 * know what to search for.
 *
 * IT IS A TEXT SEARCH AND SAYS SO. No language here resolves imports or overload sets, so a hit is a
 * mention of a name, not a proven binding: a comment counts, a different class with the same short
 * name counts. That is why `how` reports the syntactic shape it saw — `new`, `extends`, `import`,
 * `: type` — and why `describe()` names the identifiers searched. An honest maybe beats a confident
 * list, and the alternative to a text search is a compiler this harness does not have.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { languageFor } from '../../entangle/index.js';
import type { Finder, ReferenceHit } from '../hooks/types.js';

const TIMEOUT_MS = 25_000;
const MAX_BUFFER = 24 * 1024 * 1024;
/** Generated and vendored trees answer "who references this" with noise, at enormous length. */
const SKIP = ['.git', 'node_modules', 'dist', 'build', 'out', 'Library', 'Temp', 'obj', 'bin', '.venv', '__pycache__', 'vendor', 'coverage'];

/** An identifier short enough to collide with an English word is a search nobody can read. */
const MIN_NAME = 4;

/**
 * Every extension any of the nine languages might claim. Not a routing table — the LANGUAGE decides,
 * by being asked `handles()` about each one; this is only the candidate set to ask about.
 */
const CANDIDATE_EXTS = [
  '.cs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.dart', '.py', '.go', '.rs', '.rb',
  '.java', '.kt', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hh',
];

/**
 * WHICH FILES CAN EVEN CONTAIN A REFERENCE — asked of the language, never assumed.
 *
 * Searching the whole tree for a C# type name means grepping every `.bundle`, every `.png` and every
 * serialized asset in the repository. Measured here: the grep hit its 25-second timeout and was
 * killed, and a killed search returns no output, which reads exactly like "nothing references this".
 * A silent wrong answer, from a tool whose entire job is to be trusted before a delete.
 *
 * The language already answers this: `handles()` is by extension, so asking it about each candidate
 * gives the include set for free and a tenth language brings its own.
 */
function extensionsFor(path: string): string[] {
  const lang = languageFor(path);
  if (!lang) return [];
  const own = extname(path).toLowerCase();
  const found = CANDIDATE_EXTS.filter((e) => {
    try { return lang.handles(`probe${e}`); } catch { return false; }
  });
  return found.length ? found : [own];
}

/**
 * A stem worth searching for LOOKS LIKE A SYMBOL, not like a word.
 *
 * The fallback below guesses the file's own name when the parser found no declaration, and for
 * `PlayerHud.cs` or `asset_index.py` that guess is exactly right. For `unity.ts` it is a disaster:
 * measured, it searched this repository for "unity" and returned prose from three gate scripts, all
 * of it labelled as a reference. A stem is only a usable identifier when it carries a capital, an
 * underscore or a digit — the shapes a word does not have.
 */
function looksLikeSymbol(stem: string): boolean {
  return /[A-Z]/.test(stem) || /[_0-9]/.test(stem);
}

/** The types this file declares, which is what anybody referencing it has to name. */
export function declaredNames(path: string): string[] {
  const lang = languageFor(path);
  if (!lang) return [];
  let source: string;
  try { source = readFileSync(path, 'utf8'); } catch { return []; }
  let names: string[] = [];
  try { names = lang.surfaceOf(source).map((t) => t.name).filter(Boolean); } catch { return []; }
  // The file's own stem when it declares nothing a parser could see — for a language where that IS
  // the convention (a Python module, a Go file of free functions) it is the best available guess,
  // and better than refusing to answer. Only when it reads as a symbol; see `looksLikeSymbol`.
  if (names.length === 0) {
    const stem = basename(path, extname(path));
    names = looksLikeSymbol(stem) ? [stem] : [];
  }
  return [...new Set(names)].filter((n) => n.length >= MIN_NAME);
}

/** True when the names came from the FILE NAME rather than from a parsed declaration. */
export function guessedFromFilename(path: string): boolean {
  const lang = languageFor(path);
  if (!lang) return false;
  try {
    return lang.surfaceOf(readFileSync(path, 'utf8')).filter((d) => d.name).length === 0;
  } catch {
    return false;
  }
}

/** What the line looks like it is doing with the name. Syntactic, and labelled as such by the caller. */
function shapeOf(line: string, name: string): string {
  if (new RegExp(`\\b(import|from|using|require|include)\\b[^\\n]*\\b${name}\\b`).test(line)) return 'import';
  if (new RegExp(`\\b(extends|implements|:\\s*)${name}\\b`).test(line)) return 'extends/implements';
  if (new RegExp(`\\bnew\\s+${name}\\b`).test(line)) return 'construction';
  if (new RegExp(`\\b${name}\\s*\\(`).test(line)) return 'call';
  if (new RegExp(`^\\s*(//|#|\\*|/\\*)`).test(line)) return 'comment';
  return 'mention';
}

function sh(repoPath: string, args: string[]): string {
  try {
    return execFileSync('grep', args, {
      cwd: repoPath, encoding: 'utf-8', timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

export const codeFinder: Finder = {
  id: 'code',

  /** Every repo has source in it; the per-target check is the one that matters. */
  applies(): boolean {
    return true;
  },

  handles(target: string, repoPath: string): boolean {
    const abs = target.startsWith('/') ? target : join(repoPath, target);
    return existsSync(abs) && languageFor(abs) !== null && declaredNames(abs).length > 0;
  },

  describe(target: string, repoPath: string): string {
    const abs = target.startsWith('/') ? target : join(repoPath, target);
    const names = declaredNames(abs);
    const lang = languageFor(abs);
    if (names.length === 0) {
      return `${lang?.id ?? 'source'}: this file declares no type a parser here can see, and its name is `
        + 'not distinctive enough to search for — grep for the exact symbol you mean';
    }
    const guessed = guessedFromFilename(abs)
      ? ' — GUESSED FROM THE FILE NAME, because no declaration was parsed'
      : '';
    return `${lang?.id ?? 'source'}: searched for ${names.map((n) => `"${n}"`).join(', ')} as TEXT`
      + `${guessed} — a mention, not a proven binding`;
  },

  find(target: string, repoPath: string, limit: number): ReferenceHit[] {
    const abs = target.startsWith('/') ? target : join(repoPath, target);
    const names = declaredNames(abs);
    if (names.length === 0) return [];

    // `-I` as well as the include list: a file with a source extension can still be generated binary,
    // and grep reading one is the same stall in miniature.
    const args = [
      '-rnwI', '-E',
      ...extensionsFor(abs).map((e) => `--include=*${e}`),
      ...SKIP.map((d) => `--exclude-dir=${d}`),
      names.join('|'), '.',
    ];
    const raw = sh(repoPath, args);
    const hits: ReferenceHit[] = [];
    for (const row of raw.split('\n')) {
      // THE `./` IS OPTIONAL, and assuming it cost this finder every hit it had. GNU grep prints
      // `./Assets/x.cs:9:…` when told to search `.`; BSD grep — which is what macOS ships — prints
      // `Assets/x.cs:9:…`. A parser anchored on the prefix matched nothing on a Mac and returned an
      // empty list, which reads exactly like "nothing references this".
      const m = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(row);
      if (!m) continue;
      const [, file, line, text] = m;
      // THE DECLARING FILE IS NOT A REFERENCE TO ITSELF. It is where the answer came from.
      if (join(repoPath, file) === abs) continue;
      const named = names.find((n) => new RegExp(`\\b${n}\\b`).test(text)) ?? names[0];
      hits.push({ path: file, line: Number(line), how: shapeOf(text, named) });
      if (hits.length >= limit) break;
    }
    return hits;
  },
};
