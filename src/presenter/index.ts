/**
 * Presenter pass — runs BEFORE the QA gate, on the same deterministic trigger (`qaShouldRun`, checked
 * by the caller in `agent.ts`). Where QA judges whether the work is right, Presenter decides how the
 * agent's raw reply gets SHOWN: either it IS the thing the user must read verbatim (a warning,
 * rejection, error, or a question back to them — `presentable: false`), or it reports on completed
 * work, in which case Presenter builds a short, consistently-shaped answer instead of whatever prose
 * shape the model happened to write this time — a quote of what was asked, one sentence of what this
 * reply satisfies, and a bulleted file-changed list.
 *
 * ONE quick LLM call does both the classification and the build (`prompts/presenter/classifyAndBuild.txt`)
 * — no repair loop, no retry: a degraded or unparseable response just means "don't present", which is
 * always safe because the caller still has the raw reply to fall back to.
 *
 * QA THEN REVIEWS THE PRESENTED TEXT, not the raw reply, when Presenter produced one — a presentation
 * is a denser, more complete "here is what changed" statement than whatever the model's own closing
 * line happened to be, so it is strictly better evidence for the QA reviewer to check claims against.
 *
 * TESTING-ERA BEHAVIOR (temporary, per the operator): the raw reply is still shown too, de-emphasized
 * in italic BELOW the presentation, so the two can be compared while this is new. Once trusted, the
 * raw reply will stop being shown when Presenter produces a presentation — that switch lives in
 * `agent.ts`, not here, since it's about what gets printed, not about the decision itself.
 *
 * PROJECT-TYPE ARTIFACTS. What a presentation owes the user beyond the file list depends on the kind
 * of project: an Arduino turn owes a current wiring diagram (a presentation that points at a stale
 * one is worse than one that points at nothing), a generic project owes nothing extra. That decision
 * lives in the PRESENT EXECUTOR selected for the detected project type, not here — see
 * `executors/present/`. Presenter's own job is unchanged: classify, then format.
 *
 * OFF BY DEFAULT for the session — `/present` (bare, in `index.ts`) toggles it on for the rest of the
 * session; `/presentthis <message>` forces it for exactly one turn regardless of the toggle. This is
 * INDEPENDENT of QA's own toggle (`qa/index.ts`) even though both still share the identical "does this
 * look like a completion report" shape check computed once in `agent.ts` (`qaShouldRun`) — enabling one
 * without the other is a legitimate combination (e.g. nicer formatting with no QA judge, or vice versa).
 */

import { pushActivity, setActivityDetail } from '../activity.js';
import { llmChat } from '../llm/manager.js';
import { log } from '../log.js';
import { prompts, packagePath } from '../prompts-service.js';
import { detectProject, describeProject } from '../executors/detect.js';
import { presentExecutorFor } from '../executors/registry.js';
import type { ChangedFile } from '../qa/probes.js';
import { isFullMode } from '../full-mode.js';

const presenterPrompts = prompts.register('presenter', packagePath('prompts', 'presenter')).bundle;

export function presenterEnabled(): boolean {
  return process.env.AYIN_PRESENTER !== '0';
}

/**
 * OFF, unless `--full` asked for everything.
 *
 * The presenter is the third of the three session toggles and the only one with no environment
 * force, because it is TUI-only by construction (`doPresenter` is `&& !HEADLESS`) — there is nothing
 * for a headless harness to turn on. That left `--full` meaning "everything" while quietly omitting
 * it: an operator who typed the one word that exists to avoid typing three still got no presenter.
 */
let sessionEnabled = isFullMode();
let forceNextTurn = false;

export function togglePresenterSession(): boolean {
  sessionEnabled = !sessionEnabled;
  return sessionEnabled;
}

export function isPresenterSessionEnabled(): boolean {
  return sessionEnabled;
}

export function forcePresenterNextTurn(): void {
  forceNextTurn = true;
}

/**
 * Is a one-shot `/presentthis` force still pending? NON-consuming, unlike
 * `shouldRunPresenterThisTurn()` — for readers that need to know whether this turn is a presenting
 * turn *while it is still running* (see `editor.ts`: tool calls happen long before the post-turn
 * gate consumes the force, and a peek must not swallow it).
 */
export function isPresenterForcePending(): boolean {
  return forceNextTurn;
}

/**
 * Call exactly once per turn, UNCONDITIONALLY (never short-circuited behind the shared shape check) —
 * see `qa/index.ts#shouldRunQaThisTurn`'s identical reasoning: the one-shot `/presentthis` force must
 * be consumed whether or not this particular turn had anything to present.
 */
export function shouldRunPresenterThisTurn(): boolean {
  const forced = forceNextTurn;
  if (forced) forceNextTurn = false;
  return sessionEnabled || forced;
}

export interface PresenterFile {
  path: string;
  summary: string;
}

export interface PresenterOutcome {
  presented: boolean;
  text?: string;
  reason?: string;
  /** Units (Arduino sketches) whose artifacts this pass regenerated — the caller carries these so a
   *  later gate in the same turn does not redo the work. Mirrors `qaPreparedUnits()` in the other
   *  direction; whichever gate runs first tells the second what it already covered. */
  arduinoRegenerated: Set<string>;
}

