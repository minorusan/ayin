/**
 * Meticulous wiring audit — is the circuit ELECTRICALLY CORRECT, not merely present?
 *
 * `arduino-legit.mjs` asks whether a wiring diagram exists, carries the generator's provenance stamp,
 * and parses. All three can hold for a diagram that would destroy a component. That is the gap this
 * closes: a beginner does not read the diagram, they *wire from it*, and a plausible wrong picture is
 * the most expensive artifact in the whole project.
 *
 * Everything here is deterministic and cross-checked between THREE independent sources that must agree:
 *
 *   the SKETCH      which pins the code actually drives, and how (extractPinUsage)
 *   the DIAGRAM     the generated .puml — parsed as a graph of pins, legs, series parts and wires
 *   the README      the pin table a human will actually wire from
 *   the CATALOG     what each leg of each real component must connect to
 *
 * A disagreement between any two of them is a defect, and which two tells you what kind:
 *   sketch vs README   → the human wires the wrong pin. The most dangerous mismatch of the four,
 *                        because both artifacts look authoritative and nothing errors.
 *   catalog vs diagram  → the picture contradicts the part (an LED with no series resistor).
 *   sketch vs diagram   → the diagram is incomplete (a driven pin missing from the picture).
 *
 *   node tool/arduino-wiring-audit.mjs <dir> [project-id ...]
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const explain = await import(`file://${join(DIST, 'tools/arduino-explain.js')}`);
const diagramMod = await import(`file://${join(DIST, 'tools/arduino-diagram.js')}`);
const db = await import(`file://${join(DIST, 'tools/arduino-db.js')}`);
const toolchain = await import(`file://${join(DIST, 'tools/arduino-toolchain.js')}`);
const deliv = await import(`file://${join(DIST, 'executors/deliverables.js')}`);

// ANCHORED, matching the generator's own classification — see `GND_RE` in arduino-diagram.ts for the
// six catalog legs a blunt keyword search misreads, two of them dangerously (a terminal the catalog says
// must come from an EXTERNAL supply, read as the Arduino's 5V rail). The audit and the generator must
// agree on what a rail leg is, or the audit invents failures the generator was right to avoid.
const GND_RE = /^\s*(?:to\s+)?(?:the\s+)?(?:arduino\s+)?(?:GND|ground)\b/i;
const POWER_RE = /^\s*(?:to\s+)?(?:the\s+)?(?:arduino\s+)?(?:5V|3\.3V|VCC)\b/i;

/**
 * Parse the generated PlantUML into a graph. Reliable because this is OUR format — a hand-written
 * diagram is rejected upstream by the provenance stamp, so the shapes below are guaranteed.
 */
