/**
 * Compiled files with no source — PHANTOM TOOLS.
 *
 * `tsc` never deletes an output whose input is gone, which was harmless when the registry was an array:
 * a stale `dist/foo.js` was dead code nobody imported. Directory DISCOVERY changed that. A tool deleted
 * from `src/tools/defs/` keeps running from its leftover `dist/tools/defs/*.js` — measured, immediately:
 * two tools removed from the repo were still in the catalogue after a clean build, and then collided with
 * the copies they had been moved to.
 *
 * That is a nasty failure because everything looks right. The source is gone, git is clean, the build
 * passes, and the agent still offers a tool that no longer exists in the repo you are reading.
 *
 * So: after every build, any `.js` under `dist/` whose `.ts` is missing from `src/` is reported. Runs as
 * `postbuild`, and is loud rather than fatal — a stale artifact is a cleanup, not a reason to refuse to
 * build. `defs/` is the one place it IS fatal, because there a phantom file is a phantom TOOL.
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DIST = join(REPO, 'dist');
const SRC = join(REPO, 'src');

/** Emitted beside the compiled tree but generated, not compiled — never orphans. */
const GENERATED = /executors[\\/].*\.json$/;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const orphans = [];
for (const js of walk(DIST)) {
  const rel = relative(DIST, js);
  if (GENERATED.test(rel)) continue;
  const ts = join(SRC, rel.replace(/\.js$/, '.ts'));
  if (!existsSync(ts)) orphans.push(rel);
}

const phantomTools = orphans.filter((o) => o.startsWith(join('tools', 'defs')));

for (const o of orphans) {
  const tag = phantomTools.includes(o) ? 'PHANTOM TOOL' : 'orphan';
  console.error(`  ${tag}  dist/${o}  — no src/${o.replace(/\.js$/, '.ts')}`);
}

if (phantomTools.length) {
  console.error(
    `\norphan check: ${phantomTools.length} PHANTOM TOOL(S). These are still discovered and offered to the `
    + 'model although their source is gone. Delete them from dist/ (or rebuild into a clean dist).',
  );
  process.exit(1);
}
console.log(orphans.length ? `orphan check: ${orphans.length} stale file(s) in dist — worth deleting` : 'orphan check: ok');
