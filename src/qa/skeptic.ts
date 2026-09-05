/**
 * The SKEPTIC pass — a pre-mortem on a change that is about to be called finished.
 *
 * IT IS NOT THE QA GATE, AND THE DIFFERENCE IS THE WHOLE POINT. QA asks *did you do what was asked,
 * to the standing bar* — criteria derived from the operator's own prompts, checked against the files
 * and the measured probes. It is conformance. A change can satisfy every criterion, compile, pass
 * its tests and still take the system down at 03:00, because the failure was never in the request:
 * it was in the blast radius. So this pass asks the other question, out loud:
 *
 *     "tell me exactly how this breaks in production."
 *
 * WHAT IT IS GIVEN, AND WHY THAT IS THE FEATURE. Not "the changed files" — the judge already reads
 * those. It gets **the diff plus the caller list**: every other place in the repo that names what
 * this turn touched, found deterministically by grep. That list is the difference between a model
 * having opinions about a file and a model seeing that three call sites pass `undefined` to the
 * parameter that just became required. A reviewer who cannot see the callers cannot review a change;
 * it can only review a file.
 *
 * IT NEVER BLOCKS, AND THAT IS DELIBERATE. Findings are a card and a line in the session record —
 * never a fix loop, never a verdict, never a reason the operator waits longer for an answer they
 * already have. `qa/index.ts` argues the same thing about a broken judge, and it applies double
 * here: these are HYPOTHESES. Some are wrong. A pass that could hold work hostage on a guess would
 * be a worse bug than most of what it finds, and the operator — who is reading the card in the same
 * second — is a far better filter than another model round.
 *
 * ONE CALL, ONE PASS, BOUNDED. `skepticMaxFindings` caps the report; the diff and the caller list
 * are both clipped to a budget and say when they were. An LLM failure yields no findings and a card
 * that says so — never an exception into the turn.
 *
 * ON THE MODEL. It runs on the session's own model, exactly like the QA judge, because that is the
 * one door this repo has. The strongest version of this pass would spend a DIFFERENT and cheaper
 * model — a second opinion is worth most when it does not share the context that made the mistake —
 * and the seam for that already exists (`background.ts`'s `LaneTarget`, `/set-subagent-model`). That
 * is the next step, not a shipped claim.
 */

import { execFileSync } from 'node:child_process';
import { basename, relative } from 'node:path';
import { log } from '../log.js';
import { llmChat } from '../llm/manager.js';
import { getConfig, getPrompt } from '../prompts.js';
import { recordQa } from '../session-record.js';
import { collectDiff, type FileDiff } from '../diff/collect.js';
import type { ChangedFile } from './probes.js';
import type { QaCard } from './index.js';

// ── budgets ───────────────────────────────────────────────────────────
// Every one of these is a clip that ANNOUNCES itself in the rendered text. A silent truncation would
// hand the model a partial picture it cannot know is partial, which is how a reviewer concludes
// "nothing else calls this" about a repo it was only shown half of.

const MAX_DIFF_CHARS = 24_000;
const MAX_FILES = 12;
/** Needles per file. A file exporting forty symbols must not become forty greps on every turn. */
const MAX_NEEDLES_PER_FILE = 8;
const MAX_HITS_PER_NEEDLE = 8;
const MAX_HITS_TOTAL = 60;
const GREP_TIMEOUT_MS = 5_000;

// ── what the pass produces ────────────────────────────────────────────

export interface SkepticFinding {
  /** Where it bites. `file:line` when the model can point at one — it is asked to. */
  file: string;
  line?: number;
  /** The concrete input, state or timing that sets it off. Not a category. */
  trigger: string;
  /** What the user or the system actually experiences when it does. */
  consequence: string;
  /**
   * Did the model claim this is certain, or is it a suspicion?
   *
   * Asked for explicitly, and kept, because the honest half of a pre-mortem is knowing which half is
   * guesswork. A list that presents eight guesses with the same confidence as one measured fact is a
   * list the operator learns to skim, and then the one real finding goes past with the rest.
   */
  sure: boolean;
}

export interface SkepticResult {
  findings: SkepticFinding[];
  /** One line for the card's footer, or the reason there is nothing to show. */
  note: string;
  /** How many call sites the grep found — evidence that the caller half actually ran. */
  callers: number;
}

// ── when it runs ──────────────────────────────────────────────────────

/**
 * OFF by default, and toggled exactly like QA — `/skeptic` for the session, `/skepticthis` for one
 * turn. `AYIN_SKEPTIC=1` arms it headlessly, where there is no TUI to type into; `AYIN_SKEPTIC=0`
 * and `skepticMaxFindings: 0` are both kill switches.
 *
 * A SEPARATE TOGGLE FROM QA's, not a sub-setting of it. They ask different questions: an operator
 * doing a delicate refactor may want the pre-mortem and not the conformance loop, and one halfway
 * through a feature may want the opposite. Folding this into `/qa` would have made the cheaper,
 * non-blocking pass depend on turning on the expensive one that can send work back.
 */
