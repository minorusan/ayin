#!/usr/bin/env node
/**
 * mark-bin-exec — the built entry point must be RUNNABLE, and `tsc` keeps making it not.
 *
 * `npm link` / `npm install -g` set the executable bit on whatever `package.json`'s `bin` points at,
 * once, at install time. Every rebuild after that writes `dist/index.js` fresh, with the compiler's
 * default 0644 — and since the global `ayin` is a symlink straight to that file, the next run is
 * `zsh: permission denied: ayin`. The install is fine; the file it points at stopped being a program.
 *
 * It looks like a broken install and it is not, which is what makes it expensive: the obvious fix is
 * to reinstall, which works, and then the next `npm run build` breaks it again.
 *
 * So the build ends by restoring the bit. Runs as `postbuild`, reads the bin map rather than
 * hardcoding a path, and is a no-op on Windows where the mode bits mean nothing and npm ships a
 * shim instead.
 */
import { chmodSync, existsSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'win32') {
  console.log('bin exec bit: skipped (windows — npm ships a shim)');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
let marked = 0;
for (const [name, rel] of Object.entries(bins)) {
  const path = join(REPO, rel);
  if (!existsSync(path)) {
    // A bin that does not exist after a build is a broken build, not a permission problem.
    console.error(`bin exec bit: FAIL ${name} -> ${rel} does not exist`);
    process.exit(1);
  }
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o111) === 0o111) continue;
  chmodSync(path, mode | 0o755);
  console.log(`bin exec bit: restored on ${rel} (was ${mode.toString(8)})`);
  marked++;
}
if (marked === 0) console.log('bin exec bit: ok');
