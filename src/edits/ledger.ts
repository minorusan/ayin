/**
 * ledger.ts — every edit the agent made, in order, with the file's fingerprint at the time.
 *
 * WHY THIS EXISTS. An agent that can write had no way to UNWRITE. Measured twice in one week: a model
 * made a deliberate test edit to a prefab to exercise the write path, tried `git checkout -- <file>`
 * to put it back, and the permission guard refused that automatically — correctly, since a blanket
 * checkout discards whatever else is uncommitted. So the test edit stayed in the operator's tree, and
 * the model's own report called it "the single most annoying interaction this session". The guard was
 * not the defect. The defect was that the only revert available was a blunt one.
 *
 * WHAT MAKES A PRECISE REVERT POSSIBLE is recording, at the moment of the write, three things a git
 * checkout can never reconstruct: the exact bytes before, the fingerprint of the file the edit
 * PRODUCED, and the order. With those, undo is not "restore this path from HEAD" — it is "put back
 * the bytes this specific edit replaced, provided the file is still the one that edit produced".
 *
 * THE FINGERPRINT IS THE WHOLE POINT OF THE DESIGN. Between an edit and its undo, anything may have
 * touched the file: a later agent edit, the Unity editor rewriting an asset, the operator in their
 * own editor, a rebase. Restoring blindly would silently destroy all of it. So every record carries
 * `afterSha`, the hash of what the edit wrote, and an undo compares it against the file as it is now.
 * Equal means nothing has happened since and the revert is exact. Different means somebody else
 * wrote, and that is REPORTED rather than papered over — which is the difference between a tool you
 * can trust before a delete and one you cannot.
 *
 * A QUEUE, NEWEST FIRST. Edits to one file stack, and the only reversal that is safe without
 * re-deriving the whole chain is the most recent one — undo it, and the one beneath it becomes the
 * top of the stack with its own `afterSha` now matching. Undoing out of order is refused for the
 * same reason the fingerprint exists.
 *
 * ON DISK, because a turn that dies holding this in memory leaves the operator with edits and no
 * record of them (CLAUDE.md §5). The ledger is JSONL under `.ayin/edits/`; the replaced bytes are
 * content-addressed blobs beside it, so ten edits that all revert to the same text cost one copy.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ensureAyinDir } from '../ayin-dir.js';
import { log } from '../log.js';

/** One write, as it happened. Plain JSON — this file is read back by a later process. */
export interface EditRecord {
  /** 1-based, global, and the undo order read backwards. */
  seq: number;
  /** Absolute at the time of writing; rendered relative for a human. */
  path: string;
  tool: string;
  at: string;
  /** One line: what the tool said it did. */
  summary: string;
  /** sha256 of the file BEFORE. Empty string when the edit CREATED the file. */
  beforeSha: string;
  /** sha256 of the file AFTER — what an undo checks the current file against. */
  afterSha: string;
  /** Content-addressed blob holding the bytes before, or '' when there were none. */
  blob: string;
  undone?: boolean;
}

export const NO_FILE = '';

/**
 * A path the operator can place — relative inside the tree, absolute when it is genuinely elsewhere.
 *
 * `relative()` alone answers `../../../tmp/x` when the cwd and the target differ only by a symlink,
 * which on macOS is every path under /tmp (`/tmp` -> `/private/tmp`). Same rule as `shortPath` in
 * plan/present.ts, for the same reason: a path that starts with three `..` is worse than the truth.
 */
