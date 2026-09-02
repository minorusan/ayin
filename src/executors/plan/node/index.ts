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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../../log.js';
import type { Deliverable, ExecutorConfig, PlanExecutor, ProjectContext } from '../../types.js';
import { basePlanExecutor, ensureReadme } from '../base/index.js';

const config: ExecutorConfig = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'config.json'), 'utf-8'),
) as ExecutorConfig;

/** A safe npm package name from a directory name. `My Notes!` -> `my-notes`. */
function packageName(root: string): string {
  const n = (basename(root) || 'app').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return n || 'app';
}

/** Write a file only if it is absent. Returns the path when it wrote, so the caller can report it. */
function writeIfMissing(path: string, body: string): string[] {
  if (existsSync(path)) return [];
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    log('INFO', 'scaffold_node_file', { path });
    return [path];
  } catch (err) {
    // A read-only directory is worth reporting, never worth aborting the plan for.
    log('WARN', 'scaffold_node_failed', { path, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

const PKG = (name: string) => `${JSON.stringify({
  name,
  version: '0.1.0',
  private: true,
  type: 'module',
  scripts: {
    dev: 'node --watch --experimental-strip-types src/index.ts',
    build: 'tsc',
    start: 'node dist/index.js',
    typecheck: 'tsc --noEmit',
  },
  devDependencies: { typescript: '^5.9.0', '@types/node': '^22.0.0' },
}, null, 2)}\n`;

/**
 * `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` ARE LOAD-BEARING, not tidiness.
 *
 * Without them the two ways to run this project disagree. TS/ESM convention is to import the
 * COMPILED name — `from './notes.js'` — which is right for `npm run build`, and which the model
 * correctly wrote; but the `dev` script executes the .ts directly through Node's type stripping,
 * where `./notes.js` resolves literally and there is no such file. Measured: a bootstrapped project
 * with a route added died on `Cannot find module .../src/notes.js`, and neither the scaffold nor the
 * model was wrong — the scripts were.
 *
 * With these two, imports carry the `.ts` extension: Node runs them as written, and tsc rewrites them
 * to `.js` on the way into dist. Verified both directions.
 */
const TSCONFIG = `${JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    outDir: 'dist',
    rootDir: 'src',
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    declaration: false,
    sourceMap: true,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
  },
  include: ['src/**/*.ts'],
}, null, 2)}\n`;

/**
 * An entry point that RUNS, with nothing in it but the wiring.
 *
 * Node's own http module, no framework: a bootstrap that installs Express has chosen an architecture
 * on the operator's behalf, and one `createServer` call is not the part anybody wanted help with. The
 * routes the task actually asked for get added by the plan that follows this.
 */
const INDEX_TS = `import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3000);

const server = createServer((req, res) => {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: \`no route \${req.method} \${req.url}\` }));
});

server.listen(PORT, () => {
  console.log(\`listening on http://localhost:\${PORT}\`);
});
`;


/**
 * A README THAT NAMES THE FIRST COMMAND.
 *
 * The generic stub does not, and the bootstrap has a trap without it: `devDependencies` are written
 * but nothing is installed, so `npm run typecheck` fails on a fresh bootstrap with four errors about
 * `node:http` and `process` that look like broken scaffolding rather than "you have not installed
 * yet". Measured on the first run of this executor. So the very first line of the README is the
 * install, and this file is written BEFORE `ensureReadme` so the generic stub never wins.
 */
const README = (name: string) => `# ${name}

## Run it

\`\`\`bash
npm install        # required first — the type definitions come from here
npm run dev        # watch mode on http://localhost:3000
npm run typecheck  # fails until npm install has run
\`\`\`

## Layout

- \`src/index.ts\` — the entry point. It starts a server and 404s every route; the routes this
  project is for get added on top of it.
- Import local files with the \`.ts\` extension (\`./notes.ts\`) — this tsconfig rewrites it to
  \`.js\` on build, and Node runs it as written in dev.

## Notes

This project was bootstrapped deterministically — the manifest, the TypeScript configuration and the
entry point were written without a model, so they are the same every time.
`;

const GITIGNORE = `node_modules/
dist/
*.log
.env
`;

export const nodePlanExecutor: PlanExecutor = {
  config,

  // Everything not about bootstrapping is the base behaviour — the survey, the grounding and the
  // observability story for a Node project are what the generic executor was already written for.
  survey(ctx: ProjectContext): string { return basePlanExecutor.survey(ctx); },
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
   */
  grounding(ctx: ProjectContext, request?: string): string {
    const base = basePlanExecutor.grounding(ctx, request);
    if (!ctx.greenfield || ctx.type !== 'node') return base;
    const lines = [
      // THE SKETCH STEP IS RESTATED HERE, and that is not redundancy.
      //
      // Measured: with the workflow only in the system prompt (10k tokens of prefix) and this
      // grounding in the turn's volatile block (723 tokens, sitting next to the user's message), the
      // model followed THIS and skipped the sketch entirely — twice. Recency and specificity beat
      // position. Grounding that says "add routes to the existing server" without naming the step
      // before it is an instruction to skip that step, however clearly the prefix asked for it.
      'FIRST, THE SKETCH. This is a behaviour change, so the design directory comes before the code:',
      '  .naamah/<task-slug>/ — one plain .ts file per type, the members it must have, no bodies.',
      '  Then `naamah build .naamah/<task-slug>/` must exit 0 before you write any implementation.',
      '  The sketch is a DOCUMENT: never import from .naamah/ in real source — no exports exist there.',
      'Then implement from it. Skipping this is not a shortcut on a small task; it is the step that',
      'makes the implementation transcription instead of invention.',
      '',
      'THIS PROJECT WAS JUST BOOTSTRAPPED. It already exists and already runs — do not recreate it.',
      '',
      '  package.json   type: module · scripts: dev, build, start, typecheck',
      '  tsconfig.json  ES2022, strict, src -> dist',
      '  src/index.ts   THE ENTRY POINT. A node:http server that 404s every route.',
      '',
      'NO FRAMEWORK IS INSTALLED. There is no express, fastify or nest here, and nothing has been',
      'installed at all yet — `node_modules` is empty until `npm install` runs. So:',
      '  - Add routes to the EXISTING node:http server in src/index.ts. Do not replace it.',
      '  - Importing a package that is not in package.json makes the project fail to start. If a',
      '    dependency is genuinely needed, add it to package.json in the same change and say that',
      '    `npm install` must be run.',
      '  - Prefer the standard library. node:http is enough for an endpoint.',
      '',
      'IMPORT LOCAL FILES WITH THE .ts EXTENSION — `import { x } from \'./notes.ts\'`. This tsconfig',
      'sets allowImportingTsExtensions and rewriteRelativeImportExtensions, so Node runs that as',
      'written and tsc rewrites it to .js on build. A `./notes.js` import fails at run time, because',
      'no such file exists until a build has run.',
    ];
    return [base, lines.join('\n')].filter((x) => x.trim()).join('\n\n');
  },
  observability(ctx: ProjectContext): string { return basePlanExecutor.observability(ctx); },

  deliverables(ctx: ProjectContext): Deliverable[] {
    const base = basePlanExecutor.deliverables(ctx);
    if (!ctx.greenfield) return base;
    // On a bootstrap the runnable project IS part of what must exist at the end, so it is stated
    // rather than hoped for — the QA gate reads these.
    return [
      ...base,
      {
        label: 'the project manifest',
        // Both depths, for the same reason the Arduino sketch declares two: the operator may be
        // standing in the project or one directory above it, and both are the same correct project.
        patterns: ['package.json', '*/package.json'],
        why: 'without it there is no project — nothing can be installed, run or started.',
        required: true,
      },
      {
        label: 'the TypeScript configuration',
        patterns: ['tsconfig.json', '*/tsconfig.json'],
        why: 'a .ts file with no tsconfig is a file, not a build.',
        required: true,
      },
      {
        label: 'an entry point that runs',
        patterns: ['src/*.ts', 'src/**/*.ts', '*.ts', '*/src/*.ts'],
        why: 'the request asked for behaviour; behaviour has to live in a file the project starts.',
        required: true,
      },
    ];
  },

  scaffold(ctx: ProjectContext): string[] {
    // THE GUARD, FIRST. Only a directory that asked to become a Node project and holds none yet.
    // Anywhere else this falls through to exactly what the base executor did before.
    if (!ctx.greenfield || ctx.type !== 'node') return ensureReadme(ctx.root);
    const made: string[] = [];
    // Ours before the generic stub, so the README that survives is the one naming `npm install`.
    made.push(...writeIfMissing(join(ctx.root, 'README.md'), README(packageName(ctx.root))));
    made.push(...ensureReadme(ctx.root));
    made.push(...writeIfMissing(join(ctx.root, 'package.json'), PKG(packageName(ctx.root))));
    made.push(...writeIfMissing(join(ctx.root, 'tsconfig.json'), TSCONFIG));
    made.push(...writeIfMissing(join(ctx.root, '.gitignore'), GITIGNORE));
    made.push(...writeIfMissing(join(ctx.root, 'src', 'index.ts'), INDEX_TS));
    if (made.length) log('INFO', 'scaffold_node', { root: ctx.root, files: String(made.length) });
    return made;
  },
};
