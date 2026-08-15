/**
 * testrun/run.ts — executing the tests, and the two ways to do it.
 *
 *   FAST   NUnit over `Library/ScriptAssemblies/*.dll`, which the Editor already compiled. Seconds,
 *          no licence, no lock, and correct as long as nothing is stale.
 *   BATCH  `Unity -batchmode -runTests`. Authoritative, and needs the Editor to let go of the project.
 *
 * Neither path is verified on the machine this was written on — there is no .NET toolchain and no
 * Unity here. Every failure below therefore reports WHICH step failed and what would fix it, rather
 * than collapsing into "tests failed": a missing runner and a failing assertion are the same exit
 * code, and telling them apart is the difference between a five-minute fix and an afternoon.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfigString } from '../prompts.js';
import { unityHasProjectOpen, unityLockPath, unityVersion } from './asmdef.js';

export interface TestCase {
  name: string;
  outcome: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  message?: string;
}

export interface AssemblyOutcome {
  assembly: string;
  passed: number;
  failed: number;
  skipped: number;
  cases: TestCase[];
  /** Set when the assembly did not run at all. The report must never fold this into a pass. */
  notRun?: string;
}

// ── the runner ───────────────────────────────────────────────────────────────────

/**
 * Find something that can run an NUnit assembly.
 *
 * `nunitConsole` in config wins. Otherwise the usual names — and if none is present that is a
 * SETUP problem with a one-line fix, not a test result, so the caller says so in those words.
 */
export function findRunner(): { cmd: string; args: (dll: string, out: string) => string[] } | null {
  const configured = getConfigString('nunitConsole');
  if (configured) {
    return { cmd: configured, args: (dll, out) => [dll, `--result=${out}`, '--noresult=false'] };
  }
  for (const cmd of ['nunit3-console', 'nunit-console']) {
    if (which(cmd)) return { cmd, args: (dll, out) => [dll, `--result=${out}`] };
  }
  if (which('dotnet')) {
    // vstest can drive an NUnit DLL when NUnit3TestAdapter sits beside it, which it does in a Unity
    // project's package cache. Kept as a fallback because it is the toolchain most likely present.
    return { cmd: 'dotnet', args: (dll, out) => ['vstest', dll, `--logger:trx;LogFileName=${out}`] };
  }
  return null;
}

