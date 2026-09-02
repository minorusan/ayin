/**
 * The QA gate — a short agentic quality loop that runs AFTER ayin thinks it is finished.
 *
 * WHY IT EXISTS. The agent's own last message is the least trustworthy thing it produces: it is
 * written by the same model that did the work, from the same context that made the mistakes, and it
 * is rewarded for sounding complete. "Done — I've implemented the panel and updated the docs" is a
 * claim, not a fact. This gate turns the claim into a checked one before the user has to.
 *
 * OFF BY DEFAULT for the session — `/qa` toggles it on for the rest of the session, `/qathis` forces
 * it once regardless of the toggle. Once it applies at all, THE CONDITION IS DETERMINISTIC — no model
 * decides whether QA runs:
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
import { addMessage, formatGateCardForChat, setAgentStatus, HEADLESS } from '../ui.js';
import { deriveCriteria, dimensionsOf, type Criterion, type Dimension } from './criteria.js';
import { describeFile, filesModifiedSince, gatherEvidence, gitDirtySet, probeThirdPartyApi, probeWebview, projectRoot, type ChangedFile } from './probes.js';
import { reviewArtifacts, type QaIssue, type QaVerdict } from './review.js';
import { detectProject, describeProject } from '../executors/detect.js';
import { qaExecutorFor } from '../executors/registry.js';
import { isFullMode } from '../full-mode.js';

export type { QaIssue, QaVerdict };

/**
 * The facts that fail the gate WITHOUT the judge: measured, binary, and marked `hard` by the executor
 * that produced them (see `ProbeFact.hard`).
 *
 * Exported as its own function because this rule is the enforcement — and a rule buried inside a
 * 200-line async gate cannot be tested without an LLM, a turn and a repo. `tool/check-gates.mjs`
 * asserts it directly, including the case the design turns on: a fact that is `hard: false` because
 * its check never ran (a compiler missing from the machine) must NOT fail the gate.
 */
export function hardFailingFacts<T extends { ok: boolean; hard?: boolean }>(facts: T[]): T[] {
  return facts.filter((f) => f.hard === true && !f.ok);
}

// ── per-turn state ────────────────────────────────────────────────────

interface TurnState {
  touched: Set<string>;
  dirtyBefore: Set<string> | null;
  /** Wall-clock start of the turn — the non-git fallback's "changed since" baseline. */
  startedMs: number;
  passes: number;
  criteria: Criterion[] | null;
  lastIssues: QaIssue[];
  /** Units (Arduino sketches) whose artifacts the executor already regenerated this turn. */
  prepared: Set<string>;
}

function freshTurn(): TurnState {
  return {
    touched: new Set(),
    dirtyBefore: gitDirtySet(),
    // One second of slack: a file written in the same second the turn began can carry an mtime a hair
    // earlier than `Date.now()` here, and missing this turn's own first write would defeat the point.
    startedMs: Date.now() - 1000,
    passes: 0,
    criteria: null,
    lastIssues: [],
    prepared: new Set(),
  };
}

let turn: TurnState = freshTurn();

/** Start a turn: forget the last one and snapshot what was ALREADY dirty, so pre-existing
 *  uncommitted work is never mistaken for this turn's output. */
export function qaBeginTurn(): void {
  turn = freshTurn();
}

/** What the QA executor already regenerated this turn — handed to Presenter as its skip set so one
 *  turn never spends its one-grounding-call-per-unit budget twice. */
export function qaPreparedUnits(): Set<string> {
  return turn.prepared;
}

/** A file this turn wrote. Called from the agent's tool loop for write_file / str_replace. */
export function qaNoteTouched(path: string): void {
  if (path && path.trim()) turn.touched.add(path.trim());
}

