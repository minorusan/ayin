/**
 * explore/design.ts — the naamah design document, when the project has one, read FIRST.
 *
 * WHY IT LEADS. `explore` answers "where is it" from bytes on disk. A naamah `.puml` answers something the
 * bytes cannot: what each type is FOR, what each member MUST DO, which domains exist and what they are
 * allowed to reference. That is the operator's intent, written down and enforced by `entangle` — so when a
 * project has one, it is better evidence about what the code is supposed to be than any amount of grep
 * output, and it belongs above the findings rather than under them.
 *
 * RETRIEVED, NEVER DUMPED. The rule this file exists under is the one `planGrounding` learned the hard
 * way: interpolating a whole catalogue — 10,196 characters of 28 components for a project that used four —
 * put ~24 distractors into every prompt, and a distractor measurably degrades everything around it. So the
 * design is FILTERED to the types the question is actually about, with their full members and intent
 * (that part is the answer, and clipping it would be the one thing worth keeping thrown away). When
 * nothing matches, the block shrinks to the shape of the design — domains, their allowed references, and
 * the type names — because "there is a design and here is its outline" is worth a few lines and a dump is
 * not.
 *
 * THE DOMAINS ARE ALWAYS INCLUDED, matched or not. They are short, and they are the constraint an agent is
 * most likely to break without knowing it exists: a reference from a sealed domain compiles and is still
 * wrong.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadDoc, type NaamaDoc, type NaamaType } from '../../naama/index.js';
import { entangledTo } from '../../entangle/index.js';
import { runProbe } from './search.js';
import { toolLog } from '../runtime.js';

/** Types described in full. Four is a briefing on what was asked; twenty is the file. */
const MAX_TYPES = 4;
/** Members per described type. A type with more than this has its remainder counted, not printed. */
const MAX_MEMBERS = 14;
/** Type names listed when nothing matched — an index, so the agent can ask for one by name. */
const MAX_NAMES = 40;
/** Candidate `.puml` files parsed while looking for a design. */
const MAX_CANDIDATES = 8;

interface Cached { path: string; mtimeMs: number; doc: NaamaDoc }
/** Parsed designs by path. A `.puml` is kilobytes, but explore is called several times per turn. */
const cache = new Map<string, Cached>();

function parseCached(path: string): NaamaDoc | null {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.doc;
    const doc = loadDoc(path);
    cache.set(path, { path, mtimeMs, doc });
    return doc;
  } catch {
    return null;
  }
}

/** A naamah design, as opposed to any other PlantUML file: it declares domains and types. */
const looksLikeDesign = (doc: NaamaDoc | null): boolean =>
  Boolean(doc && doc.types.length > 0 && doc.domains.length > 0);

/**
 * The design for this project, or null.
 *
 * The entangled path first — a session that ran `/entangle` has already SAID which document governs, and
 * guessing past that would be answering a question the operator settled. Otherwise the project is
 * searched, bounded and shallow: a design lives where a person can find it, and a `.puml` twelve levels
 * down inside a package cache is a diagram, not a contract.
 */
