/**
 * Greenfield plan executor — plan mode for an EMPTY directory that is about to become a project.
 *
 * WHY IT IS SEPARATE FROM `base`. The base executor's survey is the generic Node/web one, and pointed
 * at an empty directory it does not go quiet, it lies with confidence: "no HTTP server or dev server
 * present", "no bundler and no existing HTML", "NO logging facility found — the plan must add one".
 * A planner reading that about `mkdir newthing && cd newthing` writes steps for a project that does
 * not exist yet, while the one thing it actually has to decide — the layout — is never stated. And the
 * base deliverable list is a single README, so the validator in `plan/plan.ts` will happily accept a
 * plan for a new Python project that never mentions `pyproject.toml`.
 *
 * THREE BRANCHES, ONE PER TYPE, because "the folder structure of a typical project" is exactly what
 * differs: `src/<pkg>/__init__.py` and a venv, `src/index.ts` and a tsconfig, `Assets/Scripts` and a
 * package manifest. Each branch names its layout, its manifest, its test convention and how work in it
 * is watched running. The layouts live in `prompts/greenfield/*.txt` — they are content an operator
 * will want to bend to a house style, which is precisely what a prompt file is for.
 *
 * IT DELEGATES WHOLESALE WHEN THE PROJECT ALREADY EXISTS. The registry selects on project TYPE and has
 * no way to say "only when greenfield" — priority is the only lever — so this executor is chosen for
 * every `python` / `node` / `unity` project and hands all five methods straight back to `base` unless
 * `ctx.greenfield` is true. That keeps established projects on exactly the behaviour they had, and
 * keeps the selection rule in `registry.ts` the readable one-liner it is.
 *
 * IT CREATES THE DIRECTORY WHEN THE REQUEST NAMED ONE. People set a project up from one level above
 * it — *"build a Python website in testwebsite-2"*, typed in a folder holding ten other projects — so
 * `ctx.targetDir` carries that folder and everything here is written into it. The deliverable patterns
 * are PREFIXED rather than resolved against it, because every path a plan states is relative to where
 * the agent actually is, and the agent is still standing one level up.
 *
 * `scaffold()` INITIALISES THE GIT REPO. A project's first commit should be able to contain its first
 * file, and after "create a Python CLI" nobody remembers to run `git init` until something is already
 * lost. `projectRoot()` answers `git rev-parse --show-toplevel`, so asking it about the directory we
 * are about to use is what refuses to nest a repository inside one that already exists — whether that
 * directory is the repo root itself or a new folder made inside it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../../log.js';
import { prompts, packagePath } from '../../../prompts-service.js';
import { projectRoot } from '../../../qa/probes.js';
import type { Deliverable, ExecutorConfig, PlanExecutor, ProjectContext, ProjectType } from '../../types.js';
import { basePlanExecutor, ensureReadme } from '../base/index.js';

const greenfieldPrompts = prompts.register('greenfield', packagePath('prompts', 'greenfield')).bundle;

const config: ExecutorConfig = {
  id: 'greenfield', kind: 'plan', projectTypes: ['python', 'node', 'unity'], priority: 100,
  description: 'Empty-project planning — the target folder structure, manifest and test convention for a new Python, TypeScript or Unity project, plus git init.',
};

/** Which set of layout facts this project gets. `node` means TypeScript — the layout says so. */
type Branch = 'python' | 'typescript' | 'unity';

const BRANCH_OF: Partial<Record<ProjectType, Branch>> = {
  python: 'python',
  node: 'typescript',
  unity: 'unity',
};

interface BranchFacts {
  label: string;
  /** One line naming the commands the plan is allowed to assume. */
  toolchain: string;
  layoutPrompt: string;
  observabilityPrompt: string;
  /** What must exist on disk beyond the README the base executor already demands. */
  deliverables: Deliverable[];
}

