/**
 * A FILE TOO BIG TO READ, ANSWERED AS STRUCTURE INSTEAD OF BYTES.
 *
 * What it replaces. A read of a file past the window cap used to return the first N lines and a note
 * saying how many were withheld — later, the first N plus the last few. Both are BYTE outlines: they
 * tell the model where the file starts and stops and nothing about what is in it, so the only way
 * forward is to guess an offset, read, guess again. Measured on a real run: 27 reads of this
 * file in 42 minutes, circling three neighbourhoods (940-1046, 1876, 1990-2154), never editing. The
 * thing it was hunting — which class declares `set_view_interval` and on what line — is one line of
 * the output below.
 *
 * What it returns instead: every type in the file, every member, the exact line range of each body,
 * what each body assigns and which calls leave the file. Roughly 300 lines standing in for 2,486,
 * and the model picks a body with `expand_method` rather than a byte offset with `read_file`.
 *
 * Structure comes from `SurfaceLanguage`, so this is per-repo-type by construction and a language that
 * has not implemented `bodyFactsOf` simply prints signatures and ranges — already most of the value.
 * A language that handles the extension but finds nothing returns null, and the caller falls back to
 * the byte window: an empty skeleton is a worse answer than a real first page.
 */
import { toolStructure, type ToolMember, type ToolType } from './runtime.js';

/**
 * Calls and assigns listed per member. Past this the line stops being a signpost and becomes a
 * transcript: a constructor that sets twenty fields prints twenty names nobody reads, and pushes the
 * next method off the page. The count that is cut is still reported, because "and 16 more" is the
 * difference between a summary and a lie.
 */
const CALLS_SHOWN = 4;
const ASSIGNS_SHOWN = 6;

/** Fields listed per type before the list is summarised. */
const FIELDS_SHOWN = 12;

export type SkeletonTier = 'full' | 'dense' | 'names';

export interface Skeleton {
  text: string;
  tier: SkeletonTier;
  types: number;
  members: number;
}

/** A member and the type that declares it — the pair every lookup here returns. */
export interface Located {
  type: ToolType;
  member: ToolMember;
}

/** `Class.method`, or `method` alone. Both are what a model writes; neither is guessed at. */
export function locate(source: string, path: string, spec: string): Located[] {
  const st = toolStructure();
  if (!st.handles(path)) return [];
  const want = spec.trim();
  const [lhs, rhs] = want.includes('.') ? [want.slice(0, want.lastIndexOf('.')), want.slice(want.lastIndexOf('.') + 1)] : ['', want];
  const out: Located[] = [];
  for (const type of st.of(path, source)) {
    if (lhs && type.name !== lhs) continue;
    for (const member of type.members) {
      if (member.name === rhs) out.push({ type, member });
    }
  }
  return out;
}

/**
 * Calls worth printing: the ones that LEAVE this file.
 *
 * `self._get_tick(...)` is a sibling method the model can see two lines down in the same skeleton;
 * printing it spends a line to point at the page it is already on. `self.axes.transAxes.transform(...)`
 * leaves the object even though it starts with `self`, and `np.floor(...)` leaves the module — those
 * are the edges that cannot be followed without another file, which is exactly why they earn the line.
 */
function externalCalls(calls: string[], declared: Set<string>): string[] {
  const out: string[] = [];
  for (const call of calls) {
    const parts = call.split('.');
    // `self.foo` — one hop, and `foo` is declared here. Same page.
    if (parts.length === 2 && (parts[0] === 'self' || parts[0] === 'cls') && declared.has(parts[1])) continue;
    // A bare `Bbox(` that this file itself declares.
    if (parts.length === 1 && declared.has(parts[0])) continue;
    out.push(call.replace(/^(?:self|cls)\./, ''));
  }
  return out;
}

/**
 * A signature that wrapped across lines is printed as the parser saw it — one line, cut mid-argument.
 * `def __init__(self, axes, loc, label,` reads as a complete three-argument signature, and a model
 * calling it with three arguments is wrong in a way nothing on screen contradicts. So the cut is shown.
 */
function signatureOf(m: ToolMember): string {
  const sig = (m.sig ?? m.name).replace(/\s*:\s*$/, '');
  return sig.includes('(') && !sig.includes(')') ? `${sig.replace(/,\s*$/, '')}, …)` : sig;
}

function memberLines(m: ToolMember): string {
  return m.line !== undefined && m.endLine !== undefined && m.endLine > m.line
    ? `${m.line}-${m.endLine}`
    : m.line !== undefined ? `${m.line}` : '';
}

/**
 * Structure of `source`, or null when no language claims the file or it declares nothing.
 *
 * `budget` is the same line cap a real read would have obeyed — the skeleton earns its place by being
 * SMALLER than the thing it replaces, and a 10,000-line file's skeleton can itself overflow. Three
 * tiers, richest first, and the header says which one came back so a thin answer never reads as a
 * complete one.
 */
