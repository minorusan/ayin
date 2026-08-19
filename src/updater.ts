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

import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setStatus } from './ui.js';
import { getConfigString } from './prompts.js';
import { log } from './log.js';
import { watchDaemonPid } from './watch.js';

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
/**
 * The git checkout this build actually runs from, or null for a plain registry install.
 *
 * Node resolves symlinks when loading modules, so `HERE` is the REAL directory even when the binary was
 * reached through `/usr/local/bin/ayin` → `lib/node_modules/ayin` → an `npm link`ed checkout. That is
 * what makes "update the repo the link points at" resolvable without parsing anything.
 */
function gitCheckout(): string | null {
  const root = join(HERE, '..');
  return existsSync(join(root, '.git')) ? root : null;
}

/**
 * `ayin update` FOR A LINKED CHECKOUT: pull, install, build, remap.
 *
 * ayin is distributed as a git repo now, so the registry path updates the wrong thing on the machine that
 * matters: it replaces a GLOBAL package while the binary on PATH runs a linked working tree, and the old
 * code keeps running while the command reports success. This pulls the tree the link resolves to, rebuilds
 * it, and re-points the global bin at it — so `ayin update` changes what `ayin` actually runs.
 *
 * `npm install` is not skipped even when package.json looks unchanged: a pull that adds a dependency (the
 * `openai` SDK did exactly that) leaves a tree that compiles against modules which are not there.
 *
 * A DIRTY TREE IS NEVER TOUCHED. Someone else's uncommitted work is not this command's to stash, and a
 * merge conflict mid-update leaves a build that matches no commit.
 */
/**
 * Files this command itself rewrites, which therefore must never block the next run of it.
 *
 * Only the lockfile: `npm install` regenerates it routinely, and nothing else the update touches is
 * tracked. Deliberately a small, explicit set — "ignore anything that looks generated" is how a guard
 * stops guarding.
 */
const SELF_WRITTEN = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

