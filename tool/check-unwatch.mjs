/**
 * check-unwatch.mjs — `ayin unwatch` must take back exactly what `ayin watch` put in, and no more.
 *
 * `watch` writes into repositories that are not ayin's: git hooks, a script under `.claude/`, an entry
 * in the repo's `settings.json`. The risk in the inverse is not that it removes too little — that is
 * merely annoying — but that it removes too much. A cleanup that eats someone's husky or git-lfs hook
 * has done far more damage than the watcher ever prevented, and it does it in a repo where the damage
 * shows up as a broken commit days later.
 *
 * So the assertions are about the BOUNDARY: our fenced block leaves the host hook byte-for-byte, a
 * hook we do not recognise is untouched, only our own `settings.json` entry goes, and other registered
 * repos are not affected. Deregistration is checked too, because while a repo stays registered the
 * daemon's self-heal reinstalls every hook within five minutes — removing files alone does not stop it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const CLI = new URL('../dist/index.js', import.meta.url).pathname;
const CHAIN_BEGIN = '# >>> ayin-watch (chained) >>>';
const CHAIN_END = '# <<< ayin-watch (chained) <<<';
const HOOK_MARKER = 'ayin-watch post-commit hook';

const failures = [];
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };

const REPOS_FILE = join(homedir(), '.ayin-cli', 'watch', 'repos.json');
const reposBefore = existsSync(REPOS_FILE) ? readFileSync(REPOS_FILE, 'utf-8') : null;

const root = mkdtempSync(join(tmpdir(), 'ayin-unwatch-'));
const repo = join(root, 'repo');
mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
git('init', '-q');
writeFileSync(join(repo, 'a.txt'), 'x\n');
git('add', 'a.txt');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

// A repo that already had its OWN post-commit hook — the case where ours is appended, not owned.
const HOST_HOOK = '#!/bin/sh\n# a hook this repo already had\necho "host hook ran"\n';
const hooks = join(repo, '.git', 'hooks');
mkdirSync(hooks, { recursive: true });
writeFileSync(join(hooks, 'post-commit'),
  `${HOST_HOOK}\n${CHAIN_BEGIN}\n# ${HOOK_MARKER} (chained)\n{ echo queued; } || true\n${CHAIN_END}\n`);
chmodSync(join(hooks, 'post-commit'), 0o755);

// A hook that is entirely ours.
writeFileSync(join(hooks, 'post-merge'), `#!/bin/sh\n# ${HOOK_MARKER} — installed by ayin watch\nexit 0\n`);
chmodSync(join(hooks, 'post-merge'), 0o755);

// A hook that is NOBODY's business but the repo's.
writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\necho "someone else entirely"\n');

// The hound, plus a settings.json carrying BOTH our entry and one that is not ours.
mkdirSync(join(repo, '.claude', 'hooks'), { recursive: true });
writeFileSync(join(repo, '.claude', 'hooks', 'ayin-hound.mjs'), '// hound\n');
const FOREIGN_ENTRY = { hooks: [{ type: 'command', command: 'echo not-ours' }] };
writeFileSync(join(repo, '.claude', 'settings.json'), `${JSON.stringify({
  hooks: { Stop: [FOREIGN_ENTRY, { hooks: [{ type: 'command', command: 'node .claude/hooks/ayin-hound.mjs' }] }] },
  permissions: { allow: ['Bash'] },
}, null, 2)}\n`);

// Registered, alongside a repo that must not be touched.
mkdirSync(join(homedir(), '.ayin-cli', 'watch'), { recursive: true });
const BYSTANDER = '/some/other/repo/that/must/survive';
writeFileSync(REPOS_FILE, `${JSON.stringify({
  [repo]: { installedAt: new Date().toISOString() },
  [BYSTANDER]: { installedAt: new Date().toISOString() },
}, null, 2)}\n`);

try {
  execFileSync('node', [CLI, 'unwatch', '--repo', repo], { stdio: 'pipe', timeout: 120_000 });
} catch (e) {
  fail(`unwatch exited non-zero: ${e.message}`);
}

// ── the boundary ────────────────────────────────────────────────────────────────
const postCommit = readFileSync(join(hooks, 'post-commit'), 'utf-8');
if (postCommit === HOST_HOOK) ok("the repo's own post-commit hook is byte-for-byte what it was");
else fail(`the host post-commit hook was altered: ${JSON.stringify(postCommit)}`);

if (!existsSync(join(hooks, 'post-merge'))) ok('a hook that was entirely ours is removed');
else fail('post-merge (ours) survived');

const prePush = existsSync(join(hooks, 'pre-push')) && readFileSync(join(hooks, 'pre-push'), 'utf-8');
if (prePush === '#!/bin/sh\necho "someone else entirely"\n') ok('an unrelated hook is untouched');
else fail('an unrelated hook was modified or removed');

if (!existsSync(join(repo, '.claude', 'hooks', 'ayin-hound.mjs'))) ok('the hound script is removed');
else fail('the hound script survived');

const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf-8'));
const stop = settings.hooks?.Stop ?? [];
if (stop.length === 1 && stop[0].hooks[0].command === 'echo not-ours') ok("someone else's Stop hook is kept, ours is gone");
else fail(`Stop hooks after unwatch: ${JSON.stringify(stop)}`);
if (settings.permissions?.allow?.[0] === 'Bash') ok('the rest of settings.json is untouched');
else fail('unrelated settings were lost');

const repos = JSON.parse(readFileSync(REPOS_FILE, 'utf-8'));
if (!(repo in repos)) ok('the repo is deregistered — self-heal will not put the hooks back');
else fail('the repo is still registered, so the daemon will reinstall the hooks');
if (BYSTANDER in repos) ok('another watched repo is left registered');
else fail('unwatching one repo deregistered another');

// Leave the operator's real registry exactly as it was.
if (reposBefore === null) rmSync(REPOS_FILE, { force: true });
else writeFileSync(REPOS_FILE, reposBefore);
rmSync(root, { recursive: true, force: true });

console.log(failures.length ? `\nunwatch check: ${failures.length} FAILED` : '\nunwatch check: ok');
process.exit(failures.length ? 1 : 0);
