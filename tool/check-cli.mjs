/**
 * check-cli.mjs — a subcommand must not start the agent it does not need.
 *
 * `ayin unwatch` removes git hooks from a repository. It shipped taking over the whole terminal with
 * a full-screen TUI and demanding a configured model first — so undoing a watcher was impossible on
 * the machine where the model had gone away, which is exactly when someone wants it undone. Nothing
 * failed; it was simply wrong in a way only a person watching would notice.
 *
 * FOUR lists decide this, in four files, and they were kept in step by memory:
 *   - the DISPATCH in app.ts (`process.argv[2] === 'x'`) — what exists
 *   - SUBCOMMANDS in index.ts — what the flag validator lets THROUGH to that dispatch
 *   - NO_TUI_COMMANDS in ui/headless.ts — what may not take the terminal
 *   - NO_MODEL_NEEDED in preflight.ts — what may not be gated behind configuring a model
 *
 * The second one was missing from this gate and immediately proved why it belongs: `ayin sprint` was
 * dispatched, exempted from the TUI, exempted from the model gate and documented — and still answered
 * `unknown command "sprint"`, because the validator that runs FIRST had never heard of it. Every other
 * list said the feature existed.
 *
 * A new subcommand lands in the first and is forgotten in the other two. This gate makes that a build
 * failure instead of a bug report, and it asks for an explicit decision rather than a default: a
 * command that genuinely wants the TUI or genuinely needs a model says so HERE, by name.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const app = readFileSync(join(REPO, 'src/app.ts'), 'utf-8');
const index = readFileSync(join(REPO, 'src/index.ts'), 'utf-8');
const headless = readFileSync(join(REPO, 'src/ui/headless.ts'), 'utf-8');
const preflight = readFileSync(join(REPO, 'src/preflight.ts'), 'utf-8');

const failures = [];
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };

/** Subcommands that DO want the full terminal UI — the agent itself, and nothing else so far. */
const WANTS_TUI = new Set([]);

/** Subcommands that genuinely cannot work without a model, so the setup gate in front of them is right. */
const NEEDS_MODEL = new Set([
  'watch',    // reviews every commit with the model
  'indulge',  // the corpus IS model output
  'explain',  // writes a narrative
]);

const listBetween = (src, marker) => {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const end = src.indexOf(']);', at);
  return src.slice(at, end);
};

const validated = listBetween(index, 'const SUBCOMMANDS = new Set(');
if (!validated) fail('SUBCOMMANDS not found in index.ts — this gate cannot check what the flag validator lets through');
const noTui = listBetween(headless, 'NO_TUI_COMMANDS = new Set(');
const noModel = listBetween(preflight, 'NO_MODEL_NEEDED = new Set(');
if (!noTui) fail('NO_TUI_COMMANDS not found in ui/headless.ts — this gate cannot check anything');
if (!noModel) fail('NO_MODEL_NEEDED not found in preflight.ts — this gate cannot check anything');

const dispatched = [...new Set([...app.matchAll(/process\.argv\[2\] === '([a-z][a-z-]*)'/g)].map((m) => m[1]))]
  .filter((c) => !['--version', '-v'].includes(c));

if (dispatched.length < 5) fail(`only ${dispatched.length} subcommand(s) found in app.ts — the dispatch shape changed and this gate is reading the wrong thing`);
else ok(`${dispatched.length} subcommands dispatched in app.ts`);

for (const cmd of dispatched) {
  // FIRST, because it runs first: a name the flag validator does not know never reaches the dispatch at
  // all — it is answered as a typo, with a suggestion naming the command it just refused.
  if (!validated?.includes(`'${cmd}'`)) {
    fail(`\`ayin ${cmd}\` is dispatched in app.ts but missing from SUBCOMMANDS in index.ts — the flag validator will reject it as a typo before it runs`);
  }
  const quiet = noTui?.includes(`'${cmd}'`);
  if (!quiet && !WANTS_TUI.has(cmd)) {
    fail(`\`ayin ${cmd}\` opens the full-screen TUI — add it to NO_TUI_COMMANDS, or to WANTS_TUI here if it really wants the terminal`);
  }
  const gated = !noModel?.includes(`'${cmd}'`);
  if (gated && !NEEDS_MODEL.has(cmd)) {
    fail(`\`ayin ${cmd}\` is gated behind configuring a model — add it to NO_MODEL_NEEDED, or to NEEDS_MODEL here if it truly needs one`);
  }
}
if (!failures.length) ok('every subcommand is classified: none takes the terminal or demands a model without a stated reason');

