/**
 * present.ts — what plan mode LOOKS LIKE while it runs.
 *
 * Planning is the longest silent stretch in a turn: triage, a survey, a scaffold, research, one or two
 * long generations. The operator sits through all of it, and what they saw was eight flat lines that
 * each began with the same two words:
 *
 *     Plan mode: 3 feature(s) detected in 128 chars — planning before executing. …
 *     Plan mode: node (greenfield) — the request (no project files on disk yet) → "node" plan executor.
 *     Plan mode: created /tmp/demo/.git, /tmp/demo/package.json, /tmp/demo/tsconfig.json, …9 abs paths…
 *     Plan mode: grounding the plan in the node reference material rather than recall.
 *     Plan mode: 1 phase(s), 1 step(s) across them, 4 model call(s), validated.
 *       /tmp/demo/ayin-plan-20260902-092646-1-verify-project-integrity-and-readiness.md
 *     Plan written: /tmp/demo/ayin-plan-20260902-092646.md
 *
 * Everything is there and none of it is legible. The prefix repeats on every line, so it carries no
 * information; the paths are absolute and share a long identical head, so the part being reported
 * starts a third of the way in; and the PHASES — the thing most worth judging, because they are what
 * will actually be worked — appear only as filenames.
 *
 * SO PLANNING NOW RENDERS AS CARDS, the same shape a tool call already uses: a headline message, then
 * one card per stage, each rolling in as that stage finishes with its own glyph and elapsed time. It
 * is not a new widget — `formatToolCallForChat` / `formatToolResultForChat` are the existing pair, so
 * plan stages inherit the indent, the spacing, the ✓ footer and the cost label for free, and the
 * transcript reads as one sequence instead of two shapes competing.
 *
 * These strings are painted, never sent to a model — the emoji cost the operator's screen and nothing
 * else. They are two cells wide, which the layout knows: see `ui/width.ts`.
 */

import { relative } from 'node:path';

/** One glyph per stage, so the sequence reads as a sequence rather than a list of sentences. */
export const PLAN_GLYPH = {
  triage: '🧭',
  survey: '🧩',
  scaffold: '🏗️',
  research: '🔭',
  grounding: '📚',
  phases: '🗂️',
  steps: '🪜',
  write: '📄',
} as const;

/** Card ids. Prefixed so they cannot collide with a real tool, and so `PREVIEW_LINES` can budget them. */
export const PLAN_CARD = {
  triage: 'plan:triage',
  survey: 'plan:survey',
  scaffold: 'plan:scaffold',
  research: 'plan:research',
  grounding: 'plan:grounding',
  phases: 'plan:phases',
  steps: 'plan:steps',
  write: 'plan:write',
} as const;

/**
 * A path as the operator can actually place it: relative to the project when it is inside it.
 *
 * Absolute paths in this output share a long identical prefix, so every one wraps and the differing
 * tail is what gets lost. Falls back to the absolute path when the file is genuinely elsewhere,
 * because `../../../..` is worse than the truth.
 */
export function shortPath(path: string, root: string): string {
  if (!root || !path.startsWith(root)) return path;
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

/** `a · b · c · d`, wrapped so a nine-file scaffold is three readable rows rather than one long one. */
export function columns(items: string[], perLine = 4): string {
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += perLine) rows.push(items.slice(i, i + perLine).join(' · '));
  return rows.join('\n');
}

/** One phase as the operator needs it: what the stage IS, how it will be judged, and where it lives. */
export interface PhaseLine {
  id: number;
  title: string;
  goal: string;
  /** null when the sub-plan could not be drafted — a hole in the job, said out loud. */
  steps: number | null;
  file: string;
}

/**
 * The phase list, as a card body.
 *
 * `done when` is the line that lets someone stop a bad breakdown before it runs for ten minutes, so it
 * sits directly under the title. The filename is last and least: it matters when something goes wrong,
 * not while deciding whether the plan is right.
 */
export function phaseBody(phases: PhaseLine[], root: string): string {
  const out: string[] = [];
  for (const p of phases) {
    const steps = p.steps === null ? '⚠️ NOT PLANNED' : `${p.steps} step${p.steps === 1 ? '' : 's'}`;
    out.push(`${p.id} ▸ ${p.title}  ·  ${steps}`);
    if (p.goal.trim()) out.push(`    ✓ done when: ${p.goal.trim()}`);
    if (p.file) out.push(`    · ${shortPath(p.file, root)}`);
  }
  return out.join('\n');
}
