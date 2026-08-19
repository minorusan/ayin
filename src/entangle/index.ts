/**
 * The entangle session state and the language registry.
 *
 * `entangle(path)` binds this session to a design. Nothing is entangled by default — the gate is opt-in
 * per session, because the first loop (drawing the diagram with the operator) must stay completely free.
 *
 * THE DESIGN FILE IS READ-ONLY TO THE AGENT, and that is not a detail. Without it the workaround simply
 * moves up a level: the model amends the diagram to legalise its own violation, and the gate then
 * certifies the drift. A write to the entangled file is itself a violation.
 */

import { resolve } from 'node:path';
import { loadDesign } from './design.js';
import { checkFile, checkAdoption, renderStop } from './check.js';
import { csharp } from './languages/csharp.js';
import { typescript } from './languages/typescript.js';
import { dart } from './languages/dart.js';
import type { Design, SurfaceLanguage, Violation } from './types.js';

export type { Design, Violation, SurfaceLanguage } from './types.js';
export { renderStop, checkAdoption } from './check.js';

/**
 * Three implementations. A fourth language is one entry here plus one file.
 *
 * This list is load-bearing well beyond entangle: `languageFor()` decides which files the CORPUS walk
 * can see (`indulge/discover.ts#walkSources`), which entities a file declares, and which import edges
 * are followed. Dart was added because a Flutter app was invisible to all three — every domain scoped to
 * its `lib/` discovered zero files.
 */
const LANGUAGES: SurfaceLanguage[] = [csharp, typescript, dart];

export function languageFor(path: string): SurfaceLanguage | null {
  return LANGUAGES.find((l) => l.handles(path)) ?? null;
}

let design: Design | null = null;
let designPath = '';
/**
 * The domain this session is working IN, when the operator says so.
 *
 * Without it, "what remains" spans the whole design: a task to implement one assembly was told 23 types
 * were missing, most of them in assemblies it had never been asked to touch, and it answered that wall by
 * trying to switch the gate off. Scope makes the completion criterion match the task. Closure and the
 * reference rule stay GLOBAL — an undesigned type is undesigned wherever it appears.
 */
let scope = '';
/** Every type name seen in a checked write, for the end-of-task ADOPTION pass. */
const seen = new Set<string>();

/**
 * A gate stop happened and has not been reported yet.
 *
 * The two mechanisms contradicted each other in a live run. The stop tells the model the write did not
 * land, to report the gap and WAIT. The adoption nudge then fired on that same text-only turn — three
 * times — telling it NOT DONE, take a step now. Told to stop and to continue at once, it went back to
 * re-reading the design, hit the repeat guard and ended the turn having delivered no report at all.
 *
 * A HARD STOP OUTRANKS A COMPLETION CRITERION. The design being unsatisfied is exactly what a stop means;
 * nudging against it destroys the conversation the stop exists to start.
 */
let stopPending = false;

/**
 * The type `op=next` last handed out, and the ones a stop has PARKED.
 *
 * Measured, and it is a flaw in the oracle rather than in any model: `op=next` returned the first
 * unimplemented type every time, so a type that CANNOT be implemented — the trial's interface, which
 * needs a type the design does not declare — was handed out 65 times in one run while nothing was
 * written. Both models deadlocked on it; the faster one merely burned fewer rounds.
 *
 * A person parks the blocker and carries on with the other eight. So does this: a stop marks what was
 * offered, and the next call skips it. The parked ones are reported at the end, which is the operator's
 * decision they were always waiting for.
 */
let offered = '';
const blocked = new Set<string>();

export function entangle(path: string, workingIn = ''): { types: number; edges: number; source: string; scope: string } {
  const abs = resolve(path);
  design = loadDesign(abs);
  designPath = abs;
  scope = workingIn.trim();
  stopPending = false;
  offered = '';
  blocked.clear();
  seen.clear();
  return { types: design.types.size, edges: design.edges.length, source: abs, scope };
}

export function disentangle(): void {
  design = null;
  designPath = '';
  scope = '';
  seen.clear();
}

export function entangledTo(): string {
  return designPath;
}

