/**
 * `undo_edit` — put back the bytes one of your own edits replaced.
 *
 * WHY IT EXISTS. An agent that can write had no way to unwrite. Measured twice in a week: a model
 * made a deliberate test edit to exercise the write path, reached for `git checkout -- <file>` to
 * put it back, and the permission guard refused that automatically — correctly, because a blanket
 * checkout discards every other uncommitted thing in the file. The test edit stayed in the
 * operator's tree, and the model's report called it the single most annoying interaction of the
 * session. The guard was right; the only revert on offer was too blunt.
 *
 * This is the precise one. `edits/ledger.ts` recorded the exact bytes before the edit and the hash
 * of what the edit produced, so a revert is "restore what THIS edit replaced, provided the file is
 * still what it left" — not "reset this path from HEAD", which is what the guard is there to stop.
 *
 * NEWEST FIRST, ONE AT A TIME, and it refuses rather than guesses: an out-of-order undo would write
 * over a later edit, and a file that something else has touched since is reported instead of
 * silently overwritten. Both refusals name what to do next, and `force` is there for when the
 * operator has looked and decided.
 */

import type { Tool } from '../base.js';
import { undoLast } from '../../edits/ledger.js';

export const tool: Tool = {
  name: 'undo_edit',
  icon: '↩️',
  description:
    'Revert your most recent edit, restoring the exact bytes it replaced. Pass a path to undo the '
    + 'last edit to one file. Call it again to walk further back, newest first. It REFUSES when '
    + 'something other than a recorded edit has written the file since, rather than discarding that '
    + 'silently — read the file, then pass force=true if you still want the old bytes. Use this '
    + 'instead of git checkout to undo your own work: it touches one edit, not the whole file.',
  parameters: [
    { name: 'path', type: 'string', description: 'Undo the last edit to THIS file. Omit to undo the most recent edit anywhere.', required: false },
    { name: 'force', type: 'string', description: 'true to proceed even though the file changed since the edit, or the edit is not the newest for that file. Only after reading it.', required: false },
  ],

  async execute(params) {
    const outcome = undoLast({
      path: params.path ? String(params.path) : undefined,
      force: String(params.force ?? '').toLowerCase() === 'true',
    });
    return outcome.message;
  },
};
