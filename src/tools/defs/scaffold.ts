import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BaseTool } from '../base.js';
import { resolveAgainstCwd } from '../lib.js';
import { toolLlm, toolLog } from '../runtime.js';
import { detectProject } from '../../executors/detect.js';
import { planExecutorFor } from '../../executors/registry.js';
import { repoState } from '../../executors/plan/git.js';
import type { ProjectContext, ProjectType } from '../../executors/types.js';

/**
 * `scaffold` — turn an empty directory into a project. ~35 milliseconds, and one model call at most.
 *
 * WHY IT IS A TOOL. Scaffolding was a hook inside plan mode, so the only door to it was a planning
 * pass. Measured on a real "set up an empty typescript web ui project": the scaffold itself took
 * **35ms** and the turn took **8m51s** — 30s of triage, 121s writing a plan whose single phase was
 * "verify the project", 239s of a subagent running `npm install`/`tsc`/`npm test` through model
 * round-trips, and 106s of QA. Six minutes of a model confirming what is deterministic by
 * construction.
 *
 * EXACTLY ONE THING HERE IS AGENTIC, AND IT IS THE ONLY THING THAT COULD BE: deciding which KIND of
 * project the request describes. Everything after that is a file table
 * (`executors/plan/greenfield/files.ts`) — a manifest, a layout, an entry point that runs, a test that
 * passes, a .gitignore, a README, the `.naamah/` design directory, `git init` and a first commit —
 * written identically every time, with no model anywhere near it.
 *
 * And even the type is asked of a model only as a LAST resort: an explicit `type` wins, then the
 * detector's regexes over the request and the directory, and only a genuine `unknown` costs one short
 * call. A tool that always spent a model call to answer a question a regex already answered would be
 * the same mistake one level down.
 *
 * IT NEVER SCAFFOLDS OVER SOMEBODY'S WORK. The refusal is explicit rather than left to the
 * write-if-missing guards underneath, because "I created a project" about a directory that already
 * held one is a lie the caller acts on.
 */
class Scaffold extends BaseTool {
  readonly name = 'scaffold';
  readonly icon = '🏗️';
  readonly description =
    'Create a new project in an EMPTY directory: the manifest, the layout, an entry point that runs, a '
    + 'test that passes, a .gitignore, a README and the .naamah design directory — then `git init` and '
    + 'an initial commit. Deterministic and instant; no model writes any of it. Pass `type` as python, '
    + 'node (TypeScript) or unity, or leave it out and it is worked out from `about` and the directory. '
    + 'Refuses a directory that already holds a project. Use this instead of planning steps that create '
    + 'a manifest, a tsconfig or an entry point by hand.';

  readonly parameters = [
    { name: 'dir', type: 'string', description: 'The directory to make into a project. Defaults to the current one.', required: false },
    { name: 'type', type: 'string', description: 'python | node | unity. Omit to work it out.', required: false },
    { name: 'about', type: 'string', description: 'What the project is for, in the requester\'s own words. Used to decide the type when `type` is omitted.', required: false },
  ];

  /** `prompts/scaffold/` beside the build — the one prompt this tool has, for the one model call. */
  readonly promptsSourceDir = fileURLToPath(new URL('../../../prompts/scaffold', import.meta.url));

  async execute(params: Record<string, string>, ctx?: { onStatus(note: string): void }): Promise<string> {
    const dir = params.dir ? resolveAgainstCwd(String(params.dir)) : process.cwd();
    if (!existsSync(dir)) return `Error: ${dir} does not exist. Create the directory first, or pass one that does.`;

    const about = String(params.about ?? '').trim();
    const asked = String(params.type ?? '').trim().toLowerCase();
    if (asked && !KNOWN.includes(asked as ProjectType)) {
      return `Error: type "${asked}" is not one of ${KNOWN.join(', ')}. Omit it to have it worked out.`;
    }

    // Detection reads the directory AND the request, which is what makes it work on the one turn that
    // creates the project — there is nothing on disk to read yet.
    const detected = detectProject(dir, about);
    let type: ProjectType = asked ? (asked as ProjectType) : detected.type;
    let how = asked ? 'you said so' : detected.evidence;

    // THE ONE MODEL CALL, and only when nothing cheaper answered.
    if (!asked && !KNOWN.includes(type)) {
      if (!about) {
        return 'Refused: nothing says what kind of project this should be. Pass `type` (python, node, '
          + 'unity) or `about` describing what it is for. Guessing would produce the wrong project, '
          + 'silently.';
      }
      ctx?.onStatus('deciding the project type');
      const answer = (await toolLlm().ask([{ role: 'user', content: this.prompt('classify', { REQUEST: about.slice(0, 2000) }) }]))
        .trim().toLowerCase();
      const picked = KNOWN.find((k) => answer.includes(k));
      if (!picked) {
        return `Refused: "${about}" does not describe a python, node or unity project (the classifier `
          + `answered "${answer.slice(0, 60)}"). Pass \`type\` explicitly if it is one of those.`;
      }
      type = picked;
      how = 'worked out from what you asked for';
    }

    const project: ProjectContext = {
      ...detected,
      type,
      evidence: how,
      greenfield: detected.greenfield || isEmptyDir(dir),
    };

    if (!project.greenfield) {
      return `Refused: ${dir} already holds a project. Scaffolding is for an empty directory — anything `
        + 'else would be writing into somebody\'s work. Nothing was created.';
    }

    ctx?.onStatus(`scaffolding a ${type} project in ${dir}`);
    const started = Date.now();
    const made = planExecutorFor(project).scaffold(project);
    const ms = Date.now() - started;

    if (!made.length) return `Nothing to do: ${dir} already has everything a ${type} scaffold would create.`;

    const repo = repoState(dir);
    const committed = repo.own && repo.commits > 0 ? `, committed ${repo.head}` : '';
    const rel = made.map((p) => (p.startsWith(dir) ? p.slice(dir.length + 1) || '.' : p));
    ctx?.onStatus(`${made.length} path(s) in ${ms}ms${committed}`);
    toolLog().info('scaffold_tool', { dir, type, files: String(made.length), ms: String(ms), how });

    return [
      `Created a ${type} project in ${dir} — ${made.length} path(s) in ${ms}ms${committed}. Type: ${how}.`,
      '',
      rel.map((p) => `  ${p}`).join('\n'),
      '',
      NEXT[type] ?? 'The project is ready.',
      '',
      'None of this was written by a model, and it is identical every time. Do NOT re-create these '
      + 'files, and do not plan steps that produce them — they exist, and they already work. Build on '
      + 'top of them.',
    ].join('\n');
  }
}

const KNOWN: ProjectType[] = ['python', 'node', 'unity'];

/** What comes next, per type — stated so neither the agent nor the operator has to re-derive it. */
const NEXT: Partial<Record<ProjectType, string>> = {
  node: 'Verify it with: npm install && npm test && npm run build. `npm run dev` serves the page on :3000.',
  python: 'Verify it with: python -m unittest discover -s tests — it passes with nothing installed.',
  unity: 'Open the folder in Unity Hub. Point ProjectSettings/ProjectVersion.txt at the editor you have first.',
};

/** Nothing but a repository, if that. Mirrors `executors/plan/git.ts#isEmptyProjectDir`. */
function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).filter((e) => e !== '.git').length === 0;
  } catch {
    return false;
  }
}

export const tool = new Scaffold();
