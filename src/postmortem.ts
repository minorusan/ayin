/**
 * postmortem.ts — when a run dies without saying goodbye, leave a note saying where it got to.
 *
 * WHY. A headless ayin that is killed leaves nothing. Not a partial answer, not a list of what it had
 * done, not the name of the file it was in the middle of writing — the operator gets an exit code and a
 * scrollback that ends mid-sentence. That is bad enough when a person pressed Ctrl+C; it is worse now
 * that ayin spawns ayin, because a parent cancelling a subagent kills a process nobody was watching,
 * and everything that child had learned dies with it.
 *
 * So: a process that dies UNEXPECTEDLY writes down where it left off. "Unexpectedly" is defined by its
 * complement — a clean shutdown calls `markCleanExit()` on the way out, and anything that reaches an
 * exit without having called it is unexpected by definition. That inversion is deliberate: a list of
 * "bad" exits is a list you have to keep complete, and the one you forget is the one that loses the
 * work.
 *
 * WHAT IS IN IT, and why each part earns its place:
 *   - WHY IT DIED — the signal or the exception. The first question anybody asks.
 *   - WHAT WAS RUNNING — from `runs.ts`, which knows the live calls, how long each had been going and
 *     the last thing it said. This is the part no log reconstructs: "killed during `npm run build`,
 *     43 seconds in" versus "killed".
 *   - THE TAIL — the last events out of the session record, in order. What it had already done.
 *   - WHERE TO RESUME — the goal, the plan file if there was one, the cwd.
 *
 * TWO COPIES, ON PURPOSE. One in the working directory, where the operator is standing and will see it
 * without being told it exists; one in `~/.ayin-cli/postmortems/`, which survives a `rm -rf` of the
 * work tree and gathers every run on the machine in one place. A note only in the cache is a note
 * nobody finds; a note only in the tree is a note that dies with the tree.
 *
 * EVERY WRITE HERE IS SYNCHRONOUS. This runs inside signal handlers and `process.on('exit')`, where the
 * event loop is already closing and a promise will never settle.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentRuns } from './runs.js';
import { getSessionId } from './session-store.js';

const POSTMORTEM_DIR = join(homedir(), '.ayin-cli', 'postmortems');

/** How many session-record events the note carries. Enough to see the shape of the run. */
const TAIL_EVENTS = 40;

let armed = false;
let cleanExit = false;
let written = false;
let context: { goal: string; plan: string } = { goal: '', plan: '' };
const startedAt = Date.now();

/** True when this process was launched with postmortems on. */
export function postmortemEnabled(): boolean {
  return process.env.AYIN_POSTMORTEM === '1' || process.argv.includes('--postmortem');
}

/**
 * THE EXPECTED EXIT SEQUENCE. Call this when the run finished the work it was asked to do.
 *
 * Everything else — a signal, an uncaught throw, a parent killing a subagent, a `process.exit` from
 * somewhere that did not think about this — is unexpected, and leaves a note.
 */
export function markCleanExit(): void {
  cleanExit = true;
}

/** What the note should say about where to pick up. Cheap to set, so set it as soon as it is known. */
export function notePostmortemContext(patch: Partial<typeof context>): void {
  context = { ...context, ...patch };
}

/** The last `TAIL_EVENTS` events of this session, oldest first. Read from disk — no in-memory state. */
function sessionTail(): string[] {
  const id = getSessionId();
  if (!id) return [];
  const path = join(homedir(), '.ayin-cli', 'sessions', `${id}.jsonl`);
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-TAIL_EVENTS).map((l) => {
      try {
        const e = JSON.parse(l) as Record<string, unknown>;
        const ts = String(e.ts ?? '').slice(11, 19);
        const kind = String(e.kind ?? '?');
        const rest = Object.entries(e)
          .filter(([k]) => !['ts', 'sessionId', 'cwd', 'kind'].includes(k))
          .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ').slice(0, 160)}`)
          .join(' ');
        return `${ts}  ${kind.padEnd(8)} ${rest}`;
      } catch {
        return l.slice(0, 200);
      }
    });
  } catch {
    return [];
  }
}

