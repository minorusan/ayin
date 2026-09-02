/**
 * Node / TypeScript planning — and, on a greenfield directory, an actual BOOTSTRAP.
 *
 * WHY THIS EXISTS. "Give me an empty TS endpoint for notes" in an empty directory used to produce a
 * README and a plan. Everything a person means by that request — a package.json, a tsconfig, an entry
 * point that starts, a script to run it — was left as prose for the model to remember, and a weak
 * model remembers about half of it. The result is a file that cannot run, in a directory that is not
 * a project, and the operator finds out when they type `npm run dev`.
 *
 * `scaffold()` is the hook the executor contract already reserved for this: deterministic, run BEFORE
 * the plan is written, creates only what is missing. Deterministic is the important word — a
 * bootstrap is the least creative part of any task and the most annoying to get wrong, so no model
 * call is involved. The plan that follows then describes the FEATURE, because the project already
 * exists.
 *
 * ONLY ON GREENFIELD. `ctx.greenfield` means the type came from the REQUEST and the directory holds
 * no project. Scaffolding anywhere else would write a package.json into somebody's existing repo, so
 * every writer below is additionally guarded on the file not existing — belt and braces, because the
 * cost of being wrong here is editing a stranger's project.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../../log.js';
import type { Deliverable, ExecutorConfig, PlanExecutor, ProjectContext } from '../../types.js';
import { greenfieldPlanExecutor } from '../greenfield/index.js';
import { isNaamah } from '../../../modes.js';

const config: ExecutorConfig = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'config.json'), 'utf-8'),
) as ExecutorConfig;

/** Where the files actually go — `root`, or the folder the request named inside it. Mirrors greenfield. */
function targetRoot(ctx: ProjectContext): string {
  return ctx.targetDir ? join(ctx.root, ctx.targetDir) : ctx.root;
}

/** How long the bootstrap install may take before the project is handed over without it. */
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * `npm install`, ONCE, AT BOOTSTRAP — because without it the compile check is theatre.
 *
 * `qa/buildcheck.ts` runs `node_modules/.bin/tsc --noEmit`, and when that binary is absent it returns
 * *ok, unverified: typescript is not installed here*. On a freshly scaffolded project that is always
 * the case, so QA reported a green "valid build and test pipeline" for a project it had compiled zero
 * files of — measured, on a run whose `npm test` exited 1 for having no tests at all. An install here
 * is what turns that fact from skipped into answered.
 *
 * FIRE AND FORGET, DELIBERATELY. `scaffold()` is synchronous and runs before the plan; blocking it on
 * a registry would make an offline machine wait two minutes to be told nothing. So this starts the
 * install and returns, and everything downstream already treats a missing toolchain as unknown rather
 * than broken. Failure is logged, never thrown: a project that cannot install is still a project worth
 * planning, and the operator has a README that says to run it.
 */
function startBootstrapInstall(dir: string): void {
  if (existsSync(join(dir, 'node_modules'))) return;
  log('INFO', 'scaffold_npm_install_start', { dir });
  const child = execFile(
    'npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'],
    { cwd: dir, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    (err) => {
      if (err) log('WARN', 'scaffold_npm_install_failed', { dir, error: err.message.slice(0, 200) });
      else log('INFO', 'scaffold_npm_install_done', { dir });
    },
  );
  // Never hold the process open for it — a plan that finished should not wait on a registry.
  child.unref?.();
}

/**
 * THIS EXECUTOR IS `greenfield` PLUS A BOOTSTRAP — it does not replace it.
 *
 * Both were written for the same complaint on two machines that could not see each other, and the
 * merge that brought them together had to pick one owner for `node` (selection is highest priority,
 * ties broken by id, so two claimants at 100 is a coin flip). Picking either one alone threw away
 * real work: `greenfield` has the layout, test convention and observability story for TypeScript in
 * tunable prompt files and a survey that does not lie about an empty directory; this one WRITES the
 * package.json, the tsconfig and an entry point that starts.
 *
 * So `node` owns the type and delegates every planning surface to `greenfield` — whose `typescript`
 * branch is still keyed on `ctx.type === 'node'` — and adds the deterministic file bootstrap on top.
 * Nothing is duplicated: the deliverables (manifest, tsconfig, entry point, test, .gitignore) are
 * greenfield's list, which already names everything this scaffold writes.
 */
