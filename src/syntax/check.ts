/**
 * syntax/check.ts — "did this edit break the file", answered by a real parser, before anything lands.
 *
 * THE FAILURE. `str_replace` inserted a stray `{` into a C# file, echoed a clean diff, and reported
 * *"read back from disk, byte-identical to what was written"* — which was true, and useless. There was
 * no syntax check anywhere in the write path, so the only thing that surfaced the damage was the
 * "edited since you last read it" diff on a later read, and the only recovery was `undo_edit`. In a
 * Unity project one broken `.cs` fails the whole assembly, so the cost is not one file.
 *
 * NOT A COMPILER, AND DELIBERATELY NOT. Compiling answers "is this program valid", which needs the
 * project, its references and — on this machine — a Unity licence that batch mode cannot get. The
 * question actually worth asking is much smaller: "is this file still well-formed". tree-sitter
 * answers it in single-digit milliseconds, offline, with a real grammar per language rather than a
 * brace-counting heuristic.
 *
 * DIFFERENTIAL, WHICH IS THE WHOLE REASON IT CAN BE A HARD GATE. tree-sitter is error-TOLERANT: it
 * reports ERROR nodes in plenty of files nobody is about to touch, and a gate keyed on "does it parse"
 * would refuse edits to files that were already like that — a wall the model cannot get past by doing
 * anything right, which burns the budget that would have fixed something real. So the count is taken
 * BEFORE and AFTER and only an INCREASE refuses. A file that was already unparseable stays editable;
 * an edit that makes it worse does not land.
 *
 * NOTHING IS WRITTEN. Every caller runs this before its `writeFileSync`, so a refusal leaves the file
 * on disk untouched — there is no half-applied edit to undo and no mess to clean up, which is the
 * point: the model reads what broke and sends the edit again.
 *
 * ABSENT IS NOT FAILED — the rule `buildcheck.ts` states and this obeys. No grammar for the extension,
 * a missing `.wasm`, a parser that will not initialise: all of those are "not checked", never a
 * refusal. A gate that fires because the machine is odd teaches the model to route around the gate.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../log.js';

/**
 * Extension → grammar, mirroring what `SurfaceLanguage.handles` already claims so the two agree about
 * which files ayin believes it understands.
 *
 * ONE GRAMMAR FOR THE WHOLE JS/TS FAMILY: `tsx` is TypeScript plus JSX, and plain TypeScript and
 * JavaScript are subsets of it, so it parses all eight extensions and saves shipping three more
 * megabytes of grammar that would answer the same question. `cpp` covers `.h` for the same reason.
 */
const GRAMMARS: Array<{ test: RegExp; wasm: string }> = [
  { test: /\.cs$/i, wasm: 'tree-sitter-c_sharp.wasm' },
  { test: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, wasm: 'tree-sitter-tsx.wasm' },
  { test: /\.dart$/i, wasm: 'tree-sitter-dart.wasm' },
  { test: /\.pyw?$/i, wasm: 'tree-sitter-python.wasm' },
  { test: /\.go$/i, wasm: 'tree-sitter-go.wasm' },
  { test: /\.rs$/i, wasm: 'tree-sitter-rust.wasm' },
  { test: /\.rb$/i, wasm: 'tree-sitter-ruby.wasm' },
  { test: /\.java$/i, wasm: 'tree-sitter-java.wasm' },
  { test: /\.(cpp|cc|cxx|c\+\+|h|hpp|hh|hxx|h\+\+|c)$/i, wasm: 'tree-sitter-cpp.wasm' },
];

/** Where the vendored grammars live, resolved from THIS build rather than assumed to be on a path. */
function grammarDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'grammars');
}

/**
 * Past this, the parse stops being free. A source file this size is generated or vendored, and either
 * way is not what an edit gate is protecting.
 */
const MAX_BYTES = 2 * 1024 * 1024;

/** Error positions worth printing. More than this and the file is rubble, not a typo. */
const SHOWN = 3;

interface Loaded { parser: unknown; }
type TSParser = {
  setLanguage(l: unknown): void;
  parse(src: string): { rootNode: TSNode } | null;
};
type TSNode = {
  type: string; isMissing: boolean; childCount: number;
  child(i: number): TSNode | null;
  startPosition: { row: number; column: number };
};

