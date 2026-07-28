/**
 * Plan survey — the DETERMINISTIC first step of plan mode. No LLM.
 *
 * Before a model reasons about a big request it should be told what this project actually IS: how it
 * is built and run, what it already depends on, what it can serve, and — the part that gets skipped
 * every time — how anything here can be OBSERVED once it runs. A plan that ends at "implement the
 * feature" hands the operator a black box; a plan that names the log line, the env switch and the
 * command that proves it works is a plan you can debug at 3am.
 *
 * Everything here is read with cheap, bounded commands (capped output, short timeouts, vendor and
 * build directories excluded), so surveying a monorepo costs a moment rather than a minute.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../qa/probes.js';

export interface Survey {
  root: string;
  kind: string;
  scripts: Record<string, string>;
  deps: string[];
  entryPoints: string[];
  /** Frameworks/servers present that can actually serve a web UI. */
  webviewStack: string[];
  /** What a new webview would still need here. */
  webviewGaps: string[];
  /** Logging facilities that already exist — what a new feature should log THROUGH. */
  logging: string[];
  /** Switches and entry points for observing a run. */
  debug: string[];
  testCmds: string[];
}

/** Bounded shell read. Returns '' on any failure — a survey never breaks the turn. */
function sh(cmd: string, cwd: string, timeout = 6000): string {
  try {
    return execSync(cmd, { cwd, timeout, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const EXCLUDES = `--exclude-dir={.git,node_modules,dist,build,out,.next,coverage,vendor,target,.venv,__pycache__,Library,Temp}`;

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>; } catch { return null; }
}

function projectKind(root: string): string {
  const has = (p: string) => existsSync(join(root, p));
  if (has('Assets') && has('ProjectSettings')) return 'Unity project';
  if (has('pubspec.yaml')) return 'Flutter/Dart project';
  if (has('tsconfig.json')) return 'TypeScript project';
  if (has('package.json')) return 'Node.js project';
  if (has('Cargo.toml')) return 'Rust project';
  if (has('go.mod')) return 'Go project';
  if (has('pyproject.toml') || has('requirements.txt')) return 'Python project';
  if (has('*.sln')) return '.NET solution';
  return 'unknown project type';
}

const WEB_DEPS: Array<[string, string]> = [
  ['express', 'Express HTTP server'],
  ['fastify', 'Fastify HTTP server'],
  ['koa', 'Koa HTTP server'],
  ['vite', 'Vite dev server / bundler'],
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['socket.io', 'Socket.IO'],
  ['ws', 'raw WebSocket server'],
  ['blessed', 'terminal UI (NOT a webview)'],
];

/**
 * What this project can already serve, and what a NEW webview would still need.
 *
 * The gap list is the useful half. "Add a settings page" in a project with no HTTP server, no
 * bundler and no static route is three tasks wearing one sentence, and the plan should say so before
 * anyone writes a line of HTML.
 */
function webviewSurvey(root: string, deps: string[], scripts: Record<string, string>): { stack: string[]; gaps: string[] } {
  const stack: string[] = [];
  for (const [dep, label] of WEB_DEPS) if (deps.includes(dep)) stack.push(`${label} (${dep})`);

  // A hand-rolled node server counts as a stack even with no framework dependency.
  const rawHttp = sh(`grep -rl ${EXCLUDES} -E "createServer\\(|http\\.createServer|\\.listen\\(" . 2>/dev/null | head -5`, root);
  if (rawHttp) stack.push(`hand-rolled HTTP server (${rawHttp.split('\n').length} file(s) call listen/createServer)`);

  const htmlFiles = sh(`find . -maxdepth 4 -name "*.html" -not -path "*/node_modules/*" -not -path "*/dist/*" 2>/dev/null | head -5`, root);
  if (htmlFiles) stack.push(`existing HTML: ${htmlFiles.split('\n').join(', ')}`);

  const gaps: string[] = [];
  const serves = stack.some((s) => /HTTP server|Vite|Next/.test(s));
  if (!serves) gaps.push('no HTTP server or dev server present — a webview needs something to serve it (add one deliberately, do not improvise a script)');
  if (!deps.some((d) => ['vite', 'next', 'webpack', 'esbuild', 'parcel', 'rollup'].includes(d)) && !htmlFiles) {
    gaps.push('no bundler and no existing HTML — decide plain static HTML vs a bundled app BEFORE writing UI code');
  }
  if (!Object.keys(scripts).some((s) => /^(dev|start|serve|preview)$/.test(s))) {
    gaps.push('no dev/start/serve script — there is no agreed command to launch the UI, so nobody can verify it runs');
  }
  gaps.push('bind the server to all interfaces, not loopback, or the page will be invisible from every other device on the network');
  return { stack, gaps };
}

/** Logging and debugging facilities that ALREADY exist — a new feature must use these, not invent its own. */
function observabilitySurvey(root: string): { logging: string[]; debug: string[] } {
  const logging: string[] = [];
  const debug: string[] = [];

  const logModules = sh(`find . -maxdepth 4 -type f \\( -name "log*.ts" -o -name "log*.js" -o -name "logger*.*" -o -name "logging*.*" \\) -not -path "*/node_modules/*" -not -path "*/dist/*" 2>/dev/null | head -5`, root);
  if (logModules) logging.push(`project logger module(s): ${logModules.split('\n').join(', ')} — log through this, not console`);

  const consoleCount = sh(`grep -rho ${EXCLUDES} -E "console\\.(log|error|warn)" . 2>/dev/null | wc -l`, root);
  if (consoleCount && Number(consoleCount) > 0) logging.push(`${consoleCount} raw console.* call(s) in the tree`);

  const structured = sh(`grep -rlo ${EXCLUDES} -E "\\b(pino|winston|bunyan|Serilog|Debug\\.Log|debugPrint|log\\.(info|warn|error))\\b" . 2>/dev/null | head -5`, root);
  if (structured) logging.push(`structured logging in: ${structured.split('\n').join(', ')}`);

  const logFiles = sh(`grep -rho ${EXCLUDES} -E "[A-Za-z0-9_./~-]+\\.log" . 2>/dev/null | sort -u | head -8`, root);
  if (logFiles) debug.push(`log file paths referenced in source: ${logFiles.split('\n').join(', ')}`);

  const envSwitches = sh(`grep -rho ${EXCLUDES} -E "(process\\.env\\.|getenv\\(['\\"]?)[A-Z_]*(LOG|DEBUG|VERBOSE|TRACE)[A-Z_]*" . 2>/dev/null | sort -u | head -10`, root);
  if (envSwitches) debug.push(`existing log/debug env switches: ${envSwitches.split('\n').map((s) => s.replace(/^.*env\./, '').replace(/^getenv\(['"]?/, '')).join(', ')}`);

  const healthRoutes = sh(`grep -rho ${EXCLUDES} -E "['\\"]/(health|status|metrics|debug)[a-z/]*['\\"]" . 2>/dev/null | sort -u | head -8`, root);
  if (healthRoutes) debug.push(`introspection routes present: ${healthRoutes.split('\n').join(', ')}`);

  if (logging.length === 0) logging.push('NO logging facility found — the plan must say what this feature will emit and where, or it will be unobservable');
  if (debug.length === 0) debug.push('NO debug switch or introspection route found — the plan must add one way to watch this feature work');
  return { logging, debug };
}

export function surveyProject(cwd = process.cwd()): Survey {
  const root = projectRoot(cwd);
  const pkg = readJson(join(root, 'package.json'));
  const scripts = (pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, string>;
  const deps = [
    ...Object.keys((pkg?.dependencies ?? {}) as Record<string, unknown>),
    ...Object.keys((pkg?.devDependencies ?? {}) as Record<string, unknown>),
  ];
  const entryPoints = [
    typeof pkg?.main === 'string' ? String(pkg.main) : '',
    ...Object.values((pkg?.bin ?? {}) as Record<string, string>),
  ].filter(Boolean);

  const { stack, gaps } = webviewSurvey(root, deps, scripts);
  const { logging, debug } = observabilitySurvey(root);
  const testCmds = Object.entries(scripts)
    .filter(([k]) => /^(test|typecheck|lint|check|build)/.test(k))
    .map(([k, v]) => `npm run ${k} → ${v}`);

  return {
    root,
    kind: projectKind(root),
    scripts,
    deps: deps.slice(0, 40),
    entryPoints,
    webviewStack: stack,
    webviewGaps: gaps,
    logging,
    debug,
    testCmds,
  };
}

/** The survey as text for the planner prompt. Facts only. */
export function renderSurvey(s: Survey): string {
  const lines = [
    `Project root: ${s.root}`,
    `Type: ${s.kind}`,
    s.entryPoints.length ? `Entry points: ${s.entryPoints.join(', ')}` : '',
    s.deps.length ? `Dependencies (${s.deps.length}): ${s.deps.join(', ')}` : 'Dependencies: none declared',
    s.testCmds.length ? `Verification commands:\n${s.testCmds.map((c) => `  - ${c}`).join('\n')}` : 'Verification commands: NONE — there is no agreed way to prove a change works',
    '',
    'WEB / UI CAPABILITY:',
    ...(s.webviewStack.length ? s.webviewStack.map((x) => `  + ${x}`) : ['  + none detected']),
    'WEBVIEW GAPS (must be closed before UI work):',
    ...s.webviewGaps.map((x) => `  ! ${x}`),
    '',
    'LOGGING FACILITIES:',
    ...s.logging.map((x) => `  - ${x}`),
    'DEBUG / OBSERVABILITY:',
    ...s.debug.map((x) => `  - ${x}`),
  ];
  return lines.filter((l) => l !== '').join('\n');
}
