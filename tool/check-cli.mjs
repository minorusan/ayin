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

console.log(failures.length ? `\ncli check: ${failures.length} FAILED` : '\ncli check: ok');
process.exit(failures.length ? 1 : 0);
