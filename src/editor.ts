/**
 * editor — the one place that knows how to hand a file to a local editor.
 *
 * Extracted out of `tools/diagram.ts` (which had its own private copy) because `tools/arduino-explain.ts`
 * needs the identical behavior: try VS Code's CLI, its Insiders build, then VSCodium, in that order,
 * and say honestly whether one was actually found and launched. A second inline copy would have been
 * the same bug this codebase's own docs warn about — a fact duplicated in two places drifts.
 */

import { execFile } from 'node:child_process';

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code });
    });
  });
}

/** Open `target` in VS Code (or Insiders/Codium) if its CLI is on PATH; false if none was found. */
export async function openInEditor(target: string): Promise<boolean> {
  for (const bin of ['code', 'code-insiders', 'codium']) {
    const probe = await run(bin, ['--version'], 8_000);
    if (probe.code === 0) {
      const r = await run(bin, [target], 10_000);
      return r.code === 0;
    }
  }
  return false;
}
