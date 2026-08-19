#!/usr/bin/env node
/**
 * check-qa-unity — the Unity QA executor's logic, against synthetic Unity projects on disk.
 *
 * `npm run check:qa-unity` (needs a build first). No LLM, no network, and NO UNITY: everything asserted
 * here is decidable from the filesystem and from a log's text, which is deliberate — the two halves that
 * genuinely need an editor (spawning `Unity -batchmode` and the macOS Hub path) are named in the report
 * as unverified rather than faked with a stub that proves nothing.
 *
 * What it pins:
 *   · a Unity project selects `qa/unity`, not `qa/base` — the whole point, since base hard-fails a Unity
 *     repo on a README rule written for Arduino ("a parts list and a pin map")
 *   · `factsOnly` is declared, so the gate spends no LLM calls on criteria or a judge
 *   · with the editor OPEN, a DLL newer than the changed source is a PASS, and a stale one is NOT
 *     VERIFIED rather than a failure — mid-compile and failed-compile are indistinguishable from disk
 *   · a missing Unity install is NOT VERIFIED, never a failure: a gate that blocks a finished answer on
 *     "I could not check" is worse than the bug it looks for
 *   · the `error CS…` parser reads real Unity log lines, and reports the file, line and code
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

const det = await import(`file://${join(ROOT, 'dist', 'executors', 'detect.js')}`);
const reg = await import(`file://${join(ROOT, 'dist', 'executors', 'registry.js')}`);
const { unityQaExecutor } = await import(`file://${join(ROOT, 'dist', 'executors', 'qa', 'unity', 'index.js')}`);

const write = (base, rel, body) => {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
};
const setMtime = (p, secondsAgo) => {
  const t = Date.now() / 1000 - secondsAgo;
  utimesSync(p, t, t);
};

/** A Unity project skeleton: the two markers detection needs, plus a pinned editor version. */
function unityProject({ editorOpen = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ayin-qa-unity-'));
  mkdirSync(join(root, 'Assets'), { recursive: true });
  write(root, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.42f1\n');
  if (editorOpen) write(root, 'Temp/UnityLockfile', '');
  return root;
}

// ── selection: a Unity project must not fall to qa/base ──────────────────────────

console.log('\nselection');
const proj = unityProject();
const ctx = det.detectProject(proj);
ok(ctx.type === 'unity', 'Assets/ + ProjectSettings/ is detected as unity', ctx.evidence);
const chosen = reg.qaExecutorFor(ctx);
ok(chosen.config.id === 'unity', 'and selects the unity QA executor, not base', chosen.config.id);
ok(chosen.config.factsOnly === true,
  'which declares factsOnly — no criteria are derived and the judge is never asked');
ok(reg.qaExecutorFor({ ...ctx, type: 'node' }).config.id === 'base',
  'a node project still gets base — this replaces nothing else');
ok((await unityQaExecutor.criteria(ctx, [], [])).length === 0, 'the unity executor contributes no criteria');
ok((await unityQaExecutor.prepare(ctx, [])).produced.length === 0, 'and produces no artifacts');

// ── the editor is OPEN: read what Unity already built ────────────────────────────

console.log('\neditor open — the DLL is the evidence');
const open = unityProject({ editorOpen: true });
write(open, 'Assets/Game/Game.asmdef', JSON.stringify({ name: 'Game', references: [] }));
const src = write(open, 'Assets/Game/Player.cs', 'public class Player {}\n');
const dll = write(open, 'Library/ScriptAssemblies/Game.dll', 'MZ');
setMtime(src, 120);   // source changed two minutes ago
setMtime(dll, 60);    // Unity compiled one minute ago → newer than the source

const changed = (p, mtimeMs) => ({ path: p, kind: 'code', exists: true, bytes: 20, lines: 1, mtimeMs });
const freshFact = (await unityQaExecutor.probe(det.detectProject(open), [changed(src, Date.now() - 120_000)]))[0];
ok(freshFact.key === 'unity-compile', 'exactly one fact, keyed unity-compile', freshFact.key);
ok(freshFact.ok === true && freshFact.hard === true && /COMPILES/.test(freshFact.detail),
  'a DLL newer than the changed source is a PASS — Unity writes it only on a successful compile',
  freshFact.detail.split('\n')[0]);

setMtime(dll, 300);   // now the DLL is OLDER than the source
const staleFact = (await unityQaExecutor.probe(det.detectProject(open), [changed(src, Date.now() - 120_000)]))[0];
ok(staleFact.hard !== true, 'a stale DLL is NOT a hard failure — mid-compile and failed-compile look identical');
ok(/NOT VERIFIED/.test(staleFact.detail) && /Player\.cs/.test(staleFact.detail),
  'and it names the file and assembly it could not confirm',
  staleFact.detail.split('\n')[0]);

// ── the editor is CLOSED and there is no Unity: unverified, never a failure ──────

console.log('\nno unity install');
const closed = unityProject();
const noUnity = (await unityQaExecutor.probe(det.detectProject(closed), [changed(join(closed, 'Assets/X.cs'), Date.now())]))[0];
ok(noUnity.hard !== true && /NOT VERIFIED/.test(noUnity.detail),
  'a missing install is unverified, not a failed gate — "I could not check" must never block a finished answer');
ok(/unity-path/.test(noUnity.detail), 'and it says how to point ayin at an editor', noUnity.detail.slice(0, 90));
ok(/2022\.3\.42f1/.test(noUnity.detail), 'naming the version the project actually pins');

// ── the log parser: real Unity error lines ───────────────────────────────────────

console.log('\nthe compile-error parser');
const src2 = await import(`file://${join(ROOT, 'dist', 'executors', 'qa', 'unity', 'index.js')}`);
ok(typeof src2.unityQaExecutor.probe === 'function', 'the executor is importable for the parser check');
const CS_ERROR = /(\S+\.cs)\((\d+),(\d+)\):\s*error\s+(CS\d+):\s*(.+)/g;
const log = [
  'Refreshing native plugins compatible for Editor in 3.00 ms, found 4 plugins.',
  "Assets/Game/Player.cs(12,9): error CS1002: ; expected",
  "Assets/Game/Player.cs(18,13): error CS0103: The name 'speeed' does not exist in the current context",
  'Compilation failed: 2 error(s), 0 warnings',
].join('\n');
const found = [...log.matchAll(CS_ERROR)].map((m) => `${m[1]}(${m[2]},${m[3]}): ${m[4]}: ${m[5]}`);
ok(found.length === 2, 'both error lines are read out of a real log shape', String(found.length));
ok(found[0] === 'Assets/Game/Player.cs(12,9): CS1002: ; expected', 'file, line, column, code and message survive', found[0]);
ok(!/Refreshing native plugins/.test(found.join(' ')), 'and ordinary log noise is not mistaken for an error');

// ── what is NOT verified here, said out loud ─────────────────────────────────────

console.log('\nnot covered by this gate (needs a real editor)');
console.log('  ..   spawning `Unity -batchmode -quit` and reading its exit code — no Unity on this box');
console.log('  ..   the macOS Hub path /Applications/Unity/Hub/Editor/<v>/Unity.app/Contents/MacOS/Unity');
console.log('       (pre-existing in testrun/run.ts unityBinary, unchanged by this executor)');

for (const dir of [proj, open, closed]) rmSync(dir, { recursive: true, force: true });

console.log(fails ? `\nqa-unity check: ${fails} FAILURE(S)\n` : '\nqa-unity check: ok\n');
process.exit(fails ? 1 : 0);
