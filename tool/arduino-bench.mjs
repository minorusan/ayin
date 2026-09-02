/**
 * Arduino benchmark runner — grade what ayin actually produced, deterministically.
 *
 * WHAT THIS IS FOR. "ayin should be good at Arduino" is not a thing you can act on. This turns it
 * into a number that moves: ten projects of escalating difficulty, each with a prompt you hand ayin
 * in an empty directory and a set of checks that need no model to evaluate. Change a prompt, change
 * the diagram renderer, change a criterion — rerun and see which way the score went.
 *
 * IT DOES NOT DRIVE AYIN. Running the agent means GPU time on a shared card, and this project's rules
 * are explicit that runs are the operator's to start. So the flow is:
 *
 *     node tool/arduino-bench.mjs prompts            # print the prompts, one per project
 *     …you run each one in its own empty directory…
 *     node tool/arduino-bench.mjs grade <dir>        # grade every project found under <dir>
 *
 * WHAT IT CHECKS, all of it deterministic and none of it opinion:
 *   - the sketch compiles (real `arduino-cli`, real target board)
 *   - the deliverables exist (sketch in a matching folder, README, .wiring.puml, .wiring.svg)
 *   - the generated PlantUML actually parses (real renderer)
 *   - `analogWrite` only on pins with hardware PWM
 *   - the project-specific `grep`/`notGrep` markers from projects.json — the traps
 *   - the README is filled in, not the scaffold stub with empty headings
 *
 * Everything a judge would have to have an OPINION about is deliberately absent. This measures the
 * floor, and the floor is where the expensive mistakes live.
 */

import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = JSON.parse(readFileSync(join(ROOT, 'bench', 'arduino', 'projects.json'), 'utf8'));
const DIST = join(ROOT, 'dist');

const mode = process.argv[2] ?? 'prompts';

// ── `prompts` — what to hand ayin ────────────────────────────────────
if (mode === 'prompts') {
  console.log('# ayin Arduino benchmark — run each of these in its OWN empty directory, with /plan /qa /present on.\n');
  for (const p of SPEC.projects) {
    console.log(`## ${p.level}. ${p.title}   (dir: ${p.id}/)`);
    console.log(`\n    ${p.prompt}\n`);
    console.log('   Traps this sets:');
    for (const t of p.traps) console.log(`     · ${t}`);
    console.log('');
  }
  console.log('Then: node tool/arduino-bench.mjs grade <parent-dir>');
  process.exit(0);
}

if (mode !== 'grade') {
  console.error('usage: node tool/arduino-bench.mjs [prompts|grade <dir>]');
  process.exit(1);
}

