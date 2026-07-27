/**
 * Updates — the startup check (a hint in the status bar) and the `ayin update` command
 * (fetch + install the newest build from the registry).
 *
 * The registry is resolved in this order, and NEVER guessed:
 *   1. `--registry <url>` on the command line
 *   2. `AYIN_UPDATE_REGISTRY`
 *   3. whatever npm itself is configured with (`npm config get registry`) — on this LAN that is
 *      the nuk's private Verdaccio (see maradel `utils/verdaccio/README.md`), which is where
 *      `ayin` and `maradel-beacon` are published.
 *
 * The passive startup check stays OPT-IN (steps 1-2 only): a fresh open-source checkout must not
 * phone home to a registry nobody asked about. `ayin update` is an explicit command, so it may
 * fall through to npm's own configured registry.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setStatus } from './ui.js';
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
  const npmReg = await npmConfiguredRegistry();
  const isPublic = !npmReg || /(^|\/\/)(registry\.)?npmjs\.(org|com)/i.test(npmReg);
  passiveRegistryCache = isPublic ? null : npmReg;
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
  const registry = flag('registry') ?? (REGISTRY || (await npmConfiguredRegistry()));

  if (!registry) {
    process.stderr.write('ayin update: no registry configured. Pass --registry <url>, set AYIN_UPDATE_REGISTRY, or point npm at one.\n');
    process.exit(1);
  }

  process.stdout.write(`ayin ${current}  ·  registry ${registry}\n`);

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

  // Running from a source checkout? A global install won't change THIS ayin — say so plainly
  // instead of letting the user wonder why the version didn't move.
  const sourceCheckout = existsSync(join(HERE, '..', '.git')) || existsSync(join(HERE, '..', 'tsconfig.json'));
  if (sourceCheckout) {
    process.stdout.write(`Note: this ayin runs from a source checkout (${join(HERE, '..')}).\n`);
    process.stdout.write('      The global package will be updated; this checkout still needs git pull + npm run build.\n');
  }

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