function parsePuml(src) {
  const pins = new Map();     // alias -> label
  const comps = new Map();    // alias -> { label, legs: Map<alias,label> }
  const series = new Map();   // alias -> label
  const wires = [];           // { from, to, label }

  let currentComp = null;
  for (const raw of src.split('\n')) {
    const line = raw.trim();

    // THE DISCRIMINATOR IS THE TRAILING `{`, not the alias shape. A first cut matched `COMP_\w+` for
    // container rectangles, which also matches `COMP_x_LEG_y` — so every LEG was registered as its own
    // component (rgb-cycle reported 10 components where it has 2) and every one then failed to match a
    // catalog entry. Indentation cannot be used either, because the line is trimmed first. In the
    // generated format a container opens with `{` and a leg never does.
    const opensContainer = /\{\s*$/.test(line);
    const rect = line.match(/^rectangle\s+"(.*?)"\s+as\s+([A-Za-z_]\w*)\b/);
    if (rect && opensContainer) {
      currentComp = rect[2] === 'BOARD' ? 'BOARD' : rect[2];
      if (rect[2] !== 'BOARD') comps.set(rect[2], { label: rect[1], legs: new Map() });
      continue;
    }
    if (rect && currentComp === 'BOARD') { pins.set(rect[2], rect[1]); continue; }
    if (rect && currentComp && comps.has(currentComp)) { comps.get(currentComp).legs.set(rect[2], rect[1]); continue; }

    if (line === '}') { currentComp = null; continue; }
    const ser = line.match(/^rectangle\s+"(.*?)"\s+as\s+(SERIES_\d+)\b/);
    if (ser) { series.set(ser[2], ser[1]); continue; }

    const wire = line.match(/^(\w+)\s*-->\s*(\w+)(?:\s*:\s*(.*))?$/);
    if (wire) wires.push({ from: wire[1], to: wire[2], label: (wire[3] ?? '').trim() });
  }
  return { pins, comps, series, wires };
}

/** Delegates to the ONE implementation in `executors/deliverables.ts` — see `readmePinTokens` for why
 *  three divergent copies of this existed and what they disagreed about. */
const readmePins = (text) => deliv.readmePinTokens(text);

function auditProject(root, id) {
  const problems = [];
  const notes = [];

  const sketches = explain.findSketches(root);
  if (sketches.length === 0) return { id, problems: ['no sketch to audit'], notes };
  const sketch = sketches[0];
  const src = readFileSync(sketch.path, 'utf8');
  const puml = diagramMod.wiringPumlPath(sketch.path);
  if (!existsSync(puml)) return { id, problems: ['no wiring diagram to audit'], notes };

  const g = parsePuml(readFileSync(puml, 'utf8'));
  const { fqbn } = toolchain.projectFqbn(root);
  const board = toolchain.boardFromFqbn(fqbn);
  const codePins = explain.extractPinUsage(src);

  // An entropy pin is DELIBERATELY floating — `randomSeed(analogRead(0))`. Demanding a wire or a README
  // row for it is demanding the opposite of what the idiom needs.
  const wiredPins = codePins.filter((p) => !p.entropyOnly);
  const entropy = codePins.filter((p) => p.entropyOnly);
  for (const p of entropy) notes.push(`${p.resolved} is a floating entropy source for randomSeed() — intentionally unconnected, not a missing wire`);

  // ── 0. a diagram that grounded NOTHING is useless, however valid ───
  // EXHAUSTED, not "grounded nothing". Blink drives only LED_BUILTIN — there IS no external part, and an
  // all-unknown diagram is the honest answer, which is exactly the trap blink was written to set. The
  // first cut of this check failed blink for being correct. The generator now records which case it was.
  const grounded = diagramMod.diagramGrounding(readFileSync(puml, 'utf8'));
  if (grounded.exhausted) {
    problems.push('the diagram\'s component-grounding call EXHAUSTED its retries — every pin is "unknown", so it shows bare pins with no parts, no resistors and no ground (rerun arduino_diagram)');
  } else if (grounded.components === 0 && grounded.unknown > 0) {
    notes.push(`no catalog component matched any pin, and the grounding call succeeded — correct when the sketch drives nothing external (e.g. LED_BUILTIN), worth an eye otherwise`);
  }

  // ── 1. every pin the CODE drives must appear in the DIAGRAM ────────
  const pinLabels = [...g.pins.values()].join(' | ');
  for (const p of wiredPins) {
    const shown = pinLabels.includes(p.raw) || pinLabels.includes(p.resolved);
    if (!shown) problems.push(`code drives ${p.raw}${p.raw !== p.resolved ? ` (${p.resolved})` : ''} but no such pin appears in the diagram`);
  }

  // ── 2. every component box must actually be wired to something ─────
  const touched = new Set(g.wires.flatMap((w) => [w.from, w.to]));
  for (const [alias, c] of g.comps) {
    const legAliases = [...c.legs.keys()];
    if (legAliases.length > 0 && !legAliases.some((l) => touched.has(l))) {
      problems.push(`component "${c.label}" is drawn with no wire to any of its legs`);
    }
  }

  // ── 3. CATALOG vs DIAGRAM: a leg the catalog says needs a series part must have one ──
  for (const [alias, c] of g.comps) {
    // Strip the per-instance suffix a split part carries (`COMP_standard_led_9` → `standard-led`).
    // `alias()` collapses `__` to `_`, so the suffix is a trailing `_<pin>`, not a double underscore.
    const compId = alias.replace(/^COMP_/, '').replace(/_(\d{1,2}|A[0-5])$/i, '').replace(/_/g, '-');
    const entry = db.getArduinoComponent(compId);
    if (!entry) { notes.push(`"${c.label}" — no catalog entry matched from the alias, series/ground checks skipped`); continue; }

    for (const leg of entry.legs) {
      const legAlias = [...c.legs.entries()].find(([, label]) => label === leg.legName)?.[0];
      if (!legAlias) continue;

      const needsSeries = diagramMod.seriesPartFor(leg.connectsTo);
      const incoming = g.wires.filter((w) => w.to === legAlias);
      const drivenFromPin = incoming.some((w) => /^PIN_/.test(w.from));
      const drivenViaSeries = incoming.some((w) => /^SERIES_/.test(w.from));

      if (needsSeries && drivenFromPin && !drivenViaSeries) {
        problems.push(`"${c.label}" leg "${leg.legName}" is wired STRAIGHT to a board pin, but the catalog requires ${needsSeries.label} in series — following this diagram damages the part`);
      }

      // A ground/power leg must actually reach ground/power somewhere in the graph.
      if (GND_RE.test(leg.connectsTo)) {
        const reaches = g.wires.some((w) => (w.from === legAlias && w.to === 'BOARD_GND') || (w.to === legAlias && w.from === 'BOARD_GND'));
        const sibling = entry.legs.some((l2) => l2 !== leg && GND_RE.test(l2.connectsTo)
          && g.wires.some((w) => w.to === 'BOARD_GND' && w.from === [...c.legs.entries()].find(([, lb]) => lb === l2.legName)?.[0]));
        if (!reaches && !sibling) problems.push(`"${c.label}" leg "${leg.legName}" must reach GND per the catalog, but no ground wire is drawn for it`);
      }
      if (POWER_RE.test(leg.connectsTo)) {
        const reaches = g.wires.some((w) => (w.to === legAlias && w.from === 'BOARD_5V') || (w.from === legAlias && w.to === 'BOARD_5V'));
        if (!reaches) problems.push(`"${c.label}" leg "${leg.legName}" must reach 5V per the catalog, but no power wire is drawn for it`);
      }
    }
  }

  // ── 4. SKETCH vs README: the human wires from the README ───────────
  const readmePath = join(root, 'README.md');
  if (existsSync(readmePath)) {
    const rp = readmePins(readFileSync(readmePath, 'utf8'));
    const codeResolved = new Set(wiredPins.map((p) => p.resolved).filter((r) => /^(\d{1,2}|A[0-5])$/i.test(r)).map((r) => r.toUpperCase()));
    for (const cp of codeResolved) {
      if (!rp.has(cp)) problems.push(`the code drives pin ${cp} but the README's wiring instructions never mention it — a person wiring from the README will miss it`);
    }
    for (const r of rp) {
      if (!codeResolved.has(r) && !/^A[45]$/.test(r)) {
        notes.push(`README mentions pin ${r}, which the code does not drive (may be GND/5V context, or a stale instruction)`);
      }
    }
  }

  // ── 5. PWM, restated here so a wiring audit is self-contained ──────
  for (const p of wiredPins) {
    if (p.calls.includes('analogWrite') && /^\d{1,2}$/.test(p.resolved) && !toolchain.isPwmPin(board, p.resolved)) {
      problems.push(`analogWrite on pin ${p.resolved}, which has no hardware PWM on ${board} — wiring is fine but the channel can only be on or off`);
    }
  }

  // ── 6. no two board pins may share one physical leg ────────────────
  // Asserted here as well as fixed in the generator, because this was the shape of the worst defect
  // found all session: pins 10 and 11 both wired into an RGB LED's common cathode. Legs are distinct
  // terminals; two pins on one is a matching failure rendered as a circuit.
  const legDrivers = new Map();
  for (const w of g.wires) {
    if (!/^PIN_|^SERIES_/.test(w.from)) continue;
    const src = /^SERIES_/.test(w.from)
      ? (g.wires.find((x) => x.to === w.from && /^PIN_/.test(x.from))?.from ?? w.from)
      : w.from;
    if (!/^COMP_/.test(w.to)) continue;
    if (!legDrivers.has(w.to)) legDrivers.set(w.to, new Set());
    legDrivers.get(w.to).add(src);
  }
  for (const [leg, drivers] of legDrivers) {
    if (drivers.size > 1) problems.push(`leg ${leg} is driven by ${drivers.size} different board pins (${[...drivers].join(', ')}) — one terminal cannot take two signals`);
  }

  // ── 7. a series part must lead somewhere ───────────────────────────
  for (const [sAlias, label] of g.series) {
    const downstream = g.wires.some((w) => w.from === sAlias);
    const upstream = g.wires.some((w) => w.to === sAlias);
    if (!downstream || !upstream) problems.push(`series part "${label}" (${sAlias}) is drawn but ${!upstream ? 'nothing feeds it' : 'it feeds nothing'} — a dangling part in the wire`);
  }

  // ── 8. INPUT_PULLUP means the other side goes to GND, never 5V ─────
  // The electrical consequence of getting this wrong is silent: with INPUT_PULLUP the pin idles HIGH and
  // is meant to be pulled LOW through the switch to ground. Wired to 5V instead, the pin reads HIGH
  // whether pressed or not — the button simply does nothing, with no error anywhere.
  if (/INPUT_PULLUP/.test(src)) {
    const anyGroundWire = g.wires.some((w) => w.to === 'BOARD_GND' || w.from === 'BOARD_GND');
    if (!anyGroundWire) problems.push('the sketch uses INPUT_PULLUP but the diagram draws no wire to GND at all — a pull-up switch must pull DOWN to ground to ever read LOW');
    const to5v = g.wires.filter((w) => w.from === 'BOARD_5V' || w.to === 'BOARD_5V');
    for (const w of to5v) {
      const legLabel = [...g.comps.values()].flatMap((c) => [...c.legs.entries()]).find(([a]) => a === w.to || a === w.from)?.[1];
      if (legLabel && /\bleg\b|\bside\b|\bterminal\b/i.test(legLabel)) {
        notes.push(`INPUT_PULLUP is used and "${legLabel}" is wired to 5V — check that is a different part, not the switch`);
      }
    }
  }

  // ── 9. I2C only ever lives on this board's fixed SDA/SCL pins ──────
  if (/#include\s*[<"](?:Wire\.h|LiquidCrystal_I2C\.h|Adafruit_SSD1306)/i.test(src)) {
    const shown = [...g.pins.values()].join(' ');
    for (const need of ['A4', 'A5']) {
      if (!shown.includes(need)) problems.push(`the sketch uses I2C but ${need} (${need === 'A4' ? 'SDA' : 'SCL'}) does not appear in the diagram — I2C pins are fixed on this board and a reader has no way to know where the bus goes`);
    }
  }

  return { id, problems, notes, stats: { pins: g.pins.size, comps: g.comps.size, series: g.series.size, wires: g.wires.length } };
}

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error('usage: node tool/arduino-wiring-audit.mjs <dir> [project-id ...]');
  process.exit(2);
}
const only = process.argv.slice(3).filter((a) => !a.startsWith('-'));
// The ladder is DATA (`bench/arduino/ladder.json`), not an import from the sibling tool. Importing
// arduino-legit.mjs for this list executed its top-level refuse-to-grade-mid-run guard and killed this
// process instead — a tool that cannot be composed because loading it has side effects.
const LADDERS = JSON.parse(readFileSync(join(ROOT, 'bench', 'arduino', 'ladder.json'), 'utf8'));
const LKEY = process.argv.includes('--ladder') ? `ladder${process.argv[process.argv.indexOf('--ladder') + 1]}`.replace('ladder1', 'ladder') : 'ladder';
if (!LADDERS[LKEY]) { console.error(`no such ladder: ${LKEY}`); process.exit(2); }
const LADDER = LADDERS[LKEY].map((l) => l.id);
const ids = only.length ? only : LADDER;

let clean = 0;
for (const id of ids) {
  const root = join(dir, id);
  if (!existsSync(root)) { console.log(`·  ${id} — not present`); continue; }
  const r = auditProject(root, id);
  const mark = r.problems.length === 0 ? '✓' : '✗';
  if (r.problems.length === 0) clean++;
  console.log(`${mark}  ${id}${r.stats ? `   (${r.stats.pins} pins, ${r.stats.comps} components, ${r.stats.series} series parts, ${r.stats.wires} wires)` : ''}`);
  for (const p of r.problems) console.log(`      ✗ ${p}`);
  for (const n of r.notes) console.log(`      · ${n}`);
}
console.log(`\n════ ${clean}/${ids.length} wirings clean ════`);
process.exit(clean === ids.length ? 0 : 1);