async function findDesign(root: string): Promise<{ path: string; doc: NaamaDoc } | null> {
  const declared = entangledTo();
  if (declared && existsSync(declared)) {
    const doc = parseCached(declared);
    if (looksLikeDesign(doc)) return { path: declared, doc: doc! };
  }

  const r = await runProbe([
    'find', '.', '-maxdepth', '3', '-name', '*.puml',
    '-not', '-path', '*/Library/*', '-not', '-path', '*/node_modules/*',
    '-not', '-path', '*/Temp/*', '-not', '-path', '*/.git/*',
  ], root);
  const candidates = r.lines.map((l) => join(root, l.replace(/^\.\//, ''))).slice(0, MAX_CANDIDATES);

  let best: { path: string; doc: NaamaDoc } | null = null;
  for (const path of candidates) {
    const doc = parseCached(path);
    if (!looksLikeDesign(doc)) continue;
    // The largest design wins when a project has several: a stub beside the real document is the common
    // case, and the real one is the one with the types in it.
    if (!best || doc!.types.length > best.doc.types.length) best = { path, doc: doc! };
  }
  return best;
}

/** How well a type answers this question. 0 means it does not. */
function score(t: NaamaType, terms: string[], question: string): number {
  const q = question.toLowerCase();
  let s = 0;
  const name = t.name.toLowerCase();
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (name === needle) s += 12;                       // the question named this type
    else if (name.includes(needle) || needle.includes(name)) s += 6;
    if (t.domain.toLowerCase() === needle) s += 3;
    if ((t.lede ?? '').toLowerCase().includes(needle)) s += 2;
    for (const m of t.members) {
      if (m.sig.toLowerCase().includes(needle)) s += 3;
      if ((m.intent ?? '').toLowerCase().includes(needle)) s += 1;
    }
  }
  // The question as prose, for the case the term extractor found no identifier at all.
  if (q.includes(name) && name.length >= 4) s += 4;
  return s;
}

function describe(t: NaamaType): string[] {
  const out = [`  ${t.kind} ${t.name} @ ${t.domain}${t.lede ? ` — ${t.lede}` : ''}`];
  for (const m of t.members.slice(0, MAX_MEMBERS)) {
    const vis = m.vis && m.vis !== 'public' ? `${m.vis} ` : '';
    out.push(`      ${vis}${m.sig}${m.intent ? `  — ${m.intent}` : ''}`);
  }
  if (t.members.length > MAX_MEMBERS) out.push(`      (+${t.members.length - MAX_MEMBERS} more members)`);
  return out;
}

/**
 * The block, or null when this project has no design. Never throws: a malformed `.puml` must not turn a
 * good localization into an error.
 */
export async function exploreDesignBlock(
  root: string, question: string, terms: string[],
): Promise<string | null> {
  if (!existsSync(root)) return null;
  let found: { path: string; doc: NaamaDoc } | null = null;
  try {
    found = await findDesign(root);
  } catch (e) {
    toolLog().warn('explore_design_lookup_failed', { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
  if (!found) return null;
  const { path, doc } = found;

  const ranked = doc.types
    .map((t) => ({ t, s: score(t, terms, question) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_TYPES);

  const out: string[] = [
    `design · ${doc.title || basename(path)} · ${path}`,
    `${doc.types.length} type(s) across ${doc.domains.length} domain(s). This is the DESIGN — what the code`,
    'is meant to be, written by the operator and enforced by entangle. Where it and the code disagree, one',
    'of the two is a bug.',
    '',
  ];

  // Always: the domains and what they may reference. Short, and the constraint most easily broken blind.
  for (const d of doc.domains) {
    const refs = d.references.length ? `refs ${d.references.join(', ')}` : 'refs NONE';
    out.push(`  domain ${d.name} — ${refs}${d.sealed ? ' · sealed (no engine/platform references)' : ''}`);
  }
  out.push('');

  if (ranked.length) {
    out.push(`about this question (${ranked.length} of ${doc.types.length} types):`);
    for (const { t } of ranked) out.push(...describe(t));
    const edges = doc.edges.filter((e) => ranked.some((r) => r.t.name === e.from || r.t.name === e.to));
    if (edges.length) {
      out.push('');
      out.push('  declared edges touching these:');
      for (const e of edges.slice(0, 12)) out.push(`      ${e.from} -> ${e.to} : ${e.kind}`);
    }
  } else {
    // Nothing matched. The index, not the document — a full dump here is the distractor case.
    const names = doc.types.map((t) => `${t.name}@${t.domain}`).slice(0, MAX_NAMES);
    out.push('nothing in the design matches this question. Its types, so you can ask for one by name:');
    out.push(`  ${names.join(' · ')}${doc.types.length > MAX_NAMES ? ` (+${doc.types.length - MAX_NAMES} more)` : ''}`);
  }

  out.push('');
  out.push(`Read ${path} for the rest, or naama op=show to print it.`);
  return out.join('\n');
}

/** For the gate: forget parsed designs between cases. */
export function resetDesignCache(): void {
  cache.clear();
}