export function skeletonOf(path: string, source: string, budget: number): Skeleton | null {
  const st = toolStructure();
  if (!st.handles(path)) return null;
  const types = st.of(path, source);
  const members = types.reduce((a, t) => a + t.members.length, 0);
  if (!types.length || !members) return null;
  /**
   * NO LINE NUMBERS, NO SKELETON.
   *
   * A skeleton's whole proposition is "here is where to look, fetch it with `expand_method`". A
   * language that records declarations but not their extent produces a map with no coordinates:
   * every `expand_method` against it answers "no recorded line range", and the model is left holding
   * a list of names and a tool that refuses — strictly worse than the first page of the file it
   * would otherwise have got. Python records ranges today; the other three do not yet, and until
   * they do their files take the byte window exactly as before.
   */
  if (!types.some((t) => t.members.some((m) => m.line !== undefined))) return null;

  const rows = source.split('\n');
  const declared = new Set<string>();
  for (const t of types) {
    declared.add(t.name);
    for (const m of t.members) declared.add(m.name);
  }

  /**
   * WHICH CLASSES SHARE A METHOD NAME — the fact that decides which body actually runs.
   *
   * A name is not an address. `ticker.py` declares `nonsingular` on `Locator`, `LogLocator` and
   * `LogitLocator`; which one executes depends on the axis scale at runtime, and for a bug reported
   * against a log axis only one of the three is the answer. Listed separately, as three unremarkable
   * lines 900 apart in a 358-line document, that is invisible.
   *
   * Demonstrated, expensively: a hand-written extractor asked for "nonsingular in ticker.py", took the
   * first match, and the model produced a confident, well-argued, WRONG patch in ten seconds — wrong
   * only because the body that runs for the reported case was never on the page.
   *
   * So each overridden method says so, and names its siblings. The data is already computed; this is a
   * grouping pass over it.
   */
  const owners = new Map<string, string[]>();
  for (const t of types) {
    for (const m of t.members) {
      if (m.kind === 'field') continue;
      owners.set(m.name, [...(owners.get(m.name) ?? []), t.name]);
    }
  }
  /**
   * The other classes declaring this name, or '' when it is unique in the file.
   *
   * INLINE, not on its own line. Written as a second line it grew a real file's skeleton by 34% —
   * three lines per override group, each repeating the same explanatory clause — and the skeleton
   * earns its place by being smaller than the thing it replaces. The class list is the information;
   * what it MEANS is said once, in the footer.
   */
  const overrideNote = (typeName: string, member: string): string => {
    const all = owners.get(member) ?? [];
    if (all.length < 2) return '';
    return `   also: ${all.filter((n) => n !== typeName).join(', ')}`;
  };

  /** True when any name is declared by more than one type — decides whether the footer says so. */
  const hasOverrides = [...owners.values()].some((v) => v.length > 1);

  const render = (tier: SkeletonTier): string => {
    const out: string[] = [];
    for (const type of types) {
      const at = type.line !== undefined ? `  line ${type.line}` : '';
      const fields = type.members.filter((m) => m.kind === 'field');
      const methods = type.members.filter((m) => m.kind !== 'field');
      out.push(`${type.kind} ${type.name}${at}`);
      if (tier === 'names') {
        out.push(`  ${type.members.length} members: ${type.members.map((m) => m.name).join(', ')}`);
        continue;
      }
      if (fields.length) {
        const shown = fields.slice(0, FIELDS_SHOWN).map((f) => f.name).join(', ');
        const rest = fields.length > FIELDS_SHOWN ? `, +${fields.length - FIELDS_SHOWN} more` : '';
        out.push(`  fields: ${shown}${rest}`);
      }
      for (const m of methods) {
        const span = memberLines(m);
        // The override note rides at BOTH tiers: when the full form does not fit, which body runs is
        // more use than what it assigns.
        out.push(`  ${signatureOf(m)}${span ? `   ${span}` : ''}${overrideNote(type.name, m.name)}`);
        if (tier !== 'full') continue;
        if (m.line === undefined || m.endLine === undefined) continue;
        const facts = st.facts(path, rows.slice(m.line, m.endLine));
        if (!facts) continue;
        const calls = externalCalls(facts.calls, declared);
        const bits: string[] = [];
        if (facts.assigns.length) {
          const rest = facts.assigns.length > ASSIGNS_SHOWN ? ` +${facts.assigns.length - ASSIGNS_SHOWN}` : '';
          bits.push(`assigns ${facts.assigns.slice(0, ASSIGNS_SHOWN).join(', ')}${rest}`);
        }
        if (calls.length) {
          const rest = calls.length > CALLS_SHOWN ? ` +${calls.length - CALLS_SHOWN}` : '';
          bits.push(`calls ${calls.slice(0, CALLS_SHOWN).join(', ')}${rest}`);
        }
        if (bits.length) out.push(`      ${bits.join(' · ')}`);
      }
    }
    return out.join('\n');
  };

  // Said ONCE, at the end, rather than on every overridden method — see `overrideNote`.
  const legend = hasOverrides
    ? '\n\n`also:` means other classes here declare the same method. Which body runs depends on the '
      + 'object, so name the class when you expand one.'
    : '';

  for (const tier of ['full', 'dense', 'names'] as const) {
    const text = render(tier) + legend;
    if (text.split('\n').length <= budget || tier === 'names') {
      return { text, tier, types: types.length, members };
    }
  }
  return null;
}
