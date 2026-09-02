/**
 * `naamah` — the ONE door to a design, and it writes TypeScript or C#, never PlantUML.
 *
 * WHY THIS REPLACED THE `naama` LINE GRAMMAR. This tool used to author a `.puml` one fact per line,
 * and that is what the model kept reaching for even after the system prompt was rewritten to ask for
 * a TypeScript sketch — measured twice: the pre-prompt said "write .ts sketch files", the tool
 * description said "the design file (.puml)", and the model followed the TOOL. A callable tool beats
 * prose in a prefix every time, so the format cannot be changed by persuasion; the door has to move.
 *
 * `op: sketch` WRITES AND VALIDATES IN ONE CALL. That pairing is the point. A sketch is only worth
 * anything once a compiler has agreed it holds together, and a model that has to remember a second
 * step will skip it — so the compile result comes back in the same tool result, and a dangling
 * relation is reported as an error on the write that caused it rather than discovered later.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Tool } from '../base.js';
import { entangle, entangledTo, gateAdoption, nextBrief } from '../../entangle/index.js';

/** Where naamah lives, resolved from this build rather than assumed to be on PATH. */
function naamahBin(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'naamah', 'bin', 'naamah.mjs');
}

/** Run a naamah subcommand and hand back what it said, exit code included. */
async function naamah(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [naamahBin(), ...args], { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/**
 * The design language a filename implies. `.js` is TypeScript here — a design is `declare class X { … }`
 * whatever it is called, and naamah typechecks a `.js` design through a `.ts` shadow. The extension
 * exists so a browser project's design can match the extension of the code it describes.
 */
const LANG_OF = (f: string) => (/\.cs$/i.test(f) ? 'cs' : 'ts');

/**
 * The vocabulary occupies the design's own global scope, so a type named after a decorator collides.
 *
 * TypeScript-only: a TS decorator is a plain function called `Owns`, while a C# attribute is a class
 * called `OwnsAttribute`, so `[Owns(...)]` leaves the bare name free. The failure is not silent — the
 * compiler says TS2813 / TS2814 — but it says it about the PRELUDE, several files from the sketch that
 * caused it, and nothing in the message mentions a name clash. Caught here instead, by name.
 *
 * `Note` was renamed to `Remark` rather than left on this list: a design having a type called Note is
 * likely enough that refusing it would be refusing the design, not protecting it.
 */
const RESERVED = new Set([
  'Domain', 'Stereotype', 'Remark', 'Kind', 'Must',
  'Owns', 'Has', 'Uses', 'Refers', 'Extends', 'Implements',
  'OwnedBy', 'HeldBy', 'UsedBy', 'ReferredBy', 'ExtendedBy', 'ImplementedBy',
]);

/** Type names a sketch declares, so a collision can be named before the compiler garbles it. */
function declaredNames(src: string): string[] {
  return [...src.matchAll(/\b(?:declare\s+)?(?:abstract\s+)?(?:class|interface|enum|struct)\s+([A-Za-z_$][\w$]*)/g)]
    .map((m) => m[1]);
}


/**
 * Translate the compiler's least helpful diagnostics into the format rule behind them.
 *
 * TS2391 ("Function implementation is missing") is what a plain `class` with a bodyless method
 * produces, and nothing in that sentence says the fix is `declare class`. A sketch is DECLARATIONS,
 * so this is the single most likely mistake in the format and the one the compiler explains worst.
 */
function hint(out: string): string {
  const tail = 'The design does NOT compile. Fix it before writing any implementation.';
  /**
   * A CHECKER THAT NEVER RAN IS NOT A FAILED CHECK — and this one cost a whole turn.
   *
   * ayin resolves naamah from its OWN build rather than PATH, so a stale vendored copy answers
   * `unknown command "build"` and prints its help. That output then arrived wrapped in *"the design
   * does NOT compile"*, which is a claim about the design and was false. Measured: the model read it,
   * concluded "this environment's naamah does not support build", and finished the turn having
   * written no implementation at all — the design gate stopped the work it exists to unblock.
   *
   * So a CLI-level refusal says what is actually wrong and what to do about it. Same rule as
   * `buildcheck.ts`: absent is not failed.
   */
  if (/unknown command|ENOENT|not found/i.test(out)) {
    return 'naamah itself refused that command — the copy ayin ships is too old for it, or missing. '
      + 'This is a TOOLCHAIN fault, not a fault in your design: do not rewrite the design to work '
      + 'around it. Report it and carry on with the implementation ungated.';
  }
  if (/TS2391|TS2813|TS2814/.test(out)) {
    return 'A member with no body is only legal in an ambient declaration: write `declare class X { … }` '
      + '(or `interface X`), not a plain `class`. That is what a sketch is — the shape exists here, the '
      + 'implementation lives in the real source.\n' + tail;
  }
  if (/TS2304/.test(out)) {
    return 'A relation or a base names a type this design does not declare. Add that type as its own '
      + 'sketch file, or fix the name.\n' + tail;
  }
  return tail;
}


export const tool: Tool = {
  name: 'naamah',
  icon: '🌸',
  description:
    'Sketch the SOLUTION\'S INTERFACE before implementing it, as plain TypeScript or C#, and have a real '
    + 'compiler check it. This is the only design door — never author a .puml, and never hand-write the '
    + 'vocabulary file. '
    + 'ops: sketch (write one design file AND compile the design) · build (compile it) · show (read it back). '
    + 'A design is a DIRECTORY, one file per type, no bodies — signatures plus a comment above each member '
    + 'saying what it MUST DO. Relations are decorators/attributes and may be declared at EITHER end:\n'
    + '  TypeScript                C#\n'
    + '  @Domain(\'Core\')           [Domain("Core")]            which domain owns it\n'
    + '  @Owns<Entry>()            [Owns(typeof(Entry))]       composition · @Has @Uses @Refers likewise\n'
    + '  @UsedBy<Svc>()            [UsedBy(typeof(Svc))]       the SAME edge, from the far end\n'
    + '  @Kind(\'struct\')           [Kind("struct")]            card kind · @Note(\'…\') a tethered note\n'
    + 'A bare field (private led: Ledger) already implies an edge. TWO HARD RULES: TypeScript design files '
    + 'have NO import and NO export and name a target in the TYPE position (@Owns<Entry>(), never '
    + '@Owns(Entry)); C# design files have NO namespace and name a target with typeof(...). Both exist '
    + 'because every design file shares one global scope — that is what lets any type name any other with '
    + 'nothing to wire up. THE DESIGN IS A DOCUMENT, NOT A MODULE: never import from the design directory in your implementation — those files have no exports, so it cannot resolve. Declare the type again in the real source.',
  parameters: [
    { name: 'dir', type: 'string', description: 'The design directory, one per task — .naamah/<task-slug>/. Created on first sketch.', required: true },
    { name: 'op', type: 'string', description: 'sketch | build | show. Default sketch.', required: false },
    { name: 'file', type: 'string', description: 'For sketch: the file to write, e.g. NoteService.ts, Game.js or NoteService.cs — match the extension of the code it describes. One type per file is the convention.', required: false },
    { name: 'content', type: 'string', description: 'For sketch: the whole file. Declarations only — no method bodies.', required: false },
    { name: 'scope', type: 'string', description: 'For build: limit enforcement to one domain, e.g. Rewards. Omit to enforce the whole design.', required: false },
  ],
  async execute(params) {
    const op = (params.op ?? 'sketch').trim().toLowerCase();
    if (!params.dir) return 'Error: dir required — the design directory for this task, e.g. .naamah/add-notes/';
    const dir = isAbsolute(params.dir) ? params.dir : resolve(process.cwd(), params.dir);

    /**
     * THE ENTANGLED DESIGN IS NOT YOURS TO EDIT. Carried over from the previous tool, and for the same
     * reason it was added there: a model stopped for naming an undeclared type answered by adding that
     * type to the design, which would have made the gate certify the drift it exists to prevent.
     */
    if (op === 'sketch' && entangledTo() && resolve(dir) === dirname(entangledTo())) {
      return 'Refused: that design is entangled, so it is the contract being enforced and not a file to '
        + 'edit. If the design and your work have diverged, that IS the gap to report — state it, give the '
        + 'options, and let the operator amend it.';
    }

    if (op === 'show') {
      const r = await naamah(['comments', dir], process.cwd());
      const t = await naamah(['build', dir, '--no-verify'], process.cwd());
      return `${t.out}\n${r.code === 0 ? r.out : ''}`.trim() || 'nothing to show yet';
    }

    /**
     * `build` IS THE HANDOFF, not just a compile.
     *
     * Sketching and implementing are two different jobs and a weak model cannot hold both in one turn
     * — measured: 29 rounds and 30 tool calls went into the design and the endpoint was never wired,
     * while the runs that skipped the design produced working code. So the two are separated by a
     * signal rather than by hope: `sketch` writes and validates one file and binds nothing, and
     * `build` means "the design is finished", which is the moment the contract can be enforced.
     *
     * Entangling here is what makes the implementation deterministic instead of remembered: from this
     * point `nextBrief()` hands over ONE type with its exact designed members, `gateWrite` refuses an
     * undesigned type or member, and the agent loop keeps going until `gateAdoption()` is empty. None
     * of that machinery is new — it simply had no door from a naamah sketch until now.
     */
    if (op === 'build') {
      const r = await naamah(['build', dir], process.cwd());
      if (r.code !== 0) return `${r.out}\n\n${hint(r.out)}`;
      // `naamah build` writes <dir>/<dirname>.html, and that page carries the graph as JSON — which is
      // exactly what entangle's loadDesign() reads. No intermediate format, no second writer.
      const page = join(dir, `${basename(dir)}.html`);
      if (!existsSync(page)) {
        return `${r.out}\n\nThe design compiles, but ${page} was not written, so it cannot be enforced. `
          + `Report this rather than implementing unguarded.`;
      }
      try {
        const e = entangle(page, params.scope ?? '');
        const remaining = gateAdoption().length;
        return `${r.out}\n\nThe design compiles and is now ENFORCED — ${e.types} designed type(s), `
          + `${e.edges} relation(s)${e.scope ? `, working in ${e.scope}` : ''}.\n`
          + `Every write is checked from here: an undesigned type, an undesigned public member, or a `
          + `reference across a forbidden boundary is refused, and you must report the gap rather than `
          + `widen the design.\n\n`
          + (remaining === 0
            ? 'Nothing remains — every designed type already exists.'
            : `${remaining} designed type(s) do not exist yet. Implement exactly this one first:\n\n${nextBrief() ?? ''}`);
      } catch (err) {
        return `${r.out}\n\nThe design compiles but could not be enforced — `
          + `${err instanceof Error ? err.message : String(err)}. Report this rather than implementing unguarded.`;
      }
    }

    // ── sketch ────────────────────────────────────────────────────────
    if (!params.file) return 'Error: file required for sketch — e.g. NoteService.ts';
    if (!params.content) return 'Error: content required for sketch — the whole file, declarations only';
    if (!/\.(ts|js|mjs|cjs|cs)$/i.test(params.file)) {
      return `Error: a design file is .ts, .js or .cs, not "${params.file}". PlantUML is not a design format here.`;
    }
    if (/^naamah\.(ts|cs)$/i.test(basename(params.file))) {
      return 'Refused: naamah.ts / Naamah.cs is the VOCABULARY and naamah writes it itself. Sketch your own types instead.';
    }

    const lang = LANG_OF(params.file);
    // The two rules the compiler reports only as a pile of confusing errors — caught here, where the
    // cause is one line away, instead of as fifteen "Cannot find name" diagnostics.
    if (lang === 'ts' && /^\s*(import|export)\b/m.test(params.content)) {
      return 'Refused: a TypeScript design file must have NO import and NO export — every design file shares '
        + 'one global scope, which is what lets any type name any other. Remove them and send it again.';
    }
    if (lang === 'cs' && /^\s*namespace\b/m.test(params.content)) {
      return 'Refused: a C# design file must have NO namespace — the design compiles into one global '
        + 'namespace so any type can name any other. Remove it and send it again.';
    }

    if (lang === 'ts') {
      const clash = declaredNames(params.content).filter((n) => RESERVED.has(n));
      if (clash.length) {
        return `Refused: ${clash.join(', ')} ${clash.length > 1 ? 'are' : 'is'} part of the design `
          + `vocabulary, and a TypeScript design shares one global scope with it — so the compiler would `
          + `report a confusing error about the vocabulary file instead of about this name. Rename the `
          + `type (a domain noun is almost always better anyway). Reserved: ${[...RESERVED].join(', ')}.`;
      }
    }

    const target = join(dir, params.file);
    try {
      mkdirSync(dirname(target), { recursive: true });
      const existed = existsSync(target);
      writeFileSync(target, params.content.endsWith('\n') ? params.content : `${params.content}\n`);
      const r = await naamah(['build', dir], process.cwd());
      const head = `${existed ? 'Updated' : 'Wrote'} ${target}`;
      // NAME THE NEXT CALL, not the next intention.
      //
      // This said "add the remaining types, then implement from it" — so the model sketched, read that
      // as permission to start coding, and never issued `op: build`. The handoff therefore never
      // happened: nothing was entangled, no brief was handed over, and the implementation was
      // unguarded and unfinished. Measured twice. A step the model has to infer is a step it skips, so
      // the success message ends with the literal call that comes next.
      return `${head}\n${r.out}\n\n${r.code === 0
        ? 'The design compiles. Sketch any remaining types the same way, then call this tool again with '
          + 'op: build and the same dir. That is what finishes the design: it enforces it and hands you '
          + 'the first type to implement. Do not write any implementation before it.'
        : hint(r.out)}`;
    } catch (err) {
      return `Error: could not write ${target} — ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
