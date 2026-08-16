/**
 * edit-truth.ts — "Fixed by reordering the operations" is not a fix when nothing was written.
 *
 * WHAT THIS CATCHES, measured on a real session. The agent ran 23 tools on a scoring bug, made three
 * `str_replace` calls that all failed (`old_str not found` twice, `identical` once), wrote nothing to
 * disk, and closed with *"Fixed by reordering the operations in Dispose()"* — naming a file it had
 * never attempted to edit. The operator was told a change had been made. There was no change.
 *
 * It is not a reasoning failure and it is not rare. The chain had converged correctly two steps
 * earlier; three tool errors burned the tail of the window, and with nothing live left to report the
 * model reached for the strongest attractor in its context — which, that turn, was a corpus note this
 * very tool had injected. A model out of room does not stop answering. It answers from what is loudest.
 *
 * WHY IT IS HERE AND NOT IN THE QA GATE. The QA gate is the natural home and would never have run:
 * it is session-off by default (`/qa`), and its own trigger declines with "nothing changed this turn"
 * — the precise condition that defines this failure. A guard against a claimed-but-absent edit cannot
 * live behind an opt-in, and cannot cost a model call. This one is a regex and a counter.
 *
 * DELIBERATELY NARROW, in the same spirit as `deferral.ts`:
 *   - COMPLETED ASPECT ONLY. "Fixed by…", "I updated…" fire. "The fix is to change X" does not —
 *     proposing a change is a legitimate answer, and nagging it would train the operator to ignore
 *     the nudge that matters.
 *   - ZERO FILES CHANGED, by `qaChangedFiles()` — the union of tool-tracked writes and the git dirty
 *     delta. That second half is load-bearing: an edit made through `bash` (heredoc, sed) is real and
 *     must exempt the turn, and only the git half sees it.
 *   - A TOOL MUST HAVE RUN. A pure-conversation turn answering "how was this fixed?" is not making a
 *     claim about its own work.
 *
 * Residual false positive, stated rather than hidden: a turn that greps history and reports "fixed by
 * commit abc" with no edit of its own. It costs one nudge, capped at one per turn. The inverse — an
 * operator shipping a fix that was never written — costs a great deal more.
 */

/** One `write_file` / `str_replace` call and whether it landed. */
export interface EditAttempt {
  tool: string;
  path: string;
  ok: boolean;
  /** First line of the tool's own error, verbatim — quoted back so the model sees what it did. */
  error: string;
}

let attempts: EditAttempt[] = [];

/** Called from `qaBeginTurn`'s neighbourhood — one ledger per turn, never carried across. */
export function beginEditTurn(): void {
  attempts = [];
}

/**
 * Record an edit attempt. Returns whether it succeeded, so the caller can gate on the same judgement
 * rather than re-deriving it — the two must never disagree.
 *
 * Success is "the tool did not return an error". Every edit tool reports failure as a leading
 * `Error:` (`str_replace`: not found / identical / ambiguous / missing file), which is the contract
 * this reads. A tool that starts reporting failure some other way would silently count as a success
 * here, so `tool/check-gates.mjs` pins the prefix against the real tool sources.
 */
export function noteEditAttempt(tool: string, path: string, result: string): boolean {
  const ok = !result.trimStart().startsWith('Error:');
  attempts.push({
    tool,
    path,
    ok,
    error: ok ? '' : result.trimStart().split('\n')[0].slice(0, 200),
  });
  return ok;
}

export function editAttempts(): readonly EditAttempt[] {
  return attempts;
}

/**
 * How many times in a row the newest attempts on `path` have failed.
 *
 * Counts back from the newest and stops at the first success or the first other path, because that is
 * the actual signal: repeated misses on ONE file mean the model is editing text it has not read, while
 * misses scattered across files are ordinary and self-correcting.
 */
export function consecutiveMissesOn(path: string): number {
  let n = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (a.path !== path) break;
    if (a.ok) break;
    n++;
  }
  return n;
}

/**
 * A claim that an edit HAS BEEN MADE — completed aspect, never a proposal.
 *
 * Every verb here is past or perfect. The present-tense forms ("change", "update", "the fix is to
 * move…") are absent on purpose: that is what a correct answer to "diagnose this" looks like.
 */
const CLAIMED_EDIT = new RegExp([
  String.raw`\bfixed\s+by\b`,
  String.raw`\b(?:i|we)(?:'ve|'ll\s+have)?\s+(?:just\s+)?(?:fixed|updated|changed|added|removed|renamed|moved|edited|modified|refactored|applied|corrected|reordered|replaced|rewrote)\b`,
  String.raw`\b(?:i|we)\s+have\s+(?:fixed|updated|changed|added|removed|renamed|moved|edited|modified|refactored|applied|corrected|reordered|replaced)\b`,
  String.raw`\b(?:fixed|updated|changed|corrected|reordered|refactored|replaced)\s+(?:the|this|it|them|by)\b`,
  String.raw`\bthe\s+fix\s+(?:has\s+been|was)\s+applied\b`,
  String.raw`\b(?:change|fix|edit|patch)\s+(?:has\s+been|was)\s+(?:made|applied|written)\b`,
].join('|'), 'i');

export function claimsCompletedEdit(text: string): boolean {
  return CLAIMED_EDIT.test(text ?? '');
}

/**
 * The whole gate, in one call, so the agent loop reads as a sentence and the rule is testable without
 * a turn, a model or a repo. `changedFiles` and `toolsRan` are passed in rather than imported: this
 * module must not reach into the QA gate's per-turn state, and a pure function is what the gate suite
 * can assert directly.
 */
export function claimsAnEditThatDoesNotExist(
  text: string, changedFiles: number, toolsRan: number,
): boolean {
  if (changedFiles > 0) return false;
  if (toolsRan === 0) return false;
  if (attempts.some((a) => a.ok)) return false;
  return claimsCompletedEdit(text);
}

/**
 * The attempts, as the model's own record of them.
 *
 * Quoted verbatim rather than summarised — "3 edits failed" is a fact it can argue with, while its own
 * error strings back are not. Bounded: the last five, because the nudge lands at the end of a window
 * that is already the reason we are here.
 */
export function attemptsSummary(): string {
  const failed = attempts.filter((a) => !a.ok);
  if (!failed.length) return 'No edit tool ran this turn.';
  const shown = failed.slice(-5);
  const lines = shown.map((a) => `  ${a.tool} ${a.path} → ${a.error}`);
  const more = failed.length - shown.length;
  return [
    `Your ${failed.length} edit attempt(s) this turn, all failed:`,
    ...lines,
    ...(more > 0 ? [`  (${more} earlier failure(s) omitted)`] : []),
  ].join('\n');
}
