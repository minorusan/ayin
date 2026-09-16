/**
 * file-view.ts — a file is materialized into the window ONCE, and re-reads return what changed.
 *
 * THE MEASUREMENT THIS EXISTS FOR. On pylint-4551 the agent ran 348 rounds and produced no edit. It
 * read `inspector.py` and its siblings over and over, and every re-read landed in the window IN FULL,
 * because the only deduplication ayin had keyed on byte-equality of the whole message — and the guard
 * appended `[REPEAT 3: …]`, with an incrementing counter, to exactly the messages that were repeats. No
 * two copies were ever equal, so nothing was ever collapsed: 101 repeat warnings, 18 dedupes. The
 * mechanism that DETECTED the waste was the mechanism that made it uncollapsible.
 *
 * So the rule here is not "refuse the re-read". A re-read is often legitimate — a third party edited the
 * file, a test rewrote a fixture — and no guard can tell that from a loop without looking at the bytes.
 * This looks at the bytes:
 *
 *   - first read of a region  → the contents, in full, and they STAY where they are
 *   - re-read, bytes same     → one line saying so, pointing up the window
 *   - re-read, bytes changed  → a diff against what is already up there
 *
 * PREFIX-CACHE SAFE, which the alternatives were not. `dedupeRepeatedResults` and `compressOldest` both
 * rewrite older messages in place, invalidating the KV prefix from that point. Nothing here touches a
 * message already in the window; only the new tail message is short. Append-only.
 */

import { createHash } from 'node:crypto';
import { log } from './log.js';

interface Message { role: string; content: string }

/** What we put in the window for one (file, region), and the bytes it showed. */
interface View {
  /** The exact message body pushed, so presence can be checked against the live window. */
  pushed: string;
  /** Hash of the RAW tool result, to answer "did the bytes change" without keeping two copies. */
  hash: string;
  /** The result as shown, so a later diff has something to diff against. */
  shown: string;
}

const views = new Map<string, View>();

/** Cleared with the turn — a view is a claim about THIS window, and the window is gone. */
export function resetFileViews(): void { views.clear(); }

/** Tools whose result is the contents of a named region of a named file. */
const VIEW_TOOLS = new Set(['read_file']);

const hashOf = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * The region key. A FILE IS NOT THE UNIT — a region is.
 *
 * `read_file(models.py, offset=340, limit=80)` and `read_file(models.py)` are not the same question, and
 * answering the second with a diff against the first would hand the model a diff of bytes it has never
 * seen. Different region ⇒ different view ⇒ materialized on its own terms.
 */
function keyOf(params: Record<string, unknown>): string | null {
  const path = String(params.path ?? params.file ?? '').trim();
  if (!path) return null;
  return `${path}|${params.offset ?? ''}|${params.limit ?? ''}`;
}

/**
 * A line diff via common prefix/suffix trim.
 *
 * Deliberately not an LCS. The edits this sees are a model changing a few lines of a source file, where
 * trimming the matching head and tail leaves exactly the changed block — and when it does not (a
 * wholesale rewrite), the honest answer is to show the new contents rather than a clever minimal script
 * nobody can read. `null` means "too different to be worth calling a diff".
 */
function diffLines(before: string, after: string): string | null {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  // A change bigger than the file's own body is not a diff, it is a different file.
  if (removed.length + added.length > Math.max(a.length, b.length)) return null;
  const CONTEXT = 3;
  const ctxBefore = a.slice(Math.max(0, head - CONTEXT), head);
  const ctxAfter = a.slice(a.length - tail, Math.min(a.length, a.length - tail + CONTEXT));
  return [
    `@@ line ${head + 1} @@`,
    ...ctxBefore.map((l) => `  ${l}`),
    ...removed.map((l) => `- ${l}`),
    ...added.map((l) => `+ ${l}`),
    ...ctxAfter.map((l) => `  ${l}`),
  ].join('\n');
}

export interface Shaped {
  body: string;
  /** True when the body already says "nothing changed" — the guard's REPEAT paragraph would only repeat it. */
  suppressRepeatNote: boolean;
}

/**
 * Shape a tool result for the window: full contents, a pointer, or a diff.
 *
 * `window` is passed rather than imported so the decision is DERIVED FROM WHAT IS ACTUALLY THERE. A
 * separate map of "files the model has" drifts the moment the trimmer evicts one, and the model then
 * gets a diff against something invisible — the same class of bug `compressOldest` guards with its
 * `canonical` set. If the copy is not in the window, there is no copy, and we materialize again.
 */
export function shapeFileResult(
  tool: string, params: Record<string, unknown>, result: string, clipped: string, window: Message[],
): Shaped {
  if (!VIEW_TOOLS.has(tool) || result.startsWith('Error:')) return { body: clipped, suppressRepeatNote: false };
  const key = keyOf(params);
  if (!key) return { body: clipped, suppressRepeatNote: false };

  const prior = views.get(key);
  const present = prior ? window.some((m) => m.content.includes(prior.pushed)) : false;
  if (!prior || !present) {
    views.set(key, { pushed: clipped, hash: hashOf(result), shown: clipped });
    if (prior && !present) log('INFO', 'file_view_rematerialized', { key });
    return { body: clipped, suppressRepeatNote: false };
  }

  if (hashOf(result) === prior.hash) {
    log('INFO', 'file_view_unchanged', { key });
    return {
      body: `${key.split('|')[0]} is unchanged since it was read earlier in this turn — its contents are `
        + `already above in this conversation. Nothing here is new; scroll up rather than reading it again.`,
      suppressRepeatNote: true,
    };
  }

  const d = diffLines(prior.shown, clipped);
  views.set(key, { pushed: prior.pushed, hash: hashOf(result), shown: clipped });
  if (d === null) {
    log('INFO', 'file_view_rewritten', { key });
    return { body: clipped, suppressRepeatNote: true };
  }
  log('INFO', 'file_view_diffed', { key, diffChars: String(d.length) });
  return {
    body: `${key.split('|')[0]} CHANGED since you read it earlier in this turn. The full earlier contents `
      + `are above; this is what is different now:\n\n${d}`,
    suppressRepeatNote: true,
  };
}