export const nodePlanExecutor: PlanExecutor = {
  config,

  survey(ctx: ProjectContext): string { return greenfieldPlanExecutor.survey(ctx); },
  /**
   * WHAT THE BOOTSTRAP ALREADY DECIDED — because the model does not know, and guesses Express.
   *
   * Measured, immediately after the bootstrap started working: the scaffold wrote a runnable
   * `node:http` server, and the model then OVERWROTE `src/index.ts` with an Express version and
   * imported `express` in a new route file. Neither the dependency nor an install existed, so a
   * project that ran a second earlier could not start. The bootstrap was necessary and not
   * sufficient: a deterministic decision nobody is told about is a decision the next writer undoes.
   *
   * Empty for a project that already exists — a real repo's conventions are read from the tree by the
   * base survey, and stating them from here would be inventing facts about somebody else's code.
   *
   * The base is greenfield's `layoutTypescript` prompt: what the project's shape SHOULD be, which an
   * operator can edit. What follows is what this scaffold has already DONE, which they cannot.
   */
  grounding(ctx: ProjectContext, request?: string): string {
    const base = greenfieldPlanExecutor.grounding(ctx, request);
    if (!ctx.greenfield || ctx.type !== 'node') return base;
    const lines = [
      // THE SKETCH STEP IS RESTATED HERE, and that is not redundancy.
      //
      // Measured: with the workflow only in the system prompt (10k tokens of prefix) and this
      // grounding in the turn's volatile block (723 tokens, sitting next to the user's message), the
      // model followed THIS and skipped the sketch entirely — twice. Recency and specificity beat
      // position. Grounding that says "add routes to the existing server" without naming the step
      // before it is an instruction to skip that step, however clearly the prefix asked for it.
      // AND IT IS GATED WITH THE REST OF IT. The restatement exists because grounding beats prefix;
      // that cuts both ways, so leaving it here with the workflow off would be the one voice still
      // ordering a design directory the operator switched off — which is exactly the failure the note
      // above describes, pointed the other way.
      ...(isNaamah() ? [
        'FIRST, THE SKETCH. This is a behaviour change, so the design directory comes before the code:',
        '  .naamah/<task-slug>/ — one plain .ts file per type, the members it must have, no bodies.',
        '  Then `naamah build .naamah/<task-slug>/` must exit 0 before you write any implementation.',
        '  The sketch is a DOCUMENT: never import from .naamah/ in real source — no exports exist there.',
        'Then implement from it. Skipping this is not a shortcut on a small task; it is the step that',
        'makes the implementation transcription instead of invention.',
        '',
      ] : []),
      'THIS PROJECT WAS JUST BOOTSTRAPPED. It already exists, already serves a page and already has a',
      'passing test — do not recreate any of it.',
      '',
      '  package.json        type: module · scripts: dev (nodemon), build, start, typecheck, test',
      '  tsconfig.json       ES2022, strict, src+test -> dist',
      '  src/server.ts       THE ROUTES. `createServer()` returns the server WITHOUT listening.',
      '  src/index.ts        the entry point: reads PORT, listens. Four lines; leave it alone.',
      '  public/index.html   the page. Everything in public/ is served as-is.',
      '  test/server.test.ts node:test over real HTTP on port 0. `npm test` passes right now.',
      '',
      'ADD ROUTES IN src/server.ts, inside `handle()`, above the static fallback. Keep `createServer()`',
      'returning an unlistened server — that is what lets the test bind port 0 instead of colliding.',
      '',
      'QA BOOTS THIS PROJECT. `npm run dev` is started on a port the gate picks and must accept a',
      'connection on it, so src/index.ts must keep reading process.env.PORT and listening.',
      '',
      'NO FRAMEWORK IS INSTALLED. There is no express, fastify or nest here, and the dependency set is',
      'typescript, @types/node and nodemon. So:',
      '  - Importing a package that is not in package.json makes the project fail to start. If a',
      '    dependency is genuinely needed, add it to package.json in the same change and say that',
      '    `npm install` must be run.',
      '  - Prefer the standard library. node:http serves the page and node:test tests it.',
      '  - Every route you add gets a case in test/server.test.ts. The suite is green now; keep it.',
      '',
      'IMPORT LOCAL FILES WITH THE .ts EXTENSION — `import { x } from \'./notes.ts\'`. This tsconfig',
      'sets allowImportingTsExtensions and rewriteRelativeImportExtensions, so Node runs that as',
      'written and tsc rewrites it to .js on build. A `./notes.js` import fails at run time, because',
      'no such file exists until a build has run.',
    ];
    return [base, lines.join('\n')].filter((x) => x.trim()).join('\n\n');
  },
  observability(ctx: ProjectContext): string { return greenfieldPlanExecutor.observability(ctx); },

  /**
   * GREENFIELD'S LIST, NOT A SECOND ONE. Its `typescript` branch already declares the manifest, the
   * compiler configuration, the entry point, a test and the ignore file — everything the scaffold
   * below writes, plus the test it deliberately does not. A parallel list here would be the same
   * facts in two places, prefixed for `targetDir` in only one of them, drifting from the first edit.
   */
  deliverables(ctx: ProjectContext): Deliverable[] { return greenfieldPlanExecutor.deliverables(ctx); },

  /**
   * GREENFIELD FIRST, THEN THE FILES. Its scaffold makes the target directory when the request named
   * one and runs `git init` — so the manifest this writes is inside the repository rather than beside
   * it, and the first commit can contain the first file.
   *
   * Everything is written into `targetRoot`, never `ctx.root`: people set a project up from one level
   * above it, and a package.json in the folder-of-projects is worse than none.
   */
  /**
   * THE FILES ARE GREENFIELD'S — this adds the install, and nothing else.
   *
   * The TypeScript file table used to live here, duplicating what greenfield's `typescript` branch
   * declares as deliverables. Two lists of what a new TS project contains is one list too many: the
   * validator rejects a plan for the project the scaffold just built the moment they disagree, and
   * they disagreed already (the table wrote no test; the deliverables required one). One table now,
   * in `greenfield/files.ts`, checked against the deliverables by `check-plan.mjs`.
   */
  scaffold(ctx: ProjectContext): string[] {
    const made = greenfieldPlanExecutor.scaffold(ctx);
    if (!ctx.greenfield || ctx.type !== 'node') return made;
    // The one thing greenfield cannot do for a language it does not own the toolchain of.
    startBootstrapInstall(targetRoot(ctx));
    return made;
  },
};