const FACTS: Record<Branch, BranchFacts> = {
  python: {
    label: 'Python',
    toolchain: 'python3 · python -m venv · pip install -e . · pytest',
    layoutPrompt: 'layoutPython',
    observabilityPrompt: 'observabilityPython',
    deliverables: [
      {
        label: 'the package manifest',
        patterns: ['pyproject.toml'],
        why: 'PEP 621 metadata, dependencies and the entry point — without it the package cannot be installed and `python -m` finds nothing',
        required: true,
      },
      {
        label: 'the package',
        patterns: ['src/*/__init__.py'],
        why: 'the importable package under a src layout, so tests exercise the installed package rather than the working directory',
        required: true,
      },
      {
        label: 'the test',
        patterns: ['tests/test_*.py'],
        why: 'one pytest that imports the package and asserts real behaviour — a project with no test has nothing that proves it still works tomorrow',
        required: true,
      },
      {
        label: 'the ignore file',
        patterns: ['.gitignore'],
        why: '`__pycache__/`, `.venv/`, `dist/`, `*.egg-info/` — the repository is initialised empty, and the first commit is where build output gets in',
        required: true,
      },
    ],
  },

  typescript: {
    label: 'TypeScript',
    toolchain: 'node · npm · npx tsc (typescript as a devDependency, never global) · node --test',
    layoutPrompt: 'layoutTypescript',
    observabilityPrompt: 'observabilityTypescript',
    deliverables: [
      {
        label: 'the package manifest',
        patterns: ['package.json'],
        why: '`"type": "module"`, the entry point and the build / test / start scripts — the file every other tool reads first',
        required: true,
      },
      {
        label: 'the compiler configuration',
        patterns: ['tsconfig.json'],
        why: 'strict mode, rootDir `src`, outDir `dist` — without it `tsc` guesses, and it guesses differently from the plan',
        required: true,
      },
      {
        label: 'the entry point',
        patterns: ['src/index.ts'],
        why: 'the module `package.json` points at — a project whose entry point is missing compiles to nothing runnable',
        required: true,
      },
      {
        label: 'the test',
        patterns: ['test/*.test.ts'],
        why: 'one `node --test` case using node:test and node:assert — no test framework to choose, and something that proves the build still works',
        required: true,
      },
      {
        label: 'the ignore file',
        patterns: ['.gitignore'],
        why: '`node_modules/`, `dist/`, `*.tsbuildinfo` — the repository is initialised empty, and the first commit is where build output gets in',
        required: true,
      },
    ],
  },

  unity: {
    label: 'Unity',
    toolchain: 'the Unity Editor (Unity Hub) · .NET / C# — the editor generates Library/, the .csproj files and every .meta on first open',
    layoutPrompt: 'layoutUnity',
    observabilityPrompt: 'observabilityUnity',
    deliverables: [
      {
        label: 'the first script',
        patterns: ['Assets/Scripts/*.cs'],
        why: 'C# under `Assets/Scripts`, one MonoBehaviour per file with the filename matching the class name — Unity refuses to attach a component whose class it cannot find by filename',
        required: true,
      },
      {
        label: 'the package manifest',
        patterns: ['Packages/manifest.json'],
        why: 'the registry packages the project depends on — Unity rebuilds the package set from this file, and a project without one is not a project the editor will open the same way twice',
        required: true,
      },
      {
        label: 'the editor version',
        patterns: ['ProjectSettings/ProjectVersion.txt'],
        why: '`m_EditorVersion:` pins which Unity opens this — opening a project in the wrong version rewrites its assets irreversibly',
        required: true,
      },
      {
        label: 'the ignore file',
        patterns: ['.gitignore'],
        why: '`Library/`, `Temp/`, `Obj/`, `Build/`, `Logs/`, `UserSettings/` — a Unity repository without one commits gigabytes of regenerable cache on the first commit',
        required: true,
      },
    ],
  },
};

