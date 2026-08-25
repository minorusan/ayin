/**
 * diff/runner.ts — one comment, one headless ayin.
 *
 * WHY A PROCESS AND NOT A TURN. A comment used to be handed to the session serving the page: idle, it
 * started a turn; busy, it was FOLDED into the running one. Folding is what made the feature dishonest.
 * Three comments absorbed by one turn share a single closing message, so the page showed the same
 * paragraph under three different questions, each looking like an individual answer — and a comment
 * written while the agent was mid-edit had to wait for work it had nothing to do with. Worse, a review
 * with no TUI attached could not be answered at all: the route refused with "no interactive session is
 * wired".
 *
 * A run per comment removes all of it. Each comment gets its own process, its own context, its own log
 * and its own reply, and two comments written a second apart are answered in parallel by two runs that
 * never see each other's prompt.
 *
 * THE RUN SETTLES ITSELF. `markDone` is called by the CHILD (see app.ts `runHeadless`), not from the
 * exit handler here — a page must still get its answer when the session that spawned the run is closed
 * mid-answer, which is now an ordinary thing to do rather than a crash. This side owns only the
 * failures the child cannot report: a non-zero exit, a spawn that never started, a run that wedged. So
 * the exit handler re-reads the record and touches it ONLY if it is still unsettled.
 *
 * WHAT IT COSTS. A run is a whole ayin: its own model context, its own tool rounds. That is the price
 * of an answer that belongs to one question, and it is paid per comment deliberately.
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addNote, getComment, markFailed, markWorking, patchComment, type DiffComment } from './comments.js';
import { getPrompt } from '../prompts.js';
import { log } from '../log.js';

/** A run that has not finished in this long is presumed wedged and is killed. Same ceiling a sentinel run gets. */
const RUN_TIMEOUT_MS = 30 * 60_000;

const DIFF_DIR = join(homedir(), '.ayin-cli', 'diffs');

/** ayin's own entry point. …/dist/diff/runner.js → …/dist/index.js */
function ayinEntry(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'index.js');
}

/** The run's log — named by the comment, so a thread on the page and a file on disk are one lookup apart. */
export function runLogPath(id: string): string {
  return join(DIFF_DIR, `comment-${id}.log`);
}

/** The instruction one run receives: the marker `prompts/ayin/system.txt` recognises, plus its own facts. */
export function commentRunPrompt(c: DiffComment, pageUrl: string): string {
  return getPrompt('diffCommentRun', {
    PAGE_URL: pageUrl,
    COMMENT_ID: c.id,
    FILE: c.file,
    LINE_NO: String(c.lineNo),
    SIDE_LABEL: c.side === 'old' ? 'removed' : 'current',
    SIDE_SIGN: c.side === 'old' ? '-' : '+',
    LINE_TEXT: c.lineText,
    COMMENT: c.text,
    CWD: c.cwd,
    LOG_PATH: runLogPath(c.id),
  });
}

/**
 * Answer one comment. Returns the pid, or 0 when nothing started — the caller reports that to the page
 * rather than leaving a thread pending against a run that does not exist.
 *
 * Nothing here awaits the run. A comment is answered in minutes and the POST that carried it must
 * return in milliseconds; the thread's status is how the page follows along.
 */
export function runCommentAgent(c: DiffComment, pageUrl: string): number {
  let logFd: number;
  try {
    mkdirSync(DIFF_DIR, { recursive: true });
    // A RAW DESCRIPTOR, not a WriteStream: `spawn` validates stdio synchronously and a fresh stream's
    // `fd` is still null until its open event fires.
    logFd = openSync(runLogPath(c.id), 'a');
  } catch (e) {
    const why = `could not open the run log — ${e instanceof Error ? e.message : String(e)}`;
    markFailed(c.cwd, c.id, why);
    return 0;
  }

  let child;
  try {
    child = spawn(process.execPath, [ayinEntry(), '-p', commentRunPrompt(c, pageUrl)], {
      cwd: c.cwd,
      // NOT detached, and NOT unref'd: the run belongs to the review the operator is looking at, so it
      // should die with a session that is torn down rather than keep editing the tree behind them. A
      // session that merely EXITS leaves it running — the child settles its own thread, so the page
      // still gets its answer.
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        // How the child knows to mirror itself into this thread instead of talking to a terminal
        // nobody is looking at. See app.ts `runHeadless`.
        AYIN_DIFF_COMMENT_ID: c.id,
        // AND THE CWD THE COMMENT WAS RECORDED UNDER, because the store is keyed by that STRING. The
        // child cannot ask for it: `process.cwd()` returns the path with every symlink resolved, so a
        // session serving `/var/folders/…` spawns a run that reports `/private/var/folders/…` and
        // settles a thread in a store nobody is reading. Observed exactly that way — the page waited
        // while the answer was written to a second file one directory-name apart.
        AYIN_DIFF_COMMENT_CWD: c.cwd,
      },
    });
  } catch (e) {
    try { closeSync(logFd); } catch { /* never opened for writing */ }
    const why = `could not start a run — ${e instanceof Error ? e.message : String(e)}`;
    markFailed(c.cwd, c.id, why);
    return 0;
  }

  const pid = child.pid ?? 0;
  // Working, and BY WHOM. The pid is what lets a later boot tell a run still editing from a run whose
  // process died with its session — see comments.ts `reapAbandoned`.
  markWorking(c.cwd, c.id);
  patchComment(c.cwd, c.id, { pid });
  log('INFO', 'diff_comment_run_started', { id: c.id, pid: String(pid), file: c.file });

  const timer = setTimeout(() => {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    addNote(c.cwd, c.id, `no answer in ${RUN_TIMEOUT_MS / 60_000} minutes — the run was killed`);
  }, RUN_TIMEOUT_MS);
  timer.unref();

  child.on('error', (e) => {
    clearTimeout(timer);
    markFailed(c.cwd, c.id, `the run could not be started — ${e instanceof Error ? e.message : String(e)}`);
  });

  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    try { closeSync(logFd); } catch { /* already closed */ }
    // The child settles its own thread on the way out. Only an exit that left it unsettled is ours to
    // report — otherwise this would overwrite the answer the run just wrote with a note about its
    // exit code.
    const fresh = getComment(c.cwd, c.id);
    if (!fresh || (fresh.status !== 'pending' && fresh.status !== 'working')) {
      log('INFO', 'diff_comment_run_exit', { id: c.id, code: String(code ?? ''), signal: String(signal ?? '') });
      return;
    }
    markFailed(c.cwd, c.id,
      `the run ended without an answer (${signal ? `killed by ${signal}` : `exit ${code}`}) — its log is ${runLogPath(c.id)}`);
  });

  return pid;
}