export function displayPath(abs: string, cwd: string): string {
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `.ayin/edits/` — the ledger and its blobs. Created on first write, never in the work tree. */
function dir(cwd = process.cwd()): string {
  return ensureAyinDir(cwd, 'edits');
}

function ledgerFile(cwd = process.cwd()): string {
  return join(dir(cwd), 'ledger.jsonl');
}

/** Read a file as text, or null when it does not exist / cannot be read as text. */
export function readIfPresent(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Record one write. `before` is null when the file did not exist.
 *
 * Returns the record, or null when there was nothing to record — a tool that reported success without
 * changing the bytes is not an edit, and a ledger full of no-ops makes the real entries hard to find.
 */
export function recordEdit(args: {
  path: string; tool: string; before: string | null; after: string | null; summary: string; cwd?: string;
}): EditRecord | null {
  const { path, tool, before, after, summary } = args;
  const cwd = args.cwd ?? process.cwd();
  const beforeSha = before === null ? NO_FILE : sha(before);
  const afterSha = after === null ? NO_FILE : sha(after);
  if (beforeSha === afterSha) return null;

  let blob = '';
  try {
    const d = dir(cwd);
    if (before !== null) {
      // CONTENT-ADDRESSED, so a file edited ten times back to the same text costs one blob, and a
      // half-written backup can never be mistaken for a good one — the name IS the checksum.
      blob = join(d, 'blobs', `${beforeSha}.bak`);
      mkdirSync(join(d, 'blobs'), { recursive: true });
      if (!existsSync(blob)) writeFileSync(blob, before);
    }
    const seq = nextSeq(cwd);
    const record: EditRecord = { seq, path: resolve(path), tool, at: new Date().toISOString(), summary: summary.trim().slice(0, 300), beforeSha, afterSha, blob };
    appendFileSync(ledgerFile(cwd), `${JSON.stringify(record)}\n`);
    log('INFO', 'edit_recorded', { seq: String(seq), tool, path: relative(cwd, resolve(path)) });
    return record;
  } catch (err) {
    // A ledger that cannot be written must never cost the edit that was already made.
    log('WARN', 'edit_record_failed', { path, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function nextSeq(cwd: string): number {
  const all = history(undefined, cwd);
  return all.length ? Math.max(...all.map((r) => r.seq)) + 1 : 1;
}

/**
 * Every recorded edit, oldest first — the whole ledger, or one file's slice of it.
 *
 * Deltas are appended, never rewritten, so an `undone` flag arrives as a second line for the same
 * seq and the later line wins. That keeps the file append-only, which is what makes it safe to write
 * from a process that may be killed at any moment.
 */
export function history(path?: string, cwd = process.cwd()): EditRecord[] {
  const file = ledgerFile(cwd);
  if (!existsSync(file)) return [];
  const bySeq = new Map<number, EditRecord>();
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as EditRecord;
      if (typeof r.seq !== 'number') continue;
      bySeq.set(r.seq, { ...(bySeq.get(r.seq) ?? {}), ...r });
    } catch { /* a torn last line from a kill — the records before it are still good */ }
  }
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  if (!path) return all;
  const want = resolve(path);
  return all.filter((r) => r.path === want);
}

/** What the file looks like NOW relative to what an edit left behind. */
export type EditState = 'current' | 'superseded' | 'undone' | 'changed-outside' | 'gone';

/**
 * Where this record stands, which is the column a reader actually needs.
 *
 * `superseded` and `changed-outside` are DIFFERENT and the distinction is the reason the ledger
 * exists: a later recorded edit explains the difference, and nothing explains it when an editor or a
 * rebase wrote the file behind us. Only the second is a reason to stop.
 */
export function stateOf(r: EditRecord, all: EditRecord[]): EditState {
  if (r.undone) return 'undone';
  const now = readIfPresent(r.path);
  const nowSha = now === null ? NO_FILE : sha(now);
  if (nowSha === r.afterSha) return 'current';
  if (now === null && r.afterSha !== NO_FILE) return 'gone';
  const later = all.filter((o) => o.path === r.path && o.seq > r.seq && !o.undone);
  return later.length ? 'superseded' : 'changed-outside';
}

export interface UndoOutcome {
  ok: boolean;
  record?: EditRecord;
  message: string;
}

/**
 * Undo the most recent recorded edit — to one file, or anywhere.
 *
 * REFUSES when the file is not the one that edit produced, unless `force`. That refusal is the whole
 * feature: the alternative is silently discarding whatever wrote the file in between, which on a
 * Unity project is routinely the editor itself.
 */
export function undoLast(opts: { path?: string; force?: boolean; cwd?: string } = {}): UndoOutcome {
  const cwd = opts.cwd ?? process.cwd();
  const all = history(undefined, cwd);
  const want = opts.path ? resolve(opts.path) : '';
  const pool = want ? all.filter((r) => r.path === want) : all;
  const target = [...pool].reverse().find((r) => !r.undone);
  if (!target) {
    return { ok: false, message: opts.path ? `No recorded edit to ${opts.path} is still standing.` : 'No recorded edit is still standing — nothing to undo.' };
  }

  const state = stateOf(target, all);
  const rel = displayPath(target.path, cwd);

  if (state === 'changed-outside' && !opts.force) {
    return {
      ok: false,
      record: target,
      message: `REFUSED — ${rel} is not the file edit #${target.seq} produced. Something wrote it since, and it `
        + 'was not a recorded edit: the Unity editor, your own editor, a checkout or a rebase. Undoing would '
        + 'discard that silently.\n'
        + `  the edit left: ${target.afterSha.slice(0, 12)}\n`
        + `  the file is:   ${(readIfPresent(target.path) === null ? NO_FILE : sha(readIfPresent(target.path) as string)).slice(0, 12) || '(no file)'}\n`
        + '  Read it, decide, then pass force=true if you still want the pre-edit bytes back.',
    };
  }
  if (state === 'superseded' && !opts.force) {
    return {
      ok: false,
      record: target,
      message: `REFUSED — edit #${target.seq} to ${rel} is not the most recent edit to that file. Undo them `
        + 'newest first, or the older revert writes over the newer edit. Undo the later one and try again.',
    };
  }

  try {
    if (target.beforeSha === NO_FILE) {
      // The edit CREATED the file, so putting it back means removing it.
      rmSync(target.path, { force: true });
    } else {
      const bytes = readIfPresent(target.blob);
      if (bytes === null) {
        return { ok: false, record: target, message: `Cannot undo edit #${target.seq}: its backup blob is missing (${target.blob}).` };
      }
      writeFileSync(target.path, bytes);
    }
  } catch (err) {
    return { ok: false, record: target, message: `Cannot undo edit #${target.seq}: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    appendFileSync(ledgerFile(cwd), `${JSON.stringify({ ...target, undone: true, undoneAt: new Date().toISOString() })}\n`);
  } catch { /* the file is already restored; the flag is bookkeeping */ }
  log('INFO', 'edit_undone', { seq: String(target.seq), path: rel, forced: String(opts.force === true) });

  const what = target.beforeSha === NO_FILE ? 'removed (the edit had created it)' : 'restored to its bytes before that edit';
  return { ok: true, record: target, message: `Undid edit #${target.seq} — ${rel} ${what}.${opts.force && state !== 'current' ? `\nFORCED over a ${state} file, as asked.` : ''}` };
}

/** Testing and a fresh turn in the same process. */
export function _resetLedgerForTest(cwd = process.cwd()): void {
  try { rmSync(join(dir(cwd), 'ledger.jsonl'), { force: true }); } catch { /* nothing written yet */ }
}
