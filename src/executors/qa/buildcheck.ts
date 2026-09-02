/**
 * buildcheck.ts — "does this actually build?", asked deterministically, for the ordinary languages.
 *
 * WHY. Unity has had this since `qa/unity/compile.ts`: one measurable question that outranks every
 * opinion, because code that does not compile is not worth reviewing. Nothing else did. Measured on a
 * greenfield Python project ayin built end to end: `__main__.py` shipped as
 *
 *     if __name__ == "__main__':          ← mismatched quote
 *
 * The declared entry point was dead. The tests passed, because they import the package's other module
 * and never touch `__main__`. QA passed, because nothing asked a compiler. The plan's own verification
 * for that step was `ls -R src/csv2json` — the file existed, so the step was "proved". A syntax error
 * survived every check ayin had.
 *
 * THE RULE THAT KEEPS IT HONEST: a toolchain that is ABSENT is not a failure. `tsc` with no
 * `node_modules`, `python3` on a machine without it — those are "could not check", reported as a
 * non-hard fact, never as a red gate. This is the arduino-README lesson applied before it can happen
 * again: a hard fact nobody can satisfy does not enforce anything, it burns the fix budget that would
 * have fixed something real. Only a compiler that RAN and said no fails the gate.
 *
 * ONLY WHAT CHANGED. The probe compiles the turn's own files, not the repository — a whole-project
 * build on every turn is a minute the operator waits for an answer they already have. The exception is
 * TypeScript, where `tsc --noEmit` is whole-project by nature and there is no per-file equivalent that
 * means anything.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangedFile } from '../../qa/probes.js';
import type { ProbeFact, ProjectContext } from '../types.js';

/** Long enough for a cold `tsc` on a real project; short enough that a hang is not the whole turn. */
const BUILD_TIMEOUT_MS = 120_000;

interface Attempt {
  /** What was run, so the operator can repeat it by hand. */
  command: string;
  ok: boolean;
  /** The compiler's own words, clipped. Empty on success. */
  errors: string[];
  /** Set when the check could NOT be made — a missing toolchain, nothing to check. Never a failure. */
  unverified?: string;
}

function run(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, {
      cwd, timeout: BUILD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
    return { code: 0, out: out ?? '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; code?: string; message?: string };
    if (e.code === 'ENOENT') return { code: -1, out: 'ENOENT' };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || '' };
  }
}

/** First `limit` lines that look like a compiler complaining. Never the whole log. */
function errorLines(out: string, limit = 12): string[] {
  const lines = out.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const hits = lines.filter((l) => /\berror\b|SyntaxError|^\s*File ".*", line \d+|Traceback/i.test(l));
  return (hits.length ? hits : lines).slice(0, limit);
}

/**
 * PYTHON — `py_compile` every changed `.py`. Syntax only, and that is the point: it needs no
 * dependencies, no venv and no install, so it works on the turn that CREATED the project, which is
 * exactly the turn that shipped the mismatched quote.
 */
function checkPython(ctx: ProjectContext, files: string[]): Attempt {
  const py = files.filter((f) => f.endsWith('.py'));
  if (py.length === 0) return { command: '(none)', ok: true, errors: [], unverified: 'no Python files changed' };
  const bin = ['python3', 'python'].find((c) => run(c, ['--version'], ctx.root).code === 0);
  if (!bin) return { command: 'python3 -m py_compile', ok: true, errors: [], unverified: 'no python interpreter on PATH — cannot check' };

  const r = run(bin, ['-m', 'py_compile', ...py], ctx.root);
  return {
    command: `${bin} -m py_compile ${py.length === 1 ? py[0] : `${py.length} file(s)`}`,
    ok: r.code === 0,
    errors: r.code === 0 ? [] : errorLines(r.out),
  };
}

/**
 * TYPESCRIPT — `tsc --noEmit`, whole project, because there is no per-file equivalent that means
 * anything: a file's types are a function of everything it imports.
 *
 * Only when the project actually has a compiler. A `tsconfig.json` with no `node_modules` is a project
 * nobody has installed yet, which is a normal state for a turn that just created it and NOT a failure.
 */