// Build output, vendor trees, lockfiles — and ayin's own plan documents, which plan mode writes
// BEFORE the work starts. The plan is an input to the change, not an artifact of it; reviewing it
// against the acceptance criteria would judge the map instead of the territory.
// `.ayin` is ayin's own working directory for the repo — plan documents and review reports. QA judging
// the agent's work must not count the plan the agent was handed as one of the files it changed; the
// root-level `ayin-plan-*.md` clause stays for repos planned in before those moved into `.ayin/plans/`.
const IGNORE_RE = /(^|\/)(node_modules|\.git|\.ayin|dist|build|out|\.next|coverage|__pycache__)(\/|$)|(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|(^|\/)ayin-plan-[\d-]+\.md$/;

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
  } else {
    // NOT A GIT REPO — and this branch is load-bearing, not a nicety. The git half of this union is
    // what catches files written through `bash`; without it, a turn that wrote everything with a
    // heredoc reports zero changed files and `qaShouldRun` declines with "nothing changed this turn".
    // The gate then does not fail, it SILENTLY DOES NOT RUN, which is worse and invisible. Measured on
    // a benchmark project in a fresh directory: it shipped a sketch that could not compile, past a
    // naming bar and a compile probe that both existed and never got the chance to look.
    for (const p of filesModifiedSince(projectRoot(), turn.startedMs)) paths.add(p);
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

/**
 * The explicit marker, same shape as plan mode's `/plan`: one unambiguous phrase instead of a length
 * or wording heuristic. `system.txt` instructs the model to end a completed turn with this exact
 * phrase — it exists because a short, honest closing message ("Done." / "Fixed the typo.") is neither
 * long enough nor phrased like `COMPLETION_RE` expects, and was going unreviewed for no reason other
 * than being terse. Case-insensitive and not word-bounded on "qa" (a model might write "ready for QA"
 * or "Ready for qa") — the literal phrase is deliberately distinctive enough that nothing else would
 * plausibly contain it by accident.
 */
const QA_READY_RE = /ready for qa/i;

export function qaEnabled(): boolean {
  return process.env.AYIN_QA !== '0' && getConfig('qaMaxPasses', 3) > 0;
}

/**
 * QA is OFF by default for the session — `/qa` (bare, in `index.ts`) toggles it for the rest of the
 * session; `/qathis <message>` forces it for exactly one turn regardless of the toggle, consumed
 * whatever that turn turns out to contain (a flag that survived a no-op turn would silently fire on
 * the NEXT unrelated one). This is INDEPENDENT of Presenter's own toggle (`presenter/index.ts`) even
 * though both still share the same underlying "does this look like a completion report" shape check
 * below (`qaShouldRun`, unchanged) — `shouldRunQaThisTurn()` is the only thing that changed: an
 * additional gate the caller ANDs with `qaShouldRun(...).run`, never folded into that function itself,
 * so Presenter can keep using the identical shape check without inheriting QA's own toggle state.
 */
/** `AYIN_QA=1` force-enables the session toggle from the environment — the mirror of the existing
 *  `AYIN_QA=0` kill switch, and the only way to exercise the gate headlessly, where there is no TUI
 *  to type `/qa` into. See `plan/index.ts`'s identical note. */
let sessionEnabled = process.env.AYIN_QA === '1' || isFullMode();
let forceNextTurn = false;

export function toggleQaSession(): boolean {
  sessionEnabled = !sessionEnabled;
  return sessionEnabled;
}

export function isQaSessionEnabled(): boolean {
  return sessionEnabled;
}

export function forceQaNextTurn(): void {
  forceNextTurn = true;
}

/**
 * Call exactly once per turn, UNCONDITIONALLY (never short-circuited behind `qaShouldRun(...).run`) —
 * it consumes the one-shot `/qathis` force flag, and that consumption must happen whether or not this
 * particular turn had a completion-report shape to act on. A forced turn that turned out to change no
 * files should still spend its one-shot request, not leave it dangling for a later, unrelated turn.
 */
export function shouldRunQaThisTurn(): boolean {
  const forced = forceNextTurn;
  if (forced) forceNextTurn = false;
  return sessionEnabled || forced;
}

/**
 * The gate condition. Deterministic and cheap — no LLM, no network, one `git status` at most.
 * Returns the reason it will NOT run when it won't, for the log. Pure shape detection — whether QA
 * (or Presenter) actually acts on a `true` result is a SEPARATE decision (see `shouldRunQaThisTurn`
 * above and `presenter/index.ts`'s own equivalent).
 */
export function qaShouldRun(finalText: string): { run: boolean; why: string; files: ChangedFile[] } {
  if (!qaEnabled()) return { run: false, why: 'disabled', files: [] };
  const files = qaChangedFiles();
  if (files.length === 0) return { run: false, why: 'nothing changed this turn', files };
  const minChars = getConfig('qaMinAnswerChars', 400);
  const head = finalText.slice(0, 240);
  const big = finalText.length >= minChars;
  const reportsCompletion = COMPLETION_RE.test(head) && finalText.length >= 80;
  // Checked over the WHOLE message, not just the head — the instruction is to put it at the end.
  const explicitlyReady = QA_READY_RE.test(finalText);
  if (!big && !reportsCompletion && !explicitlyReady) return { run: false, why: 'final message is not a completion report', files };
  const why = explicitlyReady ? '"Ready for QA" marker' : big ? `big final message (${finalText.length} chars)` : 'final message reports completion';
  return { run: true, why, files };
}

// ── the loop ──────────────────────────────────────────────────────────

export interface QaOutcome {
  action: 'pass' | 'fix' | 'exhausted' | 'skipped';
  pass: number;
  maxPasses: number;
  verdict: QaVerdict | null;
  /** What to show the user — structured; the chat widget owns how it looks. */
  card: QaCard;
  /** What to hand the agent when `action === 'fix'`. */
  feedback?: string;
}

/**
 * The verdict as a CARD, not a sentence.
 *
 * `kind` + `title` + `body` + `footer` is the shape `formatGateCardForChat` renders in the same visual
 * language as a tool result, and the shape headless mode flattens to plain text. Structured rather
 * than pre-formatted because the gate should not know what a terminal looks like — the widget does.
 */
export interface QaCard {
  kind: 'pass' | 'fail' | 'stopped' | 'info';
  title: string;
  body: string[];
  footer?: string;
}

function issueLine(i: QaIssue): string {
  const file = i.file && i.file !== '?' ? ` ${i.file.split('/').slice(-2).join('/')}` : '';
  return `[${i.criterion}]${file} — ${i.problem}${i.fix ? ` → ${i.fix}` : ''}`;
}

function passCard(pass: number, max: number, criteria: number, v: QaVerdict): QaCard {
  return {
    kind: 'pass',
    title: `QA PASS ${pass}/${max}`,
    body: v.summary ? [v.summary] : ['the change satisfies what was asked'],
    footer: `${criteria} criteria checked`,
  };
}

function failCard(pass: number, max: number, v: QaVerdict, willFix: boolean): QaCard {
  return {
    kind: willFix ? 'fail' : 'stopped',
    title: `QA FAIL ${pass}/${max} · ${v.issues.length} issue${v.issues.length === 1 ? '' : 's'}`,
    body: [...(v.summary ? [v.summary, ''] : []), ...v.issues.map(issueLine)],
    footer: willFix ? 'fixing…' : 'out of QA passes — the issues above are NOT fixed',
  };
}

/** Flatten a card for headless mode / the log, where blessed markup is noise. */
export function cardToText(c: QaCard): string {
  return [c.title, ...c.body.map((l) => (l ? `  ${l}` : '')), c.footer ? `  ${c.footer}` : '']
    .filter((l) => l !== '')
    .join('\n');
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
    const card: QaCard = {
      kind: 'stopped',
      title: `QA STOPPED after ${maxPasses} passes`,
      body: turn.lastIssues.map(issueLine),
      footer: `${turn.lastIssues.length} issue(s) remain unfixed`,
    };
    log('WARN', 'qa_exhausted', { passes: String(maxPasses), issues: String(turn.lastIssues.length) });
    recordQa('exhausted', pass, 'max passes reached', turn.lastIssues.length);
    return { action: 'exhausted', pass, maxPasses, verdict: null, card };
  }

  // One named phase for the whole pass. The wait narrator reads this instead of overwriting it, and
  // the status bar keeps `▣ QA 1/3` lit even in the gaps where no LLM call is running — so a review
  // spending the user's GPU never looks like an ordinary turn. See activity.ts.
  const endPhase = pushActivity(`QA ${pass}/${maxPasses}`, `probing ${files.length} changed file(s)`);
  try {
    // Which project this is, decided fresh every pass — the working directory can change mid-session
    // and a stale answer would apply one project type's bar to another's code. See executors/detect.ts.
    const ctx = detectProject();
    const executor = qaExecutorFor(ctx);
    log('INFO', 'qa_executor', { project: describeProject(ctx), executor: executor.config.id, pass: String(pass) });

    // PREPARE FIRST. The executor produces the artifacts its own criteria are about (for Arduino:
    // the wiring diagram) BEFORE anything is judged. Doing this after the verdict — which is what
    // happened before — meant pass 1 reliably failed a criterion the very next step would satisfy,
    // burning a whole fix pass on nothing. See executors/qa/arduino/index.ts for the measurement.
    setActivityDetail(`preparing ${ctx.type} artifacts before review`);
    const prepared = await executor.prepare(ctx, files);
    if (prepared.produced.length) {
      log('INFO', 'qa_prepared', { count: String(prepared.produced.length), paths: prepared.produced.join(',') });
    }
    turn.prepared = prepared.handled;
    if (isInterrupted()) return { action: 'skipped', pass, maxPasses, verdict: null, card: { kind: 'info', title: 'QA skipped', body: ['interrupted'] } };

    setActivityDetail(`checking ${ctx.type} project facts`);
    const facts = await executor.probe(ctx, files);

    /**
     * FACTS-ONLY PROJECT TYPES STOP HERE.
     *
     * A project type may declare (`ExecutorConfig.factsOnly`) that its deterministic facts ARE the gate:
     * no criteria are derived, no evidence is gathered, and the judge is never asked. Unity is the case
     * that forced it — "does the C# compile" is the floor, and everything the generic path asked of a
     * Unity project was either wrong for the type (a README needing "a parts list and a pin map", which
     * hard-failed every turn on a real repo) or unmeasurable without launching the editor.
     *
     * Placed here, before `deriveCriteria`, because the point is to spend nothing: two LLM calls per pass
     * saved on a turn whose verdict is a compiler's.
     */
    if (executor.config.factsOnly) {
      /**
       * A facts gate may still ask ONE question of a model — see `QaExecutor.review`. It is not the generic
       * judge: the executor picked the files after a deterministic pre-filter and asks its own narrow
       * question, and what comes back is an ordinary fact. Interruption is honoured before spending it.
       */
      if (executor.review && !isInterrupted()) {
        setActivityDetail(`${ctx.type}: semantic check on the changed files`);
        try {
          facts.push(...await executor.review(ctx, files, facts));
        } catch (e) {
          log('WARN', 'qa_executor_review_failed', { project: ctx.type, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const failures = hardFailingFacts(facts);
      if (failures.length === 0) {
        recordQa('pass', pass, `${ctx.type}: ${facts.map((f) => f.key).join(', ') || 'no facts'}`, 0);
        return {
          action: 'pass', pass, maxPasses, verdict: { verdict: 'pass', summary: facts.map((f) => f.detail).join('\n'), issues: [] },
          card: { kind: 'pass', title: `QA PASS ${pass}/${maxPasses} · ${ctx.type}`, body: facts.map((f) => f.detail) },
        };
      }
      const willFix = pass < maxPasses;
      const issues: QaIssue[] = failures.map((f) => ({
        criterion: f.key, file: ctx.root,
        problem: f.detail.split('\n')[0],
        fix: 'fix exactly what the tool reported — it is measured, not judged',
      }));
      const verdict: QaVerdict = { verdict: 'fail', summary: `${ctx.type}: ${failures.length} deterministic check(s) failed.`, issues };
      turn.lastIssues = issues;
      recordQa('fail', pass, verdict.summary, issues.length);
      log('INFO', 'qa_facts_only_fail', { project: ctx.type, keys: failures.map((f) => f.key).join(',') });
      /**
       * THE ERRORS GO TO THE AGENT, NOT TO THE OPERATOR.
       *
       * A compiler's output is work instructions. Ten `error CS…` lines with file, line and column are
       * exactly what the fix pass needs and exactly what the human does not want scrolling past — they
       * asked for a working build, not a build log, and the agent is about to act on it in the same
       * second. So the CARD keeps the headline (`DOES NOT COMPILE: 7 C# error(s) …`) and says where the
       * detail went, while `feedback` carries every line verbatim.
       *
       * `detail`'s first line is the headline by construction in every fact that has a list: the
       * executors write "WHAT: n thing(s) — …" first and indent the items below it.
       */
      const cardVerdict: QaVerdict = {
        ...verdict,
        issues: issues.map((i) => ({ ...i, problem: i.problem, fix: 'sent to the agent' })),
      };
      const card = failCard(pass, maxPasses, cardVerdict, willFix);
      const detailLines = failures.reduce((n, f) => n + Math.max(0, f.detail.split('\n').length - 1), 0);
      if (detailLines > 0) card.body = [...card.body, `${detailLines} line(s) of tool output went to the agent, not here`];
      if (!willFix) return { action: 'exhausted', pass, maxPasses, verdict, card };
      return {
        action: 'fix', pass, maxPasses, verdict, card,
        feedback: [
          `<system>QA GATE — pass ${pass} of ${maxPasses}: ${failures.length} MEASURED check(s) failed on this ${ctx.type} project. A compiler said this; there is nothing to argue with.`,
          '',
          ...failures.map((f, n) => `${n + 1}. [${f.key}] ${f.detail}`),
          '',
          'Fix exactly these. Then report what you changed.</system>',
        ].join('\n'),
      };
    }

    const webview = await probeWebview(files);
    const api = probeThirdPartyApi(files);
    const dims: Set<Dimension> = dimensionsOf(files, webview.applies, api.applies);

    if (!turn.criteria) {
      setActivityDetail('deriving acceptance criteria from your prompts');
      turn.criteria = await deriveCriteria(files, goal, dims, executor.criteria(ctx, files, facts));
    }
    if (isInterrupted()) return { action: 'skipped', pass, maxPasses, verdict: null, card: { kind: 'info', title: 'QA skipped', body: ['interrupted'] } };

    // HARD FACTS SHORT-CIRCUIT THE JUDGE. A compiler's exit code, a missing required file, a README
    // with the scaffold's TODO markers still in it — these are binary, and asking a model to weigh them
    // is how "enforce" quietly becomes "mention". Measured: a README with NO pin map produced the fact
    // "names no pins", and the judge passed the turn anyway (`QA FAIL 1/3` → fix → `QA PASS 2/3`).
    //
    // The judge still runs afterwards for everything that IS a judgement. This only removes its
    // discretion over things that are not. See `ProbeFact.hard`.
    const hardFailures = hardFailingFacts(facts);
    if (hardFailures.length > 0) {
      const willFix = pass < maxPasses;
      const issues: QaIssue[] = hardFailures.map((f) => ({
        criterion: f.key, file: ctx.root,
        problem: f.detail.split('\n')[0],
        fix: f.detail.includes('—') ? f.detail.slice(f.detail.indexOf('—') + 1).trim() : 'see the measured fact above',
      }));
      const verdict: QaVerdict = {
        verdict: 'fail',
        summary: `${hardFailures.length} deterministic check(s) failed — not a judgement call.`,
        issues,
      };
      turn.lastIssues = issues;
      recordQa('fail', pass, verdict.summary, issues.length);
      log('INFO', 'qa_hard_fail', { pass: String(pass), keys: hardFailures.map((f) => f.key).join(',') });
      const card = failCard(pass, maxPasses, verdict, willFix);
      if (!willFix) return { action: 'exhausted', pass, maxPasses, verdict, card };
      return {
        action: 'fix', pass, maxPasses, verdict, card,
        feedback: [
          `<system>QA GATE — pass ${pass} of ${maxPasses}: ${hardFailures.length} MEASURED check(s) failed. These are facts from a compiler, the filesystem or a renderer, not opinions — there is nothing to argue with.`,
          '',
          ...hardFailures.map((f, n) => `${n + 1}. [${f.key}] ${f.detail}`),
          '',
          'Fix exactly these. Then report what you changed.</system>',
        ].join('\n'),
      };
    }

    setActivityDetail(`reviewing ${files.length} artifact(s) against ${turn.criteria.length} criteria`);
    const evidence = await gatherEvidence(files, facts);
    const verdict = await reviewArtifacts(turn.criteria, evidence, goal, answer, pass);
    turn.lastIssues = verdict.issues;
    recordQa(verdict.verdict, pass, verdict.summary, verdict.issues.length);

    if (verdict.verdict === 'unknown') {
      // The judge could not answer. Say so plainly and let the turn finish — never invent a verdict.
      return {
        action: 'skipped', pass, maxPasses, verdict,
        card: {
          kind: 'info',
          title: `QA INCONCLUSIVE ${pass}/${maxPasses}`,
          body: [verdict.summary || 'the reviewer did not return a usable verdict'],
        },
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
    return {
      action: 'skipped', pass, maxPasses, verdict: null,
      card: { kind: 'info', title: 'QA skipped', body: [`gate error: ${err instanceof Error ? err.message : String(err)}`] },
    };
  } finally {
    endPhase();
    setAgentStatus('');
  }
}

/**
 * Show the verdict in the transcript. One place, so every pass looks the same.
 *
 * Headless gets flat text: blessed markup on stderr is unreadable noise, and a headless run's reader
 * is usually a log or another program.
 */
export function qaShowCard(card: QaCard): void {
  addMessage('system', HEADLESS ? cardToText(card) : formatGateCardForChat(card.kind, card.title, card.body, card.footer));
}
