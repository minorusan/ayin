/**
 * arduino-explain — SHARED extraction + grounding infrastructure for Arduino wiring features: find the
 * sketch(es) in a project, deterministically extract which pins the code actually touches, and (one
 * LLM call per sketch) ground those pins against arduino-db's component catalog. No rendering lives
 * here any more — that moved to `arduino-diagram.ts` (PUML, board+component rectangles, replacing the
 * hand-rolled HTML/SVG page this file used to render directly). This module now has exactly one job:
 * turn "here's a sketch" into "here's what's actually wired to it", grounded and validated, for
 * whichever renderer asks.
 *
 * PIPELINE, deliberately split into a deterministic half and a grounded half:
 *
 *   findSketches (walk the tree)  →  extractPinUsage (regex over pinMode/digitalWrite/…, PURE, no LLM)
 *   → groundWiring (ONE LLM call per sketch: given the real pins + source + README, map each pin to a
 *     component id from arduino-db's catalog — never invents an id outside that list)
 *
 * The split matters for testability (`tool/check-gates.mjs` exercises extractPinUsage/findSketches
 * directly, no model needed — the same shape diagram.ts uses for extractPuml/stripIncludes) and for
 * honesty: a wiring diagram that fabricated a component id no beginner asked about would be worse than
 * one that says "unknown — code touches this pin but the part isn't in the catalog", which is what a
 * validation miss degrades to here (see `groundWiring`).
 *
 * README GROUNDING. If a README is present at the project root it is fed into the one grounding call as
 * extra context (project intent, part names the code alone doesn't spell out) — but its ABSENCE never
 * blocks generation. A beginner's first sketch rarely has a README yet, and gating a teaching tool on
 * documentation that doesn't exist would defeat the point of the tool.
 *
 * NOT project-tracked resource use: one `llmChat` call per sketch, run SEQUENTIALLY (never
 * `Promise.all`) even when a project has several sketches — this codebase's "one door" discipline
 * means never stacking concurrent calls against the shared model gateway from one command.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { llmChat } from '../llm/manager.js';
import { log } from '../log.js';
import { prompts, packagePath } from '../prompts-service.js';
import { retrieveCatalog } from './arduino-db.js';
import { getArduinoComponent } from './arduino-db.js';

const arduinoPrompts = prompts.register('arduino', packagePath('prompts', 'arduino')).bundle;

// ── finding sketches ────────────────────────────────────────────────

export interface Sketch {
  path: string;
  dir: string;
  /** Filename without extension — also what the Arduino toolchain requires the containing folder to be named. */
  baseName: string;
}

const SKIP_DIR_RE = /^(node_modules|\.git|dist|build|out|\.pio|\.vscode|\.build)$/;

/** Walk the tree for `.ino`/`.pde` sketches, skipping vendor/build directories. Bounded depth — a
 *  runaway symlink loop or a vendored copy of the whole SDK must not turn this into a full-disk walk. */
export function findSketches(root: string, maxDepth = 6): Sketch[] {
  const found: Sketch[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIR_RE.test(entry)) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (/\.(ino|pde)$/i.test(entry)) found.push({ path: full, dir, baseName: basename(entry, extname(entry)) });
    }
  };
  walk(root, 0);
  return found;
}

export function isArduinoProject(root: string): boolean {
  return existsSync(join(root, 'platformio.ini')) || existsSync(join(root, 'sketch.yaml')) || findSketches(root).length > 0;
}

export function readReadme(root: string): string | null {
  for (const name of ['README.md', 'Readme.md', 'readme.md', 'README.MD']) {
    const p = join(root, name);
    if (existsSync(p)) { try { return readFileSync(p, 'utf-8'); } catch { /* unreadable — treat as absent */ } }
  }
  return null;
}

// ── pin usage extraction (pure, no LLM — the deterministic half) ────

/**
 * `randomSeed(analogRead(N))` — the canonical way to seed an AVR's RNG, and the pin is INTENTIONALLY
 * left floating: the entropy IS the noise on an unconnected input. So this pin must not be demanded in
 * a README's wiring table or wired in a diagram, and saying "you forgot to wire A0" about it is wrong.
 * Matched on the nesting, because `analogRead` anywhere else is a real sensor read.
 */
