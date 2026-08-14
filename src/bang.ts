/**
 * bang.ts — `!<command>` runs in your shell, verbatim, with the model nowhere near it.
 *
 * The whole point is the absence of interpretation. Typing `!git status -sb` into the chatbox used
 * to be an ordinary prompt: the model read it, decided what the operator "meant", and called the
 * bash tool with its own rewrite — which is why it looked like only the first word survived. A
 * passthrough has exactly one job, and any cleverness in it is a bug.
 *
 * So: the text after `!` is handed to the platform shell unchanged, nothing is added to the
 * conversation window, and no round is spent. It is the operator's own terminal, inside the TUI.
 *
 * Three things it still owes the operator, because a passthrough that hangs the UI is worse than no
 * passthrough: a timeout, a cap on output, and a way to cancel. All three announce themselves rather
 * than silently truncating — a clipped `git log` that looks complete is how you act on the wrong
 * commit.
 */

import type { ChildProcess } from 'node:child_process';
import { killTree, spawnShell } from './shell.js';

/** Long enough for a build, short enough that a hung command frees the UI on its own. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Output past this is cut — announced, never silently. */
const MAX_OUTPUT_CHARS = 200_000;

export interface BangResult {
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

let active: ChildProcess | null = null;
let cancelledFlag = false;

/** True while a `!` command is running — the key handler uses it to route Ctrl+C/Esc. */
export function bangRunning(): boolean {
  return active !== null;
}

/** Kill the running command and its whole process group. Returns false if nothing was running. */
export function cancelBang(): boolean {
  if (!active) return false;
  cancelledFlag = true;
  killTree(active, 'SIGTERM');
  // A shell that ignores SIGTERM still has to go; the operator asked twice by then.
  const child = active;
  setTimeout(() => { if (child === active) killTree(child, 'SIGKILL'); }, 2000).unref?.();
  return true;
}

/**
 * Run `command` through the platform shell and collect everything it printed.
 *
 * stdout and stderr are interleaved into one buffer in arrival order, because that is what the
 * operator would have seen in their own terminal — separating them reorders the story of what
 * happened (a warning printed before the failure it explains ends up after it).
 */
export function runBang(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<BangResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  cancelledFlag = false;

  return new Promise<BangResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnShell(command, { cwd: opts.cwd ?? process.cwd() });
    } catch (err) {
      resolve({
        output: `could not start a shell: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: null, signal: null, ms: 0, timedOut: false, cancelled: false, truncated: false,
      });
      return;
    }
    active = child;

    let output = '';
    let truncated = false;
    const append = (buf: Buffer): void => {
      if (truncated) return;
      output += buf.toString('utf-8');
      if (output.length > MAX_OUTPUT_CHARS) {
        output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n…(output cut at ${MAX_OUTPUT_CHARS} characters — the command kept printing)`;
        truncated = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child, 'SIGKILL'); }, timeoutMs);
    timer.unref?.();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      active = null;
      resolve({
        output: output.replace(/\s+$/, ''),
        exitCode, signal, ms: Date.now() - started,
        timedOut, cancelled: cancelledFlag, truncated,
      });
    };

    child.on('error', (err) => {
      output += `${output ? '\n' : ''}${err.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
