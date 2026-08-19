#!/usr/bin/env node
/**
 * check-io-tools — the I/O surface, against the measurement that produced it.
 *
 * `npm run check:io` (needs a build first). No LLM, no network: a throwaway tree in the temp dir, and the
 * real tools run against it.
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS. 483 recorded sessions, 5158 tool calls: `bash` had gone from 5% to
 * 20% of everything, and 573 of its 826 recent calls (69%) were work a tool could have done — `ls` 177,
 * `grep -r` 149, `cd X && …` 126, `find` 76, `mkdir -p` 58, `cat/head/tail` 65, `wc -l` 19. A second
 * agent's transcript said the same thing louder: 55% of its shell commands contained `grep`, 97% of those
 * PIPED (1195 into another grep, 1081 into head), and its flag histogram was `-n` 910 · `-vE` 816 · `-c`
 * 297 · `-o` 234 · `-l` 44.
 *
 * Every param asserted below exists because one of those numbers exists. A tool that cannot express what a
 * shell one-liner expresses does not get used — it gets worked around, and the workaround is unbounded
 * output through a general shell.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

(await import(`file://${join(ROOT, 'dist', 'tool-wiring.js')}`)).ensureToolRuntime();
const { tool: grep } = await import(`file://${join(ROOT, 'dist', 'tools', 'defs', 'grep.js')}`);
const { tool: listDir } = await import(`file://${join(ROOT, 'dist', 'tools', 'defs', 'list_dir.js')}`);
const { tool: readFile } = await import(`file://${join(ROOT, 'dist', 'tools', 'defs', 'read_file.js')}`);
const { tool: findFiles } = await import(`file://${join(ROOT, 'dist', 'tools', 'defs', 'find_files.js')}`);
const { tool: bash } = await import(`file://${join(ROOT, 'dist', 'tools', 'defs', 'bash.js')}`);

const root = mkdtempSync(join(tmpdir(), 'ayin-io-'));
const write = (rel, body) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
};
write('src/a.ts', ['import { x } from "./b.js";', 'export function alpha() {}', '// TODO later', ''].join('\n'));
write('src/b.ts', ['export function beta() {}', 'export function betaTwo() {}', ''].join('\n'));
write('src/nested/deep/c.ts', 'export function gamma() {}\n');
write('node_modules/dep/index.ts', 'export function shouldNotBeFound() {}\n');
write('log.txt', Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'));
const old = write('src/old.ts', 'export function ancient() {}\n');
utimesSync(old, Date.now() / 1000 - 86400 * 5, Date.now() / 1000 - 86400 * 5);

// ── list_dir: the 177 `ls` calls ──────────────────────────────────────────────────

console.log('\nlist_dir (there was no tool for this at all)');
const listed = await listDir.execute({ path: join(root, 'src') });
ok(/a\.ts/.test(listed) && /b\.ts/.test(listed), 'files are listed', listed.split('\n')[0]);
ok(/dir .*nested\//.test(listed), 'a directory is marked as one and sorted first');
ok(/ago/.test(listed), 'each entry carries how long ago it changed — "which of these did the run touch"');
ok(/entr(y|ies)\)/.test(listed), 'and the count is stated');
const capped = await listDir.execute({ path: join(root, 'src'), limit: 2 });
ok(/showing 2 of \d+ entries/.test(capped), 'truncation is ANNOUNCED, never silent', capped.split('\n').pop());
ok(/is a FILE/.test(await listDir.execute({ path: join(root, 'log.txt') })), 'pointing it at a file says so and names read_file');
ok(/not found/.test(await listDir.execute({ path: join(root, 'nope') })), 'a missing path is an error, not an empty listing');
const rec = await listDir.execute({ path: join(root, 'src'), recursive: true, limit: 50 });
ok(/nested\/deep\//.test(rec), 'recursive=true reaches one level in');

// ── grep: the flags the transcripts actually used ─────────────────────────────────

console.log('\ngrep (149 shell greps, 97% of them piped)');
const counts = await grep.execute({ pattern: 'export function', path: join(root, 'src'), count: true });
ok(/a\.ts:1/.test(counts) && /b\.ts:2/.test(counts), 'count=true gives per-file counts (`grep -c`, 297 uses)', counts.split('\n')[0]);
ok(!/:0/.test(counts), 'and files with ZERO matches are dropped — grep prints them, they are not an answer');
const only = await grep.execute({ pattern: 'export function [a-z]+', path: join(root, 'src'), only_matching: true });
ok(/export function beta\b/.test(only) && !/\{\}/.test(only), 'only_matching returns the matched text, not the line (`grep -o`, 234 uses)');
const inverted = await grep.execute({ pattern: 'export', path: join(root, 'src/a.ts'), invert: true });
ok(/TODO/.test(inverted) && !/export function alpha/.test(inverted), 'invert=true returns the lines that do NOT match (`grep -v`, 1190 uses)');
const excluded = await grep.execute({ pattern: 'export function', path: join(root, 'src'), exclude: 'betaTwo' });
ok(/beta\(\)/.test(excluded) && !/betaTwo/.test(excluded), 'exclude is the second grep of a `grep X | grep -v Y` chain (1195 uses)');
const limited = await grep.execute({ pattern: 'export function', path: join(root, 'src'), max_matches: 1 });
ok(/showing the first 1 match\b/.test(limited), 'max_matches is the `| head -N` (1081 uses), and says it truncated', limited.split('\n').pop());
// Assert on the PATH, not on the pattern: a "0 matches" reply echoes the pattern back, so testing for the
// symbol name passes when the tool works AND when it does not. Caught by this gate on its first run.
const pruned = await grep.execute({ pattern: 'shouldNotBeFound', path: root });
ok(!/node_modules/.test(pruned) && /0 matches/.test(pruned), 'node_modules is never descended into', pruned.split('\n')[0]);
ok(/0 matches/.test(await grep.execute({ pattern: 'zzzznope', path: root })),
  'no match reads as "the pattern missed", never as "this does not exist"');

// ── read_file: tail and the always-on counts ─────────────────────────────────────

console.log('\nread_file (65 cat/head/tail calls, 19 wc)');
const tailed = await readFile.execute({ path: join(root, 'log.txt'), tail: 3 });
ok(/38\tline 38/.test(tailed) && /40\tline 40/.test(tailed), 'tail=N returns the LAST n lines, numbered from their real position');
ok(!/line 1\b/.test(tailed.split('\n').slice(1).join('\n')), 'and nothing from the top');
ok(/lines 38-41 of 41/.test(tailed) || /lines 38-40 of 40/.test(tailed), 'the header states the range and the total', tailed.split('\n')[0]);
const head = await readFile.execute({ path: join(root, 'log.txt'), limit: 2 });
ok(/of \d+, \d+/.test(head) || /KB\)/.test(head), 'every read reports size — a `wc -l` is never its own call', head.split('\n')[0]);

// ── find_files: depth, recency, exclude ─────────────────────────────────────────

console.log('\nfind_files (76 shell finds)');
const shallow = await findFiles.execute({ path: root, pattern: '*.ts', max_depth: 2 });
ok(/a\.ts/.test(shallow) && !/deep\/c\.ts/.test(shallow), 'max_depth stops the walk where asked');
const recent = await findFiles.execute({ path: root, pattern: '*.ts', modified_since: '1h' });
ok(/a\.ts/.test(recent) && !/old\.ts/.test(recent), 'modified_since="1h" answers "what did this turn touch"', recent.split('\n')[0]);
const noTests = await findFiles.execute({ path: root, pattern: '*.ts', exclude: '*/nested/*' });
ok(!/nested/.test(noTests), 'exclude drops a subtree without a second call');

// ── bash: a cwd instead of `cd X && …` ──────────────────────────────────────────

console.log('\nbash (126 `cd X && …` prefixes)');
const pwd = (await bash.execute({ command: 'pwd', cwd: join(root, 'src') })).trim();
ok(pwd.endsWith('/src'), 'cwd runs the command there — no `cd` prefix needed', pwd);
const bad = await bash.execute({ command: 'pwd', cwd: join(root, 'nope') });
ok(/cwd not found/.test(bad),
  'a missing cwd is REFUSED, not silently run in the session root — a build in the wrong tree looks like success',
  bad.split('\n')[0]);

rmSync(root, { recursive: true, force: true });
console.log(fails ? `\nio tools check: ${fails} FAILURE(S)\n` : '\nio tools check: ok\n');
process.exit(fails ? 1 : 0);
