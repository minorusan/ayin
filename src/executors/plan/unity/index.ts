/**
 * Unity plan executor — planning for a Unity project that ALREADY EXISTS.
 *
 * WHAT IT REPLACES. `plan/greenfield` claims `unity`, but every one of its methods hands straight back
 * to `base` unless `ctx.greenfield` is true — so an established Unity repo was planned with the generic
 * Node/web survey. Measured on a real one: the survey reported "no HTTP server or dev server present",
 * "no bundler and no existing HTML" and "NO logging facility found — the plan must add one" about a
 * C# game, the deliverable list was a single REQUIRED root README, and with nothing grounding it the
 * plan instructed a step to "parse the JSON content of the prefab". A Unity prefab is YAML. The plan
 * was steering the work at a file format that does not exist in the project.
 *
 * THREE THINGS IT CONTRIBUTES, and nothing else:
 *
 *   1. A SURVEY IN UNITY'S TERMS — editor version, whether the Editor holds the lock right now, the
 *      render pipeline, the assembly graph, what has been compiled. All of it read from the tree.
 *   2. GROUNDING, which is the half that pays. YAML not JSON, GUIDs and .meta, filename-matches-class,
 *      serialized field names, asmdef reference rules. These are facts a model answers wrongly from
 *      recall and cannot derive from the survey, and `plan/index.ts` injects grounding even on the
 *      cheap single-feature path — so they reach the model on turns that never write a plan document.
 *   3. OBSERVABILITY that names Debug.Log, the Console and the log files, instead of a logger module
 *      and an env switch that a Unity project does not have.
 *
 * DELIVERABLES ARE NOT REQUIRED HERE, and that is deliberate. `base` demands a root README on pain of
 * failing the gate; on a game repo that is an invented requirement, and `qa/unity` already recorded
 * what it costs (a 56-byte README failing every pass of every turn, whatever the work was). Planning a
 * change inside somebody's existing project has no file that must come into existence.
 *
 * `scaffold()` DOES NOTHING. A Unity project is created by the Unity Hub — the Editor generates
 * Library/, the .csproj files and every .meta on first open — and `git init` in an existing game repo
 * is the worst thing this function could reach for. The greenfield path still owns project creation.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prompts, packagePath } from '../../../prompts-service.js';
import {
  buildAsmdefIndex, isUnityProject, unityHasProjectOpen, unityVersion,
} from '../../../testrun/asmdef.js';
import type { Deliverable, ExecutorConfig, PlanExecutor, ProjectContext, ScaffoldOpts } from '../../types.js';
import { basePlanExecutor } from '../base/index.js';
import { greenfieldPlanExecutor } from '../greenfield/index.js';

const unityPrompts = prompts.register('unity', packagePath('prompts', 'unity')).bundle;

const config: ExecutorConfig = {
  id: 'unity', kind: 'plan', projectTypes: ['unity'], priority: 110,
  description: 'Unity planning for a project that already exists — YAML assets, GUIDs and .meta files, asmdef boundaries, Console/Player.log observability.',
};

/** How many names any one survey line may carry before it stops being read. */
const LIST_CAP = 12;

/**
 * CREATION STAYS WITH `greenfield`, WHICH OWNS IT.
 *
 * This executor outranks it on `unity` so an existing project stops falling through to `base`. A
 * project being CREATED is the case greenfield was written for — the Assets/ProjectSettings layout,
 * the manifest, the .gitignore — and re-answering it here would be two owners for one question.
 */
function bootstrapping(ctx: ProjectContext): boolean {
  return ctx.greenfield || !isUnityProject(ctx.root);
}

/** Registry dependencies that are not Unity's own — what this project pulled in deliberately. */
function thirdPartyPackages(root: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'Packages', 'manifest.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(manifest.dependencies ?? {}).filter((d) => !d.startsWith('com.unity.'));
  } catch {
    return [];
  }
}

