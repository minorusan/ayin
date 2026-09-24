/**
 * verify.ts — RUN the proof each step carries, instead of rendering it and hoping.
 *
 * WHAT WAS WRONG. Every plan step has always had a `verify` field, described in the prompt as "the
 * command to run or the file to read that PROVES this step worked, and what it must show", and
 * `validateSteps` refused any step whose proof was under twelve characters. Nothing ever ran one. The
 * plan's strongest asset — a per-step success oracle, written while the context was fresh — was
 * decoration, and the only check that actually executed was QA's deliverable existence test at the end
 * of the turn, by which point a wrong step has three steps built on top of it.
 *
 * So `PlanStep.verifyCmd` carries the same proof in a form a program can run, and this module runs it
 * at the phase boundary — see `plan/progress.ts` for where, and `subagents.ts` for why that is the only
 * seam available: ayin's phases are worked by the MODEL calling `subagent`, so there is no harness loop
 * to hang a check on except the return of that call.
 *
 * A VERIFICATION IS AN OBSERVATION. These commands are model-written and run without anybody being
 * asked, which is a different thing from the `bash` tool the model calls deliberately — so a command
 * that would CHANGE something is refused rather than run, at draft time by `validateSteps` (where the
 * model can be told to fix it) and again here (where a plan drafted by an older build, or edited on
 * disk, arrives anyway). The list is deliberately short and shaped like the destructive things a
 * "proof" has no business doing; it is not a sandbox, and the header of `subagents.ts` is honest about
 * what this process can already reach.
 */

import { getConfig } from '../prompts.js';
import { log } from '../log.js';
import { killTree, spawnShell } from '../shell.js';
import type { PlanStep } from './plan.js';

/** How long one proof may run before it is reported as unverified rather than failed. */
const TIMEOUT_MS = (): number => getConfig('planVerifyTimeoutMs', 120_000);
/** Output kept per command. Enough to show why it failed, small enough to sit in a tool result. */
const OUTPUT_CAP = 2000;

/**
 * Shapes a proof must not have. Mutation, history rewriting, privilege, and the network-into-a-shell
 * pipe — none of which can be part of demonstrating that a step already worked.
 *
 * `>` and `>>` are here because a redirect is a write, and a step that "proves" itself by writing a
 * file has proved nothing. `2>` and `2>&1` are the legitimate exception and are matched around.
 */
const REFUSED: Array<[RegExp, string]> = [
  [/(^|[\s;&|])rm\s|(^|[\s;&|])rmdir\s/, 'it deletes'],
  [/(^|[\s;&|])(mv|dd|mkfs|shutdown|reboot|kill|pkill|killall)\s/, 'it changes the machine'],
  [/(^|[\s;&|])sudo\s/, 'it asks for privilege'],
  [/git\s+(push|commit|reset|checkout|clean|rebase|merge|stash)\b/, 'it changes the repository'],
  [/(npm|yarn|pnpm|pip|pip3|brew|apt|apt-get|gem|cargo)\s+(i|install|add|uninstall|remove)\b/, 'it installs'],
  [/(curl|wget)[^\n|]*\|\s*(ba)?sh\b/, 'it pipes the network into a shell'],
  [/(^|[^0-9&])>{1,2}[^&]/, 'it redirects output into a file, which is a write'],
];

/**
 * Why this command may not be run as a proof, or null when it may.
 *
 * Exported because `validateSteps` asks the same question at draft time: a refusal the model is told
 * about during the repair pass costs one round trip, where a refusal discovered mid-execution costs
 * the step its only check.
 */
export function verifyCommandRefusal(cmd: string | undefined): string | null {
  // COERCED, NOT ASSUMED. A plan read back from disk was written by whichever build was installed
  // then, and `verifyCmd` is newer than the oldest phase file a restart can hand this. A field that
  // is not there is a step with no runnable check, which is an ordinary answer.
  const c = (cmd ?? '').trim();
  if (!c) return null;
  if (c.includes('\n')) return 'it spans more than one line';
  for (const [pattern, why] of REFUSED) if (pattern.test(c)) return why;
  return null;
}

/** What running one step's proof answered. `unverified` is never a failure — see `PhaseVerification`. */
export interface StepVerification {
  step: number;
  title: string;
  cmd: string;
  state: 'passed' | 'failed' | 'unverified';
  /** Exit code, or null when the command never produced one (timeout, refusal, spawn failure). */
  code: number | null;
  /** Tail of stdout+stderr, capped. Empty on a pass — nobody reads the output of a check that passed. */
  output: string;
  /** Why it is `unverified`: the refusal, the timeout, or the spawn error. */
  note: string;
}

