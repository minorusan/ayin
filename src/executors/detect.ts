/**
 * Project-type detection — deterministic, cheap, and RECOMPUTED ON EVERY CALL.
 *
 * No cache, deliberately. A session is not pinned to one directory: the operator `cd`s from an
 * Arduino sketch into a Unity project and keeps talking to the same agent. A type decided once at
 * boot would then apply Arduino deliverables and an Arduino component catalog to a C# project, and
 * nothing in the output would say so — the gates would simply be quietly wrong for the rest of the
 * session. Detection is a few `existsSync` calls plus one bounded directory walk; running it per gate
 * invocation costs nothing measurable and removes the entire class of staleness.
 *
 * TWO SOURCES, IN STRICT ORDER:
 *
 *   1. THE TREE — files on disk. Always wins when it says anything at all.
 *   2. THE REQUEST — only consulted when the tree is silent (no project marker of any kind), which
 *      is precisely the greenfield case: an empty directory and "create an Arduino project that…".
 *
 * That second source is the fix for a real, reproduced hole. Every Arduino behaviour in this codebase
 * hangs off `isArduinoProject(root)`, which requires an `.ino` to already exist. On the one turn
 * where component grounding matters most — the turn that CREATES the sketch — no `.ino` exists yet,
 * so the planner was handed "(not an Arduino project — omit the Arduino reference section)" and wrote
 * pinouts from memory. The request said "arduino" in its first sentence.
 *
 * The request is never allowed to OVERRIDE the tree, only to speak when the tree has nothing to say.
 * A stray "arduino" in a prompt typed inside a Flutter repo must not switch the gates over.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';
import { projectRoot } from '../qa/probes.js';
import type { ProjectContext, ProjectType } from './types.js';

const SKIP_DIR_RE = /^(node_modules|\.git|dist|build|out|\.pio|\.vscode|\.build|Library|Temp|target|__pycache__|\.venv)$/;

/** Find the first file matching `re`, bounded in depth and breadth. Returns a relative-ish label. */
function findFile(root: string, re: RegExp, maxDepth = 4): string | null {
  const walk = (dir: string, depth: number, prefix: string): string | null => {
    if (depth > maxDepth) return null;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return null; }
    const dirs: Array<[string, string]> = [];
    for (const entry of entries) {
      if (SKIP_DIR_RE.test(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { dirs.push([full, prefix ? `${prefix}/${entry}` : entry]); continue; }
      if (re.test(entry)) return prefix ? `${prefix}/${entry}` : entry;
    }
    // Breadth first: a marker at the root is a better answer than one four levels down.
    for (const [full, label] of dirs) {
      const hit = walk(full, depth + 1, label);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 0, '');
}

/**
 * Root-level markers only — "is THIS directory a project", never "does it contain one". No walk.
 *
 * Separate from `fromTree` because the two questions have different answers and only one of them is
 * safe to ask about somebody else's directory.
 */
function hasShallowMarker(dir: string): boolean {
  const has = (p: string) => existsSync(join(dir, p));
  return has('platformio.ini') || has('sketch.yaml') || (has('Assets') && has('ProjectSettings'))
    || has('pubspec.yaml') || has('Cargo.toml') || has('go.mod') || has('package.json')
    || has('pyproject.toml') || has('requirements.txt');
}

/** Two is a pattern. One project beside a `docs/` folder is a project with a docs folder. */
const CONTAINER_MIN_PROJECTS = 2;

/**
 * A DIRECTORY THAT HOLDS PROJECTS IS NOT ITSELF A PROJECT, and asking the tree what type it is
 * produces an answer that is not merely useless but confidently wrong.
 *
 * Measured, from a real session: `~/…/Projects` holds ten unrelated things. The `.ino` search below
 * walks four levels, found a sibling's `Arduino/2/Janitor/Janitor.ino`, and declared the container an
 * Arduino project — so *"build a Python website in testwebsite-2"* was planned with the Arduino
 * executor, the component catalog and the sketch-naming rule. The evidence line said which file
 * decided it, which is the only reason this took minutes to find rather than an afternoon.
 *
 * The test is deliberately about the CHILDREN and never about depth: a monorepo whose root carries its
 * own `package.json` answers on the line below before this is ever consulted, and a container by
 * definition has no marker of its own. Cheap — one `readdirSync` plus a handful of `existsSync`.
 */
export function isProjectContainer(root: string): boolean {
  if (hasShallowMarker(root)) return false;
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return false;
  }
  let found = 0;
  for (const entry of entries) {
    if (SKIP_DIR_RE.test(entry) || entry.startsWith('.')) continue;
    if (hasShallowMarker(join(root, entry)) && ++found >= CONTAINER_MIN_PROJECTS) return true;
  }
  return false;
}

/**
 * What the FILES say. Ordered most-specific first: an Arduino sketch inside a repo that also has a
 * `package.json` (a tooling repo shipping an example sketch) is still, for the directory the operator
 * is standing in, an Arduino project — and the Arduino gates are the ones that produce useful output
 * there.
 */
function fromTree(root: string): { type: ProjectType; evidence: string } | null {
  // Before anything else, because a container's contents can only mislead about the container.
  if (isProjectContainer(root)) return null;

  const has = (p: string) => existsSync(join(root, p));

  if (has('platformio.ini')) return { type: 'arduino', evidence: 'platformio.ini' };
  if (has('sketch.yaml')) return { type: 'arduino', evidence: 'sketch.yaml' };
  const sketch = findFile(root, /\.(ino|pde)$/i);
  if (sketch) return { type: 'arduino', evidence: sketch };

  if (has('Assets') && has('ProjectSettings')) return { type: 'unity', evidence: 'Assets/ + ProjectSettings/' };
  if (has('pubspec.yaml')) return { type: 'flutter', evidence: 'pubspec.yaml' };
  if (has('Cargo.toml')) return { type: 'rust', evidence: 'Cargo.toml' };
  if (has('go.mod')) return { type: 'go', evidence: 'go.mod' };
  if (has('package.json')) return { type: 'node', evidence: 'package.json' };
  if (has('pyproject.toml')) return { type: 'python', evidence: 'pyproject.toml' };
  if (has('requirements.txt')) return { type: 'python', evidence: 'requirements.txt' };
  const sln = findFile(root, /\.(sln|csproj)$/i, 2);
  if (sln) return { type: 'dotnet', evidence: sln };

  return null;
}

/**
 * What the REQUEST says — consulted only when the tree is silent.
 *
 * Deliberately narrow. Each pattern names something that is not plausibly about anything else: a
 * board, a sketch extension, an Arduino core API call. "LED" alone is not enough (a web project has
 * LED indicators too); "LED" beside a pin/resistor/breadboard word is.
 *
 * ORDER IS THE TIE-BREAK, most specific first. `python` and `node` sit last because their vocabulary is
 * the broadest — "a Python script that flashes the Arduino" is an Arduino request, and the arduino
 * patterns above claim it first.
 *
 * `python`, `node` and `unity` are here so an EMPTY directory plus "set up a Python CLI" reaches the
 * greenfield plan executor (`executors/plan/greenfield/`) instead of the generic Node/web survey, which
 * on an empty directory reports missing bundlers and missing HTTP servers and steers the plan into work
 * the project does not have. Without a match the type is `unknown`, `greenfield` stays false, and plan
 * mode then spends two full `explore` loops discovering that an empty directory is empty.
 */
const REQUEST_PATTERNS: Array<[ProjectType, RegExp]> = [
  ['arduino', /\barduino\b|\.ino\b|\bplatformio\b|\bbreadboard\b|\bpinMode\b|\bdigitalWrite\b|\banalogWrite\b|\barduino[- ]?(uno|nano|mega)\b|\b(uno|nano)\s+r[34]\b/i],
  ['arduino', /\b(led|servo|buzzer|potentiometer|photoresistor)\b[\s\S]{0,80}\b(pin|resistor|breadboard|circuit|wire|wiring|anode|cathode|gpio)\b/i],
  ['arduino', /\b(pin|gpio)\b[\s\S]{0,80}\b(led|servo|buzzer|button|switch|sensor)\b[\s\S]{0,80}\b(resistor|breadboard|circuit|wiring|solder)\b/i],
  ['unity', /\bunity\b[\s\S]{0,40}\b(scene|prefab|monobehaviour|gameobject|project|game|editor|urp|hdrp)\b|\b(project|game|app|prototype)\b[\s\S]{0,40}\bunity\b|\bmonobehaviour\b|\bprefab\b/i],
  ['flutter', /\bflutter\b|\bdart\b[\s\S]{0,40}\bwidget\b|\bpubspec\b/i],
  ['python', /\bpython\b|\bpyproject\b|\bpytest\b|\bdjango\b|\bflask\b|\bfastapi\b|\.py\b/i],
  ['node', /\btypescript\b|\bnode\.?js\b|\bnpm\b|\bpnpm\b|\byarn\b|\bvite\b|\bexpress\b|\breact\b|\bts\b[\s\S]{0,20}\b(project|app|cli|package|library|service)\b|\.tsx?\b/i],
];

function fromRequest(request: string): { type: ProjectType; evidence: string } | null {
  for (const [type, re] of REQUEST_PATTERNS) {
    if (re.test(request)) return { type, evidence: 'the request (no project files on disk yet)' };
  }
  return null;
}

/** True when the directory holds nothing that looks like a project of any kind. */
function isEmptyOfProjects(root: string): boolean {
  return fromTree(root) === null;
}

/**
 * Entries that do not make a directory USED: what ayin itself writes at project start, plus OS noise.
 * Listed so that re-running plan mode in a folder it already scaffolded still sees an empty project.
 */
const SCAFFOLD_ENTRY_RE = /^(\.git|\.DS_Store|README\.md|ayin-plan-.*\.md)$/;

/** Nothing in it but what ayin put there. */
export function isFreshDirectory(dir: string): boolean {
  try {
    return readdirSync(dir).every((e) => SCAFFOLD_ENTRY_RE.test(e));
  } catch {
    return false;
  }
}

/**
 * The directory named in the request, validated — or `''`, which refuses it.
 *
 * ONE PATH SEGMENT AND NOTHING ELSE. This name is derived from prose by a model (plan mode's triage
 * call), so it reaches here as untrusted text and then decides where a `git init` and a `mkdir`
 * happen. `..`, an absolute path and a nested path are all refused rather than sanitised, because a
 * name this function cannot vouch for is one the caller is better off not having.
 *
 * An existing directory is accepted only when it is FRESH. A name that already points at somebody's
 * work is not a new project to create, and scaffolding into it would be writing into a project ayin
 * was never asked to touch.
 */
export function resolveTargetDir(root: string, name: string): string {
  const clean = name.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(clean)) return '';
  const full = join(root, clean);
  try {
    const st = statSync(full);
    if (!st.isDirectory() || !isFreshDirectory(full)) return '';
  } catch { /* it does not exist yet — the normal case, and the point */ }
  return clean;
}

