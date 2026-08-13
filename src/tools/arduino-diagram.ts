/**
 * arduino-diagram — the Arduino wiring diagram: a rectangle for the board with one rectangle per pin
 * the code actually touches, one rectangle per real catalog component with one per leg, the series
 * parts the catalog says each leg needs drawn as real nodes in the wire, and labeled arrows between
 * exact pins. Written as PlantUML and rendered to SVG, so the result opens as an EDITABLE VECTOR —
 * every rectangle stays its own group, draggable in Inkscape or draw.io.
 *
 * WHAT THE REWORK FIXED, all of it observed in a rendered image rather than reasoned about:
 *
 *   - **Series resistors were missing entirely.** The catalog says, on the leg itself, that an LED
 *     anode connects to "a PWM pin through a ~220Ω resistor". The renderer drew `pin 9 → red anode`.
 *     A beginner following that diagram wires an LED straight to a GPIO pin and destroys one or both.
 *     The catalog had the fact; the picture contradicted it. Series parts are now nodes in the wire.
 *   - **Stereotype labels were shown.** Every box was captioned `«pin»` / `«comp»` / `«board»` —
 *     internal styling tags, rendered as if they were information. Styling is now inline colour, so
 *     there are no stereotypes to leak.
 *   - **Notes were truncated mid-word at 100 characters.** The wiring note is the single most useful
 *     text on the page ("identify the common leg first — get it wrong and no colour lights") and it
 *     was being cut off at "…get it wrong and none o…". Notes are now wrapped, not amputated.
 *   - **Pins came out in whatever order the map iterated** — 9, 10, 11, GND, 2 — with the ground pin
 *     sitting in the middle of the signal pins. They are ordered numerically now, power and ground
 *     last, which is also how they sit on the physical header.
 *   - **PWM capability was invisible.** `analogWrite` on a non-PWM pin compiles perfectly and gives a
 *     pin that is only ever on or off. Pins are now labeled with what they can do.
 *
 * STILL DETERMINISTIC. No LLM call in this file. `groundWiring`'s one call per sketch (in
 * arduino-explain.ts) remains the only model involvement, and only the render target changed — not
 * how wiring is grounded.
 *
 * WHAT GETS WIRED, precisely: `groundWiring` only ever maps a pin the SKETCH CODE touches to one leg
 * of one component (the code has no idea about GND/power wiring — sketches never call pinMode on a
 * ground pin). So each matched component shows ALL its catalog legs, but only the leg the code drives
 * gets a wire to a real board pin. Other legs get a wire to a synthetic GND/5V pin ONLY when the
 * catalog's own `connectsTo` text for that leg says so — a plain string match against reviewed data,
 * not a guess. A leg whose `connectsTo` matches neither is drawn unwired, which is more honest than
 * inventing a connection the code and the catalog together do not establish.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';


import {
  findSketches, isArduinoProject, readReadme, extractPinUsage, groundWiring,
  type PinUsage, type GroundedConnection, type Sketch,
} from './arduino-explain.js';
import { getArduinoComponent } from './arduino-db.js';
import type { ArduinoComponent } from './arduino-components-data.js';
import { boardFromFqbn, isPwmPin, projectFqbn, pwmPins, type BoardKind } from './arduino-toolchain.js';
import { toolLog, toolOpenInEditor } from './runtime.js';

const PUML_BIN = process.env.AYIN_PUML_BIN || 'plantuml';

function run(cmd: string, args: string[], stdin?: string, timeoutMs = 25_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

let _hasPuml: boolean | null = null;
export async function hasPlantuml(): Promise<boolean> {
  if (_hasPuml !== null) return _hasPuml;
  const { code } = await run(PUML_BIN, ['-version'], undefined, 15_000);
  _hasPuml = code === 0;
  return _hasPuml;
}

export interface PumlValidation {
  ok: boolean;
  /** What PlantUML says it is (`DESCRIPTION`, `SEQUENCE`, …) when it parsed. */
  kind?: string;
  error?: string;
  /** True when no renderer was available and nothing was really checked. */
  unverified?: boolean;
}

/**
 * Validate PlantUML source with the real renderer. Exported because the QA executor needs the SAME
 * answer the generator got — "the diagram exists" and "the diagram parses" are different facts, and
 * only the second one means the file is any use.
 */
export async function validatePuml(src: string): Promise<PumlValidation> {
  if (!(await hasPlantuml())) {
    const balanced = /@startuml/i.test(src) && /@enduml/i.test(src);
    return balanced
      ? { ok: true, unverified: true }
      : { ok: false, unverified: true, error: 'structural check only (plantuml not installed): missing @startuml/@enduml' };
  }
  const { out } = await run(PUML_BIN, ['-syntax'], src);
  const lines = out.split('\n').map((l) => l.trim());
  if (lines[0]?.toUpperCase() === 'ERROR') {
    return { ok: false, error: `line ${lines[1] ?? '?'}: ${lines.slice(2).filter(Boolean).join(' — ') || 'syntax error'}` };
  }
  return { ok: true, kind: lines[0] || undefined };
}

/**
 * The provenance stamp written into every generated `.wiring.puml`, as a PlantUML comment (`'`).
 *
 * Deliberately a comment: it survives `plantuml -syntax`, never renders, and does not change the
 * picture. Deliberately distinctive: nothing else would plausibly contain it.
 */
