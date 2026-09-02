/**
 * ayin-dir.ts — `.ayin/`, where everything ayin writes INTO a repository lives.
 *
 * WHAT IT REPLACES. Plan documents were written to the working directory as
 * `ayin-plan-20260902-114416.md`, one per planned turn, plus one more per phase — so a repo that had
 * been planned in a few times carried a dozen timestamped files at its root, in among its actual
 * source. `ayin watch` did the same with `AYIN-REPORT-SMELLS-<ts>.md`. Both are ayin's working
 * artifacts, not the project's, and neither belongs where the project's own files are.
 *
 *     <repo>/.ayin/plans/ayin-plan-<ts>.md          the plan, and one file per phase
 *     <repo>/.ayin/reports/AYIN-REPORT-<KIND>-<ts>.md   what `ayin watch` produced
 *
 * IT IGNORES ITSELF. `ensureAyinDir` drops a `.gitignore` containing `*` inside `.ayin/`, so the
 * directory and everything under it is invisible to git without touching the operator's own
 * `.gitignore`. That is deliberate and is the opposite of the choice made for `.naamah/`: a design is
 * reviewed, so it belongs in the diff, whereas a plan is one turn's working note and there is a new
 * one every time. Before this, a completed run left the tree dirty with its own plan files — which
 * also meant the scaffold's "nothing uncommitted behind it" was only true until the first plan.
 *
 * `AYIN_PLAN_DIR` still wins where it is set: a harness that wants the plans somewhere specific has
 * said so, and this is a default, not a policy.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';

/** The directory itself. Not created by this call — see `ensureAyinDir`. */
export function ayinDir(root: string): string {
  return join(root, '.ayin');
}

/** Where plan documents and their per-phase files go. */
export function planDir(root: string): string {
  return process.env.AYIN_PLAN_DIR || join(ayinDir(root), 'plans');
}

/** Where `ayin watch` puts a review it produced for this repo. */
export function reportDir(root: string): string {
  return join(ayinDir(root), 'reports');
}

const GITIGNORE = `# ayin's working artifacts for this repository — plan documents, review reports.
#
# Ignored wholesale, and from in here rather than from your .gitignore, so that adopting ayin does not
# require editing a file you own. These are per-run and timestamped: a repo planned in a dozen times
# would otherwise carry a dozen files it never asked for.
#
# The DESIGN is deliberately not here — see .naamah/, which is meant to be reviewed and committed.
*
`;

/**
 * Create `<root>/.ayin/<sub>` and make sure the whole directory is ignored by git.
 *
 * Never throws: a read-only tree is a real condition and not a reason to lose a plan the agent has
 * already spent a model call on. The caller gets the path back either way and will fail on the write
 * if it truly cannot be written, which is the honest place to fail.
 */
export function ensureAyinDir(root: string, sub: 'plans' | 'reports'): string {
  const base = ayinDir(root);
  const dir = join(base, sub);
  try {
    mkdirSync(dir, { recursive: true });
    const ignore = join(base, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE);
  } catch (err) {
    log('WARN', 'ayin_dir_failed', { dir, error: err instanceof Error ? err.message : String(err) });
  }
  return dir;
}