const ENTROPY_SEED_RE = /randomSeed\s*\(\s*analogRead\s*\(\s*(A?\d{1,2})\s*\)/g;

export function entropyPins(source: string): Set<string> {
  const out = new Set<string>();
  ENTROPY_SEED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTROPY_SEED_RE.exec(source)) !== null) {
    const tok = m[1].toUpperCase();
    out.add(tok);
    if (/^\d+$/.test(tok)) out.add(`A${tok}`);   // analogRead(0) → A0
  }
  return out;
}

export interface PinUsage {
  /** The exact token the code uses — a literal ("13", "A0") or a named constant ("LED_PIN"). */
  raw: string;
  /** The literal pin value if `raw` was already one, or resolved from a `#define`/`const int` in the
   *  same file — still equal to `raw` when it names a constant this file never actually defines
   *  (e.g. a core macro like `LED_BUILTIN`). */
  resolved: string;
  /** Which pin-touching functions used this token, e.g. ['pinMode', 'digitalWrite']. */
  calls: string[];
  /** True when this pin exists only to seed the RNG from a FLOATING input — see `entropyPins`. It must
   *  not be wired, documented as a connection, or reported as an omission. */
  entropyOnly?: boolean;
}

const PIN_CALL_RE = /\b(pinMode|digitalWrite|digitalRead|analogWrite|analogRead)\s*\(\s*([A-Za-z_]\w*|\d{1,2}|A[0-5])\s*[,)]/g;
const INTERRUPT_RE = /\battachInterrupt\s*\(\s*(?:digitalPinToInterrupt\s*\(\s*)?([A-Za-z_]\w*|\d{1,2})\s*\)?/g;
// `myServo.attach(pin)` (Servo.h) never calls pinMode/digitalWrite on its pin at all — the library owns
// pin configuration internally — so a sketch using only Servo would otherwise show zero pins for its
// actual actuator. Matched on the method name alone (not the receiver), same generic-enough shape as
// the other deterministic regex probes in this codebase.
const ATTACH_RE = /\.attach\s*\(\s*([A-Za-z_]\w*|\d{1,2}|A[0-5])/g;
const DEFINE_RE = /^\s*#define\s+([A-Za-z_]\w*)\s+(\d{1,2}|A[0-5])\b/gm;
const CONST_DECL_RE = /\b(?:const\s+(?:int|byte|uint8_t)|constexpr\s+int)\s+([A-Za-z_]\w*)\s*=\s*(\d{1,2}|A[0-5])\s*;/g;

/**
 * Library constructors that take a PIN as an argument — a whole category of pin the calls above miss.
 *
 * `DHT dht(DHT_PIN, DHT_TYPE);` configures its pin inside the library, so the sketch never calls
 * `pinMode` on it. Measured consequence, from a real benchmark run: a correct climate-display sketch
 * with `#define DHT_PIN 2` produced a wiring diagram containing **one rectangle** — the empty board —
 * and no components at all. The artifact was valid PlantUML and completely useless, which is a worse
 * outcome than failing to generate one.
 *
 * A CURATED MAP, not a general "any constructor's first integer argument" rule, and deliberately so:
 * `LiquidCrystal_I2C lcd(0x27, 16, 2);` takes an I2C address and a geometry, none of which are pins,
 * and reading them as pins would put fictional wires in a diagram whose whole purpose is to be
 * trustworthy. Same discipline as `CORE_PIN_MACROS` — only entries that are certain. Values are the
 * zero-based argument positions that are pins.
 */
const LIBRARY_PIN_ARGS: Record<string, number[]> = {
  DHT: [0],
  OneWire: [0],
  IRrecv: [0],
  IRsend: [0],
  SoftwareSerial: [0, 1],
  NewPing: [0, 1],
  Ultrasonic: [0, 1],
  Adafruit_NeoPixel: [1], // (numPixels, pin, flags)
  Stepper: [1, 2, 3, 4],  // (stepsPerRev, p1, p2, [p3, p4])
  AccelStepper: [1, 2, 3, 4],
  LiquidCrystal: [0, 1, 2, 3, 4, 5], // the PARALLEL one; LiquidCrystal_I2C is absent on purpose
  TM1637Display: [0, 1],
  Servo: [], // configured via .attach(), already covered by ATTACH_RE
};

const LIB_CTOR_RE = /\b([A-Z][A-Za-z0-9_]*)\s+\w+\s*\(([^;)]*)\)\s*;/g;

/**
 * I2C uses FIXED pins that appear nowhere in the source: SDA and SCL. A sketch driving an I2C display
 * mentions neither, so without this the display is absent from its own wiring diagram — and "SDA→A4,
 * SCL→A5" is exactly what a beginner needs the diagram to tell them.
 */
const I2C_INCLUDE_RE = /#include\s*[<"](?:Wire\.h|LiquidCrystal_I2C\.h|Adafruit_SSD1306\.h|Adafruit_GFX\.h|SSD1306|RTClib\.h)/i;
const I2C_PINS: Array<{ raw: string; label: string }> = [
  { raw: 'A4', label: 'I2C SDA' },
  { raw: 'A5', label: 'I2C SCL' },
];

/**
 * Core macros the toolchain defines, which a sketch therefore never defines itself.
 *
 * Without these, `const int led = LED_BUILTIN;` resolves to nothing and the wiring diagram labels the
 * pin `led` — honest, but useless to the beginner the diagram exists for, who wants to know it is pin
 * 13. Observed in a real benchmark run. Only genuinely universal macros belong here: a guess about a
 * board-specific pin would be exactly the "recalled hardware fact" this whole subsystem refuses to
 * make. `LED_BUILTIN` is 13 on every AVR board ayin's catalog and toolchain defaults target.
 */
const CORE_PIN_MACROS: Record<string, string> = {
  LED_BUILTIN: '13',
};

/** Pure regex extraction — a full C++ parser is not needed to answer "which pins does this touch",
 *  same pragmatic level as `qa/probes.ts`'s own `PIN_IO_RE`, just resolving named constants too. */
export function extractPinUsage(source: string): PinUsage[] {
  const constants = new Map<string, string>(Object.entries(CORE_PIN_MACROS));
  for (const re of [DEFINE_RE, CONST_DECL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) constants.set(m[1], m[2]);
  }
  // `const int led = LED_BUILTIN;` — an alias for a core macro, not a literal, so neither regex above
  // catches it. One extra pass resolves the alias transitively through what is already known.
  for (const m of source.matchAll(/\b(?:const\s+(?:int|byte|uint8_t)|constexpr\s+int)\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*;/g)) {
    const target = constants.get(m[2]);
    if (target) constants.set(m[1], target);
  }

  const entropy = entropyPins(source);
  const hits = new Map<string, Set<string>>();
  const record = (token: string, fn: string): void => {
    if (!hits.has(token)) hits.set(token, new Set());
    hits.get(token)!.add(fn);
  };

  PIN_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PIN_CALL_RE.exec(source)) !== null) record(m[2], m[1]);
  INTERRUPT_RE.lastIndex = 0;
  while ((m = INTERRUPT_RE.exec(source)) !== null) record(m[1], 'attachInterrupt');
  ATTACH_RE.lastIndex = 0;
  while ((m = ATTACH_RE.exec(source)) !== null) record(m[1], 'attach');

  // Library constructors that own their pin — see LIBRARY_PIN_ARGS for why this is a curated map.
  LIB_CTOR_RE.lastIndex = 0;
  while ((m = LIB_CTOR_RE.exec(source)) !== null) {
    const positions = LIBRARY_PIN_ARGS[m[1]];
    if (!positions || positions.length === 0) continue;
    const args = m[2].split(',').map((a) => a.trim());
    for (const i of positions) {
      const arg = args[i];
      // Only a pin-shaped token. An I2C address (0x27), a geometry (16), a step count (2048) or an
      // expression must never become a wire — a fictional connection in a wiring diagram is the one
      // failure this whole subsystem exists to avoid.
      if (arg && /^([A-Za-z_]\w*|\d{1,2}|A[0-5])$/.test(arg) && !/^0x/i.test(arg)) {
        record(arg, `${m[1]}() constructor`);
      }
    }
  }

  // I2C's pins are fixed and appear nowhere in the source. Added only when the sketch actually
  // includes an I2C library, and marked so the diagram can label them for what they are.
  if (I2C_INCLUDE_RE.test(source)) {
    for (const p of I2C_PINS) record(p.raw, p.label);
  }

  return [...hits.entries()]
    .map(([raw, calls]) => {
      const sorted = [...calls].sort();
      let resolved = /^\d{1,2}$/.test(raw) || /^A[0-5]$/.test(raw) ? raw : (constants.get(raw) ?? raw);
      // `analogRead(0)` MEANS A0. A bare number in analogRead is an ANALOG channel, not digital pin 0 —
      // that is Arduino's own API, and pin 0 is the hardware serial RX, which nothing sane reads with
      // analogRead. Observed on a real sketch doing the textbook `randomSeed(analogRead(0))`: the audit
      // then complained that "the code drives pin 0" and the README never mentioned it, which was an
      // accusation about a pin the sketch never touched. Only for analogRead — a bare number in
      // analogWrite is genuinely a digital PWM pin.
      if (/^\d{1,2}$/.test(resolved) && Number(resolved) <= 15 && sorted.length === 1 && sorted[0] === 'analogRead') {
        resolved = `A${resolved}`;
      }
      return { raw, resolved, calls: sorted, entropyOnly: entropy.has(raw.toUpperCase()) || entropy.has(resolved.toUpperCase()) };
    })
    .sort((a, b) => a.raw.localeCompare(b.raw));
}

