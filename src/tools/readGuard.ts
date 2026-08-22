import { readFileSync, statSync } from 'node:fs';
import { resolveAgainstCwd } from './lib.js';
import { type Span, describeSpans, mergeSpans, spanLines } from './readWindow.js';

/**
 * READ BEFORE YOU EDIT, AND READ BACK AFTER — enforced by refusal, not asked for in a prompt.
 *
 * The invariant: **an edit to a region this process has not read is refused, and every write is read
 * back off the disk before it is reported as done.**
 *
 * WHY IT IS A REFUSAL. An edit written from memory is an edit against a file that may not look the way
 * the model believes it does — a previous tool truncated it, something else on the machine changed it,
 * or it is recalling a different file with a similar name. `str_replace` hides this failure by its own
 * design: "old_str not found" reads exactly like a quoting mistake, so the response is to retry with
 * looser, fuzzier context until *something* matches — and the thing it eventually matches is not the
 * thing it meant. The edit then succeeds, returns a clean diff, and is wrong. Nothing downstream can
 * tell. A hint in a system prompt cannot fix that, because the model is not being disobedient; it is
 * being confidently mistaken, which is the one failure a prompt cannot catch.
 *
 * WHY LINE RANGES AND NOT JUST PATHS. `read_file` caps a read at `READ_MAX_LINES` (800). So "I have
 * read this file" can be *true* about a 5000-line file while the edit lands at line 4012, in the four
 * fifths that were never returned — a path-level guard passes that and it is the same edit-from-memory
 * it was built to stop. `str_replace` already locates its match before writing, so the line number is
 * free; the check is therefore made where it is precise.
 *
 * THE RULES, and the deliberate holes in them:
 *  1. **Editing needs a prior read that COVERS the edited lines.** The refusal names the tool and the
 *     line, because a guard that only says "no" gets worked around — with a shell `sed`, which is the
 *     same edit with no diff and no gate.
 *  2. **The read must still be valid.** Size and mtime are captured at read time and compared at edit
 *     time. This is the case the guard actually earns its keep on: the model remembering honestly, and
 *     the file having changed underneath it anyway.
 *  3. **CREATING a file needs no read.** There is nothing to have read. Requiring one would make the
 *     rule absurd, and an absurd rule is one the next person deletes wholesale.
 *  4. **A write records a fresh, WHOLE-file read.** Consecutive edits to one file do not need a read
 *     wedged between every pair — the read-back already happened, over the entire file. Without this
 *     the guard would teach the model to emit ceremonial reads to satisfy a formality, which is pure
 *     context spend for no safety.
 *
 * PATHS ARE NORMALISED HERE, and that is load-bearing rather than tidy: `read_file` resolves through
 * `resolveAgainstCwd` while `write_file` takes `params.path` as given, so reading `src/a.ts` and then
 * writing `src/a.ts` arrive as two different strings for the same file. Keying on the raw parameter
 * would refuse a file that had just been read — a guard that fires on correct behaviour is a guard
 * that gets ripped out, taking the real check with it.
 *
 * Scope is the PROCESS, which is the session: one ayin process serves one conversation, so there is
 * nothing finer to scope to and no need for a session id.
 */

interface ReadMark {
  size: number;
  mtimeMs: number;
  at: number;
  /** Merged, sorted spans of lines the model has actually seen. */
  spans: Span[];
  /** Total lines in the file at read time — so "whole file" is answerable. */
  lines: number;
}

const reads = new Map<string, ReadMark>();

/** A long session touches many files; keep the map bounded. Eviction costs one extra read. */
const MAX_PATHS = 500;

function key(path: string): string {
  try {
    return resolveAgainstCwd(path);
  } catch {
    return path;
  }
}

function stat(path: string): { size: number; mtimeMs: number; at: number } | null {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs, at: Date.now() };
  } catch {
    return null;
  }
}

const merge = (spans: Span[], add: Span): Span[] => mergeSpans([...spans, add]);

function covers(spans: Span[], from: number, to: number): boolean {
  return spans.some((s) => s[0] <= from && s[1] >= to);
}

const coveredCount = spanLines;
const describe = describeSpans;

/**
 * Record that a file was read.
 *
 * `span` is the inclusive 1-based line range actually returned; omit it to mean the whole file (which
 * is what a read-back after a write means, since the write knows the entire content).
 */
export function recordRead(path: string, span?: Span, totalLines?: number): void {
  const k = key(path);
  const st = stat(k);
  if (!st) return;
  if (reads.size >= MAX_PATHS && !reads.has(k)) {
    const oldest = [...reads.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) reads.delete(oldest[0]);
  }
  const prev = reads.get(k);
  // A file that changed since the last read invalidates the spans recorded against the old bytes.
  const stale = !!prev && (prev.size !== st.size || prev.mtimeMs !== st.mtimeMs);
  const lines = totalLines ?? prev?.lines ?? 0;
  const whole: Span = [1, Math.max(1, lines)];
  const addition = span ?? whole;
  reads.set(k, {
    ...st,
    lines,
    spans: stale || !prev ? merge([], addition) : merge(prev.spans, addition),
  });
}

export interface Where {
  /** The 1-based line the edit starts at, when the caller knows it. */
  atLine?: number;
  /** The 1-based line the edit ends at. */
  toLine?: number;
  /** True when the operation replaces the ENTIRE file (write_file over an existing one). */
  whole?: boolean;
}

/**
 * The gate. Returns a refusal string to hand straight back as the tool result, or `null` to proceed.
 *
 * A string return rather than a throw, matching every other check in these tools: ayin's tools report
 * their own errors as text the model reads, and an exception here would surface as a transport-level
 * failure instead of an instruction the model can act on.
 */
