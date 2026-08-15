#!/usr/bin/env node
/**
 * check-launch — `ayin launch`, the hotkey entry point.
 *
 * `npm run check:launch` (needs a build first). No LLM, no network, no window opened. HOME is
 * redirected before any import, because `prompts.ts` resolves `~/.ayin-cli/prompts.json` at module
 * load and a gate that wrote there would edit the operator's live terminal setting to test it.
 *
 * What a typecheck cannot catch here, and what each of these is standing in front of:
 *
 *   1. **The quoting actually survives.** The launch script carries a directory ayin did not choose,
 *      through a shell it did not write. So the gate WRITES a script for a directory containing a
 *      space and an apostrophe, RUNS it with `/bin/pwd` as the binary, and compares. A launcher that
 *      opens a window in the wrong place — or in `$HOME` because `cd` failed — looks like a bug in
 *      the hotkey, and would be debugged there for an hour before anyone suspected the quoting.
 *   2. **The wiring.** `launch` must be in NO_TUI_COMMANDS (else blessed grabs the tty of a process
 *      that is about to exit) and in NO_MODEL_NEEDED (else the first-run onboarding fires into a
 *      window nobody can answer). Both are set membership in another file — invisible to tsc.
 *   3. **The config escape hatch works.** Every platform default is a guess about someone else's
 *      terminal. If `terminalCommand` does not actually override, an operator on a terminal we did
 *      not guess has no way out and the feature is broken for them specifically.
 *   4. **Pruning runs on the way IN.** These scripts name directories the operator was looking at,
 *      and a cleanup at exit does not run when the process is killed.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'ayin-launch-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
if (!process.argv.includes('-p')) process.argv.push('-p'); // never build blessed widgets

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const CONFIG = join(HOME, '.ayin-cli', 'prompts.json');
const writeConfig = (config) => {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ config }, null, 2));
};
writeConfig({});

const launch = await import(join(ROOT, 'dist/launch.js'));
const headless = await import(join(ROOT, 'dist/ui/headless.js'));

// ── 1 · the quoting survives a directory ayin did not choose ─────────────────────
//
// A space and an apostrophe are the two characters that break naive interpolation, and both are
// legal in a macOS folder name — "Kliment's Stuff" is not a hostile input, it is a Tuesday.

const NASTY = join(HOME, "it's a repo (v2)");
mkdirSync(NASTY, { recursive: true });

const script = launch.writeLaunchScript(NASTY, ['/bin/pwd']);
ok(statSync(script).mode & 0o100, 'the launch script is executable');
const body = readFileSync(script, 'utf-8');
ok(body.startsWith('#!/bin/bash'), 'the script has a bash shebang — one shell on every platform');
ok(/^exec /m.test(body), 'the script execs, so closing ayin closes the window it opened');

let landed = '';
try {
  landed = execFileSync('/bin/bash', [script], { encoding: 'utf-8', timeout: 5000 }).trim();
} catch (err) { landed = `THREW: ${err.message}`; }
ok(landed === NASTY, 'running the script lands in a dir with a space AND an apostrophe', landed);

// Every argv element is quoted independently, so an absolute node path with a space in it (every
// Windows install: "C:\Program Files\nodejs") does not split into two arguments.
const multi = launch.writeLaunchScript(NASTY, ['/bin/echo', "a b", "it's"]);
const argsOut = execFileSync('/bin/bash', [multi], { encoding: 'utf-8', timeout: 5000 }).trim();
ok(argsOut === "a b it's", 'each argv element is quoted separately, spaces and all', argsOut);

// The launcher must pin the interpreter and the entry script absolutely. A bare `ayin` inherits the
// hotkey daemon's stripped PATH and opens a window purely to print `command not found` — which the
// operator reads as the hotkey being broken, not as a PATH problem two layers away.
const launchSrc = readFileSync(join(ROOT, 'src/launch.ts'), 'utf-8');
ok(/writeLaunchScript\(dir, \[process\.execPath/.test(launchSrc),
  'the script pins absolute node — a hotkey daemon PATH will not have the npm prefix');

// The same path through openerCommand — the other place the directory meets a shell.
writeConfig({ terminalCommand: 'echo {{SCRIPT}}' });
const echoed = launch.openerCommand(script);
const viaShell = execFileSync('/bin/bash', ['-c', echoed], { encoding: 'utf-8', timeout: 5000 }).trim();
ok(viaShell === script, 'the opener command survives the script path through a shell', viaShell);

// ── 2 · the wiring nothing else can see ──────────────────────────────────────────

ok(headless.HEADLESS !== undefined, 'headless module loaded');
const preflightSrc = readFileSync(join(ROOT, 'src/preflight.ts'), 'utf-8');
const noModel = preflightSrc.slice(preflightSrc.indexOf('NO_MODEL_NEEDED'));
ok(/'launch'/.test(noModel.slice(0, 400)),
  'launch is in NO_MODEL_NEEDED — onboarding must not fire into a window about to be exec-replaced');
const headlessSrc = readFileSync(join(ROOT, 'src/ui/headless.ts'), 'utf-8');
ok(/'launch'/.test(headlessSrc.slice(0, headlessSrc.indexOf('HEADLESS'))),
  'launch is in NO_TUI_COMMANDS — blessed must not grab a tty this process is about to leave');
const appSrc = readFileSync(join(ROOT, 'src/app.ts'), 'utf-8');
ok(/argv\[2\] === 'launch'/.test(appSrc), 'app.ts dispatches launch');
const knownKeys = readFileSync(join(ROOT, 'src/prompts.ts'), 'utf-8');
ok(/'terminalCommand'/.test(knownKeys),
  'terminalCommand is a KNOWN_CONFIG_KEY — else /set reports the operator just set a dead key');

// ── 3 · the config escape hatch actually overrides ───────────────────────────────

writeConfig({ terminalCommand: 'my-terminal --start {{SCRIPT}} --end' });
const custom = launch.openerCommand('/tmp/x.sh');
ok(custom === 'my-terminal --start /tmp/x.sh --end',
  'terminalCommand replaces the platform default outright', custom);
writeConfig({ terminalCommand: '{{SCRIPT}} and {{SCRIPT}}' });
ok(launch.openerCommand('/tmp/y.sh') === '/tmp/y.sh and /tmp/y.sh',
  'every {{SCRIPT}} is substituted, not just the first');
writeConfig({});

// ── 4 · --dir, --print, --help, and the refusals ─────────────────────────────────

const run = async (args) => {
  const out = [];
  const err = [];
  const w = process.stdout.write.bind(process.stdout);
  const we = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => { out.push(s); return true; };
  process.stderr.write = (s) => { err.push(s); return true; };
  let code;
  try { code = await launch.runLaunch(args); }
  finally { process.stdout.write = w; process.stderr.write = we; }
  return { code, out: out.join(''), err: err.join('') };
};

const printed = await run(['--dir', NASTY, '--print']);
ok(printed.code === 0 && printed.out.trim() === NASTY,
  '--print reports the directory and opens nothing', printed.out.trim());

const bogus = await run(['--dir', join(HOME, 'no-such-place'), '--print']);
ok(bogus.code === 2 && /not a directory/.test(bogus.err),
  'an explicit --dir that does not exist is refused, not silently swapped for cwd');

const naked = await run(['--dir']);
ok(naked.code === 2 && /needs a path/.test(naked.err), '--dir with no value is refused');

const help = await run(['--help']);
ok(help.code === 0 && /ayin launch/.test(help.out), '--help prints usage and exits 0');
ok(/hotkey/.test(help.out), 'the help says what it is FOR — nobody would type this command otherwise');

// With no explicit dir and no file manager (this is a headless Linux gate), it must still resolve
// something rather than throw: cwd is the fallback that is never wrong, only uninteresting.
const fallback = await run(['--print']);
ok(fallback.code === 0 && fallback.out.trim().length > 0,
  'with no front window it falls back rather than failing', fallback.out.trim());

// ── 5 · pruning happens on the way in ────────────────────────────────────────────

const SCRIPT_DIR = join(tmpdir(), 'ayin-launch');
const stale = join(SCRIPT_DIR, 'launch-stale-test.sh');
writeFileSync(stale, '#!/bin/bash\ntrue\n');
const old = Date.now() / 1000 - 7200;      // two hours back, past the one-hour TTL
utimesSync(stale, old, old);
const fresh = launch.writeLaunchScript(NASTY, ['/bin/pwd']);
const remaining = readdirSync(SCRIPT_DIR);
ok(!remaining.includes('launch-stale-test.sh'),
  'a stale launch script is pruned by the NEXT launch, not by an exit handler that a kill skips');
ok(remaining.some((f) => fresh.endsWith(f)), 'the script just written survives its own pruning pass');

rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\nlaunch check: ${fails} FAILURE(S)\n` : '\nlaunch check: ok\n');
process.exit(fails ? 1 : 0);