const parent = process.argv[3];
if (!parent || !existsSync(parent)) {
  console.error(`grade needs a directory containing one subdirectory per project id: ${SPEC.projects.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

const toolchain = await import(`file://${join(DIST, 'tools/arduino-toolchain.js')}`);
const explain = await import(`file://${join(DIST, 'tools/arduino-explain.js')}`);
const diagram = await import(`file://${join(DIST, 'tools/arduino-diagram.js')}`);
const detect = await import(`file://${join(DIST, 'executors/detect.js')}`);
const registry = await import(`file://${join(DIST, 'executors/registry.js')}`);
const deliverables = await import(`file://${join(DIST, 'executors/deliverables.js')}`);

/**
 * Is the README real documentation, or the scaffold stub with the headings still empty?
 *
 * TWO BUGS LIVED HERE, both found by reading a run this check had failed, and both worth keeping
 * written down because they are the classic shape of a bad measuring instrument:
 *
 *   1. **Fenced code was scanned for headings.** A README whose build section contains
 *      "```bash\n# Compile\narduino-cli compile …\n```" has two lines starting with `# ` that are
 *      shell comments, not markdown headings. Splitting on `^#` turned one good section into three
 *      fragments and reported "2 headings with nothing under them" about an excellent README. Fences
 *      are stripped before any heading is looked for.
 *   2. **A per-section character floor was arbitrary.** "## Author\nAyin" is a fine section and was
 *      failed for being under twenty characters. A section is only empty when it is EMPTY.
 *
 * What replaces the floor is a check on what an Arduino README is actually FOR: the parts, the pins,
 * and the command that builds it. That is a claim about content, not about length, and it is the
 * claim the deliverable was always trying to make.
 */
function readmeIsFilledIn(root) {
  const path = join(root, 'README.md');
  if (!existsSync(path)) return { ok: false, why: 'no README.md' };
  const text = readFileSync(path, 'utf8');
  // The shared sentinel, from `executors/deliverables.js` — the banner's wording is decided in one
  // place, and a literal copied here would go quietly dead the next time it is reworded (it did).
  if (text.includes(deliverables.README_STUB_BANNER)) return { ok: false, why: 'still the untouched scaffold stub' };
  const todos = (text.match(/\bTODO\b/g) ?? []).length;
  if (todos > 0) return { ok: false, why: `${todos} TODO marker(s) left from the scaffold stub` };

  // FOUR BUGS LIVED IN THIS ONE CHECK, every one of them the instrument failing good work. Recorded
  // because the pattern is the lesson: a grader that punishes correct output teaches you to break
  // things, and I nearly "fixed" ayin four times for defects that were mine.
  //   1. Headings were counted inside fenced code (`# Compile` in a bash fence).
  //   2. So fences were stripped — which made a section whose body IS a fence read as empty, hitting
  //      "## Build & Upload", the most useful section in an Arduino README.
  //   3. A document title followed immediately by its first subsection was failed as an empty heading.
  //   4. Every heading level was treated alike, so `## Wiring` followed by `### RGB LED` — a parent
  //      containing children, which is simply how markdown nests — read as empty.
  //
  // Correct rule: a heading is a real gap only when it has no prose of its own AND the next heading is
  // not nested beneath it.
  const masked = text.replace(/^```[\s\S]*?^```/gm, (m) => m.replace(/^#/gm, '·'));
  const headings = [...masked.matchAll(/^(#{1,6}) +(.*)$/gm)]
    .map((m) => ({ level: m[1].length, title: m[2].trim(), start: m.index + m[0].length }));

  const gaps = [];
  for (let i = 0; i < headings.length; i++) {
    const next = headings[i + 1];
    const body = masked.slice(headings[i].start, next ? next.start - next.level - next.title.length - 2 : undefined).trim();
    if (body.length > 0) continue;
    if (next && next.level > headings[i].level) continue; // has subsections — not a gap
    gaps.push(headings[i].title);
  }
  if (gaps.length) return { ok: false, why: `heading(s) with nothing under them: ${gaps.join(', ')}` };

  // A pin map is very often a TABLE, and the numbers then live in their own cells — `| 8 | Red LED |`
  // under a `| Pin | Component |` header. Requiring "pin 8" adjacency failed a perfectly good pinout
  // table for its formatting, which is the same instrument bug as the two above.
  // Kept in step with `arduino-legit.mjs`'s version, including the lesson that an emphasis strip must
  // not eat `_` — doing so turned `LED_BUILTIN` into `LEDBUILTIN` and reported a README that named its
  // pin as having no pin map.
  const pinRe = /\bpin\s*\d|\bD\d\b|\bA[0-5]\b|LED_BUILTIN|\bbuilt-?in LED\b/i;
  const hasPinMap = pinRe.test(text)
    || (/\b(pinout|pin map|wiring|hardware|connections)\b/i.test(text) && /^\|\s*\**\s*(\d{1,2}|A[0-5])\b/m.test(text));
  const missing = [];
  if (!/arduino-cli\s+compile|Arduino IDE|upload/i.test(text)) missing.push('build/upload instructions');
  if (!hasPinMap) missing.push('a pin map');
  if (missing.length) return { ok: false, why: `missing ${missing.join(' and ')}` };

  return { ok: true, why: `${text.length} chars, ${headings.length} headings, parts + pins + build command` };
}

const results = [];

for (const p of SPEC.projects) {
  const root = join(parent, p.id);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    results.push({ project: p, skipped: true, checks: [] });
    continue;
  }

  const ctx = detect.detectProject(root, p.prompt);
  add('detected as an Arduino project', ctx.type === 'arduino', detect.describeProject(ctx));

  const plan = registry.planExecutorFor(ctx);
  const statuses = deliverables.checkDeliverables(root, plan.deliverables(ctx));
  for (const s of statuses) {
    add(`deliverable: ${s.deliverable.label}`, s.satisfied || !s.deliverable.required,
      s.satisfied ? s.matches.map((m) => m.slice(root.length + 1)).join(', ') : 'missing');
  }

  const rm = readmeIsFilledIn(root);
  add('README is written, not a stub', rm.ok, rm.why);

  const sketches = explain.findSketches(root);
  add('exactly one sketch, named after its folder', sketches.length === 1
    && basename(sketches[0].path).replace(/\.(ino|pde)$/i, '') === basename(sketches[0].dir),
    sketches.map((s) => `${basename(s.dir)}/${basename(s.path)}`).join(', ') || 'none');

  if (sketches.length) {
    const sketch = sketches[0];
    const source = readFileSync(sketch.path, 'utf8');
    const { fqbn } = toolchain.projectFqbn(root);
    const board = toolchain.boardFromFqbn(fqbn);

    // Compile — the real toolchain, into a temp build path so the project is left alone.
    const buildPath = mkdtempSync(join(tmpdir(), 'ayin-bench-'));
    try {
      const c = await toolchain.compileSketch(sketch.dir, fqbn, buildPath);
      if (p.expect.compiles) {
        add('compiles', c.ok && !c.skipped, c.skipped ? c.reason : c.ok ? c.reason : c.output.split('\n').find((l) => /error/i.test(l)) ?? c.reason);
      } else {
        // A project that needs a library nobody installed SHOULD fail to compile — what is being
        // measured is whether the README and the plan told you which library, not the exit code.
        add('compile failure is explained (needs a library)', /lib install|library|#include/i.test(readFileSync(join(root, 'README.md'), 'utf8')),
          p.expect.compilesNote ?? '');
      }
    } finally { rmSync(buildPath, { recursive: true, force: true }); }

    // PWM: the bug that compiles clean and silently halves the project.
    const bad = explain.extractPinUsage(source)
      .filter((u) => u.calls.includes('analogWrite') && /^\d{1,2}$/.test(u.resolved) && !toolchain.isPwmPin(board, u.resolved));
    add('analogWrite only on PWM pins', bad.length === 0,
      bad.length ? `pin(s) ${bad.map((b) => b.resolved).join(', ')} have no hardware PWM on ${board}` : `PWM pins: ${toolchain.pwmPins(board).join(', ')}`);

    // The diagram is only worth anything if it parses.
    const puml = join(sketch.dir, `${sketch.baseName}.wiring.puml`);
    if (existsSync(puml)) {
      const v = await diagram.validatePumlFile(puml);
      add('wiring diagram is valid PlantUML', v.ok, v.ok ? (v.kind ?? 'parses') : v.error);
      const text = readFileSync(puml, 'utf8');
      for (const id of p.components) {
        if (id === 'resistor') continue; // drawn as inline series parts, not a component box
        add(`diagram grounds "${id}"`, text.includes(id.replace(/-/g, '_')) || text.toLowerCase().includes(id.split('-')[0]),
          '');
      }
    } else {
      add('wiring diagram is valid PlantUML', false, 'no .wiring.puml');
    }

    // The traps, as markers in the source.
    for (const re of p.expect.grep) {
      add(`source contains /${re}/`, new RegExp(re).test(source), '');
    }
    for (const re of p.expect.notGrep) {
      add(`source avoids /${re}/`, !new RegExp(re).test(source), '');
    }
  }

  results.push({ project: p, skipped: false, checks });
}

// ── report ───────────────────────────────────────────────────────────
let totalOk = 0;
let total = 0;
for (const r of results) {
  if (r.skipped) { console.log(`\n── ${r.project.level}. ${r.project.title}  —  NOT RUN (no ${r.project.id}/ directory)`); continue; }
  const ok = r.checks.filter((c) => c.ok).length;
  totalOk += ok; total += r.checks.length;
  console.log(`\n── ${r.project.level}. ${r.project.title}  —  ${ok}/${r.checks.length}`);
  for (const c of r.checks) console.log(`   [${c.ok ? ' ok ' : 'FAIL'}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}

const ran = results.filter((r) => !r.skipped).length;
console.log(`\n════ ${totalOk}/${total} checks passed across ${ran}/${SPEC.projects.length} projects ════`);
process.exit(totalOk === total ? 0 : 1);
