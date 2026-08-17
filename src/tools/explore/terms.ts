/**
 * Turn a natural-language question into identifiers a code search can actually find.
 *
 * THE GAP THIS CLOSES. A question is written in English words separated by spaces —
 * "how is the score multiplier applied" — and code is written in camelCase, PascalCase and
 * SCREAMING_SNAKE with no spaces at all. Searching the words as typed finds prose in comments and
 * misses every declaration. Measured on a real repository: the phrase "score multiplier" appears in
 * zero identifiers, while `scoreMultiplier`, `ScoreMultiplierType` and `_scoreMultiplierType` appear
 * in 35 places across 6 files.
 *
 * So the joining is done here, deterministically, before anything is searched.
 *
 * NO MODEL, and none needed: this is a casing problem, not a reasoning problem.
 */

/**
 * Words that carry no search signal. Deliberately short — an aggressive stoplist throws away real
 * identifiers (`state`, `event`, `data`, `type` are all common English AND common code).
 */
const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'how', 'what', 'where', 'when', 'why', 'which', 'who',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'it', 'its',
  'and', 'or', 'but', 'if', 'then', 'than', 'as', 'at', 'by', 'for', 'from',
  'in', 'into', 'of', 'on', 'to', 'with', 'about', 'this', 'that', 'these', 'those',
  'tell', 'show', 'find', 'explain', 'describe', 'please', 'get', 'give',
]);

/** Verbs that describe an ACTION on a thing — kept, because code names methods after them. */
const ACTION = new Set([
  'apply', 'applied', 'applies', 'calculate', 'compute', 'set', 'get', 'add', 'remove',
  'update', 'create', 'delete', 'send', 'receive', 'handle', 'process', 'load', 'save',
  'register', 'resolve', 'parse', 'render', 'emit', 'trigger', 'invoke', 'call',
]);

export interface Terms {
  /** Identifier candidates, best first. These are what get searched. */
  identifiers: string[];
  /** Single content words, for a broad fallback pass. */
  words: string[];
  /** Anything the user quoted — searched verbatim, never re-cased. */
  literals: string[];
  /** Path-like tokens (contain / or a known extension) — searched as filenames. */
  paths: string[];
}

const CASE_ID = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
/**
 * A token the user typed that is ALREADY a key: `chat:send`, `podcast:publish-tiktok`, `a.b.c`.
 *
 * These are the highest-signal terms there are — a namespaced literal is exactly the string-key glue
 * this tool exists to follow — and the plain word splitter destroys them, because it splits on the
 * separator that makes them meaningful. Measured: "where is the chat:send socket event handled"
 * found NOTHING, because `chat:send` became the words "chat" and "send" and then got mashed into an
 * invented identifier.
 */
const KEYISH = /\b[a-zA-Z_][\w-]*(?:[:.][\w-]+)+\b/g;
const PATHISH = /(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:cs|ts|tsx|js|jsx|asset|prefab|unity|anim|meta|json|md)\b/g;

function cap(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * Build identifier candidates from a run of adjacent content words.
 *
 * Adjacency matters: "score multiplier" should produce `scoreMultiplier`, but "score" and
 * "multiplier" three words apart in different clauses should not — that manufactures a symbol nobody
 * wrote and sends the search after nothing.
 */
const MAX_JOIN = 3;

function joinRun(run: string[]): string[] {
  if (run.length < 2) return [];
  // Beyond three words the result is a symbol nobody wrote. `chatSendSocketEventHandled` was
  // generated from a five-word run and matched nothing, while burning a probe slot per strategy.
  if (run.length > MAX_JOIN) return [];
  const [head, ...rest] = run;
  const camel = head + rest.map(cap).join('');
  const pascal = cap(head) + rest.map(cap).join('');
  const snake = run.join('_');
  return [camel, pascal, snake, snake.toUpperCase()];
}

export function extractTerms(question: string): Terms {
  const quoted = [...question.matchAll(/["'`]([^"'`]{2,})["'`]/g)].map((m) => m[1].trim()).filter(Boolean);
  // Namespaced keys count as literals even unquoted — they are searched verbatim, never re-cased.
  const keyish = [...new Set(question.match(KEYISH) ?? [])].filter((k) => !/^\d/.test(k));
  const literals = [...new Set([...quoted, ...keyish])];
  const paths = [...new Set(question.match(PATHISH) ?? [])];

  // Strip quoted spans so their words don't also become loose terms.
  const bare = question.replace(/["'`][^"'`]*["'`]/g, ' ');

  // An identifier the user typed directly (already camel/Pascal/snake) is the strongest signal there
  // is — they named the thing. Keep it exactly as written.
  const typed = (bare.match(CASE_ID) ?? []).filter(
    (w) => /[A-Z]/.test(w.slice(1)) || w.includes('_') || /^[A-Z]/.test(w),
  );

  const words = (bare.toLowerCase().match(/\b[a-z][a-z0-9]{1,}\b/g) ?? [])
    .filter((w) => !STOP.has(w));

  // Runs of adjacent kept words, in original order.
  const runs: string[][] = [];
  let cur: string[] = [];
  for (const raw of bare.toLowerCase().match(/\b[a-z][a-z0-9]{1,}\b/g) ?? []) {
    if (STOP.has(raw)) { if (cur.length) { runs.push(cur); cur = []; } continue; }
    cur.push(raw);
  }
  if (cur.length) runs.push(cur);

  /**
   * SHORTER JOINS FIRST, and it is not a style preference.
   *
   * Only a few terms are searched, so ordering decides what actually gets looked for. Putting the
   * whole run first filled every slot with variants of `scoreMultiplierApplied` — a symbol nobody
   * wrote — and pushed out `scoreMultiplier`, which is the one in the code. Two-word joins are far
   * likelier to be real identifiers than three-word ones, so they rank ahead of them.
   */
  const candidates: Array<{ id: string; words: number; style: number }> = [];
  for (const run of runs) {
    const push = (words: string[]) => {
      // joinRun returns camel, pascal, snake, SCREAMING — in descending likelihood for real code.
      joinRun(words).forEach((id, style) => candidates.push({ id, words: words.length, style }));
    };
    for (let i = 0; i + 1 < run.length; i++) push([run[i], run[i + 1]]);
    if (run.length > 2) push(run);
  }
  candidates.sort((a, b) => a.words - b.words || a.style - b.style);
  const joined = candidates.map((c) => c.id);

  // Action words become method-name candidates on their own: "applied" -> Apply, apply.
  const actions = words.filter((w) => ACTION.has(w)).flatMap((w) => {
    const stem = w.replace(/(ed|es|s)$/, '');
    return [cap(stem), stem];
  });

  const identifiers = [...new Set([...typed, ...joined, ...actions])]
    .filter((s) => s.length >= 3 && s.length <= 60);

  return { identifiers, words: [...new Set(words)], literals, paths };
}
