/**
 * subagents.ts — handing a WHOLE task to a fresh agent, and the two rules that keep that safe.
 *
 * WHY THIS EXISTS. A plan whose steps are `create file a`, `create file b`, `edit d in c` is written at
 * the wrong altitude, and the agent following it spends its context remembering the plan instead of
 * doing the work. Measured on a real request: a five-phase plan totalling 27,138 characters was inlined
 * into every round's prompt, capped at 12,000 — so phases 4 and 5 were CUT OFF, the last of them being
 * "run the server and give the user the link", which is the thing the request was actually for. The
 * agent then read its own plan file over and over and produced a `pyproject.toml`.
 *
 * The shape that works is one level up. A plan says WHAT STAGES exist; each stage goes to a subagent
 * with its own context, its own tools and its own plan file to follow, and comes back with a report.
 * The top-level agent arbitrates and never holds twenty-four steps in its head.
 *
 * A CHILD PROCESS, NOT AN IN-PROCESS LOOP. The agent's state — the conversation window, the call
 * ledger, the tool guard's per-turn counters, the edit ledger — is module-level and per-turn. Running a
 * second loop inside the first would have them share every one of those, so the child's reads would
 * age the parent's repeat counters and the child's window would evict the parent's question. A child
 * process is the isolation the design already has: it is exactly what `ayin -p` is.
 *
 * TWO RULES, BOTH ENFORCED HERE:
 *
 *   1. A SUBAGENT MAY NOT SPAWN SUBAGENTS. Depth is carried in the environment, and at depth ≥ 1 the
 *      tool is not registered at all — it cannot be called because it does not exist. Without this the
 *      arbitration level is not a level: every child could re-plan and re-delegate, and a request would
 *      fan out until something ran out. `--disallow-subagents` sets the same state for a human who
 *      wants a plain agent.
 *   2. PARALLEL IS OFF UNTIL ASKED FOR. Two agents editing one tree race on every file they share, and
 *      the loser's write is silently lost. `--allow-parallel-subagents` turns it on for an operator who
 *      knows their phases are independent; by default several subagent calls in one response run one
 *      after another, which is what the plan's own phase ordering already describes.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { postmortemEnabled } from './postmortem.js';

/** How deep we already are. `0` is the operator's own session; `1` is a subagent it spawned. */
export function subagentDepth(): number {
  const n = Number(process.env.AYIN_SUBAGENT_DEPTH ?? '0');
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** True when this process is itself a subagent — it must not delegate further. */
export function isSubagent(): boolean {
  return subagentDepth() > 0;
}

/**
 * May this process delegate? No at depth ≥ 1, and no when the operator said so.
 *
 * Read by `loadTools`, which WITHHOLDS the tool rather than letting it exist and refuse: a tool the
 * model can see and cannot use is a round spent discovering that.
 */
export function subagentsAllowed(): boolean {
  if (isSubagent()) return false;
  if (process.env.AYIN_SUBAGENTS === '0') return false;
  return !process.argv.includes('--disallow-subagents');
}

/**
 * May several subagents run at once? OFF by default — see rule 2 above.
 *
 * Prepared rather than proven: nothing in this repo has yet measured two agents editing one tree, and
 * the failure it would produce (a lost write) is invisible in any output. The flag exists so that
 * measurement can happen without a code change; the default exists because it has not happened yet.
 */
export function parallelSubagentsAllowed(): boolean {
  return process.env.AYIN_PARALLEL_SUBAGENTS === '1'
    || process.argv.includes('--allow-parallel-subagents');
}

/**
 * ARBITER MODE — the top level delegates instead of typing.
 *
 * The observation this comes from, measured on a real five-phase build: the arbitrator delegated all
 * five phases correctly, and the CHILDREN then made 103 tool calls of which **zero** were `explore`.
 * They groped file by file, because `read_file` and `grep` were right there and composing an exact
 * `str_replace` anchor is what an agent does when it has one. The primitives are not wrong; having them
 * at the ARBITRATION level is, because an agent holding twenty files' exact bytes has no room left to
 * arbitrate.
 *
 * So in arbiter mode the top level keeps only what it needs to decide and verify — `read_file`,
 * `explore`, `perform_edit`, `find_relevant_files`, `subagent` — and the primitives that invite it to
 * do the work itself are withheld. Subagents are unaffected: at depth ≥ 1 the full set is present,
 * which is where the work actually happens.
 *
 * OFF BY DEFAULT, because ayin is not only a builder. "Read src/log.ts and tell me what it does" is an
 * ordinary turn, and an arbiter that must spawn a child to run one shell command has made the common
 * case worse to improve the rare one. `--arbiter` opts in; measurement decides whether it becomes the
 * default.
 */
const ARBITER_WITHHELD = new Set(['write_file', 'str_replace', 'bash', 'grep', 'find_files', 'list_dir']);

export function arbiterMode(): boolean {
  if (isSubagent()) return false;              // a child does the work; it keeps its hands
  return process.env.AYIN_ARBITER === '1' || process.argv.includes('--arbiter');
}

/** True when this tool is hidden from THIS process. Consulted by `loadTools`. */
export function toolWithheld(name: string): boolean {
  if (name === 'subagent' && !subagentsAllowed()) return true;
  // `perform_edit` and `find_relevant_files` are the arbiter's replacements for what it gives up, and
  // a subagent that had them would delegate rather than work — which is the recursion rule again,
  // wearing a different hat.
  if (isSubagent() && (name === 'perform_edit' || name === 'find_relevant_files')) return true;
  return arbiterMode() && ARBITER_WITHHELD.has(name);
}

/**
 * WHAT TO DO INSTEAD — because "unknown tool" is a lie the model routes around, and it routes around
 * it by trying the same call again.
 *
 * A withheld tool is not absent, it is refused, and the two need different sentences. Measured on the
 * first real arbiter build: the model wanted a shell, `bash` had been withheld, `loadTools` had
 * therefore dropped it, and the generic not-found branch matched `bash` against its own shell-command
 * regex and answered *"There is no bash tool. To run shell commands use the bash tool"*. It complied,
 * 28 times, and created no files at all. The refusal has to name the replacement or it is a loop.
 *
 * Returns null when the tool is genuinely not withheld here, so the caller can fall through to the
 * ordinary unknown-tool path.
 */
export function withheldRedirect(name: string): string | null {
  if (!toolWithheld(name)) return null;
  if (name === 'subagent') {
    // TWO REASONS, TWO SENTENCES. A child told "--disallow-subagents" would look for a flag nobody
    // set; the real limit is its depth, and it is permanent for this process.
    return isSubagent()
      ? 'you ARE a subagent, and a subagent cannot spawn subagents — that is what keeps arbitration one '
        + 'level deep instead of recursing. Do this stage yourself with the primitives you have; you may '
        + 'still plan it.'
      : 'subagent is switched off for this run (--disallow-subagents). Work every phase yourself.';
  }
  if (name === 'perform_edit' || name === 'find_relevant_files') {
    return `${name} belongs to the arbitration level, and you are the agent doing the work. `
      + 'Use write_file / str_replace to change a file, and grep / find_files / explore to locate one.';
  }
  // Arbiter mode. Name the one replacement that actually covers this primitive — a list of five
  // alternatives is another way of saying "guess".
  const instead: Record<string, string> = {
    bash: 'you have no shell at this level. Anything that runs a command — npm, git, a build, a test — '
      + 'goes to a child: subagent(task="…"), which has the full primitive set including bash.',
    write_file: 'describe the change instead: perform_edit(file="…", edit="…"). To create a file that '
      + 'does not exist yet, hand the whole stage to subagent(task="…").',
    str_replace: 'describe the change instead: perform_edit(file="…", edit="…") — it reads the file and '
      + 'places the edit, so you do not need its exact current bytes.',
    grep: 'use explore, or find_relevant_files(task="…") for the files a task touches.',
    find_files: 'use find_relevant_files(task="…"), which verifies every path it returns against disk.',
    list_dir: 'use explore, or find_relevant_files(task="…").',
  };
  const how = instead[name] ?? 'hand the work to subagent(task="…").';
  return `${name} is withheld at the arbitration level — you decide and verify, you do not type. ${how}`;
}

export interface SubagentResult {
  ok: boolean;
  /** What the subagent said when it finished — its answer, not its transcript. */
  report: string;
  /** Tool calls it made, counted from its own output. */
  toolCalls: number;
  ms: number;
}

/** `dist/index.js` — this module's own sibling, so a subagent runs the build that spawned it. */
function entryPoint(): string {
  return fileURLToPath(new URL('./index.js', import.meta.url));
}

/**
 * The child's ANSWER, out of its headless transcript.
 *
 * Headless prints tool cards, system notices and a HANDOFF block around the answer. Returning all of it
 * would put the child's entire working transcript into the parent's window — the parent delegated
 * precisely so it would not have to hold that. So: the prose lines, up to the handoff.
 */
/**
 * A CALL HEADER IN HEADLESS STDOUT, BY SHAPE — never by one glyph.
 *
 * `[tool] ▸ name · args` was exact while every card opened with the same character, and per-tool icons
 * ended that: `[tool] ◍ subagent · task=…` stopped matching, so `toolCalls` came back 0 for children
 * that had built an entire project. That number is not decoration — the subagent help tells the
 * operator that **zero tool calls means the child changed nothing**, so a stale regex turned the one
 * signal they are told to trust into a lie in the safe direction's opposite.
 *
 * The shape is: the prefix, one glyph that is not a body-line rule, then the tool name. Body lines
 * (`[tool] │ …`, `[tool] ╰ …`) are excluded explicitly. The TUI has the same problem and solves it the
 * same way in `chat.ts#startsToolCard`, against blessed markup instead of plaintext — two renderers,
 * so two matchers, and `check-tool-icons.mjs` asserts this one so it cannot rot again silently.
 */
export const HEADLESS_TOOL_HEADER = /^\[tool\] (?![│╰])\S \S/gm;

export function extractReport(stdout: string): { report: string; toolCalls: number } {
  const upToHandoff = stdout.split('--- HANDOFF')[0];
  const toolCalls = (stdout.match(HEADLESS_TOOL_HEADER) ?? []).length;
  const prose = upToHandoff
    .split('\n')
    .filter((l) => l.trim() && !/^\[(tool|system)\]/.test(l) && !/^[│╰]/.test(l) && !/^\s{2,}…/.test(l))
    .join('\n')
    .trim();
  return { report: prose, toolCalls };
}

/**
 * Children already running, keyed by the call that asked for them. Cleared at every turn boundary.
 *
 * HOW PARALLEL IS IMPLEMENTED WITHOUT TOUCHING THE AGENT LOOP. That loop does a great deal per call —
 * the guard, the ledger, the artifact cache, the on-screen card, the window pair — all of it in order,
 * and interleaving it would be a rewrite. So when parallelism is allowed the loop PRE-WARMS: every
 * subagent call in the batch is started at once, before the loop begins, and the loop then consumes the
 * already-running promises in its normal sequential way. The bookkeeping stays ordered and legible; only
 * the waiting overlaps.
 */
const inFlight = new Map<string, Promise<SubagentResult>>();

const keyOf = (task: string, opts: { cwd?: string; plan?: string }): string =>
  `${opts.cwd ?? ''}|${opts.plan ?? ''}|${task}`;

/** Turn boundary — a new question does not inherit the last one's children. */
export function resetSubagents(): void {
  inFlight.clear();
}

/**
 * Start these tasks now, all of them, and let the loop collect them later. No-op unless the operator
 * turned parallelism on: see `parallelSubagentsAllowed`.
 */
export function prewarmSubagents(calls: Array<{ task: string; cwd?: string; plan?: string }>): number {
  if (!parallelSubagentsAllowed() || calls.length < 2) return 0;
  let started = 0;
  for (const c of calls) {
    const key = keyOf(c.task, c);
    if (inFlight.has(key)) continue;
    inFlight.set(key, spawnSubagent(c.task, c));
    started++;
  }
  log('INFO', 'subagents_prewarmed', { count: String(started) });
  return started;
}

/**
 * Run one task to completion in a fresh agent, or collect one already running. Never throws — a
 * subagent that dies is a report the parent has to act on, not an exception that ends the parent's turn.
 */
export async function runSubagent(task: string, opts: { cwd?: string; plan?: string; signal?: AbortSignal } = {}): Promise<SubagentResult> {
  const running = inFlight.get(keyOf(task, opts));
  if (running) return running;
  return spawnSubagent(task, opts);
}

async function spawnSubagent(task: string, opts: { cwd?: string; plan?: string; signal?: AbortSignal } = {}): Promise<SubagentResult> {
  const started = Date.now();
  const cwd = opts.cwd || process.cwd();

  // A CWD THAT DOES NOT EXIST IS REPORTED AS A MISSING NODE. `spawn` raises ENOENT for a missing
  // working directory exactly as it does for a missing executable, so the message names the
  // interpreter — "spawn /usr/local/Cellar/node/26.5.0/bin/node ENOENT" — and sends the reader after a
  // broken install. Measured: a model mistyped its own cwd by one character (`arb-l0qlD` for
  // `arb-lqlD`), and that is what came back.
  if (!existsSync(cwd)) {
    log('WARN', 'subagent_bad_cwd', { cwd });
    return {
      ok: false,
      report: `Cannot start a subagent: the directory ${cwd} does not exist. Check the path — this is a `
        + 'cwd you passed, not a problem with ayin or node.',
      toolCalls: 0,
      ms: Date.now() - started,
    };
  }
  // The plan file is named, never inlined: reading it is the child's first act and costs one tool call,
  // where inlining it would put the whole phase into the PARENT's tool result as well.
  const prompt = opts.plan
    ? `${task}\n\nA plan for this task has already been written to ${opts.plan}. Read that file first and follow it.`
    : task;

  log('INFO', 'subagent_start', { cwd, plan: opts.plan ?? '', chars: String(prompt.length) });

  return new Promise<SubagentResult>((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn(process.execPath, [entryPoint(), '-p', prompt], {
      cwd,
      env: {
        ...process.env,
        AYIN_SUBAGENT_DEPTH: String(subagentDepth() + 1),
        // A CHILD THIS PROCESS MAY LATER KILL MUST LEAVE A NOTE. Cancelling a subagent kills a process
        // nobody was watching, and everything it had learned dies with it unless it wrote it down.
        // Inherited rather than always-on: the operator asked for postmortems, or did not.
        ...(postmortemEnabled() ? { AYIN_POSTMORTEM: '1' } : {}),
        /**
         * A CHILD MAY PLAN. It may not DELEGATE — those are different limits, and this line used to
         * enforce the wrong one.
         *
         * The recursion rule is about `subagent`, and it is already enforced where it belongs:
         * `subagentsAllowed()` is false at depth ≥ 1, so the tool is not registered for a child at
         * all. Hard-disabling plan mode as well took away a child's ability to decompose its own
         * stage — a phase like "implement the entry point and the server" is often several steps that
         * benefit from being written down first, and the child was forbidden from doing that while
         * the parent, which is not doing the work, was allowed.
         *
         * So: only suppress planning when the child was HANDED a plan. Then it already has one, and
         * re-planning would spend the whole gate again to rediscover the phase it was given.
         */
        ...(opts.plan ? { AYIN_PLAN: '0' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (ok: boolean, note = ''): void => {
      if (settled) return;
      settled = true;
      const { report, toolCalls } = extractReport(out);
      const ms = Date.now() - started;
      log('INFO', 'subagent_done', { ok: String(ok), toolCalls: String(toolCalls), ms: String(ms) });
      resolve({ ok, report: note ? `${note}\n${report}`.trim() : report, toolCalls, ms });
    };

    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', (err) => finish(false, `subagent failed to start: ${err.message}`));
    child.on('close', (code) => finish(code === 0, code === 0 ? '' : `subagent exited ${code}`));

    // NO TIMEOUT. A stage of the work takes as long as it takes, and a clock cannot tell a subagent
    // that is thinking from one that is stuck — only the signal can, and the signal comes from the
    // operator or from the turn. See `runs.ts`.
    if (opts.signal) {
      const stop = (): void => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      };
      if (opts.signal.aborted) stop();
      else opts.signal.addEventListener('abort', stop, { once: true });
    }
  });
}