/** The note itself. Pure — same inputs, same bytes — so two copies can never disagree. */
export function renderPostmortem(reason: string): string {
  const runs = currentRuns();
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const lines: string[] = [
    '# ayin postmortem',
    '',
    'This run ended without completing its expected exit sequence. What follows is where it got to.',
    '',
    '## How it ended',
    '',
    `- reason: **${reason}**`,
    `- pid: ${process.pid}`,
    `- session: ${getSessionId() || '(none established)'}`,
    `- cwd: ${process.cwd()}`,
    `- ran for: ${secs}s`,
    `- subagent depth: ${process.env.AYIN_SUBAGENT_DEPTH ?? '0'}`,
    '',
    '## What was running when it died',
    '',
  ];
  if (runs.length === 0) {
    lines.push('Nothing — it was between tool calls, thinking or idle.');
  } else {
    // The part no log reconstructs. `runs.ts` is the only thing that knows this.
    for (const r of runs) {
      lines.push(`- **${r.tool}**(${r.params}) — ${Math.round(r.ms / 1000)}s in${r.note ? `, last said: ${r.note}` : ', it had said nothing'}`);
    }
  }
  lines.push('', '## Where to resume', '');
  lines.push(`- goal: ${context.goal || '(none recorded)'}`);
  lines.push(`- plan: ${context.plan || '(no plan file)'}`);
  lines.push('', '## The tail', '');
  const tail = sessionTail();
  if (tail.length === 0) {
    lines.push('(no session record — the run died before it recorded anything)');
  } else {
    lines.push('```');
    lines.push(...tail);
    lines.push('```');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write the note, both copies. Returns the paths written; never throws — a process that is already
 * dying must not die differently because of its own epitaph.
 */
export function writePostmortem(reason: string): string[] {
  if (written) return [];
  written = true;
  const body = renderPostmortem(reason);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `ayin-postmortem-${stamp}-${process.pid}.md`;
  const paths: string[] = [];

  // The working directory FIRST: it is where the operator is standing, and the one they will see
  // without being told it exists.
  for (const dir of [process.cwd(), POSTMORTEM_DIR]) {
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      writeFileSync(path, body);
      paths.push(path);
      if (dir === POSTMORTEM_DIR) indexPostmortem(path);
    } catch {
      /* a note we cannot write is not a reason to fail differently */
    }
  }
  // One line on stderr, because a file nobody is told about is a file nobody reads.
  if (paths.length) {
    try { process.stderr.write(`\nayin: died unexpectedly (${reason}) — postmortem: ${paths.join(' and ')}\n`); } catch { /* closed */ }
  }
  return paths;
}

/**
 * Install the handlers. Idempotent, and a no-op unless postmortems were asked for.
 *
 * `exit` is the backstop that catches everything the named handlers do not — a `process.exit()` from
 * anywhere, a rejected promise that took the process down, a `return` out of main that nobody marked.
 */
export function armPostmortem(): void {
  if (armed || !postmortemEnabled()) return;
  armed = true;

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      writePostmortem(`killed by ${sig}`);
      // Re-raise the default disposition rather than swallowing it: a process that ignores SIGTERM is
      // a process the parent has to escalate to SIGKILL, which loses the very note this exists for.
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }

  process.on('uncaughtException', (err) => {
    writePostmortem(`uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

  process.on('unhandledRejection', (err) => {
    writePostmortem(`unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

  process.on('exit', (code) => {
    if (cleanExit) return;
    writePostmortem(code === 0 ? 'exited without completing its expected exit sequence' : `exited with code ${code}`);
  });
}

/** For `check:gates` — the note's own trail, so a gate can assert a write happened without a process. */
export function postmortemDir(): string {
  return POSTMORTEM_DIR;
}

/** True once a note has been written this process. */
export function postmortemWritten(): boolean {
  return written;
}

/** Test seam: forget that a note was written, so a gate can exercise the writer twice. */
export function resetPostmortem(): void {
  written = false;
  cleanExit = false;
}

/** Appends one line to a machine-readable index of every note on this machine. Best-effort. */
export function indexPostmortem(path: string): void {
  try {
    mkdirSync(POSTMORTEM_DIR, { recursive: true });
    const idx = join(POSTMORTEM_DIR, 'index.jsonl');
    appendFileSync(idx, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, cwd: process.cwd(), path })}\n`);
  } catch { /* best-effort */ }
}