let initPromise: Promise<boolean> | null = null;
let TS: { Parser: { init(): Promise<void>; new (): TSParser }; Language: { load(b: Uint8Array): Promise<unknown> } } | null = null;
const parsers = new Map<string, TSParser | null>();

/**
 * Bring the runtime up once, and never throw out of it.
 *
 * Lazy rather than wired into boot: the first source edit of a session pays ~50ms and every session
 * that edits nothing pays nothing. `web-tree-sitter` is WASM, so there is no native build and no
 * install step to go wrong — but a version skew between runtime and grammar shows up here as an
 * opaque failure, and the honest report of that is "not checked".
 */
async function runtime(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const m = await import('web-tree-sitter');
      TS = m as unknown as typeof TS;
      await TS!.Parser.init();
      return true;
    } catch (e) {
      log('WARN', 'syntax_runtime_unavailable', { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  })();
  return initPromise;
}

/** The parser for this path, or null when nothing here claims it. Grammars load once, on first use. */
async function parserFor(path: string): Promise<TSParser | null> {
  const hit = GRAMMARS.find((g) => g.test.test(path));
  if (!hit) return null;
  if (parsers.has(hit.wasm)) return parsers.get(hit.wasm)!;
  if (!(await runtime()) || !TS) { parsers.set(hit.wasm, null); return null; }
  try {
    const file = join(grammarDir(), hit.wasm);
    if (!existsSync(file)) throw new Error(`grammar not shipped: ${hit.wasm}`);
    const parser = new TS.Parser();
    parser.setLanguage(await TS.Language.load(new Uint8Array(readFileSync(file))));
    parsers.set(hit.wasm, parser);
    return parser;
  } catch (e) {
    log('WARN', 'syntax_grammar_unavailable', { wasm: hit.wasm, error: e instanceof Error ? e.message : String(e) });
    parsers.set(hit.wasm, null);
    return null;
  }
}

interface Spot { row: number; column: number; missing: boolean }

/** Every ERROR and MISSING node, in source order. The count is the measure; the first few are the report. */
function faults(root: TSNode): Spot[] {
  const out: Spot[] = [];
  const walk = (n: TSNode): void => {
    if (n.type === 'ERROR' || n.isMissing) out.push({ ...n.startPosition, missing: n.isMissing });
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(root);
  return out;
}

function parseFaults(parser: TSParser, source: string): Spot[] | null {
  try {
    const tree = parser.parse(source);
    return tree ? faults(tree.rootNode) : null;
  } catch {
    return null; // a parser that threw has not made a judgement about this file
  }
}

/**
 * The gate. A refusal string to hand straight back, or null to let the write proceed.
 *
 * A string rather than a throw, matching every other check on this path: ayin's tools report their own
 * errors as text the model reads, and an exception would surface as a transport failure instead of an
 * instruction it can act on.
 */
export async function syntaxBroken(path: string, before: string, after: string): Promise<string | null> {
  if (after.length > MAX_BYTES) return null;
  const parser = await parserFor(path);
  if (!parser) return null;

  const now = parseFaults(parser, after);
  if (!now || now.length === 0) return null;
  const was = parseFaults(parser, before);
  if (!was) return null;
  if (now.length <= was.length) return null; // no worse than it already was — not this edit's doing

  const lines = after.split('\n');
  const shown = now.slice(0, SHOWN).map((s) => {
    const text = (lines[s.row] ?? '').replace(/\t/g, '  ');
    return `  line ${s.row + 1}, column ${s.column + 1} — ${s.missing ? 'something is missing here' : 'the parser cannot read this'}\n`
      + `    ${s.row + 1} | ${text.slice(0, 160)}`;
  }).join('\n');

  return `Refused: this edit would leave ${path} with ${now.length - was.length} new syntax `
    + `error(s)${was.length ? ` (it had ${was.length} before, it would have ${now.length})` : ''}.\n\n${shown}\n\n`
    + `NOTHING WAS WRITTEN — the file on disk is exactly as it was, so there is no half-applied edit to `
    + `undo. Re-read the region if you need to, fix the edit, and send it again.\n`
    + `This is a PARSE of the file as it would be after your change, not a compile — it says the text `
    + `stopped being well-formed, not that the program is wrong.`;
}

/** For the gate: forget the loaded parsers, so a case can assert the absent-is-not-failed path. */
export function _resetSyntax(): void {
  parsers.clear();
  initPromise = null;
  TS = null;
}
