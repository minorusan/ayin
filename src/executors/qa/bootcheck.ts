/**
 * bootcheck.ts — "does it actually come up and answer on a port?", asked by starting it.
 *
 * WHY. `tsc --noEmit` proves the code type-checks and `npm test` proves the suite passes, and a
 * project can do both while being unable to start: a missing dependency that only the entry point
 * imports, an entry point that constructs the server and never listens, a crash in the first line of
 * config reading. The suite does not catch it because the scaffold's tests bind port 0 inside the
 * process — they never run the thing the operator runs. So this asks the one question left: `npm run
 * dev`, a real port, a real request over TCP.
 *
 * THE PORT IS OURS, NOT THE PROJECT'S DEFAULT. A probe that took port 3000 would collide with the dev
 * server the operator already has open — and would then report the operator's own app as proof that
 * the turn's project boots, which is worse than failing. A free port is picked by binding 0 and
 * reading it back, and handed to the child as `PORT`; `AYIN_QA_PORT` overrides it for anyone who
 * needs a fixed one.
 *
 * ABSENT IS NOT FAILED — the rule inherited from `buildcheck.ts`. No package.json, no boot script, no
 * `node_modules`: each is a question that could not be asked, reported as unchecked. On the turn that
 * CREATES a project the install may still be running, and a hard fact nobody can satisfy burns the fix
 * budget that would have fixed something real.
 *
 * AND A PROJECT THAT IS NOT A SERVER IS THE SAME KIND OF ABSENCE. Most Node projects are libraries,
 * CLIs and build tools, and plenty of them have a `dev` script that is a compiler — ayin's own is
 * `tsc --watch`. Waiting thirty seconds for a port it was never going to open and then reporting
 * *"the entry point must listen"* would hard-fail every one of them. So the file the boot script runs
 * is read first (`serverEntry`), and a project whose entry point does not listen is UNCHECKED.
 *
 * The boundary that costs something: an entry point that loses BOTH its `listen` and its `PORT` reads
 * as a library, so the check goes quiet instead of failing. Nothing can tell that apart from a project
 * that never was a server, and being quiet is the cheaper of the two mistakes.
 *
 * NOTHING SURVIVES THIS FUNCTION. The child is started in its own process GROUP and the group is
 * killed in a `finally` — `nodemon` is a supervisor that spawns the real server as a grandchild, so
 * killing the pid alone orphans a listening process that then owns the port for the rest of the
 * session. TERM first, KILL after a grace period, because a supervisor asked to stop politely still
 * has to stop its own child.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { ProbeFact, ProjectContext } from '../types.js';

/** Long enough for a cold `nodemon` + type-stripping start; short enough that a hang is not the turn. */
const BOOT_TIMEOUT_MS = 30_000;
/** How often the port is tried while waiting. Cheap — a refused connect costs nothing. */
const POLL_INTERVAL_MS = 250;
/** Between TERM and KILL. A supervisor needs a moment to take its own child down with it. */
const KILL_GRACE_MS = 2_000;

/** The scripts that mean "run this project", in the order we would try them by hand. */
const BOOT_SCRIPTS = ['dev', 'start', 'serve'];

interface Pkg { scripts?: Record<string, string> }

function readPkg(root: string): Pkg | null {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as Pkg;
  } catch {
    return null;
  }
}

/**
 * The script to boot with, or null.
 *
 * `dev` first on purpose: it runs the sources as they stand, where `start` usually runs `dist/` and
 * would report a stale build — or nothing at all — as the state of the turn's work.
 */
function bootScript(pkg: Pkg): string | null {
  for (const name of BOOT_SCRIPTS) {
    const body = (pkg.scripts?.[name] ?? '').trim();
    if (body) return name;
  }
  return null;
}

/**
 * The file the boot script actually runs, IF that file listens. Null when nothing proves it.
 *
 * ASKED OF THE ENTRY POINT, NOT OF THE REPOSITORY — the correction that matters. A search for
 * `.listen(` across `src/` says yes for ayin, which serves a review page and a Jira board from two
 * subcommands, while its `dev` script is `tsc --watch`. That is a compiler, it will never open a
 * port, and the gate would have hard-failed this repo for it. So the script is read for the path it
 * executes, and only THAT file's content answers.
 *
 * A script with no resolvable path — `vite`, `next dev`, a shell wrapper — proves nothing either way
 * and yields null, which is UNCHECKED. That is the safe direction: a real server reported as
 * unchecked costs one skipped fact; a library reported as broken costs a fix loop against a defect
 * that does not exist.
 */
const SERVES = /\.listen\(|process\.env\.PORT/;

function serverEntry(root: string, script: string): string | null {
  const candidates: string[] = script.match(/[\w./@-]+\.[cm]?[jt]sx?/g) ?? [];
  // The conventional entry points, tried when the script names no path of its own.
  candidates.push('src/index.ts', 'src/index.js', 'index.ts', 'index.js', 'src/server.ts');
  for (const rel of candidates) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    try {
      if (SERVES.test(readFileSync(abs, 'utf-8'))) return rel;
    } catch { /* unreadable — not evidence either way */ }
  }
  return null;
}

