/**
 * The QA gate — a short agentic quality loop that runs AFTER ayin thinks it is finished.
 *
 * WHY IT EXISTS. The agent's own last message is the least trustworthy thing it produces: it is
 * written by the same model that did the work, from the same context that made the mistakes, and it
 * is rewarded for sounding complete. "Done — I've implemented the panel and updated the docs" is a
 * claim, not a fact. This gate turns the claim into a checked one before the user has to.
 *
 * THE CONDITION IS DETERMINISTIC — no model decides whether QA runs:
 *
 *     files changed this turn > 0   AND   the final message looks like a completion report
 *                                         (big, or opening with a completion verb)
 *
 * Both halves matter. Without "files changed" the gate would fire on ordinary questions and burn GPU
 * for nothing; without "looks like a report" it would fire mid-conversation on a turn that was never
 * claiming to be done.
 *
 * THE LOOP (max `qaMaxPasses`, default 3):
 *
 *     intent  →  criteria (once per turn)  →  probes  →  review  →  pass? done
 *                                                              ↘  fail? issues back to the agent,
 *                                                                 which fixes and reports again
 *
 * Intent comes from the user's OWN prompts this session (`session-record`), not from the agent's
 * summary of them — the whole point is to check the work against what was asked, and the agent's
 * paraphrase is exactly the thing that drifts.
 *
 * SURVIVING THE POWER CUT. Every verdict is appended to the session record as it happens, so a
 * machine that dies mid-gate leaves a truthful trail: which pass ran, what it found. The gate itself
 * is in-turn work, not a long job — there is nothing to resume, so it does not pretend to.
 *
 * BOUNDED BY CONSTRUCTION. `qaMaxPasses` hard-caps the fix loop, the criteria are derived once so
 * the bar cannot drift while the agent chases it, and an LLM failure yields `unknown` — which never
 * blocks the user. A QA gate that can hold a finished answer hostage is a worse bug than the ones
 * it catches.
 */

import { pushActivity, setActivityDetail } from '../activity.js';
import { log } from '../log.js';
import { getConfig } from '../prompts.js';
import { recordQa } from '../session-record.js';
import { addMessage, setAgentStatus } from '../ui.js';
import { deriveCriteria, dimensionsOf, type Criterion, type Dimension } from './criteria.js';
import { describeFile, gatherEvidence, gitDirtySet, probeThirdPartyApi, probeWebview, type ChangedFile } from './probes.js';
import { reviewArtifacts, type QaIssue, type QaVerdict } from './review.js';

export type { QaIssue, QaVerdict };

// ── per-turn state ────────────────────────────────────────────────────

interface TurnState {
  touched: Set<string>;
  dirtyBefore: Set<string> | null;
  passes: number;
  criteria: Criterion[] | null;
  lastIssues: QaIssue[];
}

let turn: TurnState = { touched: new Set(), dirtyBefore: null, passes: 0, criteria: null, lastIssues: [] };

/** Start a turn: forget the last one and snapshot what was ALREADY dirty, so pre-existing
 *  uncommitted work is never mistaken for this turn's output. */
export function qaBeginTurn(): void {
  turn = { touched: new Set(), dirtyBefore: gitDirtySet(), passes: 0, criteria: null, lastIssues: [] };
}

/** A file this turn wrote. Called from the agent's tool loop for write_file / str_replace. */
export function qaNoteTouched(path: string): void {
  if (path && path.trim()) turn.touched.add(path.trim());
}

