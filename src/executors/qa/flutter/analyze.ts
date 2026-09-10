/**
 * analyze.ts — the toolchain half of Flutter QA: the LINTER and the project's own test suite.
 *
 * `flutter analyze` IS THE LINTER AND THE COMPILER AT ONCE, which is why there is one runner and not
 * two. The Dart analyzer reports type errors and lint violations from the same pass, tagged by
 * severity, and the lint set is the one the PROJECT declared in its own `analysis_options.yaml` — so
 * a violation is never ayin's opinion about style, it is the project's own rule being broken.
 *
 * SEVERITY IS THE LINE, AND THE ANALYZER DRAWS IT, NOT US.
 *
 *   error   → the code does not compile. Nothing to argue with.
 *   warning → the analyzer's own "this is wrong": an unused import, a widget with a non-final field
 *             under `@immutable`, an override that overrides nothing.
 *   info    → style: `prefer_const_constructors`, `avoid_print`, `sort_child_properties_last`.
 *
 * The exit code cannot be used for any of this: `flutter analyze` exits 1 when there is a single
 * `info`, so "exit 1" says nothing about whether the project compiles. Measured, on a project with
 * one `avoid_print` and nothing else. The severities are parsed instead.
 *
 * ONLY ISSUES IN THE TURN'S OWN FILES ARE ENFORCED. Analysis is whole-project because that is the only
 * mode the analyzer has, but a repo with four hundred pre-existing lints must not fail every turn for
 * them — that is the `qa/base`-on-a-Unity-repo failure again, where a rule nobody could satisfy burned
 * the fix budget that would have fixed something real. Everything outside the changed files is
 * counted and reported as context.
 *
 * ABSENT IS NOT FAILED, the rule this file inherits from `buildcheck.ts`: no SDK on PATH, no
 * `.dart_tool/package_config.json` (dependencies never resolved), no test directory — each is a
 * question that could not be asked, reported as unchecked, never as a red gate. On the turn that
 * CREATES a project, half of these are the normal state.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A whole-project analysis on a large app is seconds, not minutes; a hang must not be the turn. */
const ANALYZE_TIMEOUT_MS = 180_000;
/** A widget-test suite that takes longer than this is a broken suite, not a slow one. */
const TEST_TIMEOUT_MS = 240_000;
/** The generator AOT-compiles its builders on a cold run — measured at 44s, so this is generous. */
const CODEGEN_TIMEOUT_MS = 300_000;

export interface Issue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Repo-relative, as the analyzer printed it. */
  file: string;
  location: string;
  /** The lint or diagnostic name — `avoid_print`, `undefined_identifier`. */
  rule: string;
}

interface Ran {
  code: number;
  out: string;
  /** Set when the command could not be run at all. */
  enoent?: boolean;
}

