/**
 * Running searches — the only place in explore that touches the filesystem or spawns anything.
 *
 * TWO PROPERTIES, both structural rather than promised:
 *
 * READ-ONLY BY CONSTRUCTION. Probes are `argv` ARRAYS, never strings, and are executed with
 * `spawn(file, args)` — no shell, so there is no `;`, no `&&`, no `$(…)`, no redirect, no glob
 * expansion, because there is no shell to interpret them. The previous tool passed model-authored
 * strings to `sh -lc` behind a prefix allow-list that could not hold: `grep foo . ; echo INJECTED`
 * passed it, and the second command ran. Here the argv comes from `projects/*.ts` — repository code,
 * never model output — and the binary is fixed to a read-only set.
 *
 * PARALLEL, because the whole design rests on searching being nearly free. Measured on a 462 MB
 * repository: three concurrent greps over 2,898 C# files completed in 422 ms. One call to the local
 * 30B costs 15–20 s. That ratio — roughly 100:1 — is why the model was removed from this tool and
 * why breadth is bought with more probes rather than more thinking.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The only binaries explore may run. None of them can write. */
const READ_ONLY_BINARIES = new Set(['grep', 'find', 'git']);

/** `git` is allowed only for subcommands that read. */
const GIT_READ_SUBCOMMANDS = new Set(['grep', 'ls-files', 'log', 'show', 'blame']);

/** Directories a code search must never descend into. Shared shape with the `grep` tool's list. */
export const PRUNE = [
  '.git', 'node_modules',
  'Library', 'Temp', 'obj', 'Logs', 'Build', 'Builds',
  // GLOBS, not names. Real repositories accumulate `dist.bak-20260704-234256/`, `dist.old/`,
  // `src.bak/` — and `--exclude-dir=dist` matches none of them. Measured: a stale backup tree put
  // "this string appears in 128 files" into an answer whose real count was a handful.
  'dist', 'dist.*', 'dist-*', '*.bak', '*.bak-*', '*.old',
  'build', 'out', '.next', 'coverage', '__pycache__', '.venv', 'vendor',
];

/** One command's result. `timedOut` is reported, never silently swallowed. */
export interface ProbeResult {
  ok: boolean;
  lines: string[];
  timedOut: boolean;
  /** Reproducible by hand — printed in the "what was searched" section. */
  printable: string;
}

const TIMEOUT_MS = 8_000;
/** Enough to rank from; a probe returning more than this is too broad to be useful anyway. */
const MAX_LINES = 400;

function assertReadOnly(argv: string[]): void {
  const [bin, ...rest] = argv;
  if (!READ_ONLY_BINARIES.has(bin)) throw new Error(`explore: refusing to run "${bin}"`);
  if (bin === 'git' && !GIT_READ_SUBCOMMANDS.has(rest[0] ?? '')) {
    throw new Error(`explore: refusing git subcommand "${rest[0]}"`);
  }
  // `find -exec/-delete` can write even though `find` reads. Refuse the flags outright.
  if (bin === 'find' && rest.some((a) => /^-(exec|execdir|delete|ok|okdir|fprint|fls)/.test(a))) {
    throw new Error('explore: refusing a find flag that can write or execute');
  }
}

/**
 * `grep -rnI …` → the `git grep` that does the same job, when the root is a git work tree.
 *
 * NOT a micro-optimisation. `git grep` is parallel and walks the index instead of the filesystem, and
 * the gap is where the machine is slow rather than where it is fast: on this Linux box with a warm
 * page cache plain grep wins by 30ms, and on a macOS checkout of the same repository — BSD grep, cold
 * APFS — a single explore call was measured at 22 SECONDS against 0.4 here. A tool that promises
 * sub-second and delivers 22 is not the same tool.
 *
 * Correctness first: verified to return byte-identical hits on the real repository. `--untracked` is
 * included because a new file the operator has not committed is still code they are asking about, and
 * silently not searching it is the failure mode this whole module exists to avoid. Ignored files stay
 * ignored, which is what the `--exclude-dir` list wanted anyway.
 *
 * Returns null when the translation does not apply, and the caller runs the original.
 */
