/**
 * indulge/hooks/types.ts — the two extension points that make a corpus project-TYPE aware.
 *
 * ayin is language-agnostic by construction, which is right for the loop and wrong for knowledge: a
 * Unity repo and an Arduino sketch have facts about them that no generic parser will ever derive, and
 * baking either into the core would make the core a liar about the other. So there are exactly two
 * hooks, and the split between them is a cost decision, not a taste one:
 *
 *   - **`Indulger.onChunkCreated`** runs during `ayin indulge` — an OVERNIGHT job where the operator
 *     has already accepted the cost. Anything expensive belongs here: scanning tens of thousands of
 *     Unity assets for GUID references, counting instances, walking asmdefs. The result is written
 *     onto the chunk and travels with it.
 *   - **`Attributor.attribute`** runs inside a tool call, on a turn the operator is waiting through.
 *     It must be a LOOKUP, not a scan — read what the chunk already carries, or derive something
 *     cheap from the bytes already in hand. A hook that greps the repo here turns `read_file` into a
 *     multi-second operation.
 *
 * The division exists because the expensive question ("what references this ScriptableObject?") and
 * the useful moment (the agent is reading that file right now) are hours apart. Doing the work at the
 * useful moment is what makes assistants slow; doing it overnight and looking it up is what makes
 * them feel instant.
 *
 * **Attribution states facts. It does not give advice.** "C# source · plain class · no Unity base
 * type" is attribution. "Remember that in Unity, scripts are .cs files" is a rules file with extra
 * steps — the model already knows that and it did not help. The distinction is the whole reason this
 * mechanism exists rather than a longer system prompt.
 */

import type { Chunk } from '../store.js';

/** What a tool call was about, handed to every attributor. */
export interface AttributionContext {
  /** Which tool produced this — `read_file`, `grep`, … */
  tool: string;
  /** Absolute repo root. Attributors may read from it, but must not SCAN it. */
  repoPath: string;
  /** Repo-relative path this attribution is about. Grep fires once per file it hit. */
  file: string;
  /** The file's contents, when the tool already had them. Never re-read for the hook's sake. */
  source?: string;
  /**
   * What retrieval already fetched for this file — the overnight work, free to read.
   * Empty when the corpus does not cover the file, which is itself worth reporting.
   */
  chunks: Chunk[];
}

/**
 * A project-type attributor. Ships built in, or dropped into `~/.ayin-cli/attributors/*.mjs`.
 *
 * `applies` is asked once per repo and cached: a Unity attributor should test for
 * `ProjectSettings/ProjectVersion.txt`, not sniff every file.
 */
export interface Attributor {
  /** Stable id. A local file with the same id REPLACES the built-in — that is how override works. */
  id: string;
  /** Does this attributor have anything to say about this repo at all? Asked once, cached. */
  applies(repoPath: string): boolean;
  /**
   * One line the operator would have said out loud, or null.
   *
   * Returned as TEXT so the pack owns its wording; the caller owns the budget and truncates. Null is
   * the common case and must stay cheap — most files deserve no annotation.
   */
  attribute(ctx: AttributionContext): string | null;
  /**
   * The framing sentence, emitted ONCE per session and never again.
   *
   * Separate from `attribute` on purpose. Repeating "this is a Unity project" on every tool result is
   * how an attribution system decays into the preamble it was built to replace.
   */
  sessionPreamble?(repoPath: string): string | null;
}

/** What an indulger is given when a chunk is about to be written. */
export interface IndulgeContext {
  repoPath: string;
  /** Repo-relative path the chunk is about. */
  file: string;
  /** The file's contents, already read by the caller. */
  source: string;
}

/**
 * A project-type indulger — the expensive half, run once per chunk during the overnight build.
 *
 * Writes into `chunk.ext[id]`, a namespaced bag. Namespaced because two packs will otherwise both
 * want `references` and neither will know the other took it.
 *
 * Whatever lands there is a snapshot, not a live view: a reference count computed tonight says
 * nothing about a prefab added tomorrow. Stamp it, and let the reader discount it.
 */
export interface Indulger {
  id: string;
  applies(repoPath: string): boolean;
  /** Extra facts for this chunk, or null. Returned rather than mutated, so the caller owns the write. */
  onChunkCreated(chunk: Chunk, ctx: IndulgeContext): Record<string, unknown> | null;
}