// ── grounding: map real pins to real catalog components (one LLM call, validated) ──

export interface GroundedConnection {
  pin: string;
  /** A catalog id from `arduino-components-data.ts`, or the literal "unknown". Never invented. */
  componentId: string;
  leg: string;
  label: string;
}

/** Exported for gate testing — a model's JSON discipline is the thing most likely to drift. */
export function parseConnections(raw: string): GroundedConnection[] | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { connections?: unknown };
    if (!Array.isArray(obj.connections)) return null;
    const out: GroundedConnection[] = [];
    for (const c of obj.connections) {
      if (!c || typeof c !== 'object') continue;
      const o = c as Record<string, unknown>;
      if (typeof o.pin !== 'string' || typeof o.componentId !== 'string') continue;
      out.push({
        pin: o.pin,
        componentId: o.componentId,
        leg: typeof o.leg === 'string' ? o.leg : '',
        label: typeof o.label === 'string' && o.label ? o.label : o.componentId,
      });
    }
    return out;
  } catch {
    return null;
  }
}

const MAX_GROUND_ROUNDS = 3;

/**
 * ONE grounded LLM call (with a bounded repair loop, same shape as `diagram.ts`'s validate/retry): map
 * this sketch's real pins to real arduino-db component ids. Returns `[]` — never throws — on a down
 * model or an unusable response, so a broken grounding call degrades to "no connections mapped" rather
 * than failing the whole command; the caller (arduino-diagram.ts) still renders the raw pin list in
 * that case, each pin honestly marked as unmatched.
 */
