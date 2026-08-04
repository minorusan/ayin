/**
 * "Is this Arduino project LEGIT?" — one verdict per project, no partial credit.
 *
 * The benchmark grader (`arduino-bench.mjs`) scores 15-odd checks per project, which is right for
 * telling whether a change helped. It is the wrong instrument for the question actually being asked
 * here: *are these seven projects real, working Arduino projects?* A project at 14/15 reads like a pass
 * and may not compile.
 *
 * So this asks six things, all deterministic, and a project is LEGIT only if every one holds. No score,
 * no percentage — PASS or the list of what is wrong.
 *
 *   1. COMPILES        real `arduino-cli compile` against the target board
 *   2. NAMED           sketch filename matches its folder exactly (the toolchain refuses otherwise)
 *   3. DOCUMENTED      README with a parts list, a pin map, build/upload commands, and no TODO left
 *   4. DIAGRAMMED      `<sketch>.wiring.puml` + `.svg`, carrying the generator's provenance stamp
 *   5. DIAGRAM VALID   the real PlantUML renderer parses it
 *   6. PIN-CORRECT     no `analogWrite` on a pin without hardware PWM on this board
 *
 * Behaviour beyond that (does the state machine latch, is the beep interval non-blocking) is checked by
 * the benchmark's per-project markers; this is the floor. Everything here is a fact a compiler, a
 * renderer or the filesystem produced — nothing is a model's opinion.
 *
 *   node tool/arduino-legit.mjs <dir>
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SPEC = JSON.parse(readFileSync(join(ROOT, 'bench', 'arduino', 'projects.json'), 'utf8'));

/** The seven, in ascending complexity — from `bench/arduino/ladder.json`, shared with the wiring audit. */
const LADDERS = JSON.parse(readFileSync(join(ROOT, 'bench', 'arduino', 'ladder.json'), 'utf8'));
const LADDER_KEY = process.argv.includes('--ladder') ? `ladder${process.argv[process.argv.indexOf('--ladder') + 1]}`.replace('ladder1', 'ladder') : 'ladder';
if (!LADDERS[LADDER_KEY]) { console.error(`no such ladder: ${LADDER_KEY} (have: ${Object.keys(LADDERS).filter((k) => k.startsWith('ladder')).join(', ')})`); process.exit(2); }
export const LADDER = LADDERS[LADDER_KEY].map((l) => l.id);

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error('usage: node tool/arduino-legit.mjs <dir containing one subdir per project>');
  process.exit(2);
}

/**
 * Refuse to judge while ayin is still writing.
 *
 * A project graded mid-run reports whatever happens to be on disk at that instant, and I did exactly
 * that twice — once calling traffic-light 2/7 while it was three rounds from finishing, once calling
 * parking-sensor NOT LEGIT for a README the agent had not reached yet. Both verdicts were wrong and
 * both looked authoritative. A verdict on unfinished work is worse than no verdict.
 */
function benchRunning() {
  try {
    // THE BRACKET IS LOAD-BEARING. `pgrep -f "dist/index.js -p"` spawns a shell whose own command line
    // contains that literal string, so the pattern matches the pgrep itself and the check is ALWAYS
    // true — the guard then refuses to grade forever, including when nothing is running. `[d]ist`
    // matches the same processes without matching the search command. Third self-match of this exact
    // shape today: the first left a waiter blocked on itself for twenty minutes.
    const out = execSync('pgrep -f "[d]ist/index.js -p" || true', { encoding: 'utf8' }).trim();
    return out.length > 0;
  } catch { return false; }
}
if (benchRunning() && !process.argv.includes('--anyway')) {
  console.error('REFUSING to grade: an ayin run is still in flight, so the files on disk are mid-write.');
  console.error('Wait for it to finish, or pass --anyway if you know what you are looking at.');
  process.exit(3);
}

const toolchain = await import(`file://${join(DIST, 'tools/arduino-toolchain.js')}`);
const explain = await import(`file://${join(DIST, 'tools/arduino-explain.js')}`);
const diagram = await import(`file://${join(DIST, 'tools/arduino-diagram.js')}`);
// THE SAME implementation ayin's own QA gate uses. Three copies of the pin-map check existed and two
// were stale, so this tool and the wiring audit disagreed about the same README. See `readmePinTokens`.
const deliv = await import(`file://${join(DIST, 'executors/deliverables.js')}`);

