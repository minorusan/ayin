/**
 * postbuild — copy every executor `config.json` from `src/executors/**` into `dist/executors/**`.
 *
 * WHY THIS EXISTS. `tsc` compiles `.ts` and copies nothing else, so a config that ships beside its
 * executor in source simply would not be in the build. The registry reads those files at runtime and
 * THROWS when one is missing (a declared handler that can never be selected is worse than a missing
 * one — it looks supported), so without this step every build would fail loudly at boot. That is the
 * right failure, but this is the step that prevents it.
 *
 * The configs live beside the code rather than in a central directory on purpose: "which projects is
 * this handler for" is a property of the handler, and a reviewer should find the answer in the same
 * folder as the implementation, not three directories away.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'executors');
const DIST = join(ROOT, 'dist', 'executors');

if (!existsSync(SRC)) {
  console.error(`[copy-executor-configs] ${SRC} does not exist — nothing to copy.`);
  process.exit(1);
}

let copied = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (entry !== 'config.json') continue;
    const dest = join(DIST, relative(SRC, full));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(full, dest);
    copied++;
  }
};
walk(SRC);

if (copied === 0) {
  console.error('[copy-executor-configs] found no config.json under src/executors — every executor must declare one.');
  process.exit(1);
}
console.log(`[copy-executor-configs] ok — ${copied} executor config(s) copied into dist/executors`);