interface ParsedPresentation {
  presentable: boolean;
  reason?: string;
  satisfies?: string;
  files?: PresenterFile[];
}

function renderFileList(files: ChangedFile[]): string {
  return files.slice(0, 25).map((f) => `${f.path} [${f.kind}]${f.exists ? '' : ' (deleted)'}`).join('\n') || '(no files)';
}

/** Brace-scan + shape-check, same tolerant shape as `qa/criteria.ts`'s intent parser and
 *  `arduino-explain.ts`'s `parseConnections` — a model wraps JSON in prose/fences often enough that a
 *  strict `JSON.parse` on the raw string would reject good answers for a cosmetic reason. */
export function parsePresentation(raw: string): ParsedPresentation | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof obj.presentable !== 'boolean') return null;
    if (!obj.presentable) {
      return { presentable: false, reason: typeof obj.reason === 'string' && obj.reason ? obj.reason : 'not a presentation' };
    }
    const files = Array.isArray(obj.files)
      ? obj.files
        .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
        .map((f) => ({ path: typeof f.path === 'string' ? f.path : '', summary: typeof f.summary === 'string' ? f.summary : '' }))
        .filter((f) => f.path)
      : [];
    return { presentable: true, satisfies: typeof obj.satisfies === 'string' ? obj.satisfies : '', files };
  } catch {
    return null;
  }
}

/**
 * Pure formatter: parsed classification + the project-type executor's artifact lines → the text
 * shown to the user. `artifactLines` used to be a single optional Arduino string; it is a list now
 * because a project type can owe the user more than one artifact, and because which lines exist is
 * the executor's business rather than this formatter's.
 */
export function formatPresentation(goal: string, parsed: ParsedPresentation, artifactLines: string[] = []): string {
  const lines: string[] = [];
  lines.push(`> ${goal || '(no goal recorded this session)'}`);
  lines.push('');
  if (parsed.satisfies) lines.push(parsed.satisfies);
  lines.push('');
  lines.push('Changed:');
  const files = parsed.files ?? [];
  if (files.length === 0) lines.push('- (no file-level changes reported)');
  for (const f of files) lines.push(`- ${f.path}${f.summary ? ` — ${f.summary}` : ''}`);
  for (const line of artifactLines) lines.push(`- ${line}`);
  return lines.join('\n');
}

/**
 * The pass itself. Never throws — a model call failure or an unparseable reply both degrade to
 * `presented: false`, which is always safe: the caller still shows the raw reply exactly as it did
 * before Presenter existed.
 */
export async function presenterPass(
  goal: string,
  response: string,
  files: ChangedFile[],
  skip: Set<string> = new Set(),
): Promise<PresenterOutcome> {
  const none: PresenterOutcome = { presented: false, arduinoRegenerated: new Set() };
  if (!presenterEnabled()) return { ...none, reason: 'disabled (AYIN_PRESENTER=0)' };

  // Same visibility contract as the QA gate's own phases (`qa/index.ts#qaGate`) — a status-bar chip
  // and wait-narrator line while the quick classify+build call runs, so this never reads as a stall.
  const endPhase = pushActivity('Presenting', 'checking whether this reply should be presented');
  try {
    let raw: string;
    try {
      raw = await llmChat([{
        role: 'user',
        content: presenterPrompts.get('classifyAndBuild', {
          GOAL: goal || '(none recorded)',
          RESPONSE: response.slice(0, 8000),
          FILES: renderFileList(files),
        }),
      }]);
    } catch (err) {
      log('WARN', 'presenter_call_failed', { error: err instanceof Error ? err.message : String(err) });
      return { ...none, reason: 'model call failed' };
    }

    const parsed = parsePresentation(raw);
    if (!parsed) {
      log('WARN', 'presenter_parse_failed', {});
      return { ...none, reason: 'unparseable classification response' };
    }
    if (!parsed.presentable) {
      log('INFO', 'presenter_declined', { reason: parsed.reason ?? '' });
      return { ...none, reason: parsed.reason };
    }

    setActivityDetail('building the presentation');
    // Which project this is, decided fresh — never cached across turns; the directory changes.
    const ctx = detectProject();
    const executor = presentExecutorFor(ctx);
    let artifactLines: string[] = [];
    let arduinoRegenerated = new Set<string>();
    try {
      const produced = await executor.artifacts(ctx, files, skip);
      artifactLines = produced.lines;
      arduinoRegenerated = produced.handled;
      log('INFO', 'presenter_executor', { project: describeProject(ctx), executor: executor.config.id, lines: String(artifactLines.length) });
    } catch (err) {
      // A presentation without its artifact lines is still a presentation. Never let this take the
      // pass down — the caller's fallback is the raw reply, which is strictly worse.
      log('WARN', 'presenter_artifacts_failed', { error: err instanceof Error ? err.message : String(err) });
    }

    const text = formatPresentation(goal, parsed, artifactLines);
    log('INFO', 'presenter_presented', { files: String(parsed.files?.length ?? 0) });
    return { presented: true, text, arduinoRegenerated };
  } finally {
    endPhase();
  }
}