function readmeVerdict(root) {
  const p = join(root, 'README.md');
  if (!existsSync(p)) return 'no README.md';
  const text = readFileSync(p, 'utf8');
  if (/\bTODO\b/.test(text)) return `README still has ${(text.match(/\bTODO\b/g) || []).length} TODO marker(s)`;
  if (text.trim().length < 200) return `README is only ${text.trim().length} chars`;
  if (!deliv.readmeHasPinMap(text)) return 'README has no pin map';
  if (!/arduino-cli|Arduino IDE|upload/i.test(text)) return 'README has no build/upload instructions';
  return null;
}

const rows = [];

for (const id of LADDER) {
  const spec = SPEC.projects.find((p) => p.id === id);
  const root = join(dir, id);
  const problems = [];

  if (!existsSync(root)) {
    rows.push({ id, title: spec?.title ?? id, verdict: 'NOT RUN', problems: ['no directory'] });
    continue;
  }

  const sketches = explain.findSketches(root);
  if (sketches.length === 0) problems.push('no .ino sketch');
  if (sketches.length > 1) problems.push(`${sketches.length} sketches — expected one`);

  if (sketches.length >= 1) {
    const s = sketches[0];
    const expected = `${basename(s.dir)}.ino`;
    if (basename(s.path) !== expected) problems.push(`sketch is ${basename(s.path)}, must be ${expected} to build`);

    const { fqbn } = toolchain.projectFqbn(root);
    const board = toolchain.boardFromFqbn(fqbn);

    const buildPath = mkdtempSync(join(tmpdir(), 'ayin-legit-'));
    try {
      const c = await toolchain.compileSketch(s.dir, fqbn, buildPath);
      if (c.skipped) problems.push(`NOT compile-checked: ${c.reason}`);
      else if (!c.ok) {
        const firstError = c.output.split('\n').find((l) => /error/i.test(l)) ?? 'see output';
        problems.push(`COMPILE FAILED: ${firstError.trim().slice(0, 140)}`);
      }
    } finally { rmSync(buildPath, { recursive: true, force: true }); }

    const src = readFileSync(s.path, 'utf8');
    for (const u of explain.extractPinUsage(src)) {
      if (u.calls.includes('analogWrite') && /^\d{1,2}$/.test(u.resolved) && !toolchain.isPwmPin(board, u.resolved)) {
        problems.push(`analogWrite on pin ${u.resolved} — no hardware PWM on ${board}`);
      }
    }

    const puml = diagram.wiringPumlPath(s.path);
    if (!existsSync(puml)) problems.push('no wiring diagram (.wiring.puml)');
    else {
      // Worded carefully: on a project produced BEFORE the provenance stamp shipped, an absent stamp
      // does not prove the diagram was hand-written. Saying "hand-written" there would be a confident
      // claim the evidence does not support — the same failure this whole subsystem exists to avoid.
      if (!diagram.isGeneratedPuml(readFileSync(puml, 'utf8'))) {
        problems.push('wiring diagram carries no arduino_diagram provenance stamp (hand-written, or generated before stamping existed)');
      }
      const v = await diagram.validatePumlFile(puml);
      if (!v.ok) problems.push(`wiring diagram is invalid PlantUML: ${v.error}`);
      if (!existsSync(puml.replace(/\.puml$/, '.svg'))) problems.push('wiring diagram not rendered to .svg');
    }
  }

  const rm = readmeVerdict(root);
  if (rm) problems.push(rm);

  rows.push({ id, title: spec?.title ?? id, verdict: problems.length === 0 ? 'LEGIT' : 'NOT LEGIT', problems });
}

const legit = rows.filter((r) => r.verdict === 'LEGIT').length;
console.log(`\n════ ${legit}/${LADDER.length} projects LEGIT ════\n`);
for (const [i, r] of rows.entries()) {
  const mark = r.verdict === 'LEGIT' ? '✓' : r.verdict === 'NOT RUN' ? '·' : '✗';
  console.log(`${mark} ${i + 1}. ${r.title.padEnd(34)} ${r.verdict}`);
  for (const p of r.problems) console.log(`      → ${p}`);
}
console.log();
process.exit(legit === LADDER.length ? 0 : 1);
