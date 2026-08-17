/**
 * explore — the contract.
 *
 * WHY THIS TOOL EXISTS, in one sentence: **grep answers "where does this string appear"; explore
 * answers "what is connected to what".** If it is not deriving a fact that is absent from the text,
 * it is a slower duplicate of `grep` and `read_file`, which the agent already has.
 *
 * That is not a design preference, it is what the measurements forced. The previous version was an
 * LLM loop: 6 invocations in a day of real use, 1 produced an answer, 5 gave up and dumped raw
 * output. 27 of its 28 shell commands returned real data — the searching worked, the *judging*
 * failed. And in a three-model benchmark the two models that answered correctly used `grep`/`read`
 * directly and never called it.
 *
 * SO THERE IS NO MODEL IN HERE. Not "fewer calls" — none. Three consequences follow, and all three
 * are the point:
 *
 *  1. It is FAST. A full search battery over a 462 MB repository measured 422 ms; one call to the
 *     local 30B measured 15–20 s. A model call costs about 100× a search. Removing the model does
 *     not make this tool a bit cheaper, it changes what it is for: something the agent can call ten
 *     times in a turn rather than once and regret.
 *  2. It is DETERMINISTIC. Same question, same repository, same answer — inspectable and cacheable.
 *  3. It CANNOT LIE. See `format.ts`: every emitted line is either verbatim bytes read from a file
 *     at a stated line, a count of things enumerated, or a label from a closed set. There is no path
 *     by which prose is generated, so there is no path by which prose is invented. The old tool's
 *     worst failure was a `ls -la` digest presented as a finding; that is structurally impossible
 *     here.
 *
 * "NO IDEA" IS A CORRECT ANSWER and is reported as one — with what was searched, so the caller can
 * ask a better question rather than re-run the same one.
 */

/** One contiguous piece of a real file. `text` is verbatim bytes; nothing here is generated. */
export interface Span {
  file: string;
  /** 1-based, inclusive. */
  fromLine: number;
  toLine: number;
  text: string;
}

/**
 * Why a span is in the answer. A CLOSED SET — the formatter may print these and nothing else, which
 * is half of the no-lying guarantee (the other half is that spans are read from disk).
 *
 * Each is a fact the tool computed, not an opinion it formed:
 *   defines        — a declaration of the searched name was found here
 *   filename       — a FILE is named after the term. A pointer, not evidence: it carries no line and
 *                    no text, so it must never outrank a hit that quotes actual code. Measured on the
 *                    real repository: eight filename matches filled the answer and pushed out every
 *                    span with code in it.
 *   mentions       — the name occurs here, without a declaration
 *   spec           — a test asserts behaviour here. Often the highest-information span in a repo:
 *                    on a real question the clearest statement of the rule was a test assertion,
 *                    `TotalScore == base * (int)ScoreMultiplierType.Double`, and no production line
 *                    said it as plainly. Ranking tests DOWN was a mistake this label exists to undo.
 *   registered     — the symbol appears in a registry/list, which is how it becomes reachable
 *   asset-ref      — a Unity asset references this script by GUID (the link that is a hash, not a name)
 *   anim-event     — an animation clip calls a method BY NAME STRING; renaming the method breaks it
 *                    silently, and no compiler sees it
 *   string-key     — a string literal ties two distant files together (event name, tool name, prompt id)
 *   follows        — the searched name is handed to another symbol here; the answer continues there
 *   assembly       — an asmdef boundary this file sits inside
 */
export type Reason =
  | 'defines' | 'filename' | 'mentions' | 'spec' | 'registered'
  | 'asset-ref' | 'anim-event' | 'string-key' | 'follows' | 'assembly';

export interface Finding {
  span: Span;
  reason: Reason;
  /** The enclosing symbol, when one was identified from the source. Never guessed. */
  symbol?: string;
  /** Verbatim detail: a GUID, a matched literal, a referencing asset path. Never prose. */
  detail?: string;
  /** Which search term produced this. Used for specificity weighting — see rank.ts. */
  term?: string;
  /** Ranking score. Reported so the caller can see the ordering is mechanical. */
  score: number;
  /**
   * Keep `score` exactly as set, skipping the ranker.
   *
   * `glue()` knows things the generic scorer cannot: a NEGATIVE result ("no asset references this")
   * is worth reporting but must never outrank real code. Without this the ranker re-scored those by
   * reason weight and floated four "not wired to anything" lines above the method that answers the
   * question.
   */
  fixedScore?: boolean;
}

/** What was searched, so an empty result is actionable rather than mysterious. */
export interface Attempt {
  strategy: string;
  /** The exact command or pattern used — quotable, reproducible by hand. */
  probe: string;
  hits: number;
}

export interface ExploreResult {
  question: string;
  project: string;
  findings: Finding[];
  attempts: Attempt[];
  /** Names the tool derived from the question and searched for. */
  terms: string[];
  elapsedMs: number;
}

/**
 * A per-project strategy. The whole point of the subclass is that **the glue differs by ecosystem**:
 *
 *   Unity — a script is wired to the game by a GUID in a `.meta` file, referenced from `.prefab`,
 *           `.unity`, `.asset` and `.anim`. None of that is greppable by class name, and `.asset`
 *           (ScriptableObjects) plus animation clips are where most of the wiring actually lives.
 *   TypeScript — the equivalent glue is STRING KEYS: socket event names, tool names, resource ops,
 *           prompt ids, config keys. A literal that joins two distant files and appears in no import
 *           graph. Same shape as a GUID, different alphabet.
 */
export interface ProjectExplorer {
  id: string;
  /** True when this explorer understands the repository at `root`. Cheap filesystem checks only. */
  matches(root: string): boolean;
  /** File globs worth searching for source, most specific first. */
  sourceIncludes: string[];
  /** Language-specific probes for a term. Pure data — the runner executes them. */
  plan(term: string, root: string): Array<{ strategy: string; argv: string[]; reason: Reason }>;
  /** Derive the non-textual links: GUID references, string-key sites, registry membership. */
  glue(findings: Finding[], root: string): Promise<Finding[]>;
  /** Identify the enclosing symbol of a line, from the file's own text. Returns undefined if unsure. */
  symbolAt(lines: string[], line: number): string | undefined;
}