/** Non-hidden entries at the root, so the survey can say plainly that it is starting from nothing. */
function rootEntries(root: string): string[] {
  try {
    return readdirSync(root).filter((e) => !e.startsWith('.')).slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * `git init` when `root` is not already inside a repository. Returns the path it created.
 *
 * The guard is `projectRoot()`, not `existsSync('.git')`: a new folder made inside an existing
 * repository has no `.git` of its own, and initialising one there produces a nested repository whose
 * contents the outer repo silently stops tracking. `git rev-parse --show-toplevel` is the only thing
 * that knows the difference, and it already ships here.
 *
 * Never throws: git may not be installed and the directory may be read-only, and neither is a reason to
 * lose the plan. The failure is logged rather than swallowed — a scaffold step that quietly did nothing
 * is the kind of thing nobody notices until the history they wanted is not there.
 */
export function ensureGitRepo(root: string): string[] {
  const dotGit = join(root, '.git');
  if (existsSync(dotGit)) return [];
  const enclosing = projectRoot(root);
  if (enclosing !== root) {
    log('INFO', 'scaffold_git_init_skipped', { root, enclosing });
    return [];
  }
  try {
    execFileSync('git', ['init'], { cwd: root, timeout: 10_000, stdio: ['ignore', 'ignore', 'ignore'] });
    log('INFO', 'scaffold_git_init', { root });
    return [dotGit];
  } catch (err) {
    log('WARN', 'scaffold_git_init_failed', { root, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** The branch for this context, or null when the project already exists and `base` should serve it. */
function branchFor(ctx: ProjectContext): BranchFacts | null {
  if (!ctx.greenfield) return null;
  const branch = BRANCH_OF[ctx.type];
  return branch ? FACTS[branch] : null;
}

/** Where the files actually go — `root` itself, or the new folder the request named inside it. */
function targetRoot(ctx: ProjectContext): string {
  return ctx.targetDir ? join(ctx.root, ctx.targetDir) : ctx.root;
}

/** A deliverable path as the PLAN must state it: relative to where the agent is, which is `root`. */
function prefixed(ctx: ProjectContext, deliverables: Deliverable[]): Deliverable[] {
  if (!ctx.targetDir) return deliverables;
  return deliverables.map((d) => ({ ...d, patterns: d.patterns.map((p) => `${ctx.targetDir}/${p}`) }));
}

export const greenfieldPlanExecutor: PlanExecutor = {
  config,

  survey(ctx: ProjectContext): string {
    const facts = branchFor(ctx);
    if (!facts) return basePlanExecutor.survey(ctx);
    const dir = targetRoot(ctx);
    const entries = rootEntries(dir);
    return greenfieldPrompts.get('survey', {
      ROOT: dir,
      LABEL: facts.label,
      DETECTED_FROM: ctx.evidence,
      // The one instruction the model cannot derive: the agent's cwd is NOT the project directory, so
      // every path it writes has to carry the prefix. Stated as the paths themselves, not as a rule.
      PATH_RULE: ctx.targetDir
        ? `EVERY path in this plan is relative to ${ctx.root}, where the agent is standing — so the project's own files are \`${ctx.targetDir}/…\`, never bare.`
        : 'Paths in this plan are relative to the project root above, which is where the agent is standing.',
      ROOT_ENTRIES: entries.length ? entries.join(', ') : 'nothing',
      GIT_STATE: existsSync(join(dir, '.git'))
        ? 'a git repository is already initialised here'
        : 'none — ayin runs `git init` at project start',
      README_STATE: existsSync(join(dir, 'README.md'))
        ? 'present'
        : 'MISSING — ayin creates a stub at project start; fill it in',
      TOOLCHAIN: facts.toolchain,
    });
  },

  grounding(ctx: ProjectContext): string {
    const facts = branchFor(ctx);
    if (!facts) return basePlanExecutor.grounding(ctx);
    return greenfieldPrompts.get(facts.layoutPrompt);
  },

  // The base list is spread rather than restated: README is the same deliverable with the same wording
  // for every project type, and a second copy is how the two would eventually disagree.
  deliverables(ctx: ProjectContext): Deliverable[] {
    const facts = branchFor(ctx);
    if (!facts) return basePlanExecutor.deliverables(ctx);
    return prefixed(ctx, [...facts.deliverables, ...basePlanExecutor.deliverables(ctx)]);
  },

  observability(ctx: ProjectContext): string {
    const facts = branchFor(ctx);
    if (!facts) return basePlanExecutor.observability(ctx);
    return greenfieldPrompts.get(facts.observabilityPrompt);
  },

  scaffold(ctx: ProjectContext): string[] {
    if (!branchFor(ctx)) return basePlanExecutor.scaffold(ctx);
    const dir = targetRoot(ctx);
    const made: string[] = [];
    if (ctx.targetDir && !existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
        log('INFO', 'scaffold_project_dir', { dir });
        made.push(dir);
      } catch (err) {
        // Nothing below can work without it, and a plan is still worth writing — so report and stop.
        log('WARN', 'scaffold_project_dir_failed', { dir, error: err instanceof Error ? err.message : String(err) });
        return made;
      }
    }
    // Git next: the README is then the first file the new repository has ever seen.
    return [...made, ...ensureGitRepo(dir), ...ensureReadme(dir)];
  },
};
