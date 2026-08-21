/**
 * editor — the one place that knows how to hand a file to a local editor.
 *
 * Extracted out of `tools/diagram.ts` (which had its own private copy) because `tools/arduino-explain.ts`
 * needs the identical behavior: try VS Code's CLI, its Insiders build, then VSCodium, in that order,
 * and say honestly whether one was actually found and launched. A second inline copy would have been
 * the same bug this codebase's own docs warn about — a fact duplicated in two places drifts.
 *
 * WHEN IT MAY OPEN. Stealing focus is a side effect on the operator's desktop, so it is gated here
 * rather than at each call site — the same reasoning that put the launching itself in one file.
 * The default is `present`: an editor window appears only while the Presenter is on, i.e. when the
 * operator has actually asked to be shown things (`/present`, or `/presentthis` for one turn).
 * Generating a diagram mid-task no longer throws a window over whatever they were doing.
 *
 * Headless never opens, whatever the mode says: `ayin -p`, the watch daemon and cron have no desk
 * to put a window on, and the hound runs on every commit.
 *
 * Env: AYIN_EDITOR_OPEN = present (default) | always | never.
 *      AYIN_PUML_OPEN=0 still forces never, so the old knob keeps working.
 */

import { execFile } from 'node:child_process';
import { HEADLESS } from './ui/headless.js';
import { isPresenterSessionEnabled, isPresenterForcePending } from './presenter/index.js';

export type OpenMode = 'present' | 'always' | 'never';

export function openMode(): OpenMode {
  // The pre-existing per-tool knob wins when it says "off", so nobody's setup breaks.
  if ((process.env.AYIN_PUML_OPEN ?? '').toLowerCase() === '0') return 'never';
  const raw = (process.env.AYIN_EDITOR_OPEN ?? 'present').toLowerCase();
  return raw === 'always' || raw === 'never' ? raw : 'present';
}

/** Why an editor did or did not appear — callers report this instead of guessing. */
export function openPolicy(): { allowed: boolean; why: string } {
  if (HEADLESS) return { allowed: false, why: 'headless' };
  const mode = openMode();
  if (mode === 'never') return { allowed: false, why: 'opening disabled' };
  if (mode === 'always') return { allowed: true, why: 'AYIN_EDITOR_OPEN=always' };
  // `isPresenterSessionEnabled` is deliberately the NON-consuming accessor:
  // `shouldRunPresenterThisTurn()` eats the one-shot `/presentthis` force, and calling it here
  // would swallow it before the Presenter pass ever ran.
  if (isPresenterSessionEnabled() || isPresenterForcePending()) return { allowed: true, why: 'presenting' };
  return { allowed: false, why: 'not presenting — /present to enable' };
}

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code });
    });
  });
}

/**
 * Open one or more targets in VS Code (or Insiders/Codium) if the policy allows it AND a CLI is on PATH.
 * `force` bypasses the policy for a genuinely user-initiated open (a command whose whole purpose
 * is "show me this"); it still cannot open when headless.
 *
 * SEVERAL TARGETS GO IN ONE INVOCATION. `code a b c` opens three tabs in one window; three separate
 * launches race each other for which window wins and can leave the operator with three of them.
 */
export async function openInEditor(
  target: string | string[], opts: { force?: boolean } = {},
): Promise<boolean> {
  const targets = (Array.isArray(target) ? target : [target]).filter(Boolean);
  if (!targets.length) return false;
  if (!opts.force && !openPolicy().allowed) return false;
  if (opts.force && HEADLESS) return false;
  for (const bin of ['code', 'code-insiders', 'codium']) {
    const probe = await run(bin, ['--version'], 8_000);
    if (probe.code === 0) {
      // A big turn can touch dozens of files; a window with dozens of tabs is not a review.
      const r = await run(bin, targets.slice(0, MAX_TABS), 15_000);
      return r.code === 0;
    }
  }
  return false;
}

/** Tabs worth opening at once. Past this it is a file list, not something anyone reads. */
const MAX_TABS = 12;