async function updateFromCheckout(root: string, opts: { check: boolean; force: boolean }): Promise<void> {
  const current = getCurrentVersion();
  const git = (...args: string[]): Promise<{ code: number; out: string }> => run('git', ['-C', root, ...args]);

  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).out.trim();
  process.stdout.write(`ayin ${current}  ·  checkout ${root}${branch ? ` (${branch})` : ''}\n`);
  if (branch === 'HEAD') {
    process.stderr.write('ayin update: this checkout is on a detached HEAD — `git checkout main` first.\n');
    process.exit(1);
    return;
  }

  const before = (await git('rev-parse', 'HEAD')).out.trim();
  process.stdout.write('Fetching…\n');
  const fetched = await git('fetch', '--quiet');
  if (fetched.code !== 0) {
    process.stderr.write(`ayin update: git fetch failed — ${fetched.out.trim() || 'no detail'}\n`);
    process.exit(fetched.code || 1);
    return;
  }
  const remote = (await git('rev-parse', `origin/${branch}`)).out.trim();
  if (remote && remote === before && !opts.force) {
    process.stdout.write(`Already up to date with origin/${branch} (${before.slice(0, 7)}).\n`);
    return;
  }
  const behind = (await git('rev-list', '--count', `${before}..origin/${branch}`)).out.trim();
  process.stdout.write(`Update available: ${behind || '?'} commit(s) behind origin/${branch}.\n`);
  if (opts.check) return;

  // Only now: --check reports without touching anything, so a dirty tree must not stop it. Someone
  // else's uncommitted work is not this command's to stash, and a conflict mid-update leaves a build
  // that matches no commit.
  const dirty = (await git('status', '--porcelain')).out.trim();
  // THE UPDATE MUST NOT BE BLOCKED BY ITS OWN OUTPUT.
  //
  // This command runs `npm install`, and npm rewrites the lockfile as a matter of course — a different
  // npm version, a different platform, an optional dependency resolving differently. So a successful
  // update left the tree dirty in exactly one file and the NEXT update refused to run, every time,
  // until the operator passed --force. The guard exists to protect someone else's work; a lockfile
  // this command wrote thirty seconds ago is not that.
  const blocking = dirty
    ? dirty.split('\n').filter((line) => !SELF_WRITTEN.has(line.slice(3).trim()))
    : [];
  if (blocking.length && !opts.force) {
    process.stderr.write(`ayin update: ${blocking.length} uncommitted change(s) in ${root} — refusing to pull over them.\n`);
    for (const line of blocking.slice(0, 5)) process.stderr.write(`               ${line}\n`);
    process.stderr.write('             Commit them, or re-run with --force (which stashes them for you).\n');
    process.exit(1);
    return;
  }
  /**
   * `--force` MOVES THE WORK OUT OF THE WAY. It used to only skip the guard, which is not the same
   * thing: `git pull --ff-only` then failed on its own with "your local changes would be overwritten",
   * so `--force` over a dirty tree reliably did nothing except print a git error — the update the
   * operator asked for twice never happened.
   *
   * STASH, NEVER DISCARD. `--force` is permission to get out of the way, not permission to destroy
   * hours of someone's uncommitted work; a `checkout`/`reset` here would be unrecoverable and this
   * command runs unattended from a status-bar hint. The stash is labelled with the timestamp and
   * printed, so the work is one `git stash pop` away and the operator is told so.
   */
  if (blocking.length && opts.force) {
    const label = `ayin update --force ${new Date().toISOString()}`;
    process.stdout.write(`--force: stashing ${blocking.length} uncommitted change(s) so the pull can land…\n`);
    const stashed = await git('stash', 'push', '--include-untracked', '-m', label);
    if (stashed.code !== 0) {
      process.stderr.write(`ayin update: could not stash local changes — ${stashed.out.trim() || 'no detail'}\n`);
      process.stderr.write('             Nothing was pulled; your tree is untouched.\n');
      process.exit(stashed.code || 1);
      return;
    }
    process.stdout.write(`         stashed as "${label}" — recover with: git -C ${root} stash pop\n`);
  }
  if (dirty && !blocking.length) {
    // Said out loud rather than silently swallowed: a pull over a modified lockfile is a real decision,
    // and the operator should see it was made for them.
    process.stdout.write('Ignoring local changes to the lockfile — `npm install` writes it on every update.\n');
  }

  const pulled = await git('pull', '--ff-only');
  if (pulled.code !== 0) {
    process.stderr.write(`ayin update: git pull failed — ${pulled.out.trim() || 'no detail'}\n`);
    process.stderr.write('             The previous build is untouched.\n');
    process.exit(pulled.code || 1);
    return;
  }

  // Dependencies first: a pull that added one leaves a tree that cannot compile.
  process.stdout.write('Installing dependencies…\n');
  const installed = await run('npm', ['install', '--prefix', root], { inherit: true });
  if (installed.code !== 0) {
    process.stderr.write(`ayin update: npm install failed (exit ${installed.code}).\n`);
    process.exit(installed.code || 1);
    return;
  }

  process.stdout.write('Building…\n');
  const built = await run('npm', ['run', '--prefix', root, 'build'], { inherit: true });
  if (built.code !== 0) {
    process.stderr.write(`ayin update: build failed (exit ${built.code}) — dist/ may be inconsistent.\n`);
    process.stderr.write(`             Fix it in ${root}, then re-run \`npm run build\`.\n`);
    process.exit(built.code || 1);
    return;
  }

  // REMAP. Only when the global bin does not already resolve here — `npm link` needs a writable prefix
  // and would otherwise demand sudo on every update for no reason.
  const linked = await run('node', ['-e', 'try{process.stdout.write(require("fs").realpathSync(require("child_process").execSync("command -v ayin").toString().trim()))}catch{}']);
  const pointsHere = linked.out.trim().startsWith(root);
  if (!pointsHere) {
    process.stdout.write('Re-pointing the `ayin` command at this checkout…\n');
    const relinked = await run('npm', ['link', '--prefix', root], { inherit: true });
    if (relinked.code !== 0) {
      process.stderr.write('ayin update: built successfully, but `npm link` failed — the global `ayin` still\n');
      process.stderr.write(`             runs the old build. Re-run as: sudo npm link --prefix ${root}\n`);
    }
  }

  const after = getCurrentVersionFrom(root);
  const head = (await git('rev-parse', 'HEAD')).out.trim();
  if (head === before) {
    // The honest version of "nothing happened": a --force on a checkout that was ALREADY at
    // origin/<branch> reinstalls and rebuilds the same commit. That is a real action, but it is not an
    // update, and reporting a version that did not move reads as a no-op. Name the other door — the
    // published build — because that is what the operator usually meant.
    process.stdout.write(`Rebuilt the SAME commit (${head.slice(0, 7)}) — this checkout was already at origin/${branch}.\n`);
    process.stdout.write('To install the PUBLISHED build instead of this checkout: ayin update --registry\n');
  }
  log('INFO', 'ayin_updated_from_checkout', { root, from: current, to: after, before: before.slice(0, 7), rebuiltSameCommit: String(head === before) });
  process.stdout.write(`ayin is now ${after} (${(await git('rev-parse', '--short', 'HEAD')).out.trim()}). Restart any running session to pick it up.\n`);
  await restartWatchDaemon(after);
}