/**
 * The gate. Returns null when the write may proceed, or the STOP text when it may not.
 *
 * A file in a language with no implementation is NOT blocked — silently passing an unknown language is
 * the honest behaviour, since the alternative is refusing to write a `.md` because nothing can parse it.
 * What must never happen is treating "cannot check" as "checked and fine" for a language we DO handle,
 * which is why a malformed manifest yields no domain rather than an empty allow-list.
 */
export function gateWrite(file: string, source: string): string | null {
  if (!design) return null;
  const abs = resolve(file);
  if (abs === designPath) {
    return renderStop([{
      rule: 'CLOSURE', subject: designPath, file: abs,
      gap: 'this is the entangled design itself, and it is read-only while entangled — amending it is the operator\'s decision',
    }], designPath);
  }
  const lang = languageFor(abs);
  if (!lang) return null;
  const violations: Violation[] = checkFile(design, lang, abs, source);
  if (violations.length) {
    stopPending = true;
    // Park whatever this attempt was for, so the loop advances instead of being handed the same wall.
    if (offered) blocked.add(offered);
    return renderStop(violations, designPath);
  }
  // Only a write that LANDS counts toward adoption. Recording a blocked file's types would report them as
  // implemented when the file was never written — the completion criterion would then be satisfied by
  // rejected work, which is worse than having no criterion at all. Caught by the adoption gate.
  for (const t of lang.surfaceOf(source)) seen.add(t.name);
  return null;
}

/**
 * ONE type's brief: the next thing the design says is missing, with its full surface and intent.
 *
 * This is the answer to a measured failure rather than a convenience. Across three trial runs a nine-type
 * task never finished: one run re-read a 15 KB spec at five different offsets, another burned every
 * completion nudge with seven types left. The model cannot hold 23 types and 131 members at once, and
 * telling it to keep going does not create context. So it asks for one type and gets one type — the
 * design is the spec, and this retrieves from it.
 *
 * Returns null when the design is satisfied, which is what makes it usable as the loop's next-step oracle.
 */
export function nextBrief(): string | null {
  if (!design) return null;
  const gaps = gateAdoption();
  if (gaps.length === 0) return null;
  const open = gaps.filter((g) => !blocked.has(g.subject));
  if (open.length === 0) {
    return `Every remaining type is BLOCKED pending your operator's decision: `
      + `${gaps.map((g) => g.subject).join(', ')}. Do not try them again — report the gaps and the options `
      + `you see for each, and stop. Nothing here can be implemented as the design currently stands.`;
  }
  const t = design.types.get(open[0].subject);
  if (!t) return null;
  offered = t.name;

  const lines = [
    `NEXT: ${t.kind} ${t.name}${t.domain ? `  in ${t.domain}` : ''}`,
    `${open.length - 1} designed type(s) remain after this one`
      + `${blocked.size ? `, and ${blocked.size} parked awaiting the operator (${[...blocked].join(', ')})` : ''}.`,
    '',
    'Its designed surface — implement exactly these members, nothing more:',
  ];
  for (const m of t.spec) {
    lines.push(`  ${m.sig}${m.intent ? `\n      MUST: ${m.intent}` : ''}`);
  }
  lines.push('');
  lines.push('Implement the behaviour stated above, not the behaviour the member name suggests — where the');
  lines.push('two differ, the design wins. A member not listed here is not part of this type: if you believe');
  lines.push('one is needed, stop and report the gap rather than adding it.');
  return lines.join('\n');
}

export function implementedCount(): number {
  return seen.size;
}

/** ADOPTION, for the end of a task: what the design declares and nothing implemented. */
export function gateAdoption(): Violation[] {
  if (!design) return [];
  const gaps = checkAdoption(design, seen);
  if (!scope) return gaps;
  return gaps.filter((v) => design?.types.get(v.subject)?.domain === scope);
}

/** True while a gate stop is awaiting the operator. The loop must not nudge past it. */
export function stopAwaitingOperator(): boolean {
  return stopPending;
}

/** The operator has seen it (a new user turn, or a fresh binding). */
export function clearStop(): void {
  stopPending = false;
}

/** Types a stop has parked, for the end-of-task report. */
export function blockedTypes(): string[] {
  return [...blocked];
}

export function entangledScope(): string {
  return scope;
}