export interface PhaseVerification {
  passed: number;
  failed: number;
  unverified: number;
  /** Steps that carried no `verifyCmd` at all — no check was possible, and that is worth counting. */
  unchecked: number;
  results: StepVerification[];
}

/** Run one command through the platform shell, bounded in time and in output. */
function run(cmd: string, cwd: string, signal?: AbortSignal): Promise<{ code: number | null; output: string; timedOut: boolean; error: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnShell(cmd, { cwd });
    } catch (err) {
      resolve({ code: null, output: '', timedOut: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let out = '';
    let settled = false;
    const take = (d: Buffer): void => {
      // Capped as it arrives, so a command that prints a gigabyte cannot grow this process's heap
      // while it is being watched.
      if (out.length < OUTPUT_CAP * 4) out += d.toString();
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const finish = (code: number | null, timedOut: boolean, error = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: out.slice(-OUTPUT_CAP).trim(), timedOut, error });
    };
    const timer = setTimeout(() => { killTree(child); finish(null, true); }, TIMEOUT_MS());
    const onAbort = (): void => { killTree(child); finish(null, false, 'the turn was cancelled'); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => finish(null, false, err.message));
    child.on('close', (code) => finish(code, false));
  });
}

/**
 * Run every runnable proof in this step list and say what held.
 *
 * SEQUENTIAL, on purpose. These are a project's own build and test commands; two of them at once
 * contend for the same lock, the same port and the same output directory, and a check that fails
 * because another check was running is worse than no check.
 */
export async function verifySteps(steps: PlanStep[], cwd: string, signal?: AbortSignal): Promise<PhaseVerification> {
  const results: StepVerification[] = [];
  let unchecked = 0;
  for (const step of steps) {
    const cmd = (step.verifyCmd ?? '').trim();
    if (!cmd) { unchecked++; continue; }
    const refusal = verifyCommandRefusal(cmd);
    if (refusal) {
      log('WARN', 'plan_verify_refused', { step: String(step.id), why: refusal, cmd: cmd.slice(0, 120) });
      results.push({ step: step.id, title: step.title, cmd, state: 'unverified', code: null, output: '', note: `not run — ${refusal}` });
      continue;
    }
    const started = Date.now();
    const { code, output, timedOut, error } = await run(cmd, cwd, signal);
    const state: StepVerification['state'] = timedOut || error ? 'unverified' : code === 0 ? 'passed' : 'failed';
    log('INFO', 'plan_verify', { step: String(step.id), state, code: String(code ?? ''), ms: String(Date.now() - started) });
    results.push({
      step: step.id,
      title: step.title,
      cmd,
      state,
      code,
      // A passing check's output is noise; a failing one's output is the whole reason to have run it.
      output: state === 'passed' ? '' : output,
      note: timedOut ? `no answer within ${Math.round(TIMEOUT_MS() / 1000)}s` : error,
    });
  }
  return {
    passed: results.filter((r) => r.state === 'passed').length,
    failed: results.filter((r) => r.state === 'failed').length,
    unverified: results.filter((r) => r.state === 'unverified').length,
    unchecked,
    results,
  };
}

/** One line per proof, for the tool result the arbiter reads. Failures first — they are the news. */
export function renderVerification(v: PhaseVerification): string {
  if (v.results.length === 0) {
    return v.unchecked > 0
      ? `Verification: none of this phase's ${v.unchecked} step(s) carried a runnable check.`
      : 'Verification: this phase had no steps to check.';
  }
  const glyph = { passed: '✓', failed: '✗', unverified: '?' } as const;
  const order = { failed: 0, unverified: 1, passed: 2 } as const;
  const lines = [...v.results]
    .sort((a, b) => order[a.state] - order[b.state] || a.step - b.step)
    .map((r) => {
      const head = `${glyph[r.state]} step ${r.step} · ${r.cmd}`;
      if (r.state === 'passed') return head;
      const why = r.note ? ` — ${r.note}` : r.code === null ? '' : ` — exit ${r.code}`;
      return r.output ? `${head}${why}\n${r.output}` : `${head}${why}`;
    });
  const tally = `${v.passed} passed · ${v.failed} failed · ${v.unverified} unverified`
    + (v.unchecked ? ` · ${v.unchecked} step(s) carried no runnable check` : '');
  return `Verification — ${tally}\n${lines.join('\n')}`;
}