async function exec(bin: string, args: string[], cwd: string, timeout: number): Promise<Ran> {
  try {
    const { stdout, stderr } = await run(bin, args, {
      cwd, timeout, maxBuffer: 16 * 1024 * 1024,
      // A tool that thinks it owns a terminal prints progress bars into the fact; and a test that
      // reads stdin would hang forever behind a pipe.
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    return { code: 0, out: `${stdout ?? ''}\n${stderr ?? ''}` };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    if (e.code === 'ENOENT') return { code: -1, out: '', enoent: true };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      out: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || '',
    };
  }
}

/**
 * The SDK binary that answers `--version`, or null. `.bat` is tried because that is what the Flutter
 * SDK ships on Windows, where `execFile` without a shell will not find a bare `flutter`.
 */
export async function sdkBin(name: 'flutter' | 'dart', cwd: string): Promise<string | null> {
  for (const bin of [name, `${name}.bat`]) {
    const r = await exec(bin, ['--version'], cwd, 60_000);
    if (!r.enoent && r.code === 0) return bin;
  }
  return null;
}

/** Have the dependencies ever been resolved here? Without this, every Dart import is unresolved. */
export function depsResolved(root: string): boolean {
  return existsSync(join(root, '.dart_tool', 'package_config.json'));
}

/**
 * `severity • message • path:line:col • rule` — the analyzer's own line format, which is stable and
 * machine-readable in a way its exit code is not.
 */
export function parseIssues(out: string, root: string): Issue[] {
  const issues: Issue[] = [];
  for (const raw of out.split('\n')) {
    const m = /^\s*(error|warning|info)\s+•\s+(.+?)\s+•\s+(\S+?):(\d+):(\d+)\s+•\s+(\S+)\s*$/.exec(raw);
    if (!m) continue;
    const file = m[3].startsWith('/') ? relative(root, m[3]) : m[3];
    issues.push({
      severity: m[1] as Issue['severity'],
      message: m[2],
      file: file.split('\\').join('/'),
      location: `${file}:${m[4]}:${m[5]}`,
      rule: m[6],
    });
  }
  return issues;
}

export interface AnalyzeResult {
  /** Set when the analysis could not be made — the caller reports it as unchecked. */
  unverified?: string;
  command: string;
  issues: Issue[];
}

/** Run the analyzer. `flutter analyze` first; `dart analyze` is the fallback for a Dart-only install. */
export async function analyze(root: string): Promise<AnalyzeResult> {
  if (!depsResolved(root)) {
    return { command: 'flutter analyze', issues: [], unverified: 'dependencies are not resolved here (no .dart_tool/package_config.json) — run `flutter pub get`' };
  }
  const flutter = await sdkBin('flutter', root);
  if (flutter) {
    const r = await exec(flutter, ['analyze', '--no-pub'], root, ANALYZE_TIMEOUT_MS);
    if (!r.enoent) return { command: 'flutter analyze', issues: parseIssues(r.out, root) };
  }
  const dart = await sdkBin('dart', root);
  if (dart) {
    const r = await exec(dart, ['analyze'], root, ANALYZE_TIMEOUT_MS);
    if (!r.enoent) return { command: 'dart analyze', issues: parseIssues(r.out, root) };
  }
  return { command: 'flutter analyze', issues: [], unverified: 'no flutter or dart on PATH — cannot analyze' };
}

export interface TestResult {
  unverified?: string;
  /** The failing lines, already trimmed to what a fix pass needs. */
  failures: string[];
  passed: number;
  failed: number;
}

/**
 * `flutter test`. The project's own suite is the check: it names the widgets and the routes the
 * project claims, which no probe written here could do without going stale the moment the app grew a
 * second screen.
 *
 * The counters come from the progress line — `00:02 +3 -1: …` — because that is the one part of the
 * output every reporter emits, and the last one printed is the total.
 */
export async function runTests(root: string): Promise<TestResult> {
  if (!depsResolved(root)) {
    return { failures: [], passed: 0, failed: 0, unverified: 'dependencies are not resolved here — run `flutter pub get`' };
  }
  if (!existsSync(join(root, 'test'))) {
    return { failures: [], passed: 0, failed: 0, unverified: 'no test/ directory — this project has no suite yet' };
  }
  const flutter = await sdkBin('flutter', root);
  if (!flutter) return { failures: [], passed: 0, failed: 0, unverified: 'no flutter on PATH — cannot run the suite' };

  const r = await exec(flutter, ['test', '--no-pub', '--reporter', 'compact'], root, TEST_TIMEOUT_MS);
  if (r.enoent) return { failures: [], passed: 0, failed: 0, unverified: 'no flutter on PATH — cannot run the suite' };

  const lines = r.out.split(/[\r\n]+/).map((l) => l.trimEnd()).filter(Boolean);
  let passed = 0;
  let failed = 0;
  for (const l of lines) {
    const m = /\+(\d+)(?:\s+-(\d+))?/.exec(l);
    if (!m) continue;
    passed = Number(m[1]);
    failed = Number(m[2] ?? failed);
  }
  if (r.code === 0 && !failed) return { failures: [], passed, failed: 0 };

  // A failure is the `[E]` line plus the assertion under it; "No tests were found" is its own answer.
  if (/No tests were found/i.test(r.out)) {
    return { failures: [], passed: 0, failed: 0, unverified: 'test/ exists but holds no test files' };
  }
  const failures: string[] = [];
  for (let i = 0; i < lines.length && failures.length < 30; i++) {
    if (!/\[E\]\s*$|\[E\]/.test(lines[i]) && !/^\s*(Expected|Actual|Which):/.test(lines[i])) continue;
    failures.push(lines[i].trim().slice(0, 300));
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (/^\s*(\d{2}:\d{2}|To run)/.test(lines[j])) break;
      failures.push(lines[j].trim().slice(0, 300));
    }
  }
  return {
    failures: failures.length ? failures : lines.slice(-12),
    passed,
    failed: failed || 1,
  };
}

/**
 * `dart run build_runner build`, run in `prepare()` when the generated routes are missing or stale.
 *
 * WHY QA GENERATES RATHER THAN COMPLAINS. This is the arduino lesson, which cost a measured fix pass:
 * the wiring criterion asked whether the reply referenced a rendered diagram, the diagram was produced
 * only AFTER a pass succeeded, so pass 1 judged a project whose artifact did not exist yet. Here the
 * same shape is worse — a route added without re-running the generator makes `flutter analyze` fail on
 * an undefined name, so EVERY route-adding turn would burn a pass on a command with no decision in it.
 * Preparing first makes both the analyzer and the routing facts answerable on the first pass.
 *
 * Bounded, and every failure is the caller's to report rather than throw: a generator that cannot run
 * is a fact ("run this yourself"), not a reason to lose the turn.
 */
export async function generateRoutes(root: string): Promise<{ ok: boolean; detail: string }> {
  if (!depsResolved(root)) return { ok: false, detail: 'dependencies are not resolved — `flutter pub get` first' };
  const dart = await sdkBin('dart', root);
  if (!dart) return { ok: false, detail: 'no dart on PATH' };
  const r = await exec(dart, ['run', 'build_runner', 'build'], root, CODEGEN_TIMEOUT_MS);
  if (r.code === 0) return { ok: true, detail: 'dart run build_runner build — routes regenerated' };
  const why = r.out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' · ').slice(0, 300);
  return { ok: false, detail: `dart run build_runner build failed: ${why}` };
}
