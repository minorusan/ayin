/**
 * check-cli.mjs — a subcommand must not start the agent it does not need.
 *
 * `ayin unwatch` removes git hooks from a repository. It shipped taking over the whole terminal with
 * a full-screen TUI and demanding a configured model first — so undoing a watcher was impossible on
 * the machine where the model had gone away, which is exactly when someone wants it undone. Nothing
 * failed; it was simply wrong in a way only a person watching would notice.
 *
 * Three lists decide this, in three files, and they were kept in step by memory:
 *   - the DISPATCH in app.ts (`process.argv[2] === 'x'`) — what exists
 *   - NO_TUI_COMMANDS in ui/headless.ts — what may not take the terminal
 *   - NO_MODEL_NEEDED in preflight.ts — what may not be gated behind configuring a model
 *
 * A new subcommand lands in the first and is forgotten in the other two. This gate makes that a build
 * failure instead of a bug report, and it asks for an explicit decision rather than a default: a
 * command that genuinely wants the TUI or genuinely needs a model says so HERE, by name.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const app = readFileSync(join(REPO, 'src/app.ts'), 'utf-8');
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

const noTui = listBetween(headless, 'NO_TUI_COMMANDS = new Set(');
const noModel = listBetween(preflight, 'NO_MODEL_NEEDED = new Set(');
if (!noTui) fail('NO_TUI_COMMANDS not found in ui/headless.ts — this gate cannot check anything');
if (!noModel) fail('NO_MODEL_NEEDED not found in preflight.ts — this gate cannot check anything');

const dispatched = [...new Set([...app.matchAll(/process\.argv\[2\] === '([a-z][a-z-]*)'/g)].map((m) => m[1]))]
  .filter((c) => !['--version', '-v'].includes(c));

if (dispatched.length < 5) fail(`only ${dispatched.length} subcommand(s) found in app.ts — the dispatch shape changed and this gate is reading the wrong thing`);
else ok(`${dispatched.length} subcommands dispatched in app.ts`);

for (const cmd of dispatched) {
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

import { execFileSync } from 'node:child_process';

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

// A subcommand owns its own arguments — a whitelist applied to those would reject flags that are
// valid one frame down, which is why the check returns early when argv[2] names a subcommand.
const sub = launch(['indulge', '--status']);
if (!(sub.code === 2 && /unknown option/.test(sub.err))) ok("a subcommand's own flags are NOT validated here");
else failures.push('subcommand flags were rejected by the bare-launch whitelist');

console.log(failures.length ? `\ncli check: ${failures.length} FAILED` : '\ncli check: ok');
process.exit(failures.length ? 1 : 0);
