/**
 * Base plan executor — plan mode's behaviour for every project type nobody else claims.
 *
 * This is deliberately the OLD behaviour, moved rather than rewritten: the generic Node/web survey
 * (`plan/survey.ts`), no extra grounding, and observability phrased in terms of logger modules and
 * env switches. Anything that changed here would change planning for every project in the world that
 * is not Arduino, which is not what this refactor is for.
 *
 * The one addition is `scaffold`: a project with no README gets one, deterministically, before the
 * plan is written. "The project carries a README" has been a standing QA criterion for a long time
 * (`prompts/qa/baselineCodeReadme.txt`) and it was being enforced the expensive way — the agent
 * finishes, the judge notices the missing file, a whole fix pass is spent creating four lines of
 * markdown. A file that must exist is a `writeFileSync`, not a criterion for a model to remember.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { log } from '../../../log.js';
import { renderSurvey, surveyProject } from '../../../plan/survey.js';
import { prompts, packagePath } from '../../../prompts-service.js';
import { README_STUB_BANNER } from '../../deliverables.js';
import type { Deliverable, ExecutorConfig, PlanExecutor, ProjectContext } from '../../types.js';
import { commitScaffold, ensureGitRepo, isEmptyProjectDir } from '../git.js';

/** The `plan` namespace, shared with plan mode itself — same directory, materialized once. */
const basePlanPrompts = prompts.register('plan', packagePath('prompts', 'plan')).bundle;

const config: ExecutorConfig = {
  id: 'base', kind: 'plan', projectTypes: ['*'], priority: 0,
  description: 'Generic project planning — the Node/web-shaped survey, no domain grounding.',
};

/**
 * The stub is intentionally thin. It exists so the file is THERE (and so the agent has an obvious
 * place to write into), not to pretend the project is documented — a fabricated README describing
 * features nobody built would be worse than none. The headings name what has to be filled in.
 *
 * EVERY SECTION BODY IS A TODO MARKER, and that is deliberate. An empty stub is in one respect WORSE
 * than no README at all: it satisfies "the project has a README" for anything that only checks
 * existence, while containing nothing. Measured on the Arduino benchmark — on the grounding-only path
 * (no plan document to say "fill in the README"), the stub shipped untouched. So the stub announces
 * its own incompleteness in a form both a reader and a checker can see, and the deliverable list that
 * reaches the model says plainly that a stub counts as MISSING.
 *
 * THE BANNER CARRIES NO `TODO` OF ITS OWN, and that is the fix for a measured own-goal. It used to open
 * `> **TODO — this README is an empty stub…**`, which is an INSTRUCTION to the agent rather than part
 * of the document — so a model that filled in every section and left the instruction alone was doing
 * exactly what it was told, and shipped 570 characters of real documentation whose first line said it
 * documented nothing. `readmeSubstance` counted that one word and failed the gate. The banner now says
 * to delete itself, contains no marker word, and is checked by `README_STUB_BANNER` instead — so a
 * leftover banner is still caught, and a filled-in README is not.
 */
export function readmeStub(projectName: string): string {
  return [
    `# ${projectName}`,
    '',
    `> **This README is ${README_STUB_BANNER}.** Fill in THIS file, at the project root; do not`,
    '> write a second README somewhere else and leave this one as-is. A stub is worse than no README:',
    '> it looks like documentation and says nothing. DELETE THIS BLOCK once you have filled the file in.',
    '',
    '## What this is',
    '',
    'TODO',
    '',
    '## How to run it',
    '',
    'TODO',
    '',
    '## How to verify it works',
    '',
    'TODO',
    '',
  ].join('\n');
}

/**
 * Create README.md when the project root has none. Never overwrites — an existing README is the
 * operator's, exactly as a materialized prompt is (see `prompts-service.ts`). Returns what it made.
 */
export function ensureReadme(root: string): string[] {
  const path = join(root, 'README.md');
  if (existsSync(path)) return [];
  try {
    writeFileSync(path, readmeStub(basename(root) || 'Project'));
    log('INFO', 'scaffold_readme', { path });
    return [path];
  } catch (err) {
    // A read-only or missing directory is a real condition to report, not to swallow — but it must
    // not take the plan down with it, since the plan is still worth writing without a README.
    log('WARN', 'scaffold_readme_failed', { path, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export const basePlanExecutor: PlanExecutor = {
  config,

  survey(ctx: ProjectContext): string {
    return renderSurvey(surveyProject(ctx.root));
  },

  grounding(): string {
    return '';
  },

  deliverables(): Deliverable[] {
    return [{
      label: 'README',
      patterns: ['README.md'],
      why: 'a project nobody can start is not finished — entry points, how to run it, how to check it works',
      required: true,
    }];
  },

  observability(ctx: ProjectContext): string {
    const s = surveyProject(ctx.root);
    return basePlanPrompts.get('baseObservability', {
      FACILITIES: s.logging.join(' · '),
      DEBUG: s.debug.join(' · '),
    });
  },

  /**
   * EVERY new project is a repository whose first commit holds its first files — not only the three
   * types `greenfield` serves.
   *
   * `git init` lived in the greenfield executor, so a project of any other type (and `base` serves
   * `*`) was scaffolded into a plain directory: no repo, nothing to diff the agent's work against, and
   * nothing to revert to. Moved to `../git.ts` because base cannot import greenfield — greenfield
   * imports base.
   *
   * ONLY ON GREENFIELD. `base` is also selected for every established project of an unclaimed type,
   * and running `git init` in somebody's existing tree — or committing their staged work under our
   * message — is the worst thing in this function's reach. `ctx.greenfield` is false the moment the
   * directory holds a project, and `git.ts` refuses again on its own terms: an enclosing repository,
   * or any repository that already has history.
   */
  scaffold(ctx: ProjectContext): string[] {
    // EMPTY, not merely `greenfield`. `ctx.greenfield` also requires the REQUEST to have named a known
    // type, so "make me a brand new haskell thing here" in an empty folder detects as `unknown`, lands
    // on this executor, and used to get no repository at all. Emptiness is the honest question here and
    // also the safe one — see `isEmptyProjectDir`.
    if (!ctx.greenfield && !isEmptyProjectDir(ctx.root)) return ensureReadme(ctx.root);
    const made = [...ensureGitRepo(ctx.root), ...ensureReadme(ctx.root)];
    return [...made, ...commitScaffold(ctx.root, ctx.type === 'unknown' ? 'new' : ctx.type)];
  },
};
