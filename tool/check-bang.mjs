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

// ── the spell-check in FRONT of the passthrough ─────────────────────────────────
// `runBang` stays verbatim (above); the one thing allowed to change a typed line is `vetRewrite`,
// and what it must mostly do is REFUSE. A model asked to "fix and maybe improve" a command will
// helpfully add an `-f`, a redirection or an `rm`, and the operator approved none of them.

const { vetRewrite } = await import(join(ROOT, 'dist/bang-check.js'));

ok(vetRewrite('gti staus -sb', 'git status -sb') === 'git status -sb', 'a spelling fix is accepted');
ok(vetRewrite('ls -la', 'OK') === null, 'a line that is already right runs as typed');
ok(vetRewrite('ls -la', 'ok\n') === null, 'the OK answer is matched loosely (case, whitespace)');
ok(vetRewrite('ls -la', '```sh\nls -la\n```') === null, 'a fence around the same line is not a change');
ok(vetRewrite('gti staus', '```\ngit status\n```') === 'git status', 'a fenced correction is unwrapped');
ok(vetRewrite('gti staus', '$ git status') === 'git status', 'a shell prompt marker is stripped');
ok(vetRewrite('ls', '') === null, 'an empty reply runs what was typed');
ok(vetRewrite('ls', 'I think you meant to list the files in the current directory, so here it is: ls -la')
  === null, 'a chatty reply three times the length is not a correction');

for (const [typed, reply, why] of [
  ['ls /tmp', 'rm -rf /tmp', 'a deletion that was never typed'],
  ['npm test', 'sudo npm test', 'sudo it was not given'],
  ['git statu', 'git status && git push', 'a push bolted onto a read'],
  ['git chekcout-ish note', 'git checkout main', 'an always-gated git op it did not ask for'],
  ['npm run build', 'npm run build > out.log', 'a redirection that swallows the output'],
  ['git reset', 'git reset --hard', 'a --hard that turns a no-op into data loss'],
]) ok(vetRewrite(typed, reply) === null, `refused escalation — ${why}`, JSON.stringify(reply));

// What is inside quotes is the operator's. This one was MEASURED against the live model, which
// "corrected" the search pattern and turned a search for a typo into a search that finds nothing.
ok(vetRewrite('grep -rn "wrold" src', 'grep -rn "world" src') === null,
  'a rewrite that respells the search pattern is refused — the typo WAS the search');
ok(vetRewrite("gti log --grep='teh fix'", "git log --grep='teh fix'") === "git log --grep='teh fix'",
  'the command around an untouched quoted string is still corrected');
ok(vetRewrite('echo "hi', 'echo "hi"') === 'echo "hi"',
  'an unbalanced quote is still fixable — with no closed pair there is nothing to protect');

ok(vetRewrite('rm -rf build', 'rm -rf build/') === 'rm -rf build/',
  'an escalation already in the typed line is not an escalation — the operator typed it');
ok(vetRewrite('git push origin man', 'git push origin main') === 'git push origin main',
  'correcting a push the operator typed is still a correction (the permission gate is elsewhere)');

console.log(fails ? `\nbang check: ${fails} FAILURE(S)\n` : '\nbang check: ok\n');
process.exit(fails ? 1 : 0);

