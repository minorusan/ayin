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

// Returns only when ayin has a model to talk to; exits the process otherwise.
await preflight();

// Only now does blessed initialise.
await import('./app.js');