let sessionEnabled = process.env.AYIN_SKEPTIC === '1';
let forceNextTurn = false;

export function skepticEnabled(): boolean {
  return process.env.AYIN_SKEPTIC !== '0' && getConfig('skepticMaxFindings', 8) > 0;
}

export function toggleSkepticSession(): boolean {
  sessionEnabled = !sessionEnabled;
  return sessionEnabled;
}

export function isSkepticSessionEnabled(): boolean {
  return sessionEnabled;
}

export function forceSkepticNextTurn(): void {
  forceNextTurn = true;
}

/**
 * Call exactly once per turn, unconditionally — it consumes the one-shot force whether or not this
 * turn had anything to review. See the identical note in `qa/index.ts#shouldRunQaThisTurn`.
 */
export function shouldRunSkepticThisTurn(): boolean {
  const forced = forceNextTurn;
  if (forced) forceNextTurn = false;
  return skepticEnabled() && (sessionEnabled || forced);
}

// ── the deterministic half: the diff, and who else touches this ───────

interface CallerHit {
  needle: string;
  file: string;
  line: number;
  text: string;
}

/** Render one file's hunks the way a reviewer reads them: `+`/`-`/space, with the git line numbers. */
function renderFileDiff(f: FileDiff): string {
  const head = `--- ${f.path} [${f.status}${f.untracked ? ', untracked' : ''}] +${f.additions}/-${f.deletions}`;
  if (f.binary) return `${head}\n  (binary)`;
  if (f.bodyOmitted) return `${head}\n  (body not rendered — the diff budget ran out)`;
  const body = f.hunks
    .map((h) => [`${h.header}${h.section ? ` ${h.section}` : ''}`, ...h.lines.map((l) => {
      const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      return `${mark}${l.text}`;
    })].join('\n'))
    .join('\n');
  return `${head}\n${body}${f.truncated ? '\n  (…file diff truncated)' : ''}`;
}

/**
 * The turn's diff — and ONLY the turn's.
 *
 * `collectDiff` reports the whole working tree, which on a machine where several sessions share one
 * checkout is somebody else's work as well as this turn's. Reviewing that would be worse than
 * reviewing nothing: the pass would report failure modes in code this turn never wrote, and the
 * operator would have no way to tell which was which.
 */
function turnDiff(root: string, files: ChangedFile[]): { text: string; clipped: boolean } {
  const wanted = new Set(files.map((f) => relative(root, f.path) || f.path));
  let set;
  try {
    set = collectDiff(root);
  } catch (err) {
    log('WARN', 'skeptic_diff_failed', { error: err instanceof Error ? err.message : String(err) });
    return { text: '(no diff available — not a git repository, or git failed)', clipped: false };
  }
  const mine = set.files.filter((f) => wanted.has(f.path));
  if (mine.length === 0) return { text: '(git reported no diff for this turn\'s files)', clipped: false };

  const parts: string[] = [];
  let budget = MAX_DIFF_CHARS;
  let clipped = false;
  for (const f of mine.slice(0, MAX_FILES)) {
    const text = renderFileDiff(f);
    if (text.length > budget) { clipped = true; break; }
    budget -= text.length;
    parts.push(text);
  }
  if (mine.length > MAX_FILES) clipped = true;
  if (clipped) parts.push(`(diff clipped — ${mine.length} file(s) changed, ${parts.length} shown)`);
  return { text: parts.join('\n\n'), clipped };
}

/**
 * What to grep for: the module's own name, plus the symbols this turn actually touched.
 *
 * TOUCHED, not exported. A file may export forty things and this turn changed two of them; grepping
 * all forty spends the budget on call sites nobody is at risk from, and buries the two that matter.
 * So the symbol names come out of the ADDED AND REMOVED lines — the change itself — which is also
 * why a pure comment edit produces no needles and costs nothing.
 *
 * Deliberately regex, not a parser. A TypeScript AST would be more precise on TypeScript and useless
 * on the Dart, C# and Arduino repos this same gate runs in; a name that appears in a changed line is
 * a good enough needle for grep to do the real work.
 */
const SYMBOL_RE = /\b(?:export\s+(?:default\s+)?(?:async\s+)?)?(?:function|class|interface|type|enum|const|let|var|def|fn|struct|void|public|private|protected)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