export function requireRead(path: string, tool: string, where: Where = {}): string | null {
  const k = key(path);
  const now = stat(k);
  if (!now) return null; // does not exist: a create, not an edit

  if (waived === k) {
    waived = null;
    return null;
  }

  const mark = reads.get(k);
  if (!mark) {
    return `Error: ${tool} refused — you have not read ${path} in this session, so this edit would be `
      + `written from memory against a file you have not seen.\n`
      + `Read it first (read_file ${path}), then make the edit.\n`
      + `This is enforced rather than suggested because the failure it prevents is invisible: a wrong `
      + `old_str reads like a quoting mistake, gets retried with looser context, and eventually matches `
      + `the wrong place and returns a clean diff.`;
  }
  if (mark.size !== now.size || mark.mtimeMs !== now.mtimeMs) {
    const when = new Date(mark.mtimeMs).toISOString().slice(11, 19);
    return `Error: ${tool} refused — ${path} changed on disk since you read it `
      + `(you saw ${mark.size} B, modified ${when}; it is now ${now.size} B). Your copy is stale.\n`
      + `Read it again (read_file ${path}) and redo the edit against what is actually there — the text `
      + `you are matching against may no longer exist, or may now appear somewhere you do not intend.`;
  }

  // ── coverage: was the part being changed actually returned to you? ──
  if (mark.lines > 0) {
    if (where.whole && coveredCount(mark.spans) < mark.lines) {
      return `Error: ${tool} refused — this replaces all ${mark.lines} lines of ${path}, but you have `
        + `only read lines ${describe(mark.spans)} of it (${coveredCount(mark.spans)} of ${mark.lines}).\n`
        + `Rewriting a file you have seen part of is how content silently disappears: whatever you did not `
        + `read is not in the replacement you are about to write.\n`
        + `Either read the rest (read_file ${path} again — with no offset it SLIDES to the next part you `
        + `have not read) or, better, use `
        + `str_replace to change only the lines you mean to change.`;
    }
    const from = where.atLine;
    const to = where.toLine ?? where.atLine;
    if (from !== undefined && to !== undefined && !covers(mark.spans, from, to)) {
      return `Error: ${tool} refused — the text you are replacing is at line${from === to ? ` ${from}` : `s ${from}-${to}`} `
        + `of ${path}, and you have not read that part: you have seen lines ${describe(mark.spans)} `
        + `(the file has ${mark.lines}).\n`
        + `read_file ${path} around=${from} first — that returns a window CENTRED on that line, with `
        + `the context on both sides. A match found in text you have not seen is a match you cannot know `
        + `is the right one.`;
    }
  }
  return null;
}

export interface ReadBack {
  ok: boolean;
  /** One line for the tool result. Silence and success must not look the same. */
  note: string;
}

/**
 * The second half: prove the write landed by reading it back, and re-arm the guard.
 *
 * `expected` is compared in full, not by length — the content is already in memory here, so a byte
 * comparison is free and catches an encoding mangle or a partial write that a size check would pass.
 */
export function readBackAfter(path: string, expected: string): ReadBack {
  const k = key(path);
  const st = stat(k);
  if (!st) return { ok: false, note: `read-back FAILED: nothing exists at ${path} after the write.` };
  let actual: string;
  try {
    actual = readFileSync(k, 'utf-8');
  } catch (e) {
    return { ok: false, note: `read-back FAILED: cannot re-read ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (actual !== expected) {
    return {
      ok: false,
      note: `read-back MISMATCH: ${path} holds ${st.size} B on disk but that is not what was written `
        + `(${Buffer.byteLength(expected)} B expected). The file was NOT written as intended — re-read it `
        + `before trusting the diff above.`,
    };
  }
  // The write is now the freshest possible whole-file read, so record it as one.
  recordRead(k, undefined, actual.split('\n').length);
  return { ok: true, note: `read back from disk: ${st.size} B, byte-identical to what was written.` };
}

/**
 * A ONE-SHOT, single-purpose exemption for the headless CTA force-write.
 *
 * This exists for exactly one call site (`agent.ts`, `cta_force_write`): headless mode has run out of
 * rounds and is forcing the deliverable to disk. That write is initiated by the SYSTEM, not chosen by
 * the model, and if the guard refuses it the run delivers nothing at all while its log says otherwise.
 * A refusal there is strictly worse than an overwrite, so the requirement is waived — once, for one
 * path, consumed on use, and never for an edit the model asked for.
 *
 * The read-BACK still applies. What is waived is "did you read it first", never "did it land".
 */
let waived: string | null = null;

export function waiveReadOnce(path: string): void {
  waived = key(path);
}

export interface Coverage {
  /** Merged spans of lines already returned to the model. */
  spans: Span[];
  /** The file's line count as of that read. */
  lines: number;
}

/**
 * What has already been read of this file, or `null` if nothing has — or if the file has CHANGED since,
 * which makes the recorded spans describe bytes that are gone. Returning stale coverage would slide a
 * read past lines it never actually saw, which is the same lie as the guard passing a stale edit.
 */
export function coverage(path: string): Coverage | null {
  const k = key(path);
  const mark = reads.get(k);
  if (!mark) return null;
  const now = stat(k);
  if (!now || now.size !== mark.size || now.mtimeMs !== mark.mtimeMs) return null;
  if (mark.lines <= 0) return null;
  return { spans: mergeSpans(mark.spans), lines: mark.lines };
}

/** For gates: how many paths are marked read. */
export function readCount(): number {
  return reads.size;
}

/** For gates: forget everything. There is no other way to reset an in-memory guard. */
export function _resetReadGuard(): void {
  reads.clear();
}
