/**
 * presenter/handoff.ts — what a presentation does to the WORKING TREE, not just to the reply.
 *
 * `/present` means "show me the work". Showing it as prose and leaving the operator to stage it by hand is
 * half the job: the next thing they do, every time, is look at what changed and decide what goes in the
 * commit. So a presented turn stages per this project's policy and opens the changed files in the editor.
 *
 * THE POLICY IS NOT NEW HERE. `diff/stage.ts#autoStage` already holds it, and it is the same one the watch
 * daemon uses — C# staged line by line with live debug output HELD BACK, `.meta` following the asset it
 * belongs to, a `.asset` only when it is a ScriptableObject of a script in this project, prefabs and
 * animator files whole, nothing over the size cap. A second copy of those rules would drift from the
 * daemon's, and the two would then disagree about what a commit should contain.
 *
 * WHAT IS HELD BACK IS SAID OUT LOUD. A file staged "without 3 live debug lines" is the case an operator
 * must know about — they are about to commit, and the part left unstaged is still in their tree. Silence
 * there would be the tool quietly deciding what belongs in a commit.
 *
 * IT NEVER OPENS WHAT IT DID NOT STAGE, and never opens at all when the policy says not to (headless, the
 * daemon, `AYIN_EDITOR_OPEN=never`) — `editor.ts` owns that decision, as the one place that knows how to
 * hand a file to an editor.
 */

import { join } from 'node:path';
import { autoStage } from '../diff/stage.js';
import { openInEditor, openPolicy } from '../editor.js';
import { log } from '../log.js';

export interface PresentHandoff {
  /** '' when this project type has no staging policy — nothing was touched. */
  policy: string;
  staged: string[];
  /** Files the policy deliberately left alone, with the reason. */
  skipped: Array<{ path: string; why: string }>;
  /** Files staged only in part — the held-back lines are still unstaged changes. */
  partial: Array<{ path: string; why: string }>;
  opened: boolean;
  /** Why the editor did or did not appear. */
  openWhy: string;
}

/**
 * Stage what this turn changed, per the project's policy, and open it.
 *
 * Never throws: a presentation is the last thing to happen in a turn, and a git or editor problem must not
 * turn a finished piece of work into a failed one. Anything that goes wrong is logged and reported as part
 * of the handoff.
 */
export async function stageAndOpenForPresentation(repo: string): Promise<PresentHandoff> {
  const empty: PresentHandoff = { policy: '', staged: [], skipped: [], partial: [], opened: false, openWhy: '' };
  let result;
  try {
    result = await autoStage(repo);
  } catch (e) {
    log('WARN', 'present_stage_failed', { error: e instanceof Error ? e.message : String(e) });
    return { ...empty, openWhy: 'staging failed — nothing was opened' };
  }
  if (result.policy === 'none' || !result.outcomes.length) return empty;

  const staged = result.outcomes.filter((o) => o.staged).map((o) => o.path);
  const skipped = result.outcomes.filter((o) => !o.staged).map((o) => ({ path: o.path, why: o.why }));
  const partial = result.outcomes
    .filter((o) => o.staged && typeof o.heldBack === 'number' && o.heldBack > 0)
    .map((o) => ({ path: o.path, why: o.why }));

  const policy = openPolicy();
  let opened = false;
  if (staged.length) {
    try {
      // Absolute, because the editor is launched with no cwd of its own.
      opened = await openInEditor(staged.map((p) => join(repo, p)));
    } catch (e) {
      log('WARN', 'present_open_failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }
  log('INFO', 'present_handoff', {
    policy: result.policy, staged: String(staged.length), partial: String(partial.length),
    skipped: String(skipped.length), opened: String(opened),
  });
  return {
    policy: result.policy, staged, skipped, partial, opened,
    openWhy: opened ? 'opened in your editor' : policy.allowed ? 'no editor CLI found on PATH' : policy.why,
  };
}

/** The handoff as the lines that go under a presentation. '' when there was nothing to stage. */
export function renderHandoff(h: PresentHandoff): string {
  if (!h.policy) return '';
  const out: string[] = [];
  if (h.staged.length) {
    out.push(`staged (${h.policy} policy): ${h.staged.join(', ')}`);
  } else {
    // "Nothing staged" alone reads as a failure. What happened is that everything still unstaged was
    // something the policy declines — which is a decision, and the reasons follow underneath.
    out.push(`nothing new staged — of the ${h.skipped.length} file(s) still unstaged, none qualify under the ${h.policy} policy`);
  }
  for (const p of h.partial) out.push(`  partial: ${p.path} — ${p.why}`);
  for (const s of h.skipped.slice(0, 8)) out.push(`  not staged: ${s.path} — ${s.why}`);
  if (h.skipped.length > 8) out.push(`  (+${h.skipped.length - 8} more left alone)`);
  if (h.staged.length) out.push(h.openWhy);
  return out.join('\n');
}