function needlesFor(f: FileDiff): string[] {
  const out = new Set<string>();
  const stem = basename(f.path).replace(/\.[^.]+$/, '');
  // The module's identity: an importer names the file, not a symbol inside it.
  if (stem.length >= 3) out.add(stem);
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'ctx') continue;
      for (const m of l.text.matchAll(SYMBOL_RE)) {
        const name = m[1];
        // Two-character names are noise in a grep; language keywords slip through the regex's
        // alternation when a line reads `public static void Foo` and would match `static`.
        if (name.length >= 4 && !KEYWORDS.has(name)) out.add(name);
      }
      if (out.size >= MAX_NEEDLES_PER_FILE) return [...out].slice(0, MAX_NEEDLES_PER_FILE);
    }
  }
  return [...out].slice(0, MAX_NEEDLES_PER_FILE);
}

const KEYWORDS = new Set([
  'static', 'async', 'await', 'return', 'const', 'this', 'super', 'void', 'string', 'number',
  'boolean', 'readonly', 'export', 'default', 'public', 'private', 'protected', 'extends',
  'implements', 'namespace', 'override', 'virtual', 'abstract', 'final', 'null', 'true', 'false',
]);

/**
 * Who else in this repo names what changed. Deterministic — a grep, not a model.
 *
 * `git grep` rather than a walk: it is fast on a large repo and it already skips `.gitignore`d trees,
 * so a caller list can never fill up with `node_modules` or build output. A repo that is not a git
 * repo simply reports no callers, which is honest — better than a slow recursive scan the operator
 * has to wait through on a turn that was supposed to be finished.
 *
 * The changed files themselves are EXCLUDED. A symbol's own definition and its neighbours are already
 * in the diff above; repeating them as "callers" would pad the list with the one place the reviewer
 * can already see, and push the real call sites past the cap.
 */
function callersOf(root: string, files: FileDiff[], changed: Set<string>): CallerHit[] {
  const hits: CallerHit[] = [];
  const seen = new Set<string>();
  for (const f of files.slice(0, MAX_FILES)) {
    for (const needle of needlesFor(f)) {
      if (hits.length >= MAX_HITS_TOTAL) return hits;
      let raw = '';
      try {
        raw = execFileSync(
          'git',
          ['grep', '-n', '--fixed-strings', '--', needle],
          { cwd: root, encoding: 'utf-8', timeout: GREP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
        );
      } catch {
        // `git grep` exits 1 for "no matches", which is not an error — and any other failure (not a
        // repo, timeout) means this needle contributes nothing. Either way: next needle.
        continue;
      }
      let perNeedle = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim() || perNeedle >= MAX_HITS_PER_NEEDLE || hits.length >= MAX_HITS_TOTAL) break;
        const m = /^([^:]+):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        const [, file, no, text] = m;
        if (changed.has(file)) continue; // it is in the diff already
        const key = `${file}:${no}`;
        if (seen.has(key)) continue;
        seen.add(key);
        perNeedle++;
        hits.push({ needle, file, line: Number(no), text: text.trim().slice(0, 200) });
      }
    }
  }
  return hits;
}

function renderCallers(hits: CallerHit[]): string {
  if (hits.length === 0) {
    // Said explicitly, because "nothing here" and "the search did not run" are different facts and a
    // model shown an empty section will assume whichever suits its answer.
    return '(no other file in this repo names anything this turn changed — either it is genuinely '
      + 'self-contained, or this is not a git repository)';
  }
  const byNeedle = new Map<string, CallerHit[]>();
  for (const h of hits) {
    const list = byNeedle.get(h.needle) ?? [];
    list.push(h);
    byNeedle.set(h.needle, list);
  }
  return [...byNeedle.entries()]
    .map(([needle, list]) => [`${needle} — ${list.length} other site(s):`, ...list.map((h) => `  ${h.file}:${h.line}  ${h.text}`)].join('\n'))
    .join('\n');
}

/** Everything the pass gathered before a model saw anything. Exported for `tool/check-skeptic.mjs`. */
export interface BlastRadius {
  diff: string;
  callers: string;
  callerCount: number;
  clipped: boolean;
}

export function blastRadius(root: string, files: ChangedFile[]): BlastRadius {
  const { text: diff, clipped } = turnDiff(root, files);
  let set;
  try {
    set = collectDiff(root);
  } catch {
    return { diff, callers: renderCallers([]), callerCount: 0, clipped };
  }
  const wanted = new Set(files.map((f) => relative(root, f.path) || f.path));
  const mine = set.files.filter((f) => wanted.has(f.path));
  const hits = callersOf(root, mine, wanted);
  return { diff, callers: renderCallers(hits), callerCount: hits.length, clipped };
}

// ── the judged half ───────────────────────────────────────────────────

