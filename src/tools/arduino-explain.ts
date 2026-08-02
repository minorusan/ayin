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
import { ARDUINO_COMPONENTS } from './arduino-components-data.js';
import { catalogLine, getArduinoComponent } from './arduino-db.js';

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

export interface PinUsage {
  /** The exact token the code uses — a literal ("13", "A0") or a named constant ("LED_PIN"). */
  raw: string;
  /** The literal pin value if `raw` was already one, or resolved from a `#define`/`const int` in the
   *  same file — still equal to `raw` when it names a constant this file never actually defines
   *  (e.g. a core macro like `LED_BUILTIN`). */
  resolved: string;
  /** Which pin-touching functions used this token, e.g. ['pinMode', 'digitalWrite']. */
  calls: string[];
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

/** Pure regex extraction — a full C++ parser is not needed to answer "which pins does this touch",
 *  same pragmatic level as `qa/probes.ts`'s own `PIN_IO_RE`, just resolving named constants too. */
export function extractPinUsage(source: string): PinUsage[] {
  const constants = new Map<string, string>();
  for (const re of [DEFINE_RE, CONST_DECL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) constants.set(m[1], m[2]);
  }

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

  return [...hits.entries()]
    .map(([raw, calls]) => ({
      raw,
      resolved: /^\d{1,2}$/.test(raw) || /^A[0-5]$/.test(raw) ? raw : (constants.get(raw) ?? raw),
      calls: [...calls].sort(),
    }))
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
export async function groundWiring(
  sketchName: string,
  source: string,
  readme: string | null,
  pins: PinUsage[],
): Promise<GroundedConnection[]> {
  if (pins.length === 0) return [];
  const pinList = pins.map((p) => `${p.raw}${p.resolved !== p.raw ? ` (resolves to ${p.resolved})` : ''} — ${p.calls.join(', ')}`).join('\n');
  const catalog = ARDUINO_COMPONENTS.map(catalogLine).join('\n');
  const validPinTokens = new Set(pins.flatMap((p) => [p.raw, p.resolved]));

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
      return [];
    }
    lastRaw = raw;

    const parsed = parseConnections(raw);
    if (!parsed) { lastError = 'response was not the required JSON shape ({"connections": [...]})'; continue; }

    const filtered = parsed.filter((c) => validPinTokens.has(c.pin));
    if (filtered.length === 0 && parsed.length > 0) { lastError = 'no connection named a pin from the provided pin list'; continue; }

    return filtered.map((c) => ({ ...c, componentId: getArduinoComponent(c.componentId) ? c.componentId : 'unknown' }));
  }
  log('WARN', 'arduino_explain_ground_exhausted', { sketch: sketchName, rounds: String(MAX_GROUND_ROUNDS) });
  return [];
}