/**
 * The one entry point. `request` is the user's own text for this turn — pass it whenever it is
 * available (plan mode has it; the QA gate does not, and does not need it: by the time QA runs, the
 * files the turn created are on disk and the tree answers).
 *
 * `targetDir` is a NEW project folder the request named, from plan mode's triage call. When it
 * resolves, it wins outright: a request that says where to create the project has said something the
 * tree cannot contradict, and the directory the operator happens to be standing in — a folder holding
 * ten other projects, most often — is not evidence about a project that does not exist yet.
 */
export function detectProject(cwd = process.cwd(), request = '', targetDir = ''): ProjectContext {
  const root = projectRoot(cwd);
  const target = resolveTargetDir(root, targetDir);

  if (target) {
    // Only with a KNOWN type: `unknown` has no executor that would use the target, so claiming a
    // greenfield project there would be a half-state nothing acts on. Say nothing instead.
    const asked = fromRequest(request);
    if (asked) {
      return { root, targetDir: target, type: asked.type, evidence: `the request — creating ${target}/`, greenfield: true };
    }
    log('INFO', 'detect_target_unused', { target, reason: 'the request does not say what kind of project' });
  }

  const tree = fromTree(root);
  if (tree) return { root, targetDir: '', type: tree.type, evidence: tree.evidence, greenfield: false };

  // A CONTAINER IS NEVER GREENFIELD WITHOUT A FOLDER TO CREATE THE PROJECT IN. It has no marker of its
  // own, so it looks empty of projects to the line below — and treating it as a new project would run
  // `git init` and drop a README across somebody's whole projects directory. With a target it is
  // already handled above; without one, the honest answer is that this is not a project.
  if (isProjectContainer(root)) {
    return { root, targetDir: '', type: 'unknown', evidence: 'a directory that holds several projects, not a project itself', greenfield: false };
  }

  if (request.trim() && isEmptyOfProjects(root)) {
    const asked = fromRequest(request);
    if (asked) return { root, targetDir: '', type: asked.type, evidence: asked.evidence, greenfield: true };
  }

  return { root, targetDir: '', type: 'unknown', evidence: 'no project marker found', greenfield: false };
}

/** One line for a log field or a plan header. */
export function describeProject(ctx: ProjectContext): string {
  const where = ctx.targetDir ? ` into ${ctx.targetDir}/` : '';
  return `${ctx.type}${ctx.greenfield ? ' (greenfield)' : ''}${where} — ${ctx.evidence}`;
}
