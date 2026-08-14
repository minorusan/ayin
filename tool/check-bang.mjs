#!/usr/bin/env node
/**
 * check-bang — `!<command>` is a passthrough, and a passthrough with opinions is broken.
 *
 * `npm run check:bang` (needs a build first). No LLM, no network.
 *
 * The feature exists because typing `!git status -sb` used to be an ordinary prompt: the model read
 * it, decided what the operator meant, and called the bash tool with its own rewrite — which is why
 * it looked like only the first word survived. So the assertions here are mostly about ABSENCE: the
 * line reaches the shell unchanged, whatever is in it.
 *
 * The rest is about not hanging the UI. A passthrough that cannot be cancelled, floods the panel, or
 * lets command output be read as markup is worse than not having one.
 */

if (!process.argv.includes('-p')) process.argv.push('-p'); // never build blessed widgets

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const B = await import(join(ROOT, 'dist/bang.js'));
const UI = await import(join(ROOT, 'dist/ui.js'));

// ── the line reaches the shell exactly as typed ─────────────────────────────────

const quoted = await B.runBang('echo "one two three" | tr a-z A-Z');
ok(quoted.output === 'ONE TWO THREE', 'quotes and a pipe survive — the whole line runs, not the first word', JSON.stringify(quoted.output));

const flags = await B.runBang('printf "%s|%s\\n" -sb --porcelain');
ok(flags.output === '-sb|--porcelain', 'flags are not eaten', JSON.stringify(flags.output));

const multi = await B.runBang('cd /tmp && pwd');
ok(multi.output === '/tmp', 'multi-statement commands work', JSON.stringify(multi.output));

const streams = await B.runBang('echo to-stdout; echo to-stderr 1>&2');
ok(streams.output === 'to-stdout\nto-stderr',
  'stdout and stderr are merged in arrival order — separating them reorders the story', JSON.stringify(streams.output));

const code = await B.runBang('exit 3');
ok(code.exitCode === 3, 'the exit code is reported, not swallowed');
const missing = await B.runBang('nosuchcommand_xyz_zz');
ok(missing.exitCode === 127 && /not found/i.test(missing.output),
  "a command that does not exist returns the SHELL's own error", JSON.stringify(missing.output.slice(0, 40)));

// ── it cannot hang or flood the UI ──────────────────────────────────────────────

ok(B.bangRunning() === false, 'nothing is running between commands');
const slow = B.runBang('sleep 30');
await new Promise((r) => setTimeout(r, 300));
ok(B.bangRunning() === true, 'a running command is visible to the key handler, so Esc can reach it');
ok(B.cancelBang() === true, 'cancel reports that it killed something');
const cancelled = await slow;
ok(cancelled.cancelled === true && cancelled.ms < 5000,
  'cancel actually stops it instead of waiting out the sleep', `${(cancelled.ms / 1000).toFixed(1)}s`);
ok(B.bangRunning() === false, 'the slot is free again afterwards');
ok(B.cancelBang() === false, 'cancelling with nothing running is a no-op, not a crash');

const timed = await B.runBang('sleep 5', { timeoutMs: 700 });
ok(timed.timedOut === true && timed.ms < 4000, 'a hung command times out and frees the UI', `${(timed.ms / 1000).toFixed(1)}s`);

const flood = await B.runBang('head -c 400000 /dev/zero | tr "\\0" "x"');
ok(flood.truncated === true && /output cut at/.test(flood.output),
  'a flood of output is cut AND says so — a silent clip reads as the whole answer');

// ── rendering: visibly different, and never corrupted by the output itself ──────

const card = UI.formatShellForChat('git status', 'M src/app.ts', { exitCode: 0, ms: 340, timedOut: false, cancelled: false });
ok(card.includes('{bold}'), 'the card is bold, so a passthrough never reads as the agent talking');
ok(/✓/.test(card), 'a successful command is marked');

const nasty = UI.formatShellForChat('printf x', '{bold}{red-fg}not markup{/}', { exitCode: 0, ms: 5, timedOut: false, cancelled: false });
ok(nasty.includes('\\{bold\\}') || !nasty.includes('{bold}{red-fg}not markup'),
  'command output that looks like blessed markup is escaped before the bold tags go on');

const failed = UI.formatShellForChat('exit 3', '', { exitCode: 3, ms: 20, timedOut: false, cancelled: false });
ok(/✗/.test(failed) && /exit 3/.test(failed), 'a failure is marked and names the exit code');
ok(/no output/.test(failed), 'a command that printed nothing says so rather than showing an empty card');

const stopped = UI.formatShellForChat('sleep 30', '', { exitCode: null, ms: 300, timedOut: false, cancelled: true });
ok(/cancelled/.test(stopped), 'a cancelled command is labelled cancelled, not failed');

// ── the always-gated git operations ─────────────────────────────────────────────
// Added after the agent pushed to a remote unasked. `git push/pull/checkout` are confirmed EVERY
// time: a push is public and cannot be un-published, and a pull or a checkout can destroy
// uncommitted work. No whitelist, no skip flag and no headless run may wave them through.

const P = await import(join(ROOT, 'dist/permissions.js'));

for (const c of [
  'git push', 'git push origin main', 'git push --force origin HEAD:main',
  'git pull', 'git pull --rebase origin dev',
  'git checkout main', 'git checkout -b x', 'git checkout -- src/app.ts',
  'cd /repo && git push', 'git -C /repo push origin main',
  'npm run build && git push', 'git add -A && git commit -m x && git push',
]) ok(P.dangerousShellOp(c) !== null, `always gated: ${JSON.stringify(c)}`);

for (const c of [
  'git status', 'git log --oneline -5', 'git diff HEAD',
  'git log --grep=push',                 // the word is only a flag value
  'git log --oneline | grep checkout',   // a different segment, not a git op
  'echo "remember to push"', 'npm run push-docs', 'grep -rn pull src/',
]) ok(P.dangerousShellOp(c) === null, `not gated (needless friction): ${JSON.stringify(c)}`);

// This file runs headless, which is exactly the unattended case.
ok(await P.checkPermission('bash', { command: 'git push origin main' }) === 'deny',
  'unattended: the answer to "may I push?" with no human present is NO');
ok(await P.checkPermission('bash', { command: 'git pull' }) === 'deny', 'unattended: pull denied');
ok(await P.checkPermission('bash', { command: 'git checkout main' }) === 'deny', 'unattended: checkout denied');
ok(await P.checkPermission('bash', { command: 'git status' }) === 'allow',
  'a harmless git command is untouched — this gate is narrow on purpose');

console.log(fails ? `\nbang check: ${fails} FAILURE(S)\n` : '\nbang check: ok\n');
process.exit(fails ? 1 : 0);

