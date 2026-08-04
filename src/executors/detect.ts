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
 * What the FILES say. Ordered most-specific first: an Arduino sketch inside a repo that also has a
 * `package.json` (a tooling repo shipping an example sketch) is still, for the directory the operator
 * is standing in, an Arduino project — and the Arduino gates are the ones that produce useful output
 * there.
 */
function fromTree(root: string): { type: ProjectType; evidence: string } | null {
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
 */
const REQUEST_PATTERNS: Array<[ProjectType, RegExp]> = [
  ['arduino', /\barduino\b|\.ino\b|\bplatformio\b|\bbreadboard\b|\bpinMode\b|\bdigitalWrite\b|\banalogWrite\b|\barduino[- ]?(uno|nano|mega)\b|\b(uno|nano)\s+r[34]\b/i],
  ['arduino', /\b(led|servo|buzzer|potentiometer|photoresistor)\b[\s\S]{0,80}\b(pin|resistor|breadboard|circuit|wire|wiring|anode|cathode|gpio)\b/i],
  ['arduino', /\b(pin|gpio)\b[\s\S]{0,80}\b(led|servo|buzzer|button|switch|sensor)\b[\s\S]{0,80}\b(resistor|breadboard|circuit|wiring|solder)\b/i],
  ['unity', /\bunity\b[\s\S]{0,40}\b(scene|prefab|monobehaviour|gameobject)\b|\bmonobehaviour\b|\bprefab\b/i],
  ['flutter', /\bflutter\b|\bdart\b[\s\S]{0,40}\bwidget\b|\bpubspec\b/i],
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
 * The one entry point. `request` is the user's own text for this turn — pass it whenever it is
 * available (plan mode has it; the QA gate does not, and does not need it: by the time QA runs, the
 * files the turn created are on disk and the tree answers).
 */
export function detectProject(cwd = process.cwd(), request = ''): ProjectContext {
  const root = projectRoot(cwd);

  const tree = fromTree(root);
  if (tree) return { root, type: tree.type, evidence: tree.evidence, greenfield: false };

  if (request.trim() && isEmptyOfProjects(root)) {
    const asked = fromRequest(request);
    if (asked) return { root, type: asked.type, evidence: asked.evidence, greenfield: true };
  }

  return { root, type: 'unknown', evidence: 'no project marker found', greenfield: false };
}

/** One line for a log field or a plan header. */
export function describeProject(ctx: ProjectContext): string {
  return `${ctx.type}${ctx.greenfield ? ' (greenfield)' : ''} — ${ctx.evidence}`;
}