// The reverse direction: a name listed as exempt that no longer exists is a stale entry pointing at
// nothing, and the next reader trusts it.
for (const [, name] of (noTui ?? '').matchAll(/'([a-z][a-z-]+)'/g)) {
  if (name === 'sentinaile-supervisor') continue; // dispatched, but spawned rather than typed
  if (!dispatched.includes(name) && !['version', 'help'].includes(name)) {
    fail(`NO_TUI_COMMANDS names "${name}", which app.ts no longer dispatches`);
  }
}
if (!failures.length) ok('no exemption points at a subcommand that has been removed');

// ── `--full`, and the flag validation that makes a typo visible ───────────────────
//
// `ayin --ful` used to start an ordinary session with none of the three switches on and say nothing —
// indistinguishable from a working flag until the thing it was meant to enable failed to happen, and
// one of those things is the permission gate.
//
// TWO KINDS OF CHECK, chosen for what each can honestly prove. The three switches are read from argv
// at MODULE IMPORT, and importing those modules builds a blessed screen at module scope — a spawned
// probe around them was flaky for reasons that had nothing to do with the flag. So the WIRING is
// asserted statically, which is exactly the regression worth catching (a call site quietly deleted),
// and the REJECTION is asserted by launching the real binary, where an exit code is the whole answer.

import { execFileSync, spawn } from 'node:child_process';

const fullMode = readFileSync(join(REPO, 'src/full-mode.ts'), 'utf-8');
if (/argv\.includes\('--full'\)/.test(fullMode)) ok('--full is defined in exactly one place');
else failures.push('src/full-mode.ts no longer reads --full from argv');

// One call site per switch. Named individually so a failure says WHICH one went missing.
const wiring = [
  ['permissions.ts', 'src/permissions.ts', 'the permission gate'],
  ['qa/index.ts', 'src/qa/index.ts', 'the QA session toggle'],
  ['app.ts', 'src/app.ts', 'the boot debug bundle'],
];
for (const [label, rel, what] of wiring) {
  const src = readFileSync(join(REPO, rel), 'utf-8');
  if (/isFullMode\(\)/.test(src)) ok(`--full still reaches ${what} (${label})`);
  else failures.push(`${label} no longer consults isFullMode() — ${what} is silently off under --full`);
}

// The guard --full must NOT buy. It runs above every permission rule and denies under any skip flag,
// because a push is unrecoverable and public.
const perms = readFileSync(join(REPO, 'src/permissions.ts'), 'utf-8');
if (/if \(HEADLESS \|\| skipPermissions \|\| READONLY\) \{[\s\S]{0,240}?return 'deny'/.test(perms)) {
  ok('a dangerous op is still DENIED under a skip flag — no flag turns that off');
} else {
  failures.push('the dangerous-op guard no longer denies under skipPermissions');
}

/** Launch the real binary and return its stdout. */
function launchOut(args) {
  try {
    return execFileSync(process.execPath, [join(REPO, 'dist/index.js'), ...args],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25_000 });
  } catch (e) {
    return String(e.stdout ?? '');
  }
}

/** Launch the real binary and report exit code + stderr. */
function launch(args) {
  try {
    execFileSync(process.execPath, [join(REPO, 'dist/index.js'), ...args],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25_000 });
    return { code: 0, err: '' };
  } catch (e) {
    return { code: e.status ?? -1, err: String(e.stderr ?? '') };
  }
}

const typo = launch(['--ful']);
if (typo.code === 2 && /unknown option --ful/.test(typo.err)) ok('a mistyped flag exits 2 and names itself');
else failures.push(`--ful gave code ${typo.code}: ${typo.err.slice(0, 160)}`);

if (/Known options on a bare launch/.test(typo.err)) ok('and the error lists what IS accepted');
else failures.push('the rejection did not list the known options');

/**
 * A MISTYPED SUBCOMMAND MUST NOT LAUNCH A SESSION.
 *
 * A bare word that was not a subcommand used to be waved through — so `ayin unty prefab Assets/W.prefab`
 * started the TUI and discarded the rest of the line. The operator watched a session boot with no idea
 * what had happened to what they asked for. The help list already knows every command, which makes it the
 * database of what was probably meant.
 */
const misSub = launch(['unty', 'prefab', 'Assets/Widget.prefab']);
if (misSub.code !== 2) fail(`a mistyped subcommand exits 2 rather than launching (got ${misSub.code})`);
else ok('a mistyped subcommand exits 2 instead of starting a session');
if (!/unknown command "unty"/.test(misSub.err)) fail('the mistyped word is named back');
else ok('the mistyped word is named back');
if (!/Did you mean: ayin unity/.test(misSub.err)) fail('and the nearest real command is suggested from the help list');
else ok('and the nearest real command is suggested from the help list');
if (!/Commands: /.test(misSub.err)) fail('with the full list for when the guess is wrong');
else ok('with the full list for when the guess is wrong');