function parseFindings(raw: string, max: number): SkepticFinding[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { findings?: unknown };
    if (!Array.isArray(obj.findings)) return [];
    return obj.findings
      .slice(0, max)
      .map((f) => {
        const o = (f ?? {}) as Record<string, unknown>;
        const line = Number(o.line);
        return {
          file: String(o.file ?? '?').slice(0, 200),
          ...(Number.isFinite(line) && line > 0 ? { line } : {}),
          trigger: String(o.trigger ?? '').slice(0, 400).trim(),
          consequence: String(o.consequence ?? '').slice(0, 400).trim(),
          // Anything but an explicit `true` is a suspicion. A model that omits the field is not
          // certain, and defaulting the other way would promote every guess to a fact.
          sure: o.sure === true,
        };
      })
      .filter((f) => f.trigger.length > 0 && f.consequence.length > 0);
  } catch {
    return [];
  }
}

/**
 * One skeptic pass. Never throws: the caller is a turn that has already produced an answer, and a
 * failed pre-mortem must cost that answer nothing.
 */
export async function skepticPass(
  goal: string,
  answer: string,
  files: ChangedFile[],
  root: string,
  isInterrupted: () => boolean = () => false,
): Promise<SkepticResult> {
  const max = getConfig('skepticMaxFindings', 8);
  /**
   * EVERYTHING is inside the try, including the deterministic half — and that placement was a real
   * bug, caught by this pass's own first live run on itself.
   *
   * `blastRadius` shells out to git twice and reads a config file. Each of those has its own guard,
   * which is exactly the reasoning that left the call outside: "it cannot throw". A function whose
   * contract is NEVER THROWS cannot rest on an audit of what it happens to call today — the audit
   * stops being true the first time someone adds a line. The caller is a finished turn; a
   * pre-mortem that takes the answer down with it would be the worst possible bug in this file.
   */
  let radius: BlastRadius = { diff: '', callers: '', callerCount: 0, clipped: false };
  try {
    radius = blastRadius(root, files);
    if (isInterrupted()) return { findings: [], note: 'interrupted before the review', callers: radius.callerCount };
    const raw = await llmChat([{
      role: 'user',
      content: getPrompt('skeptic', {
        GOAL: goal || '(none derived)',
        MAX: String(max),
        DIFF: radius.diff,
        CALLERS: radius.callers,
        ANSWER: answer.slice(0, 8_000),
      }),
    }]);
    const findings = parseFindings(raw, max);
    log('INFO', 'skeptic', {
      findings: String(findings.length),
      sure: String(findings.filter((f) => f.sure).length),
      callers: String(radius.callerCount),
      files: String(files.length),
    });
    recordQa('skeptic', 0, findings.map((f) => `${f.file}: ${f.trigger}`).join(' | ').slice(0, 400), findings.length);
    return {
      findings,
      note: `${radius.callerCount} call site(s) checked${radius.clipped ? ' · diff clipped' : ''}`,
      callers: radius.callerCount,
    };
  } catch (err) {
    log('WARN', 'skeptic_failed', { error: err instanceof Error ? err.message : String(err) });
    return { findings: [], note: 'the skeptic call failed — no pre-mortem this turn', callers: radius.callerCount };
  }
}

/** One finding, as one line. `file:line` first, because that is what the reader acts on. */
function findingLine(f: SkepticFinding): string {
  const where = f.file && f.file !== '?' ? `${f.file.split('/').slice(-2).join('/')}${f.line ? `:${f.line}` : ''}` : '';
  const mark = f.sure ? '' : ' (unsure)';
  return `${where ? `${where} — ` : ''}${f.trigger} → ${f.consequence}${mark}`;
}

/**
 * The card. `info` in both directions — a skeptic pass has no verdict to give.
 *
 * A `fail` kind would be wrong even when it finds something real: nothing failed, nobody is fixing
 * anything on its say-so, and colouring a list of hypotheses like a failed gate is how the operator
 * learns to distrust the gate that does have a verdict.
 */
export function skepticCard(r: SkepticResult): QaCard {
  if (r.findings.length === 0) {
    return { kind: 'info', title: 'SKEPTIC — nothing found', body: [r.note] };
  }
  const sure = r.findings.filter((f) => f.sure).length;
  return {
    kind: 'info',
    title: `SKEPTIC · ${r.findings.length} way${r.findings.length === 1 ? '' : 's'} this could break`,
    // Certain ones first: the operator reads top-down and stops when they have had enough.
    body: [...r.findings].sort((a, b) => Number(b.sure) - Number(a.sure)).map(findingLine),
    footer: `${sure} claimed certain · ${r.note} · nothing was changed — these are hypotheses`,
  };
}
