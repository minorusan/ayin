/**
 * Executor registry — reads every `config.json` that ships beside an executor and answers, for a
 * given project type, "which handler runs plan / QA / present here".
 *
 * THE SELECTION RULE, in full: among the configs of the requested KIND, keep those whose
 * `projectTypes` contains the detected type or `"*"`, take the highest `priority`, break ties by id.
 * The base executors declare `["*"]` at priority 0, so they serve everything nobody else claims and
 * lose to any specific handler. There is no fallback logic beyond that and no implicit ordering —
 * the answer is always readable straight out of the config files.
 *
 * RECOMPUTED PER CALL. `select()` takes a `ProjectContext` and does a linear scan over a handful of
 * configs. Nothing is memoised against a directory, because the directory changes (see `detect.ts`).
 *
 * CONFIG ON DISK, CODE IN THE IMPORT MAP, AND A LOUD MISMATCH. The configs are the declaration; the
 * `INSTANCES` map below is how the code is reached. Those two can drift — a new executor directory
 * with a config nobody imported would silently never run, which is the exact failure this project's
 * rules call a symptom fix waiting to happen. So `loadRegistry()` cross-checks them and THROWS on any
 * mismatch in either direction. A missing handler is a crash at boot, never a quiet degradation.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { log } from '../log.js';
import type {
  AnyExecutor, ExecutorConfig, ExecutorKind, PlanExecutor, PresentExecutor,
  ProjectContext, ProjectType, QaExecutor,
} from './types.js';
import { PROJECT_TYPES } from './types.js';

import { basePlanExecutor } from './plan/base/index.js';
import { arduinoPlanExecutor } from './plan/arduino/index.js';
import { nodePlanExecutor } from './plan/node/index.js';
import { baseQaExecutor } from './qa/base/index.js';
import { arduinoQaExecutor } from './qa/arduino/index.js';
import { unityQaExecutor } from './qa/unity/index.js';
import { basePresentExecutor } from './present/base/index.js';
import { arduinoPresentExecutor } from './present/arduino/index.js';

/** `<kind>/<id>` → the object that implements it. The only place code and config are joined. */
const INSTANCES: Record<string, AnyExecutor> = {
  'plan/base': basePlanExecutor,
  'plan/arduino': arduinoPlanExecutor,
  'plan/node': nodePlanExecutor,
  'qa/base': baseQaExecutor,
  'qa/arduino': arduinoQaExecutor,
  'qa/unity': unityQaExecutor,
  'present/base': basePresentExecutor,
  'present/arduino': arduinoPresentExecutor,
};

const KINDS: ExecutorKind[] = ['plan', 'qa', 'present'];

/** `dist/executors/` at runtime, `src/executors/` under ts-node — this module's own directory. */
function executorsRoot(): string {
  return fileURLToPath(new URL('.', import.meta.url));
}

interface Entry {
  key: string;
  config: ExecutorConfig;
  executor: AnyExecutor;
}

let cache: Entry[] | null = null;