// A word with no near miss still refuses — it must not fall through to a session either.
const nonsense = launch(['zzzzzz']);
if (nonsense.code !== 2) fail(`an unrecognisable subcommand also refuses (got ${nonsense.code})`);
else ok('an unrecognisable subcommand also refuses, without inventing a suggestion');

// The suggester itself: exact match wins, and a typo resolves to one candidate rather than a list.
const help = await import(`file://${join(REPO, 'dist/help.js')}`);
if (help.suggestNames('unity', 'cli')[0] !== 'unity') fail('an exact name is returned as itself, not as a near miss');
else ok('an exact name is returned as itself');
if (!help.suggestNames('prefabb', 'command').includes('prefab')) fail('a one-letter slip on a slash command resolves');
else ok('a one-letter slip on a slash command resolves');
if (help.suggestNames('xyzzy', 'cli').length !== 0) fail('a word like nothing at all suggests nothing');
else ok('a word like nothing at all suggests nothing');

/**
 * THE TWO PAGE SERVERS ANSWER FOR THEMSELVES.
 *
 * `ayin diff` and `ayin sprint` park on a socket, so this cannot run them for real without leaving a
 * server behind — but `--help` proves the whole path a missing list entry breaks: the flag validator let
 * the word through, the dispatch found it, and the command printed instead of a session booting. That is
 * exactly the failure `ayin sprint` shipped with for one build.
 */
for (const [cmd, expect] of [['diff', /serve the working tree/], ['sprint', /serve your Jira sprint/]]) {
  const r = launch([cmd, '--help']);
  if (r.code !== 0) fail(`\`ayin ${cmd} --help\` exited ${r.code} instead of printing usage: ${r.err.slice(0, 160)}`);
  else ok(`\`ayin ${cmd} --help\` reaches the command and exits 0`);
  const out = launchOut([cmd, '--help']);
  if (!expect.test(out)) fail(`\`ayin ${cmd} --help\` does not describe a SERVED page — that is what these commands now do`);
  else ok(`and says it serves a page, which is what parking on a socket is for`);
}

