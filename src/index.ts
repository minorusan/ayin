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

// Returns only when ayin has a model to talk to; exits the process otherwise.
await preflight();

// Only now does blessed initialise.
await import('./app.js');