/** Which render pipeline is installed — it decides what a shader or a material change even means. */
function renderPipeline(root: string): string {
  try {
    const deps = Object.keys(
      (JSON.parse(readFileSync(join(root, 'Packages', 'manifest.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      }).dependencies ?? {},
    );
    if (deps.includes('com.unity.render-pipelines.high-definition')) return 'HDRP';
    if (deps.includes('com.unity.render-pipelines.universal')) return 'URP';
    return 'built-in';
  } catch {
    return 'unknown — Packages/manifest.json is unreadable';
  }
}

/** Top-level folders under Assets/, which is how a Unity repo states its own organisation. */
function assetDirs(root: string): string[] {
  try {
    return readdirSync(join(root, 'Assets'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** `a, b, c … and 9 more` — a survey line is read only while it is short. */
function capped(items: string[], empty: string): string {
  if (items.length === 0) return empty;
  const head = items.slice(0, LIST_CAP).join(', ');
  return items.length > LIST_CAP ? `${head} … and ${items.length - LIST_CAP} more` : head;
}

/** The test assemblies by name — where a Unity project's checks actually live. */
function testAssemblies(root: string): string[] {
  try {
    return buildAsmdefIndex(root).all.filter((a) => a.isTest).map((a) => a.name).sort();
  } catch {
    return [];
  }
}

export const unityPlanExecutor: PlanExecutor = {
  config,

  survey(ctx: ProjectContext): string {
    if (bootstrapping(ctx)) return greenfieldPlanExecutor.survey(ctx);
    const root = ctx.root;
    let asmdefs = 0;
    let tests: string[] = [];
    try {
      const index = buildAsmdefIndex(root);
      asmdefs = index.all.length;
      tests = index.all.filter((a) => a.isTest).map((a) => a.name).sort();
    } catch { /* an unreadable tree still deserves the rest of the survey */ }
    const open = unityHasProjectOpen(root);
    const compiled = existsSync(join(root, 'Library', 'ScriptAssemblies'));
    return unityPrompts.get('planSurvey', {
      ROOT: root,
      DETECTED_FROM: ctx.evidence,
      VERSION: unityVersion(root) ?? 'unreadable — ProjectSettings/ProjectVersion.txt is missing',
      // The lock decides which compile check is even available, so it is a planning fact rather than
      // a curiosity: batch mode cannot take a lock the Editor is holding.
      EDITOR_STATE: open
        ? 'OPEN — it holds the project lock, so batch-mode compiling is unavailable; read what it has already written'
        : 'closed — batch mode can take the lock',
      PIPELINE: renderPipeline(root),
      ASMDEF_COUNT: String(asmdefs),
      TEST_ASMS: capped(tests, 'none'),
      COMPILED_STATE: compiled
        ? 'Library/ScriptAssemblies exists — the Editor has compiled this project at least once'
        : 'Library/ScriptAssemblies is absent — nothing has been compiled here yet',
      ASSET_DIRS: capped(assetDirs(root), 'Assets/ is empty or unreadable'),
      PACKAGES: capped(thirdPartyPackages(root), 'none beyond Unity\'s own'),
      ADDRESSABLES: existsSync(join(root, 'Assets', 'AddressableAssetsData'))
        ? 'in use — Assets/AddressableAssetsData is present'
        : 'not in use',
    });
  },

  /**
   * The facts, and they are the reason this executor exists.
   *
   * Not retrieved against the request, unlike the Arduino catalog: this is ~1.5k characters of rules
   * that apply to every Unity change there is, where the catalog was 10k of components of which four
   * mattered. There is nothing here to filter — the Addressables paragraph is the one conditional
   * part, and it is conditional on the PROJECT, not on the wording of the request.
   */
  grounding(ctx: ProjectContext): string {
    if (bootstrapping(ctx)) return greenfieldPlanExecutor.grounding(ctx);
    return unityPrompts.get('planGrounding', {
      ADDRESSABLES_NOTE: existsSync(join(ctx.root, 'Assets', 'AddressableAssetsData'))
        ? unityPrompts.get('planAddressables')
        : '',
    });
  },

  /**
   * NOTHING IS REQUIRED. See the header: a change inside an existing game repo owes no new file, and
   * `base`'s required README is an invented requirement that `qa/unity` already measured the cost of.
   * README stays on the list as OPTIONAL so a plan that should update it still sees it named.
   */
  deliverables(ctx: ProjectContext): Deliverable[] {
    if (bootstrapping(ctx)) return greenfieldPlanExecutor.deliverables(ctx);
    return basePlanExecutor.deliverables(ctx).map((d) => ({ ...d, required: false }));
  },

  observability(ctx: ProjectContext): string {
    if (bootstrapping(ctx)) return greenfieldPlanExecutor.observability(ctx);
    return unityPrompts.get('planObservability', {
      TEST_ASMS: capped(testAssemblies(ctx.root), 'none — this project has no test assembly'),
    });
  },

  /**
   * Nothing. The Hub creates a Unity project and the Editor generates the rest; there is no file this
   * can write that the project does not already have or that the Editor would not overwrite.
   * Bootstrapping is greenfield's, including its `git init`.
   */
  scaffold(ctx: ProjectContext, opts?: ScaffoldOpts): string[] {
    return bootstrapping(ctx) ? greenfieldPlanExecutor.scaffold(ctx, opts) : [];
  },
};
