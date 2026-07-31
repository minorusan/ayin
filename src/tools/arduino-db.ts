/**
 * arduino-db — a nice little semantic-AWARE search over `arduino-components-data.ts`, deliberately
 * NOT a RAG pipeline: no embeddings, no vector store, no chunking. The whole catalog is ~30 short
 * entries that fit in memory and in a single LLM context, so a keyword/alias scorer answers "what is
 * this thing and how do I wire it" exactly as well as a vector search would, for a fraction of the
 * moving parts (see `docs/ARCHITECTURE.md` § arduino-db for why that trade was made deliberately).
 *
 * Two consumers: the agent, as the `arduino_db` tool below (so it can look up a component while
 * writing or explaining a sketch), and `arduino-explain.ts`, which calls `getArduinoComponent` /
 * `ARDUINO_COMPONENTS` directly to ground its HTML render and its pin→component LLM call.
 */

import { ARDUINO_COMPONENTS, type ArduinoComponent } from './arduino-components-data.js';

const STOPWORDS = new Set(['a', 'an', 'the', 'is', 'are', 'of', 'for', 'to', 'and', 'or', 'how', 'what', 'do', 'i', 'does']);

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 1 && !STOPWORDS.has(w)) ?? [];
}

/**
 * Score one component against a query's words. Higher-signal fields (id, name) score more per hit
 * than prose fields — the point is "does this word identify the part", not "does it appear anywhere".
 *
 * Prose is scored SEPARATELY and only ever refines ranking among components a "strong" field (id,
 * name, alias, category) already matched — it never qualifies a component on its own. Ordinary English
 * words ("not", "real", "part", "wire") show up in nearly every entry's explanatory prose, so scoring
 * prose hits into the same total as id/name/alias hits let a nonsense query ("zzz-not-a-real-part")
 * still surface a component purely because its `howUsed` text happens to contain "not" and "real" —
 * caught by `check-gates.mjs`, not by reading the code.
 */
function score(c: ArduinoComponent, queryWords: string[]): { strong: number; prose: number } {
  const idWords = words(c.id);
  const nameWords = words(c.name);
  const aliasWords = c.aliases.flatMap(words);
  const categoryWords = words(c.category);
  const prose = `${c.identify} ${c.whatItDoes} ${c.howUsed} ${c.wiringNotes}`.toLowerCase();

  let strong = 0;
  let proseScore = 0;
  for (const w of queryWords) {
    if (idWords.includes(w)) strong += 5;
    if (nameWords.includes(w)) strong += 4;
    if (aliasWords.includes(w)) strong += 3;
    if (categoryWords.includes(w)) strong += 2;
    if (prose.includes(w)) proseScore += 1;
  }
  // Exact id match (a caller passing the id itself, e.g. from a previous list) always wins outright.
  if (c.id === queryWords.join('-')) strong += 100;
  return { strong, prose: proseScore };
}

/** Keyword search — no embeddings, no network. Empty query returns nothing (use `list` instead). */
export function searchArduinoComponents(query: string, limit = 5): ArduinoComponent[] {
  const qw = words(query);
  if (qw.length === 0) return [];
  return ARDUINO_COMPONENTS
    .map((c) => ({ c, ...score(c, qw) }))
    .filter((r) => r.strong > 0) // prose alone never qualifies a component — see `score`'s comment
    .sort((a, b) => (b.strong + b.prose) - (a.strong + a.prose))
    .slice(0, limit)
    .map((r) => r.c);
}

export function getArduinoComponent(id: string): ArduinoComponent | undefined {
  return ARDUINO_COMPONENTS.find((c) => c.id === id);
}

export function listArduinoComponentSummaries(): Array<{ id: string; name: string; category: string }> {
  return ARDUINO_COMPONENTS.map((c) => ({ id: c.id, name: c.name, category: c.category }));
}

/** The catalog line handed to the pin→component grounding LLM call in `arduino-explain.ts`. */
export function catalogLine(c: ArduinoComponent): string {
  return `${c.id} — ${c.name} [${c.category}]: ${c.identify}`;
}

export function formatArduinoComponent(c: ArduinoComponent): string {
  const legs = c.legs.map((l) => `  - ${l.legName} → ${l.connectsTo} (${l.explanation})`).join('\n');
  return [
    `${c.name}  [${c.id}, ${c.category}]`,
    `Identify: ${c.identify}`,
    `What it does: ${c.whatItDoes}`,
    `How it's used: ${c.howUsed}`,
    `Wiring:`,
    legs,
    `Wiring notes: ${c.wiringNotes}`,
  ].join('\n');
}

/** Tool entry point: `arduino_db(query=…)` or `arduino_db(id=…)` or `arduino_db(list=1)`. */
export async function arduinoDbExecute(params: Record<string, string>): Promise<string> {
  if (params.list) {
    const rows = listArduinoComponentSummaries();
    return [`${rows.length} components in the catalog:`, ...rows.map((r) => `  ${r.id} — ${r.name} [${r.category}]`)].join('\n');
  }

  if (params.id) {
    const c = getArduinoComponent(params.id.trim());
    if (!c) {
      return `Error: no component with id "${params.id}". Call with list=1 to see all ids, or use query= to search.`;
    }
    return formatArduinoComponent(c);
  }

  const query = (params.query ?? '').trim();
  if (!query) return 'Error: pass query=<what you\'re looking for> (e.g. "servo", "rgb led", "distance sensor"), id=<exact id>, or list=1 for every entry.';

  const hits = searchArduinoComponents(query, 3);
  if (hits.length === 0) {
    return `No match for "${query}". Call with list=1 to see every component id and try again with one of those terms.`;
  }
  return hits.map(formatArduinoComponent).join('\n\n---\n\n');
}
