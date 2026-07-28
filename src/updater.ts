/**
 * Updates — the startup check (a hint in the status bar) and the `ayin update` command
 * (fetch + install the newest build from the registry).
 *
 * The registry is resolved in this order, and NEVER guessed:
 *   1. `--registry <url>` on the command line
 *   2. `AYIN_UPDATE_REGISTRY`
 *   3. `updateRegistry` in `~/.ayin-cli/prompts.json` (`/set update-registry <url>`) — the durable
 *      per-machine answer, independent of whatever npm happens to be pointed at
 *   4. npm's own configured registry (`npm config get registry`)
 *
 * …and step 4 is REFUSED when it resolves to public npmjs. `ayin` is a taken name there and that
 * package is not this build: a machine whose npm defaulted to registry.npmjs.org resolved `latest`
 * to a stranger's 0.0.2, and only the "local build is ahead" check stopped it — `--force` would
 * have replaced the agent with someone else's code. Explicit `--registry <public url>` is still
 * honoured, with a warning, because that is the user saying it on purpose.
 *
 * The passive startup check follows the same order minus the npmjs fallback, so a fresh
 * open-source checkout never phones home to a registry nobody asked about.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setStatus } from './ui.js';
import { getConfigString } from './prompts.js';
import { log } from './log.js';

const REGISTRY = process.env.AYIN_UPDATE_REGISTRY ?? '';
const PACKAGE_NAME = process.env.AYIN_UPDATE_PACKAGE ?? 'ayin';

const HERE = dirname(fileURLToPath(import.meta.url));

export function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

/**
 * `ayin` IS A TAKEN NAME ON PUBLIC NPM. Observed in the wild: `ayin update` on a machine whose npm
 * pointed at registry.npmjs.org resolved `latest` to a stranger's **0.0.2**. Only the
 * "local build is ahead" check stopped it; `--force` would have installed someone else's package
 * over the agent. So the public registry is never used implicitly — not for the passive check, and
 * not for an actual install. Explicit `--registry https://registry.npmjs.org/` is still honoured
 * (with a warning), because an explicit instruction is the user's call.
 */
function isPublicRegistry(url: string): boolean {
  return /(^|\/\/)(registry\.)?(npmjs\.(org|com)|yarnpkg\.com)/i.test(url);
}

/** Where the update registry came from, so a surprising answer is never unexplained. */
type RegistrySource = 'flag' | 'env' | 'ayin config' | 'npm config' | 'none';

/**
 * Which registry the PASSIVE check may talk to.
 *
 * `AYIN_UPDATE_REGISTRY` if set. Otherwise npm's own configured registry — but only when it is a
 * private one. A checkout pointed at public npmjs gets NO passive check: `ayin` is a plausible
 * public name, so that would both phone home uninvited and risk advertising a stranger's package
 * as "your update". Set `AYIN_UPDATE_CHECK=0` to switch it off entirely.
 */
let passiveRegistryCache: string | null | undefined;
async function passiveRegistry(): Promise<string | null> {
  if (process.env.AYIN_UPDATE_CHECK === '0') return null;
  if (REGISTRY) return REGISTRY;
  if (passiveRegistryCache !== undefined) return passiveRegistryCache;
  const configured = getConfigString('updateRegistry');
  if (configured) { passiveRegistryCache = configured; return configured; }
  const npmReg = await npmConfiguredRegistry();
  passiveRegistryCache = !npmReg || isPublicRegistry(npmReg) ? null : npmReg;
  return passiveRegistryCache;
}

/**
 * Passive check — best-effort, never blocks or throws. Sets the `↑ vX available` hint in the
 * status bar. Called at startup and then on a slow timer, so a fix published from this very
 * session (or from another machine) shows up without a restart.
 */
export async function checkForUpdate(): Promise<void> {
  const registry = await passiveRegistry();
  if (!registry) return;
  const current = getCurrentVersion();

  try {
    const latest = await fetchDistTag(registry, PACKAGE_NAME, 'latest');
    if (!latest) return;
    if (compareVersions(current, latest) < 0) {
      setStatus({ update: `v${latest} available — ayin update` });
      log('INFO', 'update_available', { current, latest });
    } else {
      setStatus({ update: null }); // we just updated (or the tag moved back) — drop a stale hint
    }
  } catch {
    // Silent — update check is best-effort
  }
}

/** Re-check every `everyMs` (default 10 min). Unref'd; returns a stop function. */
export function startUpdateWatch(everyMs = 10 * 60 * 1000): () => void {
  void checkForUpdate();
  const timer = setInterval(() => { void checkForUpdate(); }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── `ayin update` ─────────────────────────────────────────────────────

function run(cmd: string, args: string[], opts: { inherit?: boolean } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
    if (opts.inherit) {
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    }
  });
}