/**
 * CTRL+C MUST ACTUALLY STOP IT, and the repo it serves must be the repo, not the directory.
 *
 * Both of these shipped broken for one afternoon. `parkUntilInterrupted` printed "stopped" and resolved
 * a promise — but a listening socket keeps the event loop alive, so the process kept serving and held
 * the port. Two of them accumulated on 7773 and 7774, and the next `ayin diff` bound 7775 while the
 * first port anyone would try answered for a different repository. And launched from a subdirectory,
 * every write on the page (stage, discard, a comment's run) resolved one level too deep.
 *
 * A real launch, a real SIGINT, and a real subdirectory. The static assertions could not see either.
 */
{
  // realpath, because `git rev-parse --show-toplevel` resolves symlinks and macOS hands out
  // /var/folders/… for a temp dir that is really /private/var/folders/… — the same difference the
  // comment store's cwd key ran into.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'ayin-cli-serve-')));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q', '.');
  g('config', 'user.email', 'gate@example.invalid');
  g('config', 'user.name', 'gate');
  mkdirSync(join(repo, 'nested'), { recursive: true });
  writeFileSync(join(repo, 'nested/a.ts'), 'export const a = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  writeFileSync(join(repo, 'nested/a.ts'), 'export const a = 2;\n');

  // Launched from the SUBDIRECTORY on purpose.
  const child = spawn(process.execPath, [join(REPO, 'dist/index.js'), 'diff', '--no-open'],
    { cwd: join(repo, 'nested'), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });

  const until = async (test, ms) => {
    for (let i = 0; i < ms / 100; i++) {
      if (test()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  const up = await until(() => /Ctrl\+C to stop/.test(out), 20_000);
  if (!up) fail(`\`ayin diff\` never reported that it was serving: ${out.slice(0, 200)}`);
  else ok('`ayin diff` from a subdirectory serves and says so');

  if (!out.includes(`serving ${repo} `)) {
    fail(`it serves the DIRECTORY rather than the repo — every write on the page would aim one level too deep: ${out.slice(0, 300)}`);
  } else ok('and names the REPO ROOT as the tree it serves, not the subdirectory it was launched from');

  const url = (out.match(/http:\/\/127\.0\.0\.1:(\d+)\/diff/) ?? [])[0];
  if (!url) fail('no URL was printed — the page cannot be opened');
  else {
    const page = await fetch(url).then((r) => r.text()).catch((e) => `FETCH FAILED ${e}`);
    if (!page.includes('nested/a.ts')) fail('the served page does not carry the changed file');
    else ok('the page it serves is real — the changed file is on it');
  }

  /**
   * AND IT IS REACHABLE FROM A PHONE, which is the whole reason the bind is not loopback.
   *
   * Three separate things can silently undo this and each of them looks fine from the machine that
   * serves it: the bind going back to 127.0.0.1, the network URL not being PRINTED (an address nobody
   * is told is an address nobody uses), and the Origin guard refusing the phone's own Origin — which
   * would leave a page that renders and a comment box that 403s, the worst of the three to diagnose.
   *
   * Skipped when the machine has no non-loopback IPv4 — a CI container legitimately has none, and a
   * gate that fails there is a gate that gets deleted.
   */
  const lanIps = Object.values(networkInterfaces()).flat()
    .filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)
    .map((a) => a.address);
  if (!lanIps.length) {
    ok('no non-loopback IPv4 on this machine — the network-URL checks do not apply here');
  } else {
    const lan = (out.match(/http:\/\/[\d.]+:(\d+)\/diff[^\s]*/g) ?? []).find((u) => !u.includes('127.0.0.1'));
    if (!lan) {
      fail(`no network URL was printed, so the page cannot be opened from a phone — this machine has ${lanIps.join(', ')}: ${out.slice(0, 300)}`);
    } else if (!lanIps.includes(new URL(lan).hostname)) {
      fail(`the network URL names ${new URL(lan).hostname}, which is not an address of this machine`);
    } else {
      ok('a network URL is printed, and it names a real address of this machine');

      const page = await fetch(lan).then((r) => r.text()).catch((e) => `FETCH FAILED ${e}`);
      if (!page.includes('nested/a.ts')) fail(`the page is not served over its network address: ${page.slice(0, 120)}`);
      else ok('and the page is really served over it — the bind is not loopback-only');

      // The phone's own Origin. A comment box that 403s is the failure this catches.
      const base = new URL(lan).origin;
      const r = await fetch(`${base}/api/prompts`, {
        method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}',
      }).then((x) => x.status).catch(() => 0);
      if (r === 403) fail('a POST carrying the phone\'s own Origin is refused — the page would render and every comment on it would fail');
      else ok('and a POST from that origin is accepted, so comments written on a phone reach the agent');

      // The guard is still a guard. Both halves, because they refuse for different reasons.
      const evil = await fetch(`${base}/api/prompts`, {
        method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}',
      }).then((x) => x.status).catch(() => 0);
      if (evil !== 403) fail(`a POST from an unrelated web page was NOT refused (${evil}) — that is remote code execution through the operator's browser`);
      else ok('a POST from an unrelated origin is still refused');

      // A RAW SOCKET, not fetch: `Host` is a forbidden header there, so undici drops it silently and the
      // assertion passes against a request that never carried the thing being tested. The first version
      // of this check did exactly that and reported 404.
      const rebound = await new Promise((resolve) => {
        const sock = connect(Number(new URL(lan).port), new URL(lan).hostname, () => {
          sock.write('POST /api/prompts HTTP/1.1\r\n'
            + `Host: attacker.example:${new URL(lan).port}\r\n`
            + 'Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
        });
        let buf = '';
        sock.on('data', (b) => { buf += b; });
        sock.on('end', () => resolve(Number((buf.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1] ?? 0)));
        sock.on('error', () => resolve(0));
        sock.setTimeout(5000, () => { sock.destroy(); resolve(0); });
      });
      if (rebound !== 403) fail(`a POST whose Host is a NAME was not refused (${rebound}) — DNS rebinding gets past an address check that way`);
      else ok('and a request whose Host is a name rather than an address is refused');
    }
  }

  child.kill('SIGINT');
  const dead = await until(() => child.exitCode !== null || child.signalCode !== null, 10_000);
  if (!dead) {
    child.kill('SIGKILL');
    fail('SIGINT did NOT stop it — the process kept the port, which is how a stale server ends up answering for the wrong repo');
  } else ok('SIGINT stops it: the process exits and the port is released');
  if (!/no longer served/.test(out)) fail('and it says the page is gone rather than dying silently');
  else ok('and says the page is gone');

  rmSync(repo, { recursive: true, force: true });
}

// A subcommand owns its own arguments — a whitelist applied to those would reject flags that are
// valid one frame down, which is why the check returns early when argv[2] names a subcommand.
const sub = launch(['indulge', '--status']);
if (!(sub.code === 2 && /unknown option/.test(sub.err))) ok("a subcommand's own flags are NOT validated here");
else failures.push('subcommand flags were rejected by the bare-launch whitelist');

console.log(failures.length ? `\ncli check: ${failures.length} FAILED` : '\ncli check: ok');
process.exit(failures.length ? 1 : 0);
