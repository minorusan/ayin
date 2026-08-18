/**
 * check-connector-loop.mjs — the two ways a connector's inner loop wastes an operator's minute.
 *
 * A connector runs several model calls before the outer agent starts, so every defect here is paid in
 * wall-clock on a turn someone is watching. Both of these shipped, and both were invisible: the loop
 * produced correct answers, slowly.
 *
 * 1. A PROTOCOL LINE THAT CARRIES ITS OWN EXPLANATION. Written as
 *
 *        open <TICKET-KEY>   — when you must read a ticket's description and comments first
 *
 *    the model cannot tell the format from the commentary, so it emits the whole line back. The
 *    operator sees the prompt's own help text quoted at them as if it were an answer, and — because
 *    the loop treats a repeated `open` as a stall — the connector burns an ENTIRE extra model call,
 *    every single time, before it is allowed to answer.
 *
 * 2. A SYSTEM MESSAGE THAT CHANGES EVERY ROUND. Interpolating what has been read so far, or a
 *    decrementing round counter, into the system message moves the prompt PREFIX — so the server's
 *    KV cache matches nothing and each round reprocesses the whole prompt, ticket text included.
 *    Whatever grows belongs in the user turn, at the end.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const failures = [];
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };

// ── 1. protocol lines carry no trailing prose ────────────────────────────────────
const promptRoot = join(root, 'prompts');
const dirs = existsSync(promptRoot)
  ? readdirSync(promptRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

// A protocol line is a bare verb followed by a placeholder — the shape a model is meant to copy.
const PROTOCOL = /^\s*(answer|open|search|fetch|read|get)\s+<[^>]+>/i;
let checkedLines = 0;
for (const ns of dirs) {
  for (const file of readdirSync(join(promptRoot, ns)).filter((f) => f.endsWith('.txt'))) {
    const path = join(promptRoot, ns, file);
    for (const [i, line] of readFileSync(path, 'utf-8').split('\n').entries()) {
      if (!PROTOCOL.test(line)) continue;
      checkedLines++;
      // Anything after the placeholder that is prose — an em dash, a hyphen used as one, a comment.
      if (/[—–]|\s-\s|\s#\s/.test(line.replace(/^\s*\w+\s+<[^>]+>/, ''))) {
        fail(`${ns}/${file}:${i + 1} — a protocol line explains itself on the same line; the model copies the explanation into the command`);
      }
    }
  }
}
if (checkedLines === 0) ok('no protocol lines to check (nothing to regress)');
else if (!failures.length) ok(`${checkedLines} protocol line(s) carry the format only, no trailing prose`);

// ── 2. connector system prompts do not interpolate what changes per round ────────
const VOLATILE = ['OBSERVATIONS', 'REMAINING', 'ROUND'];
const loops = join(root, 'src', 'tools', 'connectors');
const loopFiles = [];
if (existsSync(loops)) {
  for (const d of readdirSync(loops, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const f = join(loops, d.name, 'loop.ts');
    if (existsSync(f)) loopFiles.push([d.name, f]);
  }
}

for (const [name, file] of loopFiles) {
  const src = readFileSync(file, 'utf-8');
  // The NON-final system prompt is the one sent on every gathering round; `final` is sent once, so a
  // volatile value there costs nothing.
  const m = /prompts\.get\('loop',\s*\{([^}]*)\}/s.exec(src);
  if (!m) { ok(`${name}: no per-round 'loop' prompt to check`); continue; }
  const bad = VOLATILE.filter((v) => m[1].includes(v));
  if (bad.length) {
    fail(`${name}: the per-round SYSTEM prompt interpolates ${bad.join(', ')} — the prefix moves every round, so the whole prompt is reprocessed`);
  } else {
    ok(`${name}: the per-round system prompt is stable; what grows rides in the user turn`);
  }
}
if (loopFiles.length === 0) ok('no connector loops present');

console.log(failures.length ? `\nconnector loop check: ${failures.length} FAILED` : '\nconnector loop check: ok');
process.exit(failures.length ? 1 : 0);
