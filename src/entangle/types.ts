/**
 * ENTANGLE — the code is bound to the diagram, and a write that breaks the diagram stops the turn.
 *
 * WHY THIS EXISTS
 *
 * Design and implementation are two loops. In the first, the operator and the agent draw a diagram
 * together and the agent is at its best: reasoning, confirming, rejecting against the real codebase. In
 * the second, that diagram stops being an output and becomes a CONSTRAINT — and nothing in a normal
 * harness knows that. The design sits in the prompt as prose the model can paraphrase, forget, or
 * "improve", competing for attention with everything else and losing a little on every summarization.
 *
 * What that produces, measured on a real sprint (36 designed types, 38 built): the model kept every
 * stated PROHIBITION — not one forbidden assembly reference — and quietly discarded the PRESCRIPTIONS.
 * Two specified integration points into existing code were never touched. A designed view layer of five
 * types vanished and six types in a different shape appeared instead. Two interfaces were invented for
 * no purpose but to mediate calls the diagram had going direct, one of them turning a direct method call
 * into a two-way dependency. The type COUNT barely moved, which is why review never caught it.
 *
 * The asymmetry behind that is not a competence gap. A prohibition on a named token is satisfied by not
 * typing it — free, local, verifiable without leaving the file. A prescription to USE WHAT EXISTS costs
 * tool calls to locate, read and trust something else, and it forbids solving the problem locally.
 * Inventing an interface costs one file and compiles first try. Cheap-and-wrong beats expensive-and-right
 * every round, forever, and no instruction changes that arithmetic.
 *
 * So this is not an instruction. It costs ZERO prompt tokens: nothing tells the model to obey the
 * design. A write that violates it does not land.
 *
 * WHAT IS AND IS NOT GUARANTEED
 *
 * Guaranteed, mechanically: no type exists that the design does not declare; every declared type
 * exists; no new public seam; no reference crossing a domain boundary the manifest forbids. Set
 * operations over parsed source — not talked around, not forgotten at round 40.
 *
 * NOT guaranteed: that a method BODY is right. Semantics like "the MAX of live multipliers, never the
 * product" live inside bodies and are invisible to a surface diff. This layer gives the skeleton, not
 * the flesh; the semantic half is a separate, judge-based pass and deliberately not here.
 *
 * BILATERAL, NOT FROZEN
 *
 * The gate exists to make every change NEGOTIATED rather than unilateral, which is a different thing
 * from preventing change. A first diagram is wrong; seams appear; that is normal and fine. What is not
 * fine is a decision made behind the architect's back. So a violation is: STOP · the gap · the options.
 * Amending the design is a first-class outcome, not a concession — it is how a design becomes reality
 * instead of acquiring a compatibility layer to bridge a divergence nobody declared.
 *
 * Detection must be per-write for a reason beyond cost. At round 3 a gap has two honest resolutions:
 * change the code, or change the design. Both are cheap; nothing depends on either yet. At round 40
 * twenty things consume the invention, the design can no longer be moved to meet the code, and the
 * adapter is the ONLY move left. Late detection does not merely cost more — it removes the
 * design-change option entirely.
 *
 * LANGUAGE-AGNOSTIC BY CONSTRUCTION
 *
 * The diagram is universal. Enforcement is not: a C# dependency unit is an `.asmdef`, a JS one is a
 * `package.json`, and Python's is something else again. So the CHECKS live in `check.ts` and know
 * nothing about any language, while a `SurfaceLanguage` per language answers two questions — what does
 * this file declare, and which domain does it belong to. Adding a language is one implementation, not a
 * change to the rules.
 */

/** How a type is declared. Normalized across languages; a JS class and a C# class are the same kind. */
export type TypeKind = 'class' | 'interface' | 'struct' | 'enum' | 'abstract';

export type Visibility = 'public' | 'private' | 'protected' | 'internal';

export type MemberKind = 'method' | 'field' | 'property' | 'event';

export interface DeclaredMember {
  name: string;
  kind: MemberKind;
  /** The declaration as written, so a signature can be compared and not merely a name. */
  sig?: string;
  /** Closure applies to the PUBLIC surface only — a private helper is the implementation freedom the
   *  operator explicitly wants. Over-constrain this and the model hides structure in tuples,
   *  dictionaries-as-objects and 200-line methods, which is worse and invisible to a type diff. */
  visibility: Visibility;
}

