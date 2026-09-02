/**
 * `/naamah` — the design conversation, in a browser, wired to this session's agent.
 *
 * SHAPED LIKE `/diff`, BECAUSE IT IS THE SAME LOOP ON A DIFFERENT ARTEFACT. `/diff` puts the working
 * tree on a page, the operator writes a comment on a line, and the agent fixes the cause. This puts
 * the DESIGN on a page, the operator writes a comment on a type, and the agent changes the sketch.
 * Same review surface, one step earlier — before the code exists, which is where a design comment is
 * worth a hundred code comments.
 *
 * THE JOINT IS A JSON FILE, NOT THIS MODULE. naamah's daemon owns the page, the comment store and the
 * watch; this module starts it, subscribes to its hook, and hands whatever arrives to the agent. That
 * split is deliberate: the daemon keeps working — page, comments, live rebuild — whether or not ayin
 * is running, so a design review is never blocked on an agent being awake, and a comment written while
 * ayin is down is still on disk and still fires when it comes back.
 *
 * The design directory is per task and autocreated by the agent (see the ayin system prompt), so this
 * defaults to the newest `.naamah/<task>/` in the repo rather than asking.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { log } from '../log.js';

/** One thread as naamah stores it. Mirrors naamah/src/comments.mjs. */
export interface NaamahMessage { id: string; by: string; at: string; text: string; agent: boolean }
export interface NaamahThread {
  id: string;
  target: { kind: string; id: string | null; row: number | null; label: string | null };
  resolved: boolean;
  messages: NaamahMessage[];
}

export interface NaamahSession {
  dir: string;
  url: string;
  port: number;
  stop(): void;
}

const COMMENTS = 'naamah.comments.json';

/**
 * The design directory to show.
 *
 * Explicit argument wins. Otherwise the MOST RECENTLY MODIFIED `.naamah/*` — with one design per task,
 * that is the task in hand, and asking "which design?" of someone who has one is friction for nothing.
 */