function which(cmd: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * Parse an NUnit3 result file.
 *
 * Regex over `<test-case …>` rather than a real XML parser: ayin ships no XML dependency, and the
 * shape consumed here is two attributes and an optional message. A malformed file yields zero cases,
 * which the caller reports as "ran but produced no readable results" — never as a pass.
 */
export function parseNUnitXml(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const re = /<test-case\b([^>]*?)(\/>|>([\s\S]*?)<\/test-case>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const inner = m[3] ?? '';
    const name = attr(attrs, 'fullname') || attr(attrs, 'name') || '(unnamed)';
    const result = (attr(attrs, 'result') || '').toLowerCase();
    const outcome: TestCase['outcome'] =
      result.startsWith('pass') ? 'passed' : result.startsWith('fail') ? 'failed' : 'skipped';
    const durationMs = Math.round(Number(attr(attrs, 'duration') || '0') * 1000) || 0;
    let message: string | undefined;
    if (outcome === 'failed') {
      const msg = /<message>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/message>/.exec(inner);
      if (msg) message = msg[1].trim().slice(0, 600);
    }
    cases.push({ name, outcome, durationMs, message });
  }
  return cases;
}

function attr(s: string, key: string): string {
  const m = new RegExp(`${key}="([^"]*)"`).exec(s);
  return m ? m[1] : '';
}

/** Tally cases into an assembly outcome. */
export function tally(assembly: string, cases: TestCase[]): AssemblyOutcome {
  return {
    assembly,
    cases,
    passed: cases.filter((c) => c.outcome === 'passed').length,
    failed: cases.filter((c) => c.outcome === 'failed').length,
    skipped: cases.filter((c) => c.outcome === 'skipped').length,
  };
}

/**
 * Run one already-compiled assembly.
 *
 * A NON-ZERO EXIT IS NOT AN ERROR HERE — NUnit exits non-zero when tests fail, which is a result,
 * not a failure to run. The distinction is whether a result file appeared.
 */
export function runAssembly(dll: string, assembly: string): AssemblyOutcome {
  const runner = findRunner();
  if (!runner) {
    return { assembly, passed: 0, failed: 0, skipped: 0, cases: [], notRun: 'no NUnit runner found' };
  }
  const dir = mkdtempSync(join(tmpdir(), 'ayin-testrun-'));
  const out = join(dir, 'result.xml');
  try {
    try {
      execFileSync(runner.cmd, runner.args(dll, out), {
        encoding: 'utf-8', timeout: 10 * 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { /* failing tests exit non-zero; the result file is what decides */ }
    if (!existsSync(out)) {
      return {
        assembly, passed: 0, failed: 0, skipped: 0, cases: [],
        notRun: `${runner.cmd} produced no result file — the assembly probably could not load (engine types?)`,
      };
    }
    const cases = parseNUnitXml(readFileSync(out, 'utf-8'));
    if (!cases.length) {
      return { assembly, passed: 0, failed: 0, skipped: 0, cases: [], notRun: 'ran but produced no readable results' };
    }
    return tally(assembly, cases);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Unity, when it has to be involved ────────────────────────────────────────────

/**
 * Ask the Editor to quit, then wait for it to let go of the lock.
 *
 * GRACEFUL ONLY. A SIGKILL on Unity loses unsaved scene and prefab edits and can leave `Library/`
 * half-written — an afternoon, to save thirty seconds. So this asks, waits, and REPORTS when the
 * Editor does not go: the usual reason is a save-changes modal waiting for a human, which from here
 * is indistinguishable from a hang and must not be resolved by force.
 */
export function quitUnity(repo: string, timeoutMs = 30_000): { ok: boolean; reason?: string } {
  if (!unityHasProjectOpen(repo)) return { ok: true };
  try {
    if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e', 'tell application "Unity" to quit'], { timeout: 10_000, stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execFileSync('taskkill', ['/im', 'Unity.exe'], { timeout: 10_000, stdio: 'ignore' }); // no /f — asks
    } else {
      execFileSync('pkill', ['-TERM', '-x', 'Unity'], { timeout: 10_000, stdio: 'ignore' });
    }
  } catch {
    return { ok: false, reason: 'could not signal the Unity process' };
  }
  // Poll the lock rather than the process: the lock is what batch mode actually contends for.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(unityLockPath(repo))) return { ok: true };
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { timeout: 2000 });
  }
  return {
    ok: false,
    reason: 'Unity still holds the project after 30s — it is probably asking about unsaved changes. '
      + 'Switch to it and answer, then run this again.',
  };
}

/** Where the matching Editor lives. Config first: an install path is machine-specific by nature. */
export function unityBinary(repo: string): string | null {
  const configured = getConfigString('unityPath');
  if (configured && existsSync(configured)) return configured;
  const version = unityVersion(repo);
  if (!version) return null;
  const guesses = process.platform === 'darwin'
    ? [`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`]
    : process.platform === 'win32'
      ? [`C:\\Program Files\\Unity\\Hub\\Editor\\${version}\\Editor\\Unity.exe`]
      : [`${process.env.HOME}/Unity/Hub/Editor/${version}/Editor/Unity`];
  return guesses.find((g) => existsSync(g)) ?? null;
}

/**
 * `Unity -batchmode -runTests`. Authoritative, slow, and needs the project to itself.
 *
 * `-assemblyNames` is what makes a domain-scoped run possible at all: without it Unity runs every
 * test in the project, which on a tree this size is the difference between minutes and an hour.
 */
export function runBatchmode(
  repo: string, assemblies: string[], platform: 'EditMode' | 'PlayMode',
): { outcomes: AssemblyOutcome[]; error?: string } {
  const unity = unityBinary(repo);
  if (!unity) {
    return { outcomes: [], error: `no Unity ${unityVersion(repo) ?? ''} install found — set one with /set unity-path <path>` };
  }
  const dir = mkdtempSync(join(tmpdir(), 'ayin-batch-'));
  const results = join(dir, 'results.xml');
  try {
    try {
      execFileSync(unity, [
        '-batchmode', '-runTests', '-nographics',
        '-projectPath', repo,
        '-testPlatform', platform,
        '-testResults', results,
        '-assemblyNames', assemblies.join(';'),
        '-logFile', '-',
      ], { encoding: 'utf-8', timeout: 60 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { /* Unity exits non-zero when tests fail — the results file decides */ }
    if (!existsSync(results)) return { outcomes: [], error: 'Unity produced no results file' };
    const cases = parseNUnitXml(readFileSync(results, 'utf-8'));
    // Batch mode returns one file for everything; split back per assembly by the fullname prefix so
    // the report reads the same whichever path produced it.
    const byAssembly = new Map<string, TestCase[]>();
    for (const c of cases) {
      const owner = assemblies.find((a) => c.name.startsWith(a)) ?? platform;
      const list = byAssembly.get(owner) ?? [];
      list.push(c);
      byAssembly.set(owner, list);
    }
    return { outcomes: [...byAssembly.entries()].map(([a, cs]) => tally(a, cs)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
