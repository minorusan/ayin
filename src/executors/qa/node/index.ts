/**
 * Node/TypeScript QA — three questions with machine answers, and no opinions at all.
 *
 * WHY THIS EXISTS. The generic gate ran criteria derivation and then the judge on every finished
 * Node turn: two LLM calls before the operator sees anything, non-reproducible between runs, and
 * measurably wrong on this project type. It failed a freshly scaffolded page for *"the integration
 * with the third-party API (w3.org) lacks handling for non-2xx, 401/403, 429, or timeout errors"* —
 * the URL was an inline SVG's `xmlns` — and the fix pass then wrote an `/api/proxy` route into the
 * project. Twice, in separately measured runs.
 *
 * A judge is the right instrument for a question with no machine answer. A TypeScript service has
 * three questions that DO have machine answers, so it gets those and stops:
 *
 *   1. DOES IT COMPILE — `tsc --noEmit`, whole project. Errors, never style.
 *   2. DOES IT STILL WORK — the project's own test suite, which for anything ayin scaffolds is a set
 *      of real requests against a real server on a real port: `/api/health` returns 200 and `ok`,
 *      `/` serves HTML, an unknown route is a 404 not a crash, and `..` does not escape `public/`.
 *   3. DOES IT COME UP — `npm run dev` with a `PORT` we chose, and something accepting a connection on
 *      it. The suite cannot answer this: it binds port 0 INSIDE the test process and never runs the
 *      command the operator runs, so a project whose entry point imports a missing package, or builds
 *      a server and forgets to listen, passes every other check and starts for nobody. See
 *      `bootcheck.ts`.
 *
 * RUNNING THE PROJECT'S OWN TESTS, NOT A PROBE OF OUR OWN, is the whole trick for question 2. A
 * bespoke endpoint prober would have to guess the port, the routes and the start command, would go
 * stale the moment the project grew a second endpoint, and would test something other than what the
 * project says it is. The test file is already there, already names the endpoints, and is already the
 * thing a developer would run.
 *
 * `factsOnly: true` in the config is what turns the judge off. All three are `hard`, so a failure
 * goes straight back to the agent as work instructions and the gate never asks a model what it thinks.
 *
 * ABSENT IS NOT FAILED — the rule this file inherits from `buildcheck.ts` and must not break. No
 * `tsconfig.json`, no installed typescript, no test script, no test files, no boot script: each is a
 * question that could not be asked, reported as unchecked. A hard fact nobody can satisfy burns the fix budget that
 * would have fixed something real, and on the turn that CREATES a project half of these are normal.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ChangedFile } from '../../../qa/probes.js';
import { buildCheck } from '../buildcheck.js';
import { bootCheck } from '../bootcheck.js';
import { repoBaselineFact } from '../../plan/git.js';
import type { ExecutorConfig, PrepareResult, ProbeFact, ProjectContext, QaExecutor } from '../../types.js';

const config: ExecutorConfig = {
  id: 'node', kind: 'qa', projectTypes: ['node'], priority: 10, factsOnly: true,
  description: 'Node/TS QA — tsc --noEmit, the project\'s own test suite, and a real boot on a real port. Deterministic, no judge.',
};

/**
 * Long enough for a suite that starts a server per test; short enough that a hung test is not the
 * turn. Deliberately far below the build timeout — a unit suite that takes a minute is a broken
 * suite, and waiting three more will not tell us anything new.
 */
const TEST_TIMEOUT_MS = 60_000;

function run(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, {
      cwd, timeout: TEST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      // A test that reads the terminal would hang forever behind a pipe; and colour codes in a fact
      // handed to a model are pure noise.
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    return { code: 0, out: out ?? '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; code?: string; message?: string };
    if (e.code === 'ENOENT') return { code: -1, out: 'ENOENT' };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || '' };
  }
}

/** Does this project declare a test script that is not the npm placeholder? */
function testScript(root: string): string | null {
  try {
    const pkg = JSON.parse(execFileSync('node', ['-e', 'process.stdout.write(require("fs").readFileSync("package.json","utf8"))'],
      { cwd: root, encoding: 'utf8', timeout: 10_000 })) as { scripts?: Record<string, string> };
    const t = (pkg.scripts?.test ?? '').trim();
    // `npm init` writes a test script that exits 1 with "no test specified". Running it would report
    // a failing suite on a project that simply has none.
    if (!t || /no test specified/i.test(t)) return null;
    return t;
  } catch {
    return null;
  }
}

