#!/usr/bin/env node
/**
 * tg-auth — Standalone Telegram MTProto auth command.
 * Run: tg-auth
 *
 * This entry point avoids loading the Blessed UI, which owns the terminal
 * and conflicts with interactive readline prompts.
 */

import { runTgAuth } from './tg-auth.js';

runTgAuth()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`tg-auth failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
