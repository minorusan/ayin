/**
 * sprint/runner.ts — one message, one headless ayin.
 *
 * The same change diff/runner.ts made, for the same reasons and with the same shape. A ticket question
 * used to be handed to the session serving the board: idle it started a turn, busy it was folded into
 * the running one, and a board opened with no TUI behind it could not be asked anything at all ("no
 * interactive session is wired"). Folding is worse here than on the diff page, not better — two
 * questions about two different tickets absorbed into one turn produced one closing message, appended
 * verbatim to both threads.
 *
 * So every message spawns its own run, in the repo the board was served from, and that run appends its
 * own turns. The thread file is still written ONLY by `sprint/chat.ts` — the run's process calls it
 * (app.ts `runHeadless`), the model never learns the path.
 *
 * WHAT DIFFERS FROM THE DIFF RUNNER, and why it is not shared: a ticket thread has no status machine and
 * no reply payload to settle — the FILE growing is the whole signal, which is what the board polls. So
 * there is nothing here to mark done, nothing to reap at boot, and no pid to remember. Two small
 * spawners that say what they each need beat one that carries a status machine for a caller with no
 * status.
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendTurn, isTicketKey } from './chat.js';
import { prompts as promptService, packagePath } from '../prompts-service.js';
import { log } from '../log.js';

/** The sprint namespace's prompts. Registering twice is idempotent and returns the same bundle. */
const sprintPrompts = (): { get: (id: string, vars?: Record<string, string>) => string } =>
  promptService.register('sprint', packagePath('prompts', 'sprint')).bundle;

/** A run that has not finished in this long is presumed wedged and is killed. */
const RUN_TIMEOUT_MS = 30 * 60_000;

/** Beside the threads, deliberately: a ticket's conversation and the runs that answered it are one place. */
function runsDir(): string {
  return join(homedir(), '.ayin-cli', 'sprint', 'chat');
}

/** ayin's own entry point. …/dist/sprint/runner.js → …/dist/index.js */
function ayinEntry(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'index.js');
}

/**
 * The log for one run. Stamped, because a ticket gets asked more than once and the previous run's log is
 * the only record of what it did — a fixed name per key would overwrite it.
 */
export function runLogPath(key: string, stamp = new Date().toISOString()): string {
  return join(runsDir(), `${key}-${stamp.replace(/[:.]/g, '-')}.log`);
}

export interface SprintRun {
  pid: number;
  logPath: string;
}

export interface ChatRunFacts {
  key: string;
  status: string;
  title: string;
  description: string;
  /** Everything said before this message, as text. Never a path — a path the model never sees is a file it cannot corrupt. */
  thread: string;
  comment: string;
  logPath: string;
}

/**
 * The instruction one run receives. Beside the spawn rather than in the route, for the same reason
 * `commentRunPrompt` sits in diff/runner.ts: what a run is TOLD and how a run is STARTED change together,
 * and a gate can then check the prompt without starting a process.
 */
export function chatRunPrompt(f: ChatRunFacts): string {
  return sprintPrompts().get('chatTurn', {
    KEY: f.key,
    STATUS: f.status,
    TITLE: f.title,
    // 8000 chars of description is already more than any answer needs, and a whole epic would push the
    // question itself out of the model's attention.
    DESCRIPTION: f.description.slice(0, 8000),
    THREAD: f.thread || '(nothing — this is the first message about this ticket)',
    COMMENT: f.comment,
    LOG_PATH: f.logPath,
  });
}

/**
 * Answer one ticket message. Nothing here awaits the run: the answer takes minutes and the POST that
 * carried the question must return in milliseconds. The thread file is how the board follows along.
 *
 * `prompt` and `logPath` are built by the CALLER — the prompt because it needs Jira, the log because the
 * prompt names it, and a second `runLogPath()` call here would stamp a different second and hand the run
 * a path to a file nothing writes. This function stays the part that knows about processes and nothing
 * else.
 */
export function runSprintChatAgent(key: string, cwd: string, prompt: string, logPath: string): SprintRun {
  if (!isTicketKey(key)) throw new Error(`not a ticket key: ${key}`);
  mkdirSync(runsDir(), { recursive: true });
  // A RAW DESCRIPTOR, not a WriteStream: `spawn` validates stdio synchronously and a fresh stream's `fd`
  // is still null until its open event fires.
  const logFd = openSync(logPath, 'a');

  let child;
  try {
    child = spawn(process.execPath, [ayinEntry(), '-p', prompt], {
      cwd,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        // How the child knows its messages belong in a ticket thread rather than a terminal nobody is
        // watching. See app.ts `runHeadless`.
        AYIN_SPRINT_CHAT_KEY: key,
        // And where to point the operator when it has nothing to say — the child writes that line
        // itself, because a run that exits 0 in silence is not a failure this side can see.
        AYIN_SPRINT_CHAT_LOG: logPath,
      },
    });
  } catch (e) {
    try { closeSync(logFd); } catch { /* never opened for writing */ }
    const why = e instanceof Error ? e.message : String(e);
    // INTO THE THREAD, because that is where the operator is looking. A question that vanishes because a
    // process failed to start is the one outcome this must never produce.
    appendTurn(key, 'ayin', `The run could not be started — ${why}`);
    throw e;
  }

  const pid = child.pid ?? 0;
  log('INFO', 'sprint_chat_run_started', { key, pid: String(pid), log: logPath });

  const timer = setTimeout(() => {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    appendTurn(key, 'ayin', `No answer in ${RUN_TIMEOUT_MS / 60_000} minutes — the run was killed. Its log is ${logPath}`);
  }, RUN_TIMEOUT_MS);
  timer.unref();

  child.on('error', (e) => {
    clearTimeout(timer);
    appendTurn(key, 'ayin', `The run failed to start — ${e instanceof Error ? e.message : String(e)}`);
  });

  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    try { closeSync(logFd); } catch { /* already closed */ }
    log('INFO', 'sprint_chat_run_exit', { key, code: String(code ?? ''), signal: String(signal ?? '') });
    // A run that died before saying anything leaves the thread ending on an unanswered question. The
    // child writes its own reply when it has one, so this only speaks for the case where it never did —
    // and it says where to look rather than inventing an answer.
    if (code !== 0 || signal) {
      appendTurn(key, 'ayin',
        `The run ended without answering (${signal ? `killed by ${signal}` : `exit ${code}`}). Its log is ${logPath}`);
    }
  });

  return { pid, logPath };
}