/** Is there anything for that script to run? A green suite of zero tests proves nothing. */
function hasTestFiles(root: string): boolean {
  for (const dir of ['test', 'tests', '__tests__', 'src']) {
    const d = join(root, dir);
    if (!existsSync(d)) continue;
    try {
      const stack = [d];
      let seen = 0;
      while (stack.length && seen < 400) {
        const cur = stack.pop()!;
        for (const e of readdirSync(cur, { withFileTypes: true })) {
          seen++;
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
          const p = join(cur, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) return true;
        }
      }
    } catch { /* unreadable dir — treat as no tests */ }
  }
  return false;
}

/**
 * ONLY WHAT FAILED. The agent is about to act on this, and a passing suite's output is a hundred
 * lines saying so.
 *
 * `node --test` reports TAP: `not ok N - name`, then an indented YAML diagnostic block carrying the
 * assertion. Both matter — the name says which endpoint, the diagnostic says what it got — so a
 * failing point keeps its following indented lines. Other runners (vitest, jest) are matched on their
 * own failure markers, and anything unrecognised falls back to the tail of the log, which is where
 * every runner puts its summary.
 */
function failureLines(out: string, limit = 40): string[] {
  const lines = out.split('\n').map((l) => l.trimEnd());
  const picked: string[] = [];
  let capturing = false;
  for (const l of lines) {
    const isFailHead = /^\s*not ok \d+/.test(l)
      || /^\s*(✕|✗|×|FAIL)\s/.test(l)
      || /^\s*●/.test(l);
    if (isFailHead) { capturing = true; picked.push(l.trim()); continue; }
    if (capturing) {
      // The diagnostic block is indented under its point; the next unindented line ends it.
      if (/^\s+\S/.test(l) && !/^\s*ok \d+/.test(l)) picked.push(l.trim());
      else capturing = false;
    }
    if (picked.length >= limit) break;
  }
  if (picked.length) return picked.slice(0, limit);
  // Unrecognised runner: the summary is at the end, and it is better than nothing.
  return lines.filter(Boolean).slice(-limit);
}

function testFact(ctx: ProjectContext): ProbeFact {
  const script = testScript(ctx.root);
  if (!script) {
    return { key: 'tests', ok: true, detail: 'tests not checked: package.json declares no test script' };
  }
  if (!existsSync(join(ctx.root, 'node_modules'))) {
    return { key: 'tests', ok: true, detail: 'tests not checked: dependencies are not installed (no node_modules)' };
  }
  if (!hasTestFiles(ctx.root)) {
    return { key: 'tests', ok: true, detail: 'tests not checked: no *.test.* or *.spec.* files exist yet' };
  }

  const r = run('npm', ['test', '--silent'], ctx.root);
  if (r.code === -1) {
    return { key: 'tests', ok: true, detail: 'tests not checked: npm is not on PATH' };
  }
  if (r.code === 0) {
    return { key: 'tests', ok: true, hard: true, detail: `npm test — passing (${script})` };
  }
  const fails = failureLines(r.out);
  return {
    key: 'tests',
    ok: false,
    hard: true,
    detail: `npm test FAILED — ${fails.length} failing line(s). The endpoints this project claims do not all work:\n`
      + fails.map((l) => `  ${l}`).join('\n'),
  };
}

export const nodeQaExecutor: QaExecutor = {
  config,

  async prepare(): Promise<PrepareResult> {
    // Nothing to regenerate: both facts read the project exactly as it stands.
    return { produced: [], handled: new Set(), notes: [] };
  },

  async probe(ctx: ProjectContext, files: ChangedFile[]): Promise<ProbeFact[]> {
    const facts: ProbeFact[] = [];
    // 1 · does it compile. `buildCheck` owns the tsc invocation and the absent-toolchain rule.
    const built = buildCheck(ctx, files);
    if (built) facts.push(built);
    // 2 · does it still work — the project's own suite, which is the endpoint check.
    facts.push(testFact(ctx));
    // 3 · does it come up. Last because it is the only fact that COSTS seconds, and a project that
    //     does not compile has already failed for a reason the agent can act on.
    facts.push(await bootCheck(ctx));
    // 4 · the scaffold's promise that there is something to diff against. Instant, and hard only on a
    //     greenfield turn — see `plan/git.ts`.
    facts.push(repoBaselineFact(ctx));
    return facts;
  },

  criteria(): string[] {
    // factsOnly — nothing is derived, so there is no baseline id to add.
    return [];
  },
};
