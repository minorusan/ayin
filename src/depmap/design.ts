/**
 * The graph, written as a naamah DESIGN DIRECTORY — one file per type, no PlantUML anywhere.
 *
 * WHY NOT `toPuml`. It worked, and the route was graph → .puml → plantuml → svg → naamah page: three
 * formats and an external binary between a graph ayin already had and a page naamah was going to
 * build anyway. Each hop costs something real. PlantUML nests a package name on its dots, so
 * `PlayPerfect.GameModes.Rewards.SolitaireStreak` and `PlayPerfect.GameModes.SolitaireStreak` both
 * came out as a leaf box labelled "SolitaireStreak" — two different assemblies, one label, and the
 * .asmdef name is the whole reason the grouping is worth drawing. `naamah build` takes the design
 * directly, so the domain string arrives intact.
 *
 * `--no-verify`, and that is not laziness. A naamah design is normally typechecked so that a
 * relation naming a type which does not exist is a compile error rather than a missing arrow. Here
 * every type and every edge was READ OUT OF SOURCE THAT ALREADY COMPILES — the check has nothing to
 * add, and it would fail on C# signatures copied verbatim out of a file that is not a design.
 *
 * WHAT THE ATTRIBUTES MEAN, taken from naamah's own vocabulary rather than invented here:
 *   Domain    the assembly — an .asmdef name in Unity
 *   Remark    prose tethered to the type; used for the directory it lives in
 *   Owns      composition · Has aggregation · Uses dependency
 *   Extends   generalisation · Implements realisation — chosen by what the TARGET is
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NaamaDoc, NaamaEdge, NaamaType } from '../naama/index.js';

/** naamah writes its own vocabulary file; a project type of that name would be overwritten by it. */
const RESERVED = /^naamah$/i;

const KIND_CS: Record<string, string> = {
  class: 'public class', interface: 'public interface', struct: 'public struct',
  enum: 'public enum', abstract: 'public abstract class',
};
const KIND_TS: Record<string, string> = {
  class: 'declare class', interface: 'declare interface', struct: 'declare class',
  enum: 'declare enum', abstract: 'declare abstract class',
};

/** Composition/aggregation/dependency map straight over; generalisation splits on the target's kind. */
function attrName(edge: NaamaEdge, targetKind: string | undefined): string {
  if (edge.kind === 'composition') return 'Owns';
  if (edge.kind === 'aggregation') return 'Has';
  if (edge.kind === 'extension') return targetKind === 'interface' ? 'Implements' : 'Extends';
  return 'Uses';
}

const quote = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function fileFor(t: NaamaType, edges: NaamaEdge[], kinds: Map<string, string>, lang: 'cs' | 'ts'): string {
  const out: string[] = [];
  const attr = (name: string, arg: string): void => {
    out.push(lang === 'cs' ? `[${name}(${arg})]` : `@${name}(${arg})`);
  };
  attr('Domain', `"${quote(t.domain)}"`);
  if (t.lede) attr('Remark', `"${quote(t.lede)}"`);
  for (const e of edges) {
    const name = attrName(e, kinds.get(e.to));
    // C# keeps interfaces at runtime so `typeof` is the only spelling; TypeScript erases them, which
    // is why naamah's TS vocabulary names the target in the TYPE position instead.
    out.push(lang === 'cs' ? `[${name}(typeof(${e.to}))]` : `@${name}<${e.to}>()`);
  }
  out.push(`${(lang === 'cs' ? KIND_CS : KIND_TS)[t.kind] ?? (lang === 'cs' ? 'public class' : 'declare class')} ${t.name}`);
  out.push('{');
  for (const m of t.members) {
    const sig = m.sig.replace(/[\r\n]+/g, ' ').trim();
    if (sig) out.push(`    ${sig.replace(/;+$/, '')};`);
  }
  out.push('}');
  return `${out.join('\n')}\n`;
}

/**
 * Write the design and return the directory.
 *
 * Stale files are removed FIRST, and only the ones this function writes. A second run over a smaller
 * graph would otherwise leave the previous run's types on disk, and `naamah build` reads the whole
 * directory — so the page would show nodes that the walk no longer reaches, with nothing on it
 * admitting they are from an older question.
 */
export function writeDesign(doc: NaamaDoc, dir: string, lang: 'cs' | 'ts'): string {
  mkdirSync(dir, { recursive: true });
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (/\.(cs|ts)$/i.test(f) || /\.html$/i.test(f)) rmSync(join(dir, f), { force: true });
    }
  }
  const kinds = new Map(doc.types.map((t) => [t.name, t.kind]));
  const written = new Set<string>();
  for (const t of doc.types) {
    if (RESERVED.test(t.name)) continue;
    const mine = doc.edges.filter((e) => e.from === t.name && kinds.has(e.to));
    writeFileSync(join(dir, `${t.name}.${lang}`), fileFor(t, mine, kinds, lang));
    written.add(t.name);
  }
  // An edge whose source was skipped still has to be drawn, so it is declared from the far end —
  // naamah treats `[Owns(typeof(B))]` on A and `[OwnedBy(typeof(A))]` on B as the same single edge.
  if (written.size !== doc.types.length) {
    for (const e of doc.edges) {
      if (written.has(e.from) || !written.has(e.to)) continue;
      const target = doc.types.find((t) => t.name === e.to);
      if (target) writeFileSync(join(dir, `${target.name}.${lang}`), fileFor(target, [], kinds, lang));
    }
  }
  return dir;
}