export function findDesignDir(repo: string, arg = ''): string | null {
  if (arg.trim()) {
    const p = resolve(repo, arg.trim());
    return existsSync(p) ? p : null;
  }
  const root = join(repo, '.naamah');
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name))
    .map((p) => ({ p, at: statSync(p).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return dirs.length ? dirs[0].p : null;
}

/** Threads still waiting on an answer, read straight from naamah's file. */
export function pendingThreads(dir: string): NaamahThread[] {
  const p = join(dir, COMMENTS);
  if (!existsSync(p)) return [];
  try {
    const doc = JSON.parse(readFileSync(p, 'utf-8')) as { threads?: NaamahThread[] };
    return (doc.threads ?? []).filter((t) => {
      if (t.resolved) return false;
      const last = t.messages[t.messages.length - 1];
      return !last || !last.agent;
    });
  } catch {
    // A half-written file is a file that is about to be complete; the watcher fires again.
    return [];
  }
}

/**
 * One thread as the agent should receive it.
 *
 * The TARGET is the point. "This is wrong" on a card means the card; the same words on a member row
 * mean that member. Handing the agent the words without what they were attached to is how a review
 * comment turns into "which line did you mean?" — the failure `/diff`'s comment handling exists to
 * avoid, and the same rule applies here.
 */
export function threadPrompt(dir: string, t: NaamahThread, repo = ''): string {
  const tg = t.target ?? { kind: 'page', id: null, row: null, label: null };
  const where = tg.kind === 'row' && tg.id
    ? `member row ${tg.row} of ${tg.id}${tg.label ? ` — "${tg.label}"` : ''}`
    : tg.kind === 'node' && tg.id ? `the type ${tg.id}`
    : tg.kind === 'edge' && tg.id ? `the relation ${tg.id}`
    : tg.kind === 'domain' && tg.id ? `the domain ${tg.id}`
    : 'the design as a whole';
  const said = t.messages.map((m) => `${m.by}${m.agent ? ' (you, earlier)' : ''}: ${m.text}`).join('\n');
  /**
   * A SHORT, RELATIVE PATH — NEVER THE ABSOLUTE ONE.
   *
   * The first version pasted the design's absolute path and asked the model to work in it. gemma4:26b
   * retyped `…a6500f09-f8c9-4fad-a945-fbc78c4db154…` as `…fbc7c4db154…`, then as
   * `/tmp/claude-1000/-/home-…`, and spent the whole run `ls`-ing directories that do not exist. That
   * is not the model being stupid: a 100-character path is not transcribable, and asking for it is
   * asking for invention in the one workflow built to remove invention.
   *
   * The run already starts with `cwd` at the repo and `NAAMAH_DIR` in the environment, so the design
   * is reachable without retyping anything.
   */
  const rel = repo && dir.startsWith(repo) ? dir.slice(repo.length).replace(/^[\\/]+/, '') : dir;
  return [
    `<naamah-comment thread='${t.id}' design='${rel}'>`,
    `The operator is reading the design in a browser and commented on ${where}.`,
    '',
    said,
    '',
    `The design is the directory ${rel} (also in $NAAMAH_DIR) — plain TypeScript or C# sketch files,`,
    'one type per class. CHANGE THE DESIGN to answer this: edit or add a sketch file there, then run',
    `\`naamah build ${rel}\` to prove it still compiles. The open page rebuilds itself, so the operator`,
    'sees the result without asking.',
    '',
    'Use that relative path exactly as written. Do not reconstruct an absolute path.',
    'Do not describe the change instead of making it, and do not reply about work you have not done.',
    `When it is done: \`naamah reply ${t.id} ayin "<one or two sentences>"\` — that text is the only`,
    'answer the operator gets, so name what changed.',
    '</naamah-comment>',
  ].join('\n');
}

/**
 * Start `naamah show` and watch its comment file.
 *
 * The DAEMON is a child process rather than an in-process import: it binds a port, watches a tree and
 * runs for as long as the review does, and none of that belongs inside a TUI's event loop. If it dies,
 * the page dies with it and the operator can see that — an in-process server that quietly stopped
 * serving would look like a browser problem.
 *
 * `onThreads` is called with whatever is waiting. Polling the file rather than parsing the child's
 * stderr, because the FILE is the contract — the same one the CLI and any other agent read.
 */
export function startNaamah(
  dir: string,
  opts: { port?: number; onThreads?: (threads: NaamahThread[]) => void; everyMs?: number } = {},
): NaamahSession {
  const args = ['show', dir];
  if (opts.port) args.push('--port', String(opts.port));

  let child: ChildProcess | null = null;
  let url = '';
  let port = opts.port ?? 0;

  child = spawn('naamah', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    // The daemon prints its URL once; catching it here means the operator is told the real port even
    // when the requested one was taken and it moved up.
    const m = chunk.match(/https?:\/\/[\d.]+:(\d+)\//);
    if (m && !url) { url = m[0]; port = Number(m[1]); }
    for (const line of chunk.split('\n')) {
      if (line.trim()) log('INFO', 'naamah_daemon', { line: line.trim().slice(0, 300) });
    }
  });
  child.on('exit', (code) => log('INFO', 'naamah_daemon_exit', { code: String(code ?? '') }));

  /**
   * ONE THREAD IS OFFERED ONCE. Without this the poll re-offers the same comment every tick until the
   * agent finishes replying, which for a slow local model means the same task queued a dozen times.
   * Keyed on the thread AND its message count, so a follow-up comment on an answered thread is a new
   * offer rather than being swallowed as already-seen.
   */
  const offered = new Set<string>();
  const timer = setInterval(() => {
    if (!opts.onThreads) return;
    const open = pendingThreads(dir);
    const fresh = open.filter((t) => !offered.has(`${t.id}:${t.messages.length}`));
    if (!fresh.length) return;
    for (const t of fresh) offered.add(`${t.id}:${t.messages.length}`);
    try { opts.onThreads(fresh); } catch (err) {
      log('ERROR', 'naamah_hook_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, opts.everyMs ?? 1500);

  return {
    dir,
    get url() { return url; },
    get port() { return port; },
    stop() {
      clearInterval(timer);
      try { child?.kill('SIGTERM'); } catch { /* already gone */ }
    },
  } as NaamahSession;
}

/**
 * Answer one thread in a HEADLESS child, the way `/diff` answers a review comment.
 *
 * NOT ON THE SESSION'S OWN TURN LOOP. A comment arrives whenever the operator writes one — usually
 * while the agent is mid-task or idle at a prompt, neither of which can be interrupted to take a new
 * instruction. `/diff` settled this the same way: spawn a run that owns the thread end to end and
 * writes its own answer back. The reply door is naamah's CLI, so the child needs nothing from here
 * except `NAAMAH_DIR`.
 *
 * Returns the pid, or 0 if it could not start.
 */
export function runThreadAgent(dir: string, thread: NaamahThread, repo: string): number {
  const logDir = join(homedir(), '.ayin-cli', 'naamah');
  let fd: number;
  try {
    mkdirSync(logDir, { recursive: true });
    // A RAW DESCRIPTOR: `spawn` validates stdio synchronously, and a WriteStream's fd is null until
    // its open event fires.
    fd = openSync(join(logDir, `${thread.id}.log`), 'a');
  } catch (err) {
    log('ERROR', 'naamah_run_log_failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
  try {
    const child = spawn(process.execPath, [process.argv[1], '-p', threadPrompt(dir, thread, repo)], {
      cwd: repo,
      // Not detached: the run belongs to the review in front of the operator, so tearing the session
      // down should stop it rather than leave it editing the design unattended.
      stdio: ['ignore', fd, fd],
      env: { ...process.env, NAAMAH_DIR: dir, AYIN_NAAMAH_THREAD: thread.id },
    });
    log('INFO', 'naamah_thread_run', { thread: thread.id, pid: String(child.pid ?? 0), dir });
    return child.pid ?? 0;
  } catch (err) {
    log('ERROR', 'naamah_run_failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}
