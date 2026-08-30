/**
 * WEAVE/DELTA — what the code declares, minus what the diagram declares.
 *
 * The half of `--weave` that must never guess. A model is expensive, slow and occasionally creative;
 * "which types exist in this file" and "which of them the diagram is missing" are set operations over
 * parsed declarations, and a set operation is free, instant and the same every time. So the model is
 * never asked what changed — it is TOLD, and its whole job is the judgment that remains: which domain
 * a new type belongs to, what each member is for, whether the thing belongs on an architecture
 * diagram at all.
 *
 * That split is the same one `entangle` makes, for the same reason and in the opposite direction:
 * entangle stops code that drifts from the design, this reports a design that drifts from the code.
 * Both read the source through `SurfaceLanguage` and the design through `naama`'s parser — the only
 * two parsers ayin has — because a third reader of either format would drift from both.
 *
 * WHAT IT COMPARES, AND WHAT IT DELIBERATELY DOES NOT
 *
 * Member NAMES, public only. Not signatures: a diagram writes `Feed(Telemetry)` where the code writes
 * `public void Feed(Telemetry t)`, and comparing those two strings reports drift on every member of
 * every type forever. Not private members either — a private helper is the implementation freedom the
 * operator explicitly keeps, and putting it on the diagram is noise that makes the diagram worse.
 *
 * A type whose file DISAPPEARED is not automatically a removal: a rename or a move shows up as one
 * file deleted and another added, and dropping the type on the way through would delete a designed
 * type and its edges to re-add it a moment later, losing the intent prose written against it. So a
 * name that leaves one file and appears in another is `moved` — reported, and nothing to do.
 */

import { languageFor } from '../entangle/index.js';
import { parsePuml, type NaamaDoc } from '../naama/index.js';
import type { TypeKind } from '../entangle/types.js';

/** One type as the SOURCE declares it. */
export interface SourceType {
  name: string;
  kind: TypeKind;
  /** Repo-relative file that declares it. */
  file: string;
  /** The dependency unit the code puts it in — assembly, package — or '' when there is no manifest. */
  unit: string;
  /** Public member names, in declaration order. */
  members: string[];
}

export interface WeaveDelta {
  /** Declared in the source, absent from the design. */
  added: SourceType[];
  /** On the design, and the file that declared it is gone with the name nowhere else. */
  removed: Array<{ name: string; domain: string; file: string }>;
  /** On both, with a different public surface. */
  drifted: Array<{ name: string; file: string; gained: string[]; lost: string[] }>;
  /** The same name in a different file. Informational: a rename or a move, not a design change. */
  moved: Array<{ name: string; from: string; to: string }>;
}

/** Nothing to weave. Checked before anything is spawned — most edits are bodies, and a body is not a surface. */
export function isEmpty(d: WeaveDelta): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.drifted.length === 0;
}

export function countOf(d: WeaveDelta): number {
  return d.added.length + d.removed.length + d.drifted.length;
}

/**
 * Every type one source file declares.
 *
 * `unit` comes from the language's own notion of a dependency unit — the `.asmdef`, the
 * `package.json` — which is the concept a diagram's domains correspond to. It is a SUGGESTION carried
 * to the model, not an instruction: a repo whose packages do not match its architecture is common, and
 * the operator's domains win.
 */
export function typesIn(repoRel: string, source: string, absPath: string): SourceType[] {
  const lang = languageFor(absPath);
  if (!lang) return [];
  const unit = lang.domainOf(absPath)?.name ?? '';
  return lang.surfaceOf(source).map((t) => ({
    name: t.name,
    kind: t.kind,
    file: repoRel,
    unit,
    members: t.members.filter((m) => m.visibility === 'public').map((m) => m.name),
  }));
}

/** `+Foo(...)`, `+event Bar`, `- _x : int` → `Foo` / `Bar` / `_x`. The design's own member vocabulary. */
function designMemberName(sig: string): string | null {
  const m = /^\s*(?:event\s+)?([A-Za-z_$][A-Za-z0-9_$]*)/.exec(sig.trim());
  return m ? m[1] : null;
}

