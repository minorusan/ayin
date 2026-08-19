/**
 * Executors — the contracts that let plan / QA / present behave DIFFERENTLY per project type.
 *
 * WHY THIS EXISTS. The three gates were written against one implicit project shape: a Node/web repo
 * with a package.json, an HTTP server and a logger module. That assumption is baked into their
 * output, and on any other kind of project it does not merely go quiet — it actively misleads. An
 * Arduino sketch surveyed by the generic planner is told it has "NO logging facility found — the plan
 * must add one" (the answer is `Serial.begin`, not a logger module) and "bind the server to all
 * interfaces or the page will be invisible" (there is no page). The gate was steering the work wrong.
 *
 * So the shape is: ONE base implementation that is exactly what the gates did before, plus a
 * per-project-type implementation that overrides only what genuinely differs. Selection is by
 * DETECTED PROJECT TYPE, recomputed on every call — never cached across turns, because the working
 * directory changes mid-session (`cd ../unity-thing`) and a stale pick would apply Arduino rules to a
 * Unity project without a single visible symptom.
 *
 * DECLARATION LIVES IN DATA, NOT IN A SWITCH. Every executor ships a `config.json` beside it naming
 * which project types it serves and at what priority. The registry reads those files; adding support
 * for a new project type is a new directory, never an edit to a central dispatch table. See
 * `registry.ts` for the selection rule and `detect.ts` for how the type is decided.
 */

import type { ChangedFile } from '../qa/probes.js';

/**
 * The project types the detector can name. `unknown` is a real answer, not a failure — the base
 * executor serves it, and that is exactly the behaviour the gates had before executors existed.
 */
export type ProjectType =
  | 'arduino'
  | 'unity'
  | 'flutter'
  | 'node'
  | 'rust'
  | 'go'
  | 'python'
  | 'dotnet'
  | 'unknown';

export const PROJECT_TYPES: ProjectType[] = [
  'arduino', 'unity', 'flutter', 'node', 'rust', 'go', 'python', 'dotnet', 'unknown',
];

/** The three gates an executor can specialise. One executor object serves exactly one kind. */
export type ExecutorKind = 'plan' | 'qa' | 'present';

/**
 * What a `config.json` declares. Read at runtime from the shipped file — never duplicated in TS, so
 * "which projects is this handler for" has exactly one answer and an operator can read it without a
 * compiler.
 */
export interface ExecutorConfig {
  /** Unique within a kind. Matches the directory name. */
  id: string;
  kind: ExecutorKind;
  /** Project types this handler serves. `["*"]` means "anything" — that is how the base wins nothing
   *  but loses to nobody. */
  projectTypes: Array<ProjectType | '*'>;
  /** Higher wins when several configs match. The base ships 0; a specific handler ships 100. */
  priority: number;
  /** One line, shown by `/executors` and in the plan header — why this handler exists. */
  description: string;
  /**
   * This kind's gate is DETERMINISTIC ONLY: stop after the facts, derive no criteria, ask no judge.
   *
   * For a project type where the measurable check is the whole point — Unity, where "does the C# compile"
   * is the floor and everything else the generic gate asked was either wrong for the type or
   * unmeasurable without launching the editor. Declared in the config so the answer is readable without
   * a compiler, like every other selection fact here. Only meaningful for `kind: 'qa'`.
   */
  factsOnly?: boolean;
}

/**
 * What the detector decided, plus WHY. The reason travels with the type because every consumer
 * eventually has to explain itself: the plan document prints it, the QA log records it, and a wrong
 * detection is far easier to debug when the evidence that produced it is written down beside it.
 */
export interface ProjectContext {
  root: string;
  type: ProjectType;
  /** Short phrase naming the evidence — `"RgbCycle/RgbCycle.ino"`, `"pubspec.yaml"`, `"the request"`. */
  evidence: string;
  /**
   * True when the directory holds no project of this type YET and the type came from the REQUEST
   * rather than from files on disk.
   *
   * This flag is the whole reason "create an Arduino project" used to get no Arduino treatment at
   * all: every Arduino hook in the codebase keys off `isArduinoProject(root)`, which needs an `.ino`
   * to already exist. On the one turn where the grounding matters most — the turn that CREATES the
   * sketch — there is no sketch yet, so the catalog was withheld and the plan was written from
   * recall. Greenfield detection closes that hole.
   */
  greenfield: boolean;
}

/**
 * A file this project type MUST end up with. Deliverables are the executor's answer to "what does
 * done look like on disk", and they are checked as FACTS (does the path exist, does it validate) —
 * never as a reviewer's impression of whether the work seems complete.
 */