export function asGitGrep(argv: string[], cwd: string): string[] | null {
  if (argv[0] !== 'grep') return null;
  if (!existsSync(join(cwd, '.git'))) return null;

  const includes: string[] = [];
  const flags: string[] = [];
  let pattern: string | null = null;
  let mode: 'E' | 'F' | null = null;
  let listOnly = false;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '.') continue;
    if (a.startsWith('--exclude-dir=')) continue;        // ignored files are already excluded
    if (a.startsWith('--include=')) { includes.push(a.slice('--include='.length)); continue; }
    if (a === '-E' || a === '-F') { mode = a.slice(1) as 'E' | 'F'; pattern = argv[++i] ?? null; continue; }
    if (a.startsWith('-') && a.length > 1) {
      if (a.includes('l')) listOnly = true;
      continue;                                          // -rnI / -rlI: recursion and binary skip are implicit
    }
    if (pattern === null) pattern = a;
  }
  if (pattern === null || mode === null) return null;     // an unrecognised shape runs unchanged

  flags.push('-nI');
  if (listOnly) flags.splice(0, 1, '-lI');
  // No `-C`: the runner already spawns with this cwd, and a `git -C …` shape would put a flag where
  // the read-only guard looks for the subcommand — which it rightly refuses.
  return [
    'git', 'grep', '--no-color', '--untracked', ...flags, `-${mode}`, pattern,
    '--', ...(includes.length ? includes : ['.']),
  ];
}

export function runProbe(argv: string[], cwd: string): Promise<ProbeResult> {
  const translated = asGitGrep(argv, cwd);
  if (translated) argv = translated;
  assertReadOnly(argv);
  const printable = argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  return new Promise((resolve) => {
    // NO SHELL. `spawn(file, args)` passes the array straight to execve, so shell metacharacters in
    // any argument are just bytes in a pattern — which is exactly what a search pattern should be.
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (timedOut: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const lines = out.split('\n').filter(Boolean).slice(0, MAX_LINES);
      resolve({ ok: true, lines, timedOut, printable });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(true); }, TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => {
      if (out.length < 2_000_000) out += c.toString();
    });
    child.on('close', () => finish(false));
    // grep exits 1 on "no match" — a normal answer, not a failure.
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, lines: [], timedOut: false, printable }); } });
  });
}

/** Every probe at once. The point of removing the model is that breadth costs milliseconds. */
export async function runAll(
  probes: Array<{ strategy: string; argv: string[] }>,
  cwd: string,
): Promise<Array<{ strategy: string; argv: string[]; result: ProbeResult }>> {
  return Promise.all(probes.map(async (p) => ({ ...p, result: await runProbe(p.argv, cwd) })));
}

/** grep's `path:line:text` — parsed strictly, so a line that does not match this shape is dropped. */
export function parseGrepLine(line: string): { file: string; line: number; text: string } | null {
  const m = /^(.+?):(\d+):([\s\S]*)$/.exec(line);
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n < 1) return null;
  return { file: m[1], line: n, text: m[3] };
}

/**
 * Read a span from disk. THE NO-LYING GUARANTEE LIVES HERE: findings carry bytes read at answer
 * time, so a span cannot describe a file that does not say what the span claims. Returns null when
 * the file cannot be read, and the caller drops the finding rather than reporting it unverified.
 */
export function readSpan(abs: string, from: number, to: number): { text: string; lines: string[] } | null {
  if (!existsSync(abs)) return null;
  try {
    const lines = readFileSync(abs, 'utf-8').split('\n');
    const a = Math.max(1, from);
    const b = Math.min(lines.length, to);
    if (a > lines.length) return null;
    return { text: lines.slice(a - 1, b).join('\n'), lines };
  } catch {
    return null;
  }
}