export interface GroundingResult {
  connections: GroundedConnection[];
  /**
   * True when the LLM call burned every repair round and produced nothing usable — as opposed to
   * succeeding and honestly finding no catalog match.
   *
   * The distinction is invisible in the rendered diagram and decides whether it is worthless or
   * correct. Blink drives only `LED_BUILTIN`: there IS no external part, so a diagram with one
   * "unknown" pin is the RIGHT answer and inventing an LED would be the bug. A five-pin traffic light
   * whose grounding exhausted produces the same all-unknown shape and is useless. A check that reads
   * only the picture cannot tell them apart, so the outcome is recorded at generation time instead.
   */
  exhausted: boolean;
}

export async function groundWiring(
  sketchName: string,
  source: string,
  readme: string | null,
  pins: PinUsage[],
): Promise<GroundingResult> {
  if (pins.length === 0) return { connections: [], exhausted: false };
  const pinList = pins.map((p) => `${p.raw}${p.resolved !== p.raw ? ` (resolves to ${p.resolved})` : ''} — ${p.calls.join(', ')}`).join('\n');
  // RETRIEVED, not dumped. The sketch source plus its README is an excellent retrieval query — it
  // names the parts in comments, in pin constant names (`RED_PIN`, `BUTTON_PIN`) and in the README's
  // own parts list. Dumping all 28 entries put ~24 irrelevant component descriptions in front of a
  // model whose entire job here is to pick the right few, which is the worst place to spend a
  // distractor budget. Ids of everything else still ship, so a component the keywords missed can
  // still be named.
  const catalog = retrieveCatalog(`${sketchName} ${readme ?? ''} ${source}`.slice(0, 4000)).text;
  // NORMALISED matching, not exact. `validPinTokens.has(c.pin)` was an exact string compare against
  // free-form model output, so an answer of "D2", "pin 2", "GPIO2" or "a0" — all perfectly clear to a
  // human — dropped EVERY connection, the repair round produced the same phrasing, and the call
  // exhausted. The diagram then rendered bare pins with no parts, and my first response to that was to
  // tell the operator to rerun the tool by hand, which is exactly the wrong place to put the work.
  //
  // This is the same bug as `matchLeg` in arduino-diagram.ts — a brittle exact-match on a field the
  // prompt invites the model to phrase naturally. I fixed that one and left its twin.
  // The lookahead admits `A0` as well as `2`: "pin A0" is as natural an answer as "pin 2", and a
  // digit-only lookahead left it as the literal key `PINA0`, matching nothing.
  const pinKey = (t: string) => t.trim().toUpperCase().replace(/^(?:PIN|GPIO|IO|D)\s*(?=\d|A\d)/, '').replace(/\s+/g, '');
  const validPinTokens = new Map<string, string>();
  for (const p of pins) {
    validPinTokens.set(pinKey(p.raw), p.raw);
    validPinTokens.set(pinKey(p.resolved), p.raw);
  }

  let lastError = '';
  let lastRaw = '';
  for (let round = 1; round <= MAX_GROUND_ROUNDS; round++) {
    const prompt = arduinoPrompts.get('groundWiring', {
      SKETCH_NAME: sketchName,
      README_BLOCK: readme ? `README (for context):\n${readme.slice(0, 3000)}\n` : '',
      SKETCH_SOURCE: source.slice(0, 8000),
      PIN_LIST: pinList,
      CATALOG: catalog,
      REPAIR: lastError ? `\n${arduinoPrompts.get('groundRepair', { ERROR: lastError, PREVIOUS: lastRaw.slice(0, 1500) })}\n` : '',
    });

    let raw: string;
    try {
      raw = await llmChat([{ role: 'user', content: prompt }]);
    } catch (err) {
      log('WARN', 'arduino_explain_ground_call_failed', { sketch: sketchName, error: err instanceof Error ? err.message : String(err) });
      return { connections: [], exhausted: true };
    }
    lastRaw = raw;

    const parsed = parseConnections(raw);
    if (!parsed) { lastError = 'response was not the required JSON shape ({"connections": [...]})'; continue; }

    // Rewrite each accepted connection's pin back to the token the DIAGRAM uses, so downstream code
    // still keys off `p.raw` exactly as before.
    const filtered = parsed
      .map((c) => { const canon = validPinTokens.get(pinKey(c.pin)); return canon ? { ...c, pin: canon } : null; })
      .filter((c): c is GroundedConnection => c !== null);
    if (filtered.length === 0 && parsed.length > 0) {
      lastError = `none of the ${parsed.length} connection(s) named a pin from the list — use exactly these tokens: ${pins.map((p) => p.raw).join(', ')}`;
      continue;
    }

    return {
      connections: filtered.map((c) => ({ ...c, componentId: getArduinoComponent(c.componentId) ? c.componentId : 'unknown' })),
      exhausted: false,
    };
  }
  log('WARN', 'arduino_explain_ground_exhausted', { sketch: sketchName, rounds: String(MAX_GROUND_ROUNDS) });
  return { connections: [], exhausted: true };
}