function checkTypescript(ctx: ProjectContext, files: string[]): Attempt {
  if (!files.some((f) => /\.tsx?$/.test(f))) {
    return { command: '(none)', ok: true, errors: [], unverified: 'no TypeScript files changed' };
  }
  if (!existsSync(join(ctx.root, 'tsconfig.json'))) {
    return { command: 'tsc --noEmit', ok: true, errors: [], unverified: 'no tsconfig.json — nothing declares how to compile this' };
  }
  const local = join(ctx.root, 'node_modules', '.bin', 'tsc');
  if (!existsSync(local)) {
    return { command: 'tsc --noEmit', ok: true, errors: [], unverified: 'typescript is not installed here (no node_modules/.bin/tsc) — cannot check' };
  }
  const r = run(local, ['--noEmit'], ctx.root);
  return { command: 'npx tsc --noEmit', ok: r.code === 0, errors: r.code === 0 ? [] : errorLines(r.out) };
}

/** GO and RUST come free — both have a first-class "check without building" and both are one call. */
function checkGo(ctx: ProjectContext, files: string[]): Attempt {
  if (!files.some((f) => f.endsWith('.go'))) return { command: '(none)', ok: true, errors: [], unverified: 'no Go files changed' };
  if (run('go', ['version'], ctx.root).code !== 0) return { command: 'go build ./...', ok: true, errors: [], unverified: 'go is not on PATH — cannot check' };
  const r = run('go', ['build', './...'], ctx.root);
  return { command: 'go build ./...', ok: r.code === 0, errors: r.code === 0 ? [] : errorLines(r.out) };
}

function checkRust(ctx: ProjectContext, files: string[]): Attempt {
  if (!files.some((f) => f.endsWith('.rs'))) return { command: '(none)', ok: true, errors: [], unverified: 'no Rust files changed' };
  if (run('cargo', ['--version'], ctx.root).code !== 0) return { command: 'cargo check', ok: true, errors: [], unverified: 'cargo is not on PATH — cannot check' };
  const r = run('cargo', ['check', '--quiet'], ctx.root);
  return { command: 'cargo check', ok: r.code === 0, errors: r.code === 0 ? [] : errorLines(r.out) };
}

/**
 * The one entry point. Returns a single fact, or null for a project type this cannot check — Unity and
 * Arduino have their own compile probes and must not be second-guessed by a generic one.
 */
export function buildCheck(ctx: ProjectContext, files: ChangedFile[]): ProbeFact | null {
  // NO LIST IS "NOTHING CHANGED", NOT A CRASH. The interface says `ChangedFile[]` and the one
  // production caller obeys it, but a probe is also called from gates and from tooling that predates
  // the second parameter — and this file's whole stance is that an unanswerable question returns "not
  // checked". Throwing a TypeError out of a QA probe would fail the turn over a missing argument.
  const paths = (files ?? []).filter((f) => f.exists).map((f) => f.path);
  if (paths.length === 0) return null;

  let attempt: Attempt | null = null;
  switch (ctx.type) {
    case 'python': attempt = checkPython(ctx, paths); break;
    case 'node': attempt = checkTypescript(ctx, paths); break;
    case 'go': attempt = checkGo(ctx, paths); break;
    case 'rust': attempt = checkRust(ctx, paths); break;
    // arduino → qa/arduino runs arduino-cli; unity → qa/unity runs csc. flutter and dotnet have no
    // probe here yet, and a fact nobody measured is worse than none.
    default: return null;
  }
  if (!attempt) return null;

  if (attempt.unverified) {
    // NOT A FAILURE. A toolchain that is absent is a thing the gate could not measure, and a hard fact
    // nobody can satisfy burns the fix budget that would have fixed something real.
    return { key: 'builds', ok: true, detail: `build not checked: ${attempt.unverified}` };
  }
  if (attempt.ok) {
    return { key: 'builds', ok: true, detail: `${attempt.command} — clean`, hard: true };
  }
  return {
    key: 'builds',
    ok: false,
    hard: true,
    detail: `${attempt.command} FAILED — this code does not compile:\n${attempt.errors.map((e) => `  ${e}`).join('\n')}`,
  };
}