function parseConfig(path: string, kind: ExecutorKind, id: string): ExecutorConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`executor config ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const o = raw as Partial<ExecutorConfig>;
  // Validated, not coerced. A config with a typo'd project type would silently never match, and the
  // handler would appear to "not work" with nothing in any log to say why — exactly the two-day bug.
  if (o.id !== id) throw new Error(`executor config ${path}: "id" is ${JSON.stringify(o.id)} but the directory is "${id}"`);
  if (o.kind !== kind) throw new Error(`executor config ${path}: "kind" is ${JSON.stringify(o.kind)} but the directory is "${kind}"`);
  if (!Array.isArray(o.projectTypes) || o.projectTypes.length === 0) {
    throw new Error(`executor config ${path}: "projectTypes" must be a non-empty array`);
  }
  for (const t of o.projectTypes) {
    if (t !== '*' && !PROJECT_TYPES.includes(t as ProjectType)) {
      throw new Error(`executor config ${path}: "${t}" is not a known project type (${PROJECT_TYPES.join(', ')}, or "*")`);
    }
  }
  if (typeof o.priority !== 'number' || !Number.isFinite(o.priority)) {
    throw new Error(`executor config ${path}: "priority" must be a number`);
  }
  if (typeof o.description !== 'string' || !o.description.trim()) {
    throw new Error(`executor config ${path}: "description" must be a non-empty string`);
  }
  if (o.factsOnly !== undefined && typeof o.factsOnly !== 'boolean') {
    throw new Error(`executor config ${path}: "factsOnly" must be a boolean when present`);
  }
  // `factsOnly` is carried through, not dropped. The config file is the DECLARATION — the doc at the top
  // of this file says so — and a field the parser silently discards makes the file a lie about behaviour
  // the code takes from the TS literal instead. Both halves must say the same thing.
  return {
    id, kind, projectTypes: o.projectTypes, priority: o.priority, description: o.description,
    ...(o.factsOnly === true ? { factsOnly: true } : {}),
  };
}

/**
 * Scan, validate, cross-check. Runs once per process — the CONFIG FILES are static for a process's
 * lifetime (they ship with the build), unlike the project type, which is not.
 */
export function loadRegistry(): Entry[] {
  if (cache) return cache;
  const root = executorsRoot();
  const found: Entry[] = [];
  const seenKeys = new Set<string>();

  for (const kind of KINDS) {
    const kindDir = join(root, kind);
    if (!existsSync(kindDir)) throw new Error(`executor kind directory missing: ${kindDir}`);
    for (const id of readdirSync(kindDir).sort()) {
      const cfgPath = join(kindDir, id, 'config.json');
      if (!existsSync(cfgPath)) continue;
      const config = parseConfig(cfgPath, kind, id);
      const key = `${kind}/${id}`;
      const executor = INSTANCES[key];
      if (!executor) {
        throw new Error(
          `executor ${key} ships a config.json but nothing imports it — add it to INSTANCES in executors/registry.ts. ` +
          'A declared handler that never runs is worse than a missing one: it looks supported.',
        );
      }
      seenKeys.add(key);
      found.push({ key, config, executor });
    }
  }

  const orphaned = Object.keys(INSTANCES).filter((k) => !seenKeys.has(k));
  if (orphaned.length) {
    throw new Error(
      `executor(s) imported but with no config.json on disk: ${orphaned.join(', ')} — ` +
      'the config is the declaration; without it the handler can never be selected. ' +
      '(If this is a fresh build, `npm run build` copies executor configs into dist as a postbuild step.)',
    );
  }

  log('INFO', 'executors_loaded', { count: String(found.length), ids: found.map((e) => e.key).join(',') });
  cache = found;
  return cache;
}

/** Every config, for `/executors` and diagnostics. */
export function listExecutors(): ExecutorConfig[] {
  return loadRegistry().map((e) => e.config);
}

function select(kind: ExecutorKind, ctx: ProjectContext): Entry {
  const candidates = loadRegistry().filter(
    (e) => e.config.kind === kind && (e.config.projectTypes.includes('*') || e.config.projectTypes.includes(ctx.type)),
  );
  if (candidates.length === 0) {
    // Unreachable while the base executors declare "*", and a hard error rather than a silent
    // no-op if someone ever narrows them: a gate with no handler must not quietly stop gating.
    throw new Error(`no ${kind} executor serves project type "${ctx.type}" — the base executor should declare "*"`);
  }
  candidates.sort((a, b) => b.config.priority - a.config.priority || a.config.id.localeCompare(b.config.id));
  return candidates[0];
}

export function planExecutorFor(ctx: ProjectContext): PlanExecutor {
  return select('plan', ctx).executor as PlanExecutor;
}

export function qaExecutorFor(ctx: ProjectContext): QaExecutor {
  return select('qa', ctx).executor as QaExecutor;
}

export function presentExecutorFor(ctx: ProjectContext): PresentExecutor {
  return select('present', ctx).executor as PresentExecutor;
}