function normalizeRegistry(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

async function npmConfiguredRegistry(): Promise<string> {
  const { code, out } = await run('npm', ['config', 'get', 'registry']);
  if (code !== 0) return '';
  const url = out.split('\n').pop()?.trim() ?? '';
  return url && url !== 'undefined' && url !== 'null' ? url : '';
}

async function fetchDistTag(registry: string, pkg: string, tag: string): Promise<string | null> {
  const res = await fetch(`${normalizeRegistry(registry)}${encodeURIComponent(pkg)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = await res.json() as { 'dist-tags'?: Record<string, string> };
  return data['dist-tags']?.[tag] ?? null;
}

/** Is the global npm prefix writable by us? (`npm i -g` into /usr needs root on this box.) */
async function globalPrefixWritable(): Promise<{ prefix: string; writable: boolean }> {
  const { out } = await run('npm', ['prefix', '-g']);
  const prefix = out.split('\n').pop()?.trim() || '/usr';
  try {
    accessSync(join(prefix, 'lib'), constants.W_OK);
    return { prefix, writable: true };
  } catch {
    return { prefix, writable: false };
  }
}

/**
 * `ayin update` — install the newest published build.
 *
 * Flags: `--check` (report only) · `--registry <url>` · `--tag <dist-tag>` · `--force` (reinstall
 * even when the versions match).
 *
 * Deliberately NOT clever: it shells out to `npm install -g`, so the install is atomic in npm's
 * own terms and a half-downloaded tarball leaves the existing binary untouched — interrupt it and
 * the old ayin still runs. Exits non-zero when it could not update, so a wrapper can react.
 */
export async function runUpdate(argv: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const current = getCurrentVersion();
  const tag = flag('tag') ?? 'latest';

  // Resolve the registry, remembering WHERE it came from — the difference between an explicit
  // instruction and a fallback decides whether the public registry is allowed.
  let registry = flag('registry');
  let source: RegistrySource = registry ? 'flag' : 'none';
  if (!registry && REGISTRY) { registry = REGISTRY; source = 'env'; }
  if (!registry) {
    const configured = getConfigString('updateRegistry');
    if (configured) { registry = configured; source = 'ayin config'; }
  }
  if (!registry) {
    const npmReg = await npmConfiguredRegistry();
    if (npmReg) { registry = npmReg; source = 'npm config'; }
  }

  if (!registry) {
    process.stderr.write('ayin update: no registry configured. Pass --registry <url>, set AYIN_UPDATE_REGISTRY, or run /set update-registry <url> in the TUI.\n');
    process.exit(1);
    return;
  }

  // The guard. `ayin` exists on public npm and is not us; a fallback must never reach it.
  if (isPublicRegistry(registry) && source !== 'flag') {
    process.stderr.write(
      `ayin update: refusing to update from the PUBLIC npm registry (${registry}, from ${source}).\n` +
      `             "ayin" is a taken name there and that package is not this build — installing it\n` +
      `             would replace your agent with a stranger's code.\n` +
      `             Point it at the registry your build comes from, once:\n` +
      `               /set update-registry http://<your-registry>:4873      (persists in ~/.ayin-cli)\n` +
      `             or per-run:  ayin update --registry http://<your-registry>:4873\n` +
      `             or export AYIN_UPDATE_REGISTRY.\n` +
      `             If you really do want the public package, pass --registry ${registry} explicitly.\n`,
    );
    process.exit(1);
    return;
  }
  if (isPublicRegistry(registry)) {
    process.stdout.write(`⚠ using the PUBLIC npm registry by explicit request — "ayin" there is not necessarily your build.\n`);
  }

  process.stdout.write(`ayin ${current}  ·  registry ${registry} (${source})\n`);

  // SAY THIS FIRST, ALWAYS. This note used to live further down, after the "already newest" and
  // `--check` early returns — i.e. it never printed in the two cases where it was most needed. Someone
  // ran `ayin update` repeatedly on a machine whose binary runs a source checkout, was told "already on
  // the newest build" every time, and had no way to know that a global install cannot change what runs
  // here. The one sentence that explains it has to come before any early return.
  const sourceCheckout = existsSync(join(HERE, '..', '.git')) || existsSync(join(HERE, '..', 'tsconfig.json'));
  if (sourceCheckout) {
    process.stdout.write(`Note: this ayin runs from a source checkout (${join(HERE, '..')}).\n`);
    process.stdout.write('      `ayin update` installs the GLOBAL package and cannot change this build —\n');
    process.stdout.write('      to update what actually runs here: git pull && npm run build (then restart ayin).\n');
  }

  let latest: string | null;
  try {
    latest = await fetchDistTag(registry, PACKAGE_NAME, tag);
  } catch (err) {
    process.stderr.write(`ayin update: cannot reach ${registry} — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
    return;
  }

  if (!latest) {
    process.stderr.write(`ayin update: registry has no "${tag}" version of ${PACKAGE_NAME}.\n`);
    process.exit(1);
    return;
  }

  const cmp = compareVersions(current, latest);
  if (cmp >= 0 && !has('force')) {
    process.stdout.write(cmp === 0
      ? `Already on the newest build (${latest}).\n`
      : `Local build ${current} is ahead of the registry's ${tag} (${latest}) — nothing to do (--force to install it anyway).\n`);
    return;
  }

  process.stdout.write(`${cmp < 0 ? 'Update available' : 'Reinstalling'}: ${current} → ${latest}\n`);
  if (has('check')) return;

  const { prefix, writable } = await globalPrefixWritable();
  if (!writable && process.getuid?.() !== 0) {
    process.stderr.write(`ayin update: the global npm prefix (${prefix}) is not writable by this user.\n`);
    process.stderr.write('             Re-run as:  sudo ayin update\n');
    process.exit(1);
    return;
  }

  process.stdout.write(`Installing ${PACKAGE_NAME}@${latest} globally…\n`);
  const { code } = await run('npm', ['install', '-g', `${PACKAGE_NAME}@${latest}`, '--registry', registry], { inherit: true });
  if (code !== 0) {
    process.stderr.write(`ayin update: npm install failed (exit ${code}) — the previous build is untouched.\n`);
    process.exit(code || 1);
    return;
  }

  log('INFO', 'ayin_updated', { from: current, to: latest, registry });
  process.stdout.write(`ayin is now ${latest}. Restart any running session to pick it up.\n`);
}