export const PROVENANCE_MARK = "' generated-by: ayin arduino_diagram — do not hand-edit; rerun the tool";

/**
 * Was this file produced by `renderArduinoWiringPuml`, or written by hand?
 *
 * The distinction is the whole value of the artifact. A generated diagram is grounded in the sketch's
 * real pin usage and the shipped component catalog and cannot invent a part; a hand-written one can
 * say anything, and a plausible wrong pinout is worse than no diagram because a beginner will wire it.
 */
export function isGeneratedPuml(src: string): boolean {
  return src.includes(PROVENANCE_MARK);
}

/**
 * How much of this diagram is actually GROUNDED — real catalog components versus `unknown` pins.
 *
 * A diagram can exist, carry the provenance stamp, and parse perfectly while grounding NOTHING: if
 * `groundWiring`'s one LLM call exhausts its repair rounds it returns no connections, every pin becomes
 * an `unknown` box, and the render is a board with bare pins — no components, no series resistors, no
 * ground. Observed in a confirmation run (`arduino_explain_ground_exhausted`, 6 pins, 0 connections):
 * the artifact passed every existence check and was useless to anyone holding a breadboard.
 *
 * Degrading honestly is right; degrading SILENTLY is not. Exposing the ratio lets the QA gate fail the
 * turn and the fix pass rerun the tool, which re-rolls the grounding call.
 */
export const GROUNDING_MARK = "' grounding: ";

