#!/usr/bin/env node

/**
 * ayin's entry point — and deliberately nothing but a gate.
 *
 * The app lives in `app.ts`. This file exists so that ONE check can run before the terminal is taken:
 * `ui/screen.ts` creates the blessed screen at module scope, and ESM evaluates every static import
 * before any statement in the importing module — so a check written inside the app cannot run first, no
 * matter where in the file it is placed. A dynamic import is the only ordering that holds.
 *
 * Keep this file empty of features. Anything added here runs before the UI exists, without a log sink,
 * and with no way to tell the operator anything except by writing to stdout.
 */

import { namesOfKind, suggestNames } from './help.js';
import { preflight } from './preflight.js';

// HELP BEFORE ANYTHING ELSE, including the preflight gate: someone asking what the commands are must
// not first be asked to configure a model. It also must not touch `app.ts`, which creates the blessed
// screen at import scope — the whole reason this file exists.
const helpArg = process.argv[2];
if (helpArg === '--help' || helpArg === '-h' || helpArg === 'help') {
  const { runHelp } = await import('./help-page.js');
  process.exit(runHelp(process.argv.slice(3)));
}

/**
 * `ayin <subcommand> --help`, for the subcommands that never had one.
 *
 * `watch`, `unwatch`, `update`, `debug` and `explain` install hooks, remove them, replace the binary,
 * write bundles and spend model time — and asking any of them for help did nothing at all: the flag
 * fell through to the command, which ignored it and RAN. Asking a daemon how it works started it.
 *
 * The four with their own USAGE keep it: those strings are specific about flags and have been correct
 * for longer than this page has existed.
 */
const NO_OWN_USAGE = new Set(['watch', 'unwatch', 'update', 'debug', 'explain']);
if (NO_OWN_USAGE.has(helpArg ?? '')
  && process.argv.slice(3).some((a) => a === '--help' || a === '-h')) {
  const { runHelp } = await import('./help-page.js');
  process.exit(runHelp([`ayin ${helpArg}`]));
}

/**
 * A MISTYPED FLAG MUST FAIL, not launch a normal session.
 *
 * Nothing validated argv, so `ayin --ful` started an ordinary TUI with none of the three switches on
 * and said nothing about it — indistinguishable from a working flag until the thing it was supposed to
 * enable failed to happen. `--dangerously-skip-permissions` is in that set, which makes a silent
 * typo a security-shaped bug rather than an inconvenience.
 *
 * SCOPED TO A BARE LAUNCH, and that is the whole subtlety. Every subcommand parses its OWN arguments —
 * `indulge --domains`, `diff --no-open`, `watch --repo` — so a whitelist applied to those would reject
 * flags that are perfectly valid one frame down. When argv[2] names a subcommand this returns
 * immediately and the subcommand stays the authority on its own surface.
 *
 * Flags that consume the NEXT argument skip it: `-p "some prompt"` must not have its prompt validated
 * as a flag, and a prompt beginning with `--` would otherwise be rejected as one.
 */
function rejectUnknownFlags(): void {
  const SUBCOMMANDS = new Set([
    'watch', 'unwatch', 'kill', 'indulge', 'launch', 'testrun', 'debug', 'diff', 'sprint', 'update',
    'explain', 'version', 'help', 'sentinaile-supervisor', 'unity', 'chore',
  ]);
  const args = process.argv.slice(2);
  if (args.length === 0) return;
  if (SUBCOMMANDS.has(args[0])) return;                 // the subcommand owns its arguments

  /**
   * A MISTYPED SUBCOMMAND MUST NOT LAUNCH A SESSION.
   *
   * A bare word that is not a subcommand used to be waved through as "not our business", so
   * `ayin unty prefab Assets/Widget.prefab` opened the TUI and threw the rest of the line away — the
   * operator watched a session boot and had to work out what they had actually asked for. It is a typo,
   * and the help list knows what was meant.
   */
  if (!args[0].startsWith('-')) {
    const near = suggestNames(args[0], 'cli');
    process.stderr.write(`ayin: unknown command "${args[0]}"\n`);
    if (near.length) process.stderr.write(`Did you mean: ${near.map((n) => `ayin ${n}`).join(' · ')}?\n`);
    process.stderr.write(`Commands: ${namesOfKind('cli').join(' ')}\n`);
    process.stderr.write('A bare `ayin` starts a session; `ayin --help` lists everything.\n');
    process.exit(2);
  }

  /** Bare-launch flags, each one actually read somewhere in this codebase. */
  const KNOWN = new Set([
    '-p', '--prompt', '--non-interactive',              // headless; these take a value
    '--full', '--debug', '--dangerously-skip-permissions', '--thinking', '--transcribe',
    '--disallow-subagents', '--allow-parallel-subagents', '--postmortem',
    '--help', '-h', '--version', '-v',
  ]);
  const TAKES_VALUE = new Set(['-p', '--prompt', '--non-interactive']);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--prompt=')) continue;
    if (KNOWN.has(a)) {
      if (TAKES_VALUE.has(a)) i++;                      // its value is not a flag
      continue;
    }
    if (!a.startsWith('-')) continue;                   // a flag's value, already skipped above
    process.stderr.write(`ayin: unknown option ${a}\n`);
    process.stderr.write(`Known options on a bare launch: ${[...KNOWN].join(' ')}\n`);
    process.stderr.write('Subcommands take their own flags — try `ayin <subcommand> --help`.\n');
    process.exit(2);
  }
}

rejectUnknownFlags();

// Returns only when ayin has a model to talk to; exits the process otherwise.
await preflight();

// Only now does blessed initialise.
await import('./app.js');