// Build output, vendor trees, lockfiles — and ayin's own plan documents, which plan mode writes
// BEFORE the work starts. The plan is an input to the change, not an artifact of it; reviewing it
// against the acceptance criteria would judge the map instead of the territory.
const IGNORE_RE = /(^|\/)(node_modules|\.git|dist|build|out|\.next|coverage|__pycache__)(\/|$)|(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|(^|\/)ayin-plan-[\d-]+\.md$/;

/**
 * What this turn changed: tool-tracked writes ∪ files that went dirty in git during the turn.
 *
 * Only real files survive. `git status` reports a collapsed untracked DIRECTORY as one path, and a
 * directory described as a file would be reported to the judge as "MISSING (deleted?)" — a fact that
 * is simply false. A path that does not exist is kept only when a tool in this turn wrote to it,
 * which is the one case where "gone" is real information.
 */
export function qaChangedFiles(): ChangedFile[] {
  const paths = new Set(turn.touched);
  const after = gitDirtySet();
  if (after && turn.dirtyBefore) {
    for (const p of after) if (!turn.dirtyBefore.has(p)) paths.add(p);
  }
  const touchedAbs = new Set([...turn.touched].map((p) => describeFile(p).path));
  return [...paths]
    .filter((p) => !IGNORE_RE.test(p))
    .map(describeFile)
    .filter((f) => (f.exists ? f.kind !== 'other' : touchedAbs.has(f.path)))
    .slice(0, 25);
}

// ── the deterministic trigger ─────────────────────────────────────────

/** A completion report opens by saying it is done. Checked on the head of the message only. */
const COMPLETION_RE = /\b(done|complete[d]?|implemented|added|created|updated|fixed|shipped|finished|verified|working now|all set|ready)\b/i;

export function qaEnabled(): boolean {
  return process.env.AYIN_QA !== '0' && getConfig('qaMaxPasses', 3) > 0;
}

/**
 * The gate condition. Deterministic and cheap — no LLM, no network, one `git status` at most.
 * Returns the reason it will NOT run when it won't, for the log.
 */
export function qaShouldRun(finalText: string): { run: boolean; why: string; files: ChangedFile[] } {
  if (!qaEnabled()) return { run: false, why: 'disabled', files: [] };
  const files = qaChangedFiles();
  if (files.length === 0) return { run: false, why: 'nothing changed this turn', files };
  const minChars = getConfig('qaMinAnswerChars', 400);
  const head = finalText.slice(0, 240);
  const big = finalText.length >= minChars;
  const reportsCompletion = COMPLETION_RE.test(head) && finalText.length >= 80;
  if (!big && !reportsCompletion) return { run: false, why: 'final message is not a completion report', files };
  return { run: true, why: big ? `big final message (${finalText.length} chars)` : 'final message reports completion', files };
}

// ── the loop ──────────────────────────────────────────────────────────

export interface QaOutcome {
  action: 'pass' | 'fix' | 'exhausted' | 'skipped';
  pass: number;
  maxPasses: number;
  verdict: QaVerdict | null;
  /** What to show the user — already formatted, one compact card. */
  card: string;
  /** What to hand the agent when `action === 'fix'`. */
  feedback?: string;
}

function issueLine(i: QaIssue): string {
  const file = i.file && i.file !== '?' ? ` ${i.file.split('/').slice(-2).join('/')}` : '';
  return `  • [${i.criterion}]${file} — ${i.problem}${i.fix ? ` → ${i.fix}` : ''}`;
}

function passCard(pass: number, max: number, criteria: number, v: QaVerdict): string {
  return `QA PASS (${pass}/${max}) · ${criteria} criteria checked · ${v.summary || 'the change satisfies what was asked.'}`;
}

function failCard(pass: number, max: number, v: QaVerdict, willFix: boolean): string {
  const head = `QA FAIL (${pass}/${max}) · ${v.issues.length} issue(s)${v.summary ? ` · ${v.summary}` : ''}`;
  const body = v.issues.map(issueLine).join('\n');
  const tail = willFix ? '\n  fixing…' : `\n  out of QA passes — the issues above are NOT fixed.`;
  return [head, body, tail].filter(Boolean).join('\n');
}

/**
 * Run one gate pass over the turn's artifacts.
 *
 * `isInterrupted` is polled between the two LLM calls so Ctrl+C during QA stops it instead of
 * queueing another minute of GPU work the user has already walked away from.
 */
export async function qaGate(
  goal: string,
  answer: string,
  files: ChangedFile[],
  isInterrupted: () => boolean = () => false,
): Promise<QaOutcome> {
  const maxPasses = getConfig('qaMaxPasses', 3);
  turn.passes++;
  const pass = turn.passes;

  if (pass > maxPasses) {
    const card = `QA STOPPED after ${maxPasses} passes · ${turn.lastIssues.length} issue(s) remain unfixed`;
    log('WARN', 'qa_exhausted', { passes: String(maxPasses), issues: String(turn.lastIssues.length) });
    recordQa('exhausted', pass, 'max passes reached', turn.lastIssues.length);
    return { action: 'exhausted', pass, maxPasses, verdict: null, card };
  }

  // One named phase for the whole pass. The wait narrator reads this instead of overwriting it, and
  // the status bar keeps `▣ QA 1/3` lit even in the gaps where no LLM call is running — so a review
  // spending the user's GPU never looks like an ordinary turn. See activity.ts.
  const endPhase = pushActivity(`QA ${pass}/${maxPasses}`, `probing ${files.length} changed file(s)`);
  try {
    const webview = await probeWebview(files);
    const api = probeThirdPartyApi(files);
    const dims: Set<Dimension> = dimensionsOf(files, webview.applies, api.applies);

    if (!turn.criteria) {
      setActivityDetail('deriving acceptance criteria from your prompts');
      turn.criteria = await deriveCriteria(files, goal, dims);
    }
    if (isInterrupted()) return { action: 'skipped', pass, maxPasses, verdict: null, card: 'QA skipped (interrupted).' };

    setActivityDetail(`reviewing ${files.length} artifact(s) against ${turn.criteria.length} criteria`);
    const evidence = await gatherEvidence(files);
    const verdict = await reviewArtifacts(turn.criteria, evidence, goal, answer, pass);
    turn.lastIssues = verdict.issues;
    recordQa(verdict.verdict, pass, verdict.summary, verdict.issues.length);

    if (verdict.verdict === 'unknown') {
      // The judge could not answer. Say so plainly and let the turn finish — never invent a verdict.
      return {
        action: 'skipped', pass, maxPasses, verdict,
        card: `QA INCONCLUSIVE (${pass}/${maxPasses}) · ${verdict.summary || 'the reviewer did not return a usable verdict'}`,
      };
    }

    if (verdict.verdict === 'pass') {
      return { action: 'pass', pass, maxPasses, verdict, card: passCard(pass, maxPasses, turn.criteria.length, verdict) };
    }

    const willFix = pass < maxPasses;
    const card = failCard(pass, maxPasses, verdict, willFix);
    if (!willFix) return { action: 'exhausted', pass, maxPasses, verdict, card };

    const feedback = [
      `<system>QA GATE — pass ${pass} of ${maxPasses}: your change did NOT satisfy what the user asked for.`,
      '',
      'Issues found (each names the file and the fix):',
      ...verdict.issues.map((i, n) => `${n + 1}. [${i.criterion}] ${i.file}\n   problem: ${i.problem}\n   fix: ${i.fix}`),
      '',
      'Fix exactly these now — nothing else, no unrelated refactoring. Then report what you changed.',
      'Your report will be reviewed again against the same criteria.</system>',
    ].join('\n');

    return { action: 'fix', pass, maxPasses, verdict, card, feedback };
  } catch (err) {
    // A broken gate must not break the turn it was protecting.
    log('ERROR', 'qa_gate_error', { error: err instanceof Error ? err.message : String(err) });
    return { action: 'skipped', pass, maxPasses, verdict: null, card: `QA skipped (gate error: ${err instanceof Error ? err.message : String(err)})` };
  } finally {
    endPhase();
    setAgentStatus('');
  }
}

/** Show the verdict card in the transcript. One place, so the format stays consistent. */
export function qaShowCard(card: string): void {
  addMessage('system', card);
}
