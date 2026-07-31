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
 * ARDUINO. A presentation of Arduino work is only accurate if the wiring page it can reference is
 * current, so Presenter calls the same `regenerateTouchedSketches` the QA-pass hook uses — see that
 * function's own doc for why the two share one implementation with a skip-set instead of each having
 * their own copy.
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
import { regenerateTouchedSketches } from '../tools/arduino-explain.js';
import type { ChangedFile } from '../qa/probes.js';

const presenterPrompts = prompts.register('presenter', packagePath('prompts', 'presenter')).bundle;

export function presenterEnabled(): boolean {
  return process.env.AYIN_PRESENTER !== '0';
}

let sessionEnabled = false;
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
  /** Sketch paths this pass already regenerated the wiring explainer for — the caller hands this to
   *  the QA-pass hook's `regenerateTouchedSketches` call as `skip` so it isn't redone. */
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

/** Pure formatter: parsed classification + an optional Arduino note → the text shown to the user. */
export function formatPresentation(goal: string, parsed: ParsedPresentation, arduinoNote: string | null): string {
  const lines: string[] = [];
  lines.push(`> ${goal || '(no goal recorded this session)'}`);
  lines.push('');
  if (parsed.satisfies) lines.push(parsed.satisfies);
  lines.push('');
  lines.push('Changed:');
  const files = parsed.files ?? [];
  if (files.length === 0) lines.push('- (no file-level changes reported)');
  for (const f of files) lines.push(`- ${f.path}${f.summary ? ` — ${f.summary}` : ''}`);
  if (arduinoNote) lines.push(`- ${arduinoNote}`);
  return lines.join('\n');
}

/**
 * The pass itself. Never throws — a model call failure or an unparseable reply both degrade to
 * `presented: false`, which is always safe: the caller still shows the raw reply exactly as it did
 * before Presenter existed.
 */
export async function presenterPass(goal: string, response: string, files: ChangedFile[]): Promise<PresenterOutcome> {
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
    let arduinoNote: string | null = null;
    let arduinoRegenerated = new Set<string>();
    try {
      const regen = await regenerateTouchedSketches(process.cwd(), files);
      if (regen) {
        arduinoRegenerated = regen.regeneratedPaths;
        arduinoNote = regen.results.length
          ? `wiring explainer regenerated (arduino-explain): ${regen.results.map((r) => r.htmlPath).join(', ')}`
          : null;
      }
    } catch (err) {
      log('WARN', 'presenter_arduino_regen_failed', { error: err instanceof Error ? err.message : String(err) });
    }

    const text = formatPresentation(goal, parsed, arduinoNote);
    log('INFO', 'presenter_presented', { files: String(parsed.files?.length ?? 0) });
    return { presented: true, text, arduinoRegenerated };
  } finally {
    endPhase();
  }
}