/** The version in a checkout's package.json — read AFTER a pull, so it reflects what was just built. */
function getCurrentVersionFrom(root: string): string {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version || '0.0.0';
  } catch {
    return getCurrentVersion();
  }
}

export async function runUpdate(argv: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  // A LINKED CHECKOUT IS THE NORMAL CASE NOW, and updating the global package would change something
  // other than what runs here. `--registry` is taken as an explicit request for the old path.
  const checkout = gitCheckout();
  /**
   * `--registry` is ALSO a door, not just a value. Written bare (`ayin update --registry`) it used to
   * be dropped on the floor — `flag()` returned undefined, the checkout path ran, and the operator who
   * asked for the published build got a local rebuild with no hint that their flag was ignored. Bare
   * now means "the configured registry", which is the only registry they could have meant.
   */
  if (checkout && !has('registry')) {
    await updateFromCheckout(checkout, { check: has('check'), force: has('force') });
    return;
  }

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
  await restartWatchDaemon(latest);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * `ayin watch` is a long-running daemon nobody sits and watches — left alone it would keep
 * reviewing every commit on the OLD build until someone happened to notice and restart it by
 * hand. So a successful `ayin update` restarts it itself: SIGTERM (the daemon's own handler
 * cleans up its pidfile and releases any held LLM authority — graceful, and its queue survives
 * the interruption regardless per the poll-only + persistent-queue design), wait for it to
 * actually exit, then relaunch `ayin watch` from PATH — which now resolves to the build just
 * installed. Best-effort: a daemon that isn't running is a no-op, and a machine with no `ayin`
 * on PATH (e.g. Windows, where the daemon runs as a Task Scheduler job instead) just gets a
 * fallback note instead of a crash.
 */
async function restartWatchDaemon(newVersion: string): Promise<void> {
  const pid = watchDaemonPid();
  if (!pid) return;
  process.stdout.write(`Restarting the watch daemon (pid ${pid}) so it picks up ${newVersion} immediately…\n`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise(r => setTimeout(r, 250));
  }
  try {
    const child = spawn('ayin', ['watch'], { detached: true, stdio: 'ignore' });
    const spawned = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    child.unref();
    process.stdout.write(spawned
      ? 'Watch daemon relaunched in the background.\n'
      : 'Could not relaunch the watch daemon automatically — run `ayin watch` yourself.\n');
  } catch {
    process.stdout.write('Could not relaunch the watch daemon automatically — run `ayin watch` yourself.\n');
  }
}