/** A port nobody is on, by letting the OS name one and giving it straight back. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

/** One TCP connect. True when something accepted it. */
async function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean): void => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1_000, () => done(false));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The whole process GROUP, not the pid. See the header — `nodemon` is the reason this is not a
 * one-liner. Best-effort throughout: a group that is already gone throws ESRCH, which is the outcome
 * we wanted anyway.
 */
async function killGroup(pid: number): Promise<void> {
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  await sleep(KILL_GRACE_MS);
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

/**
 * Start it, wait for the port, kill it. Returns what to tell the agent.
 *
 * The child's own output is captured rather than inherited, because it is the only evidence when the
 * boot fails — a stack trace on our stdout would land in the operator's transcript unattributed, and
 * be gone by the time the fact is written.
 */
async function tryBoot(root: string, script: string, port: number): Promise<ProbeFact> {
  const child = spawn('npm', ['run', script, '--silent'], {
    cwd: root,
    detached: true, // its own process group — see killGroup
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), NO_COLOR: '1', FORCE_COLOR: '0' },
  });

  let out = '';
  const grab = (d: Buffer): void => { if (out.length < 8_000) out += d.toString(); };
  child.stdout?.on('data', grab);
  child.stderr?.on('data', grab);

  let exited: number | null = null;
  child.once('exit', (code) => { exited = code ?? 0; });

  /**
   * UNDER A SUPERVISOR, A CRASH IS NOT AN EXIT. nodemon catches the failure, prints `app crashed -
   * waiting for file changes` and stays alive holding the watch, so the exit shortcut below never
   * fires and a broken entry point costs the full timeout — measured at 32s per failed boot, on every
   * round of a QA fix loop. The marker is the supervisor's own answer to the question we are asking.
   */
  const crashed = (): boolean => /\[nodemon\] app crashed/.test(out);

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await accepts(port)) {
        return {
          key: 'boots',
          ok: true,
          hard: true,
          detail: `npm run ${script} — listening on port ${port}`,
        };
      }
      // A process that has already exited — or a supervisor that has given up on its child — will
      // never open the port. Say so now rather than spending the remaining thirty seconds proving it.
      if (exited !== null || crashed()) {
        const how = exited !== null ? `EXITED (code ${exited})` : 'CRASHED';
        return {
          key: 'boots',
          ok: false,
          hard: true,
          detail: `npm run ${script} ${how} without listening. The project does not start:\n${tail(out)}`,
        };
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return {
      key: 'boots',
      ok: false,
      hard: true,
      detail: `npm run ${script} did not listen on PORT=${port} within ${BOOT_TIMEOUT_MS / 1000}s. `
        + `The entry point must read process.env.PORT and listen on it:\n${tail(out)}`,
    };
  } finally {
    if (child.pid) await killGroup(child.pid);
  }
}

/**
 * The last lines of the child's output — where a crash puts its reason.
 *
 * ANSI STRIPPED HERE, NOT LEFT TO `NO_COLOR`. nodemon colours its own lines regardless, and escape
 * codes in a fact handed to a model are pure noise that also survives into the transcript.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function tail(out: string, limit = 20): string {
  const lines = out.replace(ANSI, '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-limit);
  return lines.length ? lines.map((l) => `  ${l}`).join('\n') : '  (no output)';
}

/**
 * "Does it come up?" as one fact. Never throws: every failure to ASK is an unchecked pass, and only a
 * boot that was attempted and did not listen is a red gate.
 */
export async function bootCheck(ctx: ProjectContext): Promise<ProbeFact> {
  const unchecked = (why: string): ProbeFact => ({ key: 'boots', ok: true, detail: `boot not checked: ${why}` });

  const pkg = readPkg(ctx.root);
  if (!pkg) return unchecked('no readable package.json');
  const script = bootScript(pkg);
  if (!script) return unchecked(`package.json declares none of ${BOOT_SCRIPTS.join(', ')}`);
  if (!existsSync(join(ctx.root, 'node_modules'))) {
    return unchecked('dependencies are not installed (no node_modules)');
  }
  const entry = serverEntry(ctx.root, (pkg.scripts?.[script] ?? ''));
  if (!entry) {
    return unchecked(`npm run ${script} runs nothing that listens on a port — this is not a server`);
  }

  const override = Number(process.env.AYIN_QA_PORT);
  let port: number;
  try {
    port = Number.isInteger(override) && override > 0 ? override : await freePort();
  } catch {
    return unchecked('no free port could be reserved');
  }

  try {
    return await tryBoot(ctx.root, script, port);
  } catch (err) {
    // Spawning itself failed — npm missing, root unreadable. A question that could not be asked.
    return unchecked(`npm run ${script} could not be started (${err instanceof Error ? err.message : String(err)})`);
  }
}