/**
 * The delta for one repo.
 *
 * `current` is every type the CHANGED files now declare. `wasDeclaredBy` is what the snapshot says the
 * DELETED files used to declare — the only way to know a designed type lost its home without walking
 * the whole repo on every pass. `design` is the parsed `.puml`.
 */
export function computeDelta(args: {
  design: NaamaDoc;
  current: SourceType[];
  goneFrom: Array<{ file: string; types: string[] }>;
}): WeaveDelta {
  const { design, current, goneFrom } = args;

  const designed = new Map(design.types.map((t) => [t.name, t]));
  const byName = new Map<string, SourceType>();
  for (const t of current) byName.set(t.name, t);

  const added: SourceType[] = [];
  const drifted: WeaveDelta['drifted'] = [];
  const moved: WeaveDelta['moved'] = [];

  for (const t of current) {
    const d = designed.get(t.name);
    if (!d) { added.push(t); continue; }
    // ZERO PARSED MEMBERS IS "UNKNOWN", NOT "EMPTY", and this is the difference between a useful
    // feature and a destructive one. `SurfaceLanguage` reads declarations LINE BY LINE, so a type
    // written `interface IGauge { read(): number; }` on one line parses as having none — measured, on
    // the first real repo this ran against. Believing that would report every member of that type as
    // lost, and the model would be sent to delete design facts that are true.
    //
    // The trade is deliberate and one-directional: a type that genuinely had every member removed is
    // reported late, when the next real edit touches it. A missed drift leaves a diagram slightly
    // stale; a false removal destroys the intent prose that only the diagram was carrying.
    if (t.members.length === 0) continue;
    const on = new Set(
      d.members.filter((m) => m.vis !== 'private').map((m) => designMemberName(m.sig)).filter(Boolean) as string[],
    );
    const inCode = new Set(t.members);
    const gained = [...inCode].filter((m) => !on.has(m));
    const lost = [...on].filter((m) => !inCode.has(m));
    if (gained.length || lost.length) drifted.push({ name: t.name, file: t.file, gained, lost });
  }

  const removed: WeaveDelta['removed'] = [];
  for (const { file, types } of goneFrom) {
    for (const name of types) {
      const elsewhere = byName.get(name);
      if (elsewhere) { moved.push({ name, from: file, to: elsewhere.file }); continue; }
      const d = designed.get(name);
      if (d) removed.push({ name, domain: d.domain, file });
    }
  }

  return { added, removed, drifted, moved };
}

/** Read a design without caring which of the two formats it is in. Throws on a file it cannot parse. */
export function designOf(text: string): NaamaDoc {
  return parsePuml(text);
}

/**
 * The delta as the lines a prompt interpolates — one fact per line, nothing wrapped in prose.
 *
 * Each section renders empty as `(none)` rather than vanishing: a heading with nothing under it tells
 * the model there is nothing of that kind, where an absent heading reads as an omission it might try
 * to fill in.
 */
export function renderDelta(d: WeaveDelta): {
  added: string; removed: string; drifted: string; moved: string;
} {
  const none = '(none)';
  const list = (xs: string[]): string => (xs.length ? xs.join('\n') : none);
  return {
    added: list(d.added.map((t) =>
      `${t.name} : ${t.kind} — ${t.file}${t.unit ? ` — code unit "${t.unit}"` : ''}` +
      `${t.members.length ? ` — public: ${t.members.join(', ')}` : ' — no public members'}`)),
    removed: list(d.removed.map((r) => `${r.name} — was in ${r.file}, design domain "${r.domain}"`)),
    drifted: list(d.drifted.map((x) =>
      `${x.name} — ${x.file}` +
      `${x.gained.length ? ` — in code, not on the design: ${x.gained.join(', ')}` : ''}` +
      `${x.lost.length ? ` — on the design, not in code: ${x.lost.join(', ')}` : ''}`)),
    moved: list(d.moved.map((m) => `${m.name} — ${m.from} → ${m.to}`)),
  };
}