export function diagramGrounding(src: string): { components: number; unknown: number; exhausted: boolean } {
  const containers = [...src.matchAll(/^rectangle\s+"[^"]*"\s+as\s+(COMP_\w+)\s+#[^{]*\{/gm)].map((m) => m[1]);
  const unknown = containers.filter((a) => /^COMP_unknown/.test(a)).length;
  return { components: containers.length - unknown, unknown, exhausted: src.includes(`${GROUNDING_MARK}exhausted`) };
}

export async function validatePumlFile(path: string): Promise<PumlValidation> {
  let src: string;
  try { src = readFileSync(path, 'utf8'); } catch (err) {
    return { ok: false, error: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  return validatePuml(src);
}

// ── PUML text generation (pure — no LLM, no I/O) ────────────────────────────

/** A PlantUML alias must be identifier-shaped; component/pin names are free text ("5V", "top-left leg"). */
function alias(prefix: string, s: string): string {
  const safe = s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
  return `${prefix}_${safe}`;
}

/**
 * Escape free text for a PlantUML label or note.
 *
 * Three hazards, each a real one. `"` ends a quoted label. `<` and `>` open an HTML-ish tag and get
 * eaten. And DOUBLED markup characters are Creole: `**bold**`, `__underline__`, `~~strike~~`,
 * `//italic//`. `~` is PlantUML's own escape character, so prefixing each one makes it literal.
 *
 * Deliberately NOT escaping single `*` or `_` mid-word: identifiers are full of them (`RED_PIN`,
 * `INPUT_PULLUP`), they are harmless on their own, and escaping every one turns readable generated
 * source into `RED~_PIN`. Only a doubled run is markup. A `*` at the START of a note line is a
 * bullet, so that one is escaped too. (This whole function exists because of a real render bug: a
 * `~` written to mark a PWM pin escaped the `**` that followed it and the label came out as the
 * literal text `**9**` — the picture said `**9**` where it meant pin 9.)
 */
function esc(s: string): string {
  return s
    .replace(/"/g, "'")
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~/=-])\1/g, '~$1~$1')
    .replace(/^([*#])/gm, '~$1');
}

function quote(s: string): string {
  return `"${s}"`;
}

/**
 * Wrap free text to a readable column, whole words only, capped in height.
 *
 * The previous behaviour — one line hard-truncated at 100 characters with an ellipsis — threw away
 * the actionable half of every wiring note. A note box is allowed to be several lines tall; it is not
 * allowed to stop mid-sentence.
 */
export function wrapText(s: string, width = 54, maxLines = 7): string[] {
  const words = s.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) { current = word; continue; }
    if (current.length + 1 + word.length <= width) { current += ` ${word}`; continue; }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1]} …`;
  }
  return lines;
}

/**
 * Does this leg's catalog text say it goes to the BOARD's ground / power rail?
 *
 * ANCHORED AT THE START, not a keyword search anywhere in the sentence, and that distinction is
 * load-bearing in both directions. A `connectsTo` is a short phrase naming the destination, sometimes
 * followed by an explanation that mentions other nets — so a blunt `/\bGND\b/` misreads the
 * explanation as the destination. Six legs in the shipped catalog were misclassified, and two of those
 * were actively dangerous:
 *
 *   - the LDR's and thermistor's signal leg — "an analog pin, and also to one leg of a 10k resistor
 *     whose other leg goes to GND" — was read as a GROUND leg, so the divider's signal leg got no
 *     signal wire and the diagram then had no ground wire either. (Reported live by the wiring audit.)
 *   - the L298N's motor terminal — "an external 6-12V supply, NEVER the Arduino's 5V pin" — and the
 *     WS2812B's 5V — "an external 5V power supply" — were read as the board's 5V rail, so the diagram
 *     would draw a wire from the Arduino's 5V pin to a terminal the catalog explicitly forbids. A
 *     beginner following that browns out the board at best.
 *
 * A leg that names no board rail is left UNWIRED and its note carries the catalog's own text. Honest,
 * and far better than a confident wrong wire.
 */
const GND_RE = /^\s*(?:to\s+)?(?:the\s+)?(?:arduino\s+)?(?:GND|ground)\b/i;
const POWER_RE = /^\s*(?:to\s+)?(?:the\s+)?(?:arduino\s+)?(?:5V|3\.3V|VCC)\b/i;

/**
 * Does this leg need a part IN SERIES with the wire, and which?
 *
 * Read straight out of the catalog's own `connectsTo` prose ("a PWM pin through a ~220Ω resistor"),
 * because that is where the fact already lives and duplicating it in a lookup table here would
 * create a second copy that can disagree. Returns the value as the catalog states it — including a
 * range like "150-220 Ω", which is a real answer, not an imprecision to round away.
 */
export function seriesPartFor(connectsTo: string): { label: string } | null {
  const m = connectsTo.match(/through\s+(?:its\s+own\s+|a\s+|an\s+)?~?\s*(\d{1,5}\s*(?:-\s*\d{1,5})?)\s*(?:Ω|ohm|k)/i);
  if (m) return { label: `${m[1].replace(/\s*-\s*/, '–')} Ω` };
  // "through its own resistor" with no value stated — still a part in the wire, and saying so beats
  // drawing a direct connection that the catalog explicitly denies.
  if (/through\s+(?:its\s+own\s+|a\s+|an\s+)?resistor/i.test(connectsTo)) return { label: 'resistor' };
  if (/through\s+a\s+transistor/i.test(connectsTo)) return { label: 'transistor' };
  return null;
}

// ── palette ────────────────────────────────────────────────────────────
// One place for every colour. Light page, dark board — the same visual language as a real board
// photographed on a bench, and legible when printed.
const C = {
  page: '#F7F7F9',
  board: 'back:2B2F3A;line:151821;text:FFFFFF',
  pin: 'back:3A4050;line:5A627A;text:E8EAF0',
  pinNoPwm: 'back:363B49;line:565D72;text:C6CAD6',
  gnd: 'back:1F2027;line:4A4C56;text:C9CBD4',
  power: 'back:5A2D2D;line:AA6666;text:FFD9D9',
  comp: 'back:1E3A5F;line:4A7FB5;text:FFFFFF',
  leg: 'back:3A4050;line:5A627A;text:E8EAF0',
  legRed: 'back:8C2F39;line:C05C66;text:FFECEE',
  legGreen: 'back:245C33;line:4E9A63;text:E9F7ED',
  legBlue: 'back:1F3D73;line:5379BF;text:E7EDFA',
  legGnd: 'back:2A2A2A;line:5A5A5A;text:D8D8D8',
  series: 'back:FFF3D6;line:C9A227;text:6B5300',
  unknown: 'back:5A4A20;line:C9A227;text:FFF3D6',
};

/** The `back:` colour of a style, as a `#RRGGBB` legend swatch. One source of truth for both. */
function swatch(style: string): string {
  return `#${style.match(/back:([0-9A-Fa-f]{6})/)?.[1] ?? '888888'}`;
}

/** Colour a leg by what it IS — an RGB LED's three channels should not be three identical grey boxes. */
function legStyle(legName: string, connectsTo: string): string {
  if (GND_RE.test(connectsTo)) return C.legGnd;
  if (/\bred\b/i.test(legName)) return C.legRed;
  if (/\bgreen\b/i.test(legName)) return C.legGreen;
  if (/\bblue\b/i.test(legName)) return C.legBlue;
  return C.leg;
}

interface ComponentGroup {
  key: string;
  label: string;
  component: ArduinoComponent | null;
  /** legName -> connectsTo text, in catalog order (or a single synthetic "pin" leg for an unmatched pin). */
  legs: Array<{ legName: string; connectsTo: string }>;
  /**
   * EVERY real board-pin → leg wire the sketch actually makes to this component. Usually one, but a
   * multi-channel part (an RGB LED with a separate PWM pin per colour, a stepper with several coil
   * pins) drives several legs from several DIFFERENT pins — a single "the one leg this drives" field
   * cannot represent that without losing wires. Caught live against a real project: three pins each
   * drove one anode of the SAME component; the single-leg model kept only the FIRST pin's label and
   * let the LAST connection's leg match win, rendering as one mislabeled wire with the other two pins
   * silently missing from the board rectangle — real data loss, not a hypothetical.
   */
  groundedConnections: Array<{ leg: string; boardPinKey: string; boardPinLabel: string; boardPinSub: string }>;
}

/**
 * `GroundedConnection.leg` is DELIBERATELY free-form project phrasing, not the catalog's exact
 * `legName` — `groundWiring.txt` explicitly asks for "in this project's own words" ("cathode",
 * "signal wire"), because that field's original (and still real) consumer is a HUMAN reading the
 * label. Matching it to a catalog leg for wire-drawing therefore needs fuzzy word overlap, not
 * equality: an exact-match lookup silently drops the wire for nearly every real model response.
 */
function matchLeg(
  connLeg: string,
  legs: Array<{ legName: string; connectsTo: string }>,
  claimed: Set<string> = new Set(),
): string {
  if (legs.length === 0) return 'pin';

  // TWO EXCLUSIONS, both of which produced a WRONG CIRCUIT before they existed. Found by auditing a
  // rendered diagram against the sketch and the README, not by reading this function.
  //
  // 1. A GROUND OR POWER LEG IS NEVER A SIGNAL DESTINATION. The catalog states, per leg, that the RGB
  //    LED's common cathode goes to Arduino GND. Free-form model phrasing like "green channel, via a
  //    resistor to the common cathode" shares TWO words with "common cathode (longest leg)" and only
  //    ONE with "green anode" — so plain word-overlap chose the cathode. Observed: pins 10 and 11 both
  //    wired into the common cathode, the green and blue anodes left unwired, and no ground wire at
  //    all. Anyone following that picture gets a dead circuit.
  // 2. A LEG ALREADY CLAIMED BY ANOTHER PIN IS OUT. Legs are distinct physical terminals; two board
  //    pins driving one leg is a matching failure, not a circuit. Assignment is injective while there
  //    are legs left to assign.
  const signalLegs = legs.filter((l) => !GND_RE.test(l.connectsTo) && !POWER_RE.test(l.connectsTo));
  const pool = (signalLegs.length ? signalLegs : legs).filter((l) => !claimed.has(l.legName));
  const candidates = pool.length ? pool : (signalLegs.length ? signalLegs : legs);

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const target = norm(connLeg);
  if (!target) return candidates[0].legName;
  const exact = candidates.find((l) => norm(l.legName) === target);
  if (exact) return exact.legName;
  const targetWords = new Set(target.split(' ').filter(Boolean));
  let best = candidates[0];
  let bestScore = -1;
  for (const l of candidates) {
    const score = norm(l.legName).split(' ').filter((w) => w && targetWords.has(w)).length;
    if (score > bestScore) { bestScore = score; best = l; }
  }
  return best.legName;
}

/**
 * Board pins in the order a human reads a header: digital pins ascending, then analog, then named
 * constants that never resolved, then power and ground. The previous order was Map insertion order,
 * which put GND between pins 11 and 2.
 */
function pinSortKey(resolved: string): [number, number, string] {
  if (/^\d{1,2}$/.test(resolved)) return [0, Number(resolved), resolved];
  if (/^A[0-5]$/i.test(resolved)) return [1, Number(resolved.slice(1)), resolved];
  return [2, 0, resolved];
}

/** Group grounded connections by component so a component driven from several pins still renders as
 *  ONE box with ALL of its real wires — never collapsed to whichever pin was processed first. */
function groupByComponent(pins: PinUsage[], connections: GroundedConnection[], board: BoardKind): ComponentGroup[] {
  const byPin = new Map(connections.map((c) => [c.pin, c]));
  const groups = new Map<string, ComponentGroup>();
  let unknownIdx = 0;

  const ordered = [...pins].sort((a, b) => {
    const ka = pinSortKey(a.resolved);
    const kb = pinSortKey(b.resolved);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
  });

  for (const p of ordered) {
    const conn = byPin.get(p.raw) ?? byPin.get(p.resolved);
    const label = p.raw === p.resolved ? p.raw : `${p.raw} (${p.resolved})`;
    // The sub-line is what reading the code alone cannot tell you: what the pin is used for, and
    // whether it can actually do PWM. `analogWrite` on a non-PWM pin is the classic silent bug.
    const capable = /^\d{1,2}$/.test(p.resolved) && isPwmPin(board, p.resolved);
    const usesPwm = p.calls.includes('analogWrite');
    const sub = [
      p.calls.join(' · '),
      usesPwm && !capable ? 'NO HARDWARE PWM — analogWrite here is on/off only' : capable ? 'PWM capable' : '',
    ].filter(Boolean).join(' — ');

    if (!conn || conn.componentId === 'unknown') {
      const key = `unknown_${unknownIdx++}`;
      groups.set(key, {
        key, label: conn?.label || p.calls.join('/') || 'Unmatched pin', component: null,
        legs: [{ legName: 'pin', connectsTo: '' }],
        groundedConnections: [{ leg: 'pin', boardPinKey: p.resolved, boardPinLabel: label, boardPinSub: sub }],
      });
      continue;
    }

    const existing = groups.get(conn.componentId);
    if (existing) {
      // `claimed` makes leg assignment injective across the pins driving one component — see matchLeg.
      const claimed = new Set(existing.groundedConnections.map((c) => c.leg));
      existing.groundedConnections.push({ leg: matchLeg(conn.leg, existing.legs, claimed), boardPinKey: p.resolved, boardPinLabel: label, boardPinSub: sub });
      continue;
    }
    const component = getArduinoComponent(conn.componentId) ?? null;
    const legs = component ? component.legs.map((l) => ({ legName: l.legName, connectsTo: l.connectsTo })) : [{ legName: conn.leg || 'pin', connectsTo: '' }];
    groups.set(conn.componentId, {
      key: conn.componentId,
      label: component?.name ?? conn.label,
      component,
      legs,
      groundedConnections: [{ leg: matchLeg(conn.leg, legs), boardPinKey: p.resolved, boardPinLabel: label, boardPinSub: sub }],
    });
  }
  return splitMultiInstance([...groups.values()]);
}

/**
 * Three discrete LEDs are THREE parts, not one part with three wires into the same leg.
 *
 * `groupByComponent` groups by catalog id, which is exactly right for an RGB LED — one physical bulb
 * whose three colour channels are three separate anodes — and exactly wrong for a traffic light, where
 * pins 9, 10 and 11 drive three separate `standard-led`s. Seen in a real render: one "Standard LED" box
 * with three signal wires converging on the same anode. Valid PlantUML, catalog-grounded, stamped, and
 * describing a circuit nobody built — a beginner following it wires one LED.
 *
 * THE TEST IS THE CATALOG'S OWN LEG LIST, not a guess: count the legs that are not ground or power
 * (the ones a board pin can actually drive). A part with ONE driveable leg cannot be driven by three
 * pins — so three pins mean three of them. A part with three driveable anodes can.
 *
 * Deliberately conservative: it splits only when the leg count PROVES a single instance impossible.
 * Two buttons on two pins still render as one box (a 4-leg button has two pin-side legs, so two
 * connections are not proof), because inventing a part that is not there is the worse error.
 */
function splitMultiInstance(groups: ComponentGroup[]): ComponentGroup[] {
  const out: ComponentGroup[] = [];
  for (const g of groups) {
    const driveable = g.legs.filter((l) => !GND_RE.test(l.connectsTo) && !POWER_RE.test(l.connectsTo)).length;
    const pins = new Set(g.groundedConnections.map((c) => c.boardPinKey));
    if (!g.component || driveable === 0 || pins.size <= driveable) { out.push(g); continue; }

    for (const conn of g.groundedConnections) {
      out.push({
        ...g,
        key: `${g.key}__${conn.boardPinKey}`,
        // Named by the pin that drives it, so the three boxes are telling apart at a glance and the
        // label matches the pin rectangle it wires from.
        label: `${g.label} (${conn.boardPinLabel})`,
        groundedConnections: [conn],
      });
    }
  }
  return out;
}

/** `rectangle "label" as ALIAS #style` — one helper so no call site hand-rolls the syntax. */
function box(label: string, aliasName: string, style: string, indent = ''): string {
  return `${indent}rectangle ${quote(label)} as ${aliasName} #${style}`;
}

/** A two-line label: a bold heading and a smaller subtitle. */
function titled(main: string, sub: string): string {
  return sub ? `<b>${esc(main)}</b>\\n<size:9>${esc(sub)}</size>` : `<b>${esc(main)}</b>`;
}

/**
 * Pure renderer: pins + grounded connections → PlantUML source.
 *
 * `board` selects the pin-capability facts (which pins do PWM) and the board's title. The diagram
 * only ever shows pins the code actually touches, never a full physical pinout, so a board's
 * physical pin COUNT does not matter here — its PWM map does.
 */
export function renderArduinoWiringPuml(
  sketchName: string,
  board: BoardKind,
  pins: PinUsage[],
  connections: GroundedConnection[],
  groundingExhausted = false,
): string {
  const boardLabel = { uno: 'Arduino Uno', nano: 'Arduino Nano', mega: 'Arduino Mega', other: 'Arduino board' }[board];
  const groups = groupByComponent(pins, connections, board);

  const groundedLegNames = (g: ComponentGroup): Set<string> => new Set(g.groundedConnections.map((c) => c.leg));
  const needsGnd = groups.some((g) => { const gl = groundedLegNames(g); return g.legs.some((l) => !gl.has(l.legName) && GND_RE.test(l.connectsTo)); });
  const needsPower = groups.some((g) => { const gl = groundedLegNames(g); return g.legs.some((l) => !gl.has(l.legName) && POWER_RE.test(l.connectsTo)); });

  const lines: string[] = [];
  lines.push('@startuml');
  // PROVENANCE, first line of the body. A `.wiring.puml` is only worth anything if it was GENERATED
  // from the sketch's real pins and the real catalog — a hand-written one is the model's imagination
  // wearing the filename of a grounded artifact, and it looks entirely plausible.
  //
  // This is not hypothetical. In a benchmark run the model wrote its own `traffic-light.wiring.puml`:
  // valid PlantUML, sensible-looking, resistors and all — and with zero catalog grounding, so nothing
  // had checked a single pinout in it. It survived because `regenerateTouchedDiagrams`'s mtime skip
  // assumed this tool was the only writer of that path. The stamp is how every consumer can tell the
  // difference, and `isGeneratedPuml` below is the check.
  lines.push(`${PROVENANCE_MARK} ${new Date().toISOString()}`);
  // The GROUNDING OUTCOME, recorded here because it cannot be recovered from the picture. An
  // all-unknown diagram is CORRECT for a sketch with no external parts (blink drives only LED_BUILTIN)
  // and WORTHLESS for one whose grounding call died — identical shapes, opposite meanings.
  lines.push(`${GROUNDING_MARK}${groundingExhausted ? 'exhausted' : 'ok'}`);
  lines.push(`title <size:16><b>${esc(boardLabel)} — ${esc(sketchName)}</b></size>\\n<size:10>wiring generated from the sketch's real pin usage · every part below comes from ayin's component catalog</size>`);
  lines.push('');
  lines.push(`skinparam backgroundColor ${C.page}`);
  lines.push('skinparam shadowing false');
  lines.push('skinparam nodesep 14');
  lines.push('skinparam ranksep 55');
  lines.push('skinparam linetype ortho');
  lines.push('skinparam ArrowColor #7A7A85');
  lines.push('skinparam ArrowFontColor #55555F');
  lines.push('skinparam ArrowFontSize 11');
  // The FLAT form, not `skinparam rectangle { … }`. PlantUML's block form must span several lines;
  // written on one line it is a syntax error, which `plantuml -syntax` reports as an unhelpful
  // "Syntax Error? (Assumed diagram type: sequence)" pointing at the first line of the block. Caught
  // by validating a real render rather than by reading the source — which is exactly why every
  // diagram this tool writes is validated before it is offered to anyone.
  lines.push('skinparam RectangleRoundCorner 10');
  lines.push('skinparam NoteBackgroundColor #FFFDF2');
  lines.push('skinparam NoteBorderColor #D9D2B0');
  lines.push('skinparam NoteFontSize 11');
  // Belt and braces: styling is inline colour rather than stereotypes, so there should be no «tags»
  // to render at all — this makes that true even if a future edit reintroduces one.
  lines.push('hide stereotype');
  lines.push('');

  // ── the board ────────────────────────────────────────────────────
  lines.push(`rectangle ${quote(`<b>${esc(boardLabel)}</b>`)} as BOARD #${C.board} {`);
  const pinAlias = new Map<string, string>();
  for (const g of groups) {
    for (const conn of g.groundedConnections) {
      if (pinAlias.has(conn.boardPinKey)) continue;
      const a = alias('PIN', conn.boardPinKey);
      pinAlias.set(conn.boardPinKey, a);
      const noPwm = /NO HARDWARE PWM/.test(conn.boardPinSub);
      lines.push(box(titled(conn.boardPinLabel, conn.boardPinSub), a, noPwm ? C.pinNoPwm : C.pin, '  '));
    }
  }
  if (needsPower) lines.push(box('<b>5V</b>', 'BOARD_5V', C.power, '  '));
  if (needsGnd) lines.push(box('<b>GND</b>', 'BOARD_GND', C.gnd, '  '));
  lines.push('}');
  lines.push('');

  const wires: string[] = [];
  const seriesBoxes: string[] = [];
  let seriesIdx = 0;

  for (const g of groups) {
    const compAlias = alias('COMP', g.key);
    const legMeta = new Map(g.legs.map((l) => [l.legName, l.connectsTo]));

    lines.push(`rectangle ${quote(titled(g.label, g.component?.category ?? ''))} as ${compAlias} #${g.component ? C.comp : C.unknown} {`);
    const legAliases = new Map<string, string>();
    for (const leg of g.legs) {
      const a = `${compAlias}_${alias('LEG', leg.legName)}`;
      legAliases.set(leg.legName, a);
      lines.push(box(esc(leg.legName), a, legStyle(leg.legName, leg.connectsTo), '  '));
    }
    lines.push('}');

    // The note carries the two things a picture cannot: what the part IS, and the mistake people make
    // wiring it. Wrapped, never truncated — the second half of a wiring note is the useful half.
    lines.push(`note bottom of ${compAlias}`);
    if (g.component) {
      for (const l of wrapText(g.component.whatItDoes, 58, 4)) lines.push(`  ${esc(l)}`);
      lines.push('  ----');
      for (const l of wrapText(g.component.wiringNotes, 58, 10)) lines.push(`  ${esc(l)}`);
    } else {
      lines.push('  The code drives this pin, but no arduino_db catalog component matched');
      lines.push('  it — check this connection by hand.');
    }
    lines.push('end note');
    lines.push('');

    // ── signal wires: board pin → (series part) → leg ───────────────
    for (const conn of g.groundedConnections) {
      const boardAlias = pinAlias.get(conn.boardPinKey);
      const legAlias = legAliases.get(conn.leg);
      if (!boardAlias || !legAlias) continue;
      const series = seriesPartFor(legMeta.get(conn.leg) ?? '');
      if (series) {
        // A real node in the wire, not a footnote. The catalog states the part; the picture now
        // agrees with it, which is the whole difference between a diagram you can build from and one
        // that destroys an LED.
        const sAlias = `SERIES_${seriesIdx++}`;
        seriesBoxes.push(box(titled(series.label, 'in series'), sAlias, C.series));
        wires.push(`${boardAlias} --> ${sAlias} : signal`);
        wires.push(`${sAlias} --> ${legAlias}`);
      } else {
        wires.push(`${boardAlias} --> ${legAlias} : signal`);
      }
    }

    // ── ONE wire per net, not one per leg ──────────────────────────
    // A catalog component often lists a ground/power net as TWO+ separate legs that are internally
    // shorted and only exist as a pair for mechanical stability (the push-button's own catalog text
    // says so: "wiring only one is enough"). Drawing a wire from EVERY such leg claims you need two
    // ground wires, which is wrong and was reported live against a real render. The first matching
    // leg gets the wire; the rest stay drawn as bare rectangles, same as any other unwired leg.
    const groundedLegs = new Set(g.groundedConnections.map((c) => c.leg));
    let groundDrawn = false;
    let powerDrawn = false;
    for (const leg of g.legs) {
      if (groundedLegs.has(leg.legName)) continue;
      const legAlias2 = legAliases.get(leg.legName);
      if (!legAlias2) continue;
      if (GND_RE.test(leg.connectsTo)) {
        if (groundDrawn) continue;
        wires.push(`${legAlias2} --> BOARD_GND : ground`);
        groundDrawn = true;
      } else if (POWER_RE.test(leg.connectsTo)) {
        if (powerDrawn) continue;
        wires.push(`BOARD_5V --> ${legAlias2} : power`);
        powerDrawn = true;
      }
    }
  }

  if (seriesBoxes.length) {
    lines.push("' parts in series with a signal wire — stated by the component catalog, not optional");
    lines.push(...seriesBoxes);
    lines.push('');
  }
  lines.push(...wires);
  lines.push('');

  // ── parts list + key ─────────────────────────────────────────────
  // DEDUPED BY CATALOG ID, with a count. Three discrete LEDs are three component boxes — correct, and
  // the whole point of splitting them — but three identical "how to spot it" rows in the parts list is
  // noise in the one table a person reads while picking parts out of a kit.
  const partCounts = new Map<string, { component: ArduinoComponent; n: number }>();
  for (const g of groups) {
    if (!g.component) continue;
    const seen = partCounts.get(g.component.id);
    if (seen) seen.n++;
    else partCounts.set(g.component.id, { component: g.component, n: 1 });
  }
  const parts = [...partCounts.values()];
  lines.push('legend bottom');
  lines.push('  <b>Parts</b>');
  if (parts.length) {
    lines.push('  |= part |= how to spot it |');
    for (const { component: p, n } of parts) lines.push(`  | ${esc(p.name)}${n > 1 ? ` ×${n}` : ''} | ${esc(wrapText(p.identify, 70, 1)[0] ?? '')} |`);
  } else {
    lines.push('  | no catalog component matched any pin in this sketch |');
  }
  const seriesCount = seriesBoxes.length;
  if (seriesCount) lines.push(`  | resistor ×${seriesCount} | the catalog requires one in series with each of these signal wires |`);
  lines.push('  ');
  lines.push('  <b>Key</b>');
  lines.push(`  |<${swatch(C.pin)}>    | board pin the code drives |`);
  lines.push(`  |<${swatch(C.gnd)}>    | ground / power pin |`);
  lines.push(`  |<${swatch(C.series)}>    | part in series with the wire |`);
  lines.push(`  |<${swatch(C.comp)}>    | component from the catalog |`);
  if (board !== 'other') lines.push(`  PWM pins on this board: ${pwmPins(board).join(', ')}`);
  lines.push('endlegend');
  lines.push('@enduml');
  return lines.join('\n');
}

// ── orchestration (I/O + rendering) ──────────────────────────────────────────

export interface DiagramSketchResult {
  sketch: string;
  pumlPath: string;
  svgPath?: string;
  opened: boolean;
  pinsFound: number;
  connectionsMatched: number;
  verified: boolean;
  /** When `verified` is false and plantuml IS installed, what it objected to. */
  syntaxError?: string;
}

export interface DiagramOutcome {
  ok: boolean;
  reason?: string;
  results: DiagramSketchResult[];
}

/**
 * One PUML+SVG wiring diagram per sketch. Sequential, never parallel — one door to the shared model
 * for `groundWiring`'s LLM call. The board comes from the project (`sketch.yaml`/`AYIN_ARDUINO_FQBN`)
 * unless the caller names one, so the PWM facts in the diagram match the board being built for.
 */
export async function runArduinoDiagram(
  root: string,
  opts: { board?: BoardKind; open?: boolean; only?: Set<string> } = {},
): Promise<DiagramOutcome> {
  if (!isArduinoProject(root)) {
    return { ok: false, reason: `${root} does not look like an Arduino project — no .ino/.pde sketch and no platformio.ini/sketch.yaml`, results: [] };
  }
  let sketches: Sketch[] = findSketches(root);
  if (opts.only) sketches = sketches.filter((s) => opts.only!.has(s.path));
  if (sketches.length === 0) {
    return { ok: false, reason: 'Arduino project marker found but no matching .ino/.pde sketch to diagram', results: [] };
  }

  const board = opts.board ?? boardFromFqbn(projectFqbn(root).fqbn);
  const readme = readReadme(root);
  const results: DiagramSketchResult[] = [];

  for (const sketch of sketches) {
    let source: string;
    try { source = readFileSync(sketch.path, 'utf-8'); } catch (err) {
      toolLog().warn('arduino_diagram_read_failed', { sketch: sketch.path, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const pins = extractPinUsage(source);
    // SELF-HEALING, because the machine already knows it failed. `groundWiring` exhausting its repair
    // rounds is a transient bad roll on one LLM call, and the correct response is to roll again — not to
    // emit a useless diagram and ask a person to type "rerun arduino_diagram". Telling the operator to
    // do the retry was my own first answer to this, and it is precisely the "no human in the loop" rule
    // this codebase is built on: the work resumes itself or it was never really running.
    //
    // ONE extra attempt, and only when the sketch HAS pins to ground — a sketch with nothing external
    // (blink) legitimately grounds nothing and must not pay for a second call. Bounded on purpose: two
    // failures in a row is a real problem worth reporting, not something to grind the GPU over.
    let grounding = await groundWiring(sketch.baseName, source, readme, pins);
    if (grounding.exhausted && pins.length > 0) {
      toolLog().warn('arduino_diagram_grounding_retry', { sketch: sketch.baseName, pins: String(pins.length) });
      grounding = await groundWiring(sketch.baseName, source, readme, pins);
      if (grounding.exhausted) toolLog().error('arduino_diagram_grounding_failed_twice', { sketch: sketch.baseName });
    }
    const connections = grounding.connections;
    const puml = renderArduinoWiringPuml(sketch.baseName, board, pins, connections, grounding.exhausted);

    mkdirSync(sketch.dir, { recursive: true });
    const pumlPath = join(sketch.dir, `${sketch.baseName}.wiring.puml`);
    writeFileSync(pumlPath, `${puml}\n`);

    // Validate BEFORE rendering: a render attempt on invalid source wastes a JVM start and leaves a
    // stale SVG from a previous run looking current. The syntax answer is also what QA reports.
    const validation = await validatePuml(puml);
    let svgPath: string | undefined;
    if (validation.ok && !validation.unverified) {
      const { code } = await run(PUML_BIN, ['-tsvg', pumlPath], undefined, 60_000);
      const candidate = pumlPath.replace(/\.puml$/, '.svg');
      if (code === 0 && existsSync(candidate)) svgPath = candidate;
    }

    const opened = opts.open === false ? false : await toolOpenInEditor(svgPath ?? pumlPath);
    toolLog().info('arduino_diagram_generated', {
      sketch: sketch.baseName, pins: String(pins.length), connections: String(connections.length),
      verified: String(validation.ok), rendered: String(!!svgPath), opened: String(opened),
    });
    results.push({
      sketch: sketch.baseName, pumlPath, svgPath, opened,
      verified: validation.ok && !validation.unverified,
      syntaxError: validation.error,
      pinsFound: pins.length, connectionsMatched: connections.filter((c) => c.componentId !== 'unknown').length,
    });
  }
  return { ok: true, results };
}

export interface RegenerateDiagramResult {
  results: DiagramSketchResult[];
  regeneratedPaths: Set<string>;
}

/** The `.wiring.puml` for a sketch. One definition, so no two callers can disagree about the path. */
export function wiringPumlPath(sketchPath: string): string {
  return sketchPath.replace(/\.(ino|pde)$/i, '.wiring.puml');
}

/**
 * Is the diagram beside this sketch both CURRENT and actually GENERATED?
 *
 * Lives here rather than in a caller because "don't redraw an unchanged, tool-made diagram" is a
 * property of the regeneration operation, not of whoever asks for it. It was previously only in the QA
 * executor, so every other caller re-spent a grounding LLM call — and any future caller would have had
 * to remember to reimplement it.
 *
 * Two conditions, both load-bearing:
 *  - **mtime**: the whole point of a fix pass is that the sketch changed, and a diagram drawn from the
 *    previous version is worse than none because it looks current. The filesystem keeps knowing this
 *    across a crash, a restart, or a second ayin process; a flag would forget.
 *  - **provenance**: an unstamped diagram was written by hand, and is regenerated no matter how fresh.
 *    A model once wrote its own `.wiring.puml` — valid, plausible, grounded in nothing — and it
 *    survived precisely because it was newer than the sketch.
 */
export function isDiagramCurrent(sketchPath: string): boolean {
  const puml = wiringPumlPath(sketchPath);
  try {
    if (statSync(puml).mtimeMs < statSync(sketchPath).mtimeMs) return false;
    return isGeneratedPuml(readFileSync(puml, 'utf8'));
  } catch {
    return false; // no diagram, or unreadable — regenerate, which is the safe direction
  }
}

export function formatArduinoDiagramOutcome(o: DiagramOutcome): string {
  if (!o.ok) return `Not generating a wiring diagram: ${o.reason}`;
  if (o.results.length === 0) return 'No sketch produced output.';
  return o.results
    .map((r) => {
      const verify = r.svgPath
        ? 'validated by plantuml and rendered'
        : r.syntaxError
          ? `INVALID PlantUML — ${r.syntaxError}`
          : 'plantuml not installed — .puml written, not rendered';
      return `${r.sketch}: ${r.connectionsMatched}/${r.pinsFound} pin(s) matched to arduino-db → ${r.svgPath ?? r.pumlPath} (${verify})${r.opened ? ', opened in editor' : ''}`;
    })
    .join('\n');
}

/** Tool entry point: `arduino_diagram(board=uno|nano|mega)`. */
export async function arduinoDiagramExecute(params: Record<string, string>): Promise<string> {
  const asked = params.board?.toLowerCase();
  const board: BoardKind | undefined =
    asked === 'nano' ? 'nano' : asked === 'mega' ? 'mega' : asked === 'uno' ? 'uno' : undefined;
  const outcome = await runArduinoDiagram(process.cwd(), { board });
  return formatArduinoDiagramOutcome(outcome);
}