export interface DeclaredType {
  name: string;
  kind: TypeKind;
  members: DeclaredMember[];
}

/**
 * A dependency unit: the thing that has a manifest saying what it may reference. `.asmdef` in C#,
 * `package.json` in JS/TS. This is the concept the diagram's clusters correspond to.
 */
export interface Domain {
  /** As the manifest names it, e.g. an assembly name or a package name. */
  name: string;
  /** Absolute path of the manifest, so a violation can point at the file that forbids the reference. */
  manifest: string;
  /** References the manifest permits. Empty means "nothing outside itself". */
  allows: string[];
  /**
   * The manifest declares this unit closed to the platform/engine (C#'s `noEngineReferences`, a JS
   * package with no runtime deps). Kept separate from `allows` because it is the constraint most worth
   * naming in a violation — and, measured, the one a model actually respects.
   */
  sealed: boolean;
}

/** One language's answers. Nothing here knows what a rule is. */
export interface SurfaceLanguage {
  readonly id: string;
  /** By extension. Cheap, and wrong only for files nobody entangles. */
  handles(path: string): boolean;
  /** Walk up for the nearest manifest. null when the file is in no dependency unit. */
  domainOf(path: string): Domain | null;
  /** Types and members declared in this source. Declarations only — bodies are not parsed. */
  surfaceOf(source: string): DeclaredType[];
  /** Imported/referenced units, for checking against `Domain.allows`. */
  referencesOf(source: string): string[];
  /**
   * References that need no manifest entry because they are the PLATFORM, not a dependency.
   *
   * Load-bearing: a Unity `.asmdef` lists other *assemblies* in `references`, never BCL namespaces, and
   * `noEngineReferences` forbids the engine — not `System`. Checking every `using` against an empty
   * `references` array flagged `using System;`, which would have blocked the first line of every file in
   * a self-contained assembly. Each language owns its own baseline; the rules own none of it.
   */
  isPlatform(ref: string, domain: Domain): boolean;
  /**
   * Is this identifier a language/platform type rather than one the design should declare?
   *
   * Needed by the REFERENCE rule: a signature naming a type nobody designed is the same violation as
   * declaring one, and it is the FORM the trap took in the trial — `Feed(Telemetry)` where
   * `Telemetry` exists nowhere. But a signature is also full of `int`, `Dictionary<,>` and `Func<>`,
   * so the language has to say which names are its own furniture. When in doubt a language should answer
   * TRUE: a missed violation is a bad day, a false stop on `string` is an unusable tool.
   */
  isBuiltinType(name: string): boolean;
}

/** What the design says, normalized from a naama graph. Language-free by construction. */
export interface DesignedType {
  name: string;
  kind: TypeKind;
  /** The cluster/domain the diagram places it in, '' when the diagram does not say. */
  domain: string;
  /** Public member names the diagram declares. */
  members: string[];
  /**
   * The full designed surface: each member's signature and what it MUST DO.
   *
   * Kept so the design can be RETRIEVED one type at a time instead of read whole. Measured across three
   * trial runs: a 15 KB spec was re-read at five different offsets in one run, and a nine-type task never
   * finished in any of them. The model cannot hold 23 types and 131 members in a working set, and no
   * amount of nudging fixes a context problem — so the answer is to hand it one type, with its intent,
   * when it asks. Retrieve, never dump.
   */
  spec: Array<{ sig: string; intent?: string }>;
}

export interface Design {
  /** Where it came from, so a stop can name the file the operator should amend. */
  source: string;
  types: Map<string, DesignedType>;
  edges: Array<{ from: string; to: string; kind: string }>;
}

export type Rule = 'CLOSURE' | 'ADOPTION' | 'DOMAIN' | 'MEMBER' | 'REFERENCE' | 'SIGNATURE';

/**
 * STOP · the gap · the options — in that order, because that is the order the operator reads it in.
 * `options` are the agent's to fill: it just did the work and knows why it wanted the deviation, which
 * no graph query can reconstruct. The DETERMINISM is in raising the stop, never in the suggestion.
 */
export interface Violation {
  rule: Rule;
  /** The type, member or reference at fault. */
  subject: string;
  /** The file the write was landing in. */
  file: string;
  /** One sentence: what the design says and what this does instead. */
  gap: string;
}