export interface Deliverable {
  /** Human label — "the sketch", "the wiring diagram". */
  label: string;
  /**
   * Glob-ish relative patterns, resolved against the project root; ANY match satisfies it. Only `*`
   * is supported and it does not cross a directory separator — enough for `*\/*.ino`, and small
   * enough to stay readable.
   *
   * A LIST, not one pattern, because the same deliverable legitimately sits at different depths
   * depending on where the operator is standing. An Arduino sketch lives at `RgbCycle/RgbCycle.ino`
   * seen from the parent directory and at `RgbCycle.ino` seen from inside the sketch folder — both
   * are the same correct project, and a single-pattern check would report the second one MISSING and
   * send the agent off to "create" a file that is already there.
   */
  patterns: string[];
  /** Why the project needs it — quoted verbatim into the plan and into a QA failure. */
  why: string;
  /** When false the deliverable is a nice-to-have and QA reports it without failing. */
  required: boolean;
}

/** One deterministic fact for the judge. Facts, never opinions — see `qa/probes.ts`'s header. */
export interface ProbeFact {
  /** Short stable key: `compile`, `diagram-syntax`, `deliverables`. */
  key: string;
  ok: boolean;
  /** One line the judge reads verbatim. */
  detail: string;
  /**
   * When true, `ok: false` FAILS THE GATE OUTRIGHT — the judge is not consulted about it.
   *
   * Because handing a deterministic fact to a model and letting the model decide is not enforcement,
   * it is a suggestion with extra steps. Measured: motor-transistor's README shipped with no pin map
   * at all, and the log reads `QA FAIL 1/3` → agent fixes something → `QA PASS 2/3`. The
   * `readme-substance` fact said "names no pins" and the judge passed the turn anyway. I had called
   * that "enforce, don't request" after moving the check out of a prompt; it was still a request,
   * addressed to a different reader.
   *
   * Reserved for facts that are BINARY AND UNARGUABLE — a compiler's exit code, a file's existence, a
   * README with the scaffold's TODO markers still in it. Never for anything with a defensible
   * exception, because a hard gate on a judgement call is how a QA loop becomes unfalsifiable.
   */
  hard?: boolean;
}

export interface PrepareResult {
  /** Artifacts produced before the judge ran, as absolute paths — reported to the user. */
  produced: string[];
  /** Sketch/unit paths already handled, so a later hook in the same turn does not redo the work. */
  handled: Set<string>;
  notes: string[];
}

// ── the three contracts ────────────────────────────────────────────────

export interface PlanExecutor {
  readonly config: ExecutorConfig;
  /**
   * Project-shaped survey text. The base returns the generic Node/web survey unchanged; a
   * specialisation returns what its own toolchain actually offers, and — crucially — omits the
   * generic advice that is wrong for it.
   */
  survey(ctx: ProjectContext): string;
  /**
   * Reference material the plan must be grounded in rather than recall (a component catalog).
   *
   * `request` is the user's own text, passed as a RETRIEVAL QUERY. Grounding material is the largest
   * thing any of these prompts interpolates — the Arduino catalog dumped whole was 10,196 characters
   * on every plan, for a project using four of its twenty-eight components. Every irrelevant entry is
   * a distractor, and distractors are the measured cause of degraded instruction-following. An
   * executor with reference material should retrieve against this query, not dump.
   */
  grounding(ctx: ProjectContext, request?: string): string;
  /** What must exist on disk when the work is done. */
  deliverables(ctx: ProjectContext): Deliverable[];
  /** How a feature in THIS kind of project is watched working — a logger module, or Serial Monitor. */
  observability(ctx: ProjectContext): string;
  /**
   * Deterministic project scaffolding, run BEFORE the plan is written. Returns the paths it created.
   * Only ever creates what is missing; never overwrites. This is where a greenfield project gets its
   * README, so "the project has a README" stops being a thing a model is asked to remember.
   */
  scaffold(ctx: ProjectContext): string[];
}

export interface QaExecutor {
  readonly config: ExecutorConfig;
  /**
   * Produce the artifacts this project type's criteria require, BEFORE the judge reads anything.
   *
   * This ordering is load-bearing. The Arduino wiring criterion asks whether the reply references a
   * rendered `.wiring.puml`; the diagram used to be generated only AFTER a QA pass succeeded, so
   * pass 1 judged a project whose diagram did not exist yet, failed it, and spent a whole fix pass
   * (two LLM calls plus the agent's own round) arriving where the system was going to arrive anyway.
   * Preparing first makes the criterion answerable on the first pass.
   */
  prepare(ctx: ProjectContext, files: ChangedFile[]): Promise<PrepareResult>;
  /** Deterministic facts gathered after `prepare` — compile result, diagram validity, deliverables. */
  probe(ctx: ProjectContext, files: ChangedFile[]): Promise<ProbeFact[]>;
  /** Baseline criterion ids this project type adds, on top of what the file kinds already imply. */
  criteria(ctx: ProjectContext, files: ChangedFile[], facts: ProbeFact[]): string[];
}

export interface PresentExecutor {
  readonly config: ExecutorConfig;
  /** Extra "Changed:" lines for the presentation — the artifacts this project type produces. */
  artifacts(ctx: ProjectContext, files: ChangedFile[], skip: Set<string>): Promise<{ lines: string[]; handled: Set<string> }>;
}

export type AnyExecutor = PlanExecutor | QaExecutor | PresentExecutor;
