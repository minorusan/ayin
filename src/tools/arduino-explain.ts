/**
 * arduino-explain — "teach me my own wiring": for an Arduino project, render one self-contained HTML
 * page per sketch showing the board, which pin drives which physical part, and a beginner-level
 * explanation of that part (identify / what it does / how it's used / wiring notes), then open it in
 * VS Code. Powers the `/arduino-explain` command and the QA-pass regeneration hook (`agent.ts`).
 *
 * PIPELINE, deliberately split into a deterministic half and a grounded half:
 *
 *   findSketches (walk the tree)  →  extractPinUsage (regex over pinMode/digitalWrite/…, PURE, no LLM)
 *   → groundWiring (ONE LLM call per sketch: given the real pins + source + README, map each pin to a
 *     component id from arduino-db's catalog — never invents an id outside that list) → renderExplainHtml
 *     (PURE: given pins + grounded connections, produce the HTML — no LLM in this half either)
 *
 * The split matters for testability (`tool/check-gates.mjs` exercises extractPinUsage/findSketches/
 * renderExplainHtml directly, no model needed — the same shape diagram.ts uses for extractPuml/
 * stripIncludes) and for honesty: a wiring diagram that fabricated a component id no beginner asked
 * about would be worse than one that says "unknown — code touches this pin but the part isn't in the
 * catalog", which is what a validation miss degrades to here (see `groundWiring`).
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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { llmChat } from '../llm/manager.js';
import { log } from '../log.js';
import { prompts, packagePath } from '../prompts-service.js';
import { openInEditor } from '../editor.js';
import { ARDUINO_COMPONENTS, type ArduinoCategory, type ArduinoComponent } from './arduino-components-data.js';
import { catalogLine, getArduinoComponent } from './arduino-db.js';
import { probeArduinoProject, type ChangedFile } from '../qa/probes.js';

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

function readReadme(root: string): string | null {
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
 * than failing the whole command; `renderExplainHtml` still shows the raw pin list in that case.
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

// ── rendering (pure, no LLM — the other deterministic half) ─────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CATEGORY_COLOR: Record<ArduinoCategory, string> = {
  output: '#d9782f', input: '#3f7fd9', sensor: '#2fa669', display: '#9a4fd9', communication: '#d93f4a', passive: '#7a828c',
};

/** A handful of recognizable per-id icons; everything else falls back to its category's shape. */
function componentIcon(id: string, category: ArduinoCategory): string {
  const c = CATEGORY_COLOR[category];
  switch (id) {
    case 'standard-led':
      return `<circle cx="12" cy="10" r="7" fill="none" stroke="${c}" stroke-width="2"/><line x1="9" y1="17" x2="9" y2="22" stroke="${c}" stroke-width="2"/><line x1="15" y1="17" x2="15" y2="20" stroke="${c}" stroke-width="2"/>`;
    case 'rgb-led-common-cathode':
      return `<circle cx="12" cy="10" r="7" fill="none" stroke="${c}" stroke-width="2"/><path d="M6 10a6 6 0 0 1 4-5.6" stroke="#d93f3f" stroke-width="2" fill="none"/><path d="M8 15.5a6 6 0 0 0 8 0" stroke="#2fa669" stroke-width="2" fill="none"/><path d="M18 10a6 6 0 0 1-4 5.6" stroke="#3f7fd9" stroke-width="2" fill="none"/><line x1="12" y1="17" x2="12" y2="22" stroke="${c}" stroke-width="2"/>`;
    case 'push-button':
      return `<rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke="${c}" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="${c}"/><line x1="4" y1="4" x2="6" y2="6" stroke="${c}" stroke-width="2"/><line x1="20" y1="4" x2="18" y2="6" stroke="${c}" stroke-width="2"/><line x1="4" y1="20" x2="6" y2="18" stroke="${c}" stroke-width="2"/><line x1="20" y1="20" x2="18" y2="18" stroke="${c}" stroke-width="2"/>`;
    case 'sg90-micro-servo':
      return `<rect x="5" y="9" width="11" height="10" rx="1.5" fill="none" stroke="${c}" stroke-width="2"/><line x1="16" y1="10" x2="21" y2="6" stroke="${c}" stroke-width="2"/><line x1="16" y1="10" x2="21" y2="12" stroke="${c}" stroke-width="2"/>`;
    case 'piezo-buzzer':
      return `<circle cx="12" cy="12" r="4" fill="${c}"/><path d="M12 4a8 8 0 0 1 0 16" stroke="${c}" stroke-width="1.5" fill="none" opacity="0.6"/><path d="M12 1a11 11 0 0 1 0 22" stroke="${c}" stroke-width="1.5" fill="none" opacity="0.35"/>`;
    case 'potentiometer':
      return `<circle cx="12" cy="12" r="7" fill="none" stroke="${c}" stroke-width="2"/><line x1="12" y1="12" x2="17" y2="8" stroke="${c}" stroke-width="2"/>`;
    case 'resistor':
      return `<line x1="1" y1="12" x2="6" y2="12" stroke="${c}" stroke-width="2"/><path d="M6 12l2-4 3 8 3-8 3 8 2-4" fill="none" stroke="${c}" stroke-width="2"/><line x1="18" y1="12" x2="23" y2="12" stroke="${c}" stroke-width="2"/>`;
    default:
      switch (category) {
        case 'output':
          return `<path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="${c}"/>`;
        case 'input':
          return `<rect x="4" y="9" width="16" height="6" rx="3" fill="none" stroke="${c}" stroke-width="2"/><circle cx="9" cy="12" r="2.5" fill="${c}"/>`;
        case 'sensor':
          return `<path d="M4 16a8 8 0 0 1 16 0" fill="none" stroke="${c}" stroke-width="2"/><path d="M8 16a4 4 0 0 1 8 0" fill="none" stroke="${c}" stroke-width="2"/><circle cx="12" cy="16" r="1.6" fill="${c}"/>`;
        case 'display':
          return `<rect x="3" y="5" width="18" height="12" rx="1.5" fill="none" stroke="${c}" stroke-width="2"/><line x1="8" y1="20" x2="16" y2="20" stroke="${c}" stroke-width="2"/>`;
        case 'communication':
          return `<circle cx="12" cy="19" r="1.6" fill="${c}"/><path d="M8 15a6 6 0 0 1 8 0" stroke="${c}" stroke-width="2" fill="none"/><path d="M5 11a11 11 0 0 1 14 0" stroke="${c}" stroke-width="2" fill="none" opacity="0.6"/>`;
        default:
          return `<rect x="5" y="5" width="14" height="14" rx="1.5" fill="none" stroke="${c}" stroke-width="2"/><line x1="9" y1="2" x2="9" y2="5" stroke="${c}" stroke-width="2"/><line x1="15" y1="2" x2="15" y2="5" stroke="${c}" stroke-width="2"/><line x1="9" y1="19" x2="9" y2="22" stroke="${c}" stroke-width="2"/><line x1="15" y1="19" x2="15" y2="22" stroke="${c}" stroke-width="2"/>`;
      }
  }
}

const DIGITAL_SLOTS = 14; // pins 0-13, laid out left→right along the board's top edge
const ANALOG_SLOTS = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];

interface Point { x: number; y: number; }

/** Where a resolved pin token sits on the (simplified, not-to-scale) board outline, or `null` if the
 *  token never resolved to a real pin number (an unrecognized named constant). */
function pinAnchor(resolved: string, boardX: number, boardY: number, boardW: number, boardH: number): Point | null {
  if (/^\d{1,2}$/.test(resolved)) {
    const n = Number(resolved);
    if (n < 0 || n > 13) return null;
    return { x: boardX + 20 + (n * (boardW - 40)) / (DIGITAL_SLOTS - 1), y: boardY };
  }
  const ai = ANALOG_SLOTS.indexOf(resolved);
  if (ai >= 0) {
    return { x: boardX + 20 + (ai * (boardW - 40)) / (ANALOG_SLOTS.length - 1), y: boardY + boardH };
  }
  return null;
}

/** A quadratic breadcrumb: the dashed wire itself PLUS a few dot markers and a leg-label chip at the
 *  midpoint — "breadcrumbs with symbols" per the spec, not just a single plain connecting line. */
function breadcrumbPath(from: Point, to: Point, leg: string): string {
  const midX = (from.x + to.x) / 2;
  const c1 = { x: from.x + (midX - from.x) * 0.6, y: from.y };
  const c2 = { x: to.x - (to.x - midX) * 0.6, y: to.y };
  const bezier = (t: number): Point => {
    const u = 1 - t;
    return {
      x: u ** 3 * from.x + 3 * u ** 2 * t * c1.x + 3 * u * t ** 2 * c2.x + t ** 3 * to.x,
      y: u ** 3 * from.y + 3 * u ** 2 * t * c1.y + 3 * u * t ** 2 * c2.y + t ** 3 * to.y,
    };
  };
  const dots = [0.25, 0.5, 0.75].map(bezier);
  const mid = bezier(0.5);
  const dotEls = dots.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="#9aa4b2"/>`).join('');
  const chipW = Math.min(220, 14 + leg.length * 6.2);
  return [
    `<path d="M ${from.x.toFixed(1)},${from.y.toFixed(1)} C ${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}" fill="none" stroke="#9aa4b2" stroke-width="1.6" stroke-dasharray="1 7" stroke-linecap="round"/>`,
    dotEls,
    leg
      ? `<g transform="translate(${(mid.x - chipW / 2).toFixed(1)}, ${(mid.y - 10).toFixed(1)})"><rect width="${chipW.toFixed(1)}" height="20" rx="10" fill="#20242c" stroke="#454c59"/><text x="${(chipW / 2).toFixed(1)}" y="14" font-size="10.5" fill="#dfe3ea" text-anchor="middle" font-family="Menlo, Consolas, monospace">${escapeHtml(leg.length > 34 ? `${leg.slice(0, 33)}…` : leg)}</text></g>`
      : '',
  ].join('');
}

interface CardEntry {
  pinLabel: string;
  connectorLabel: string;
  component: ArduinoComponent | null;
  anchor: Point | null;
}

const CARD_W = 620;
const CARD_H = 250;
const CARD_GAP = 34;
const BOARD_X = 60;
const BOARD_Y = 90;
const BOARD_W = 300;
const BOARD_H = 460;

function renderCard(entry: CardEntry, y: number): string {
  const c = entry.component;
  const category: ArduinoCategory = c?.category ?? 'passive';
  const icon = componentIcon(c?.id ?? 'unknown', category);
  const color = CATEGORY_COLOR[category];
  const title = c ? c.name : 'Unknown component';
  const legsHtml = c
    ? c.legs.map((l) => `<div class="leg"><span class="legname">${escapeHtml(l.legName)}</span> → ${escapeHtml(l.connectsTo)} <span class="legwhy">(${escapeHtml(l.explanation)})</span></div>`).join('')
    : `<div class="leg">The sketch drives this pin, but no catalog component matched — check the wiring by hand.</div>`;

  return `
    <g transform="translate(${BOARD_X + BOARD_W + 130}, ${y})">
      <rect width="${CARD_W}" height="${CARD_H}" rx="14" fill="#181b21" stroke="${color}" stroke-width="1.6"/>
      <foreignObject x="0" y="0" width="${CARD_W}" height="${CARD_H}">
        <div xmlns="http://www.w3.org/1999/xhtml" class="card">
          <div class="card-head">
            <svg viewBox="0 0 24 24" width="30" height="30">${icon}</svg>
            <div>
              <div class="card-title">${escapeHtml(entry.connectorLabel)}</div>
              <div class="card-sub">${escapeHtml(title)} · pin ${escapeHtml(entry.pinLabel)}</div>
            </div>
          </div>
          ${c ? `<div class="card-row"><b>Identify:</b> ${escapeHtml(c.identify)}</div>
          <div class="card-row"><b>What it does:</b> ${escapeHtml(c.whatItDoes)}</div>
          <div class="card-row"><b>How it's used:</b> ${escapeHtml(c.howUsed)}</div>
          <div class="legs">${legsHtml}</div>
          <div class="card-row wiring-note"><b>Wiring note:</b> ${escapeHtml(c.wiringNotes)}</div>` : `<div class="card-row">${legsHtml}</div>`}
        </div>
      </foreignObject>
    </g>`;
}

/**
 * Pure renderer: pins + grounded connections → one self-contained HTML page. No LLM call in here — see
 * the module header for why the split matters. `pins` alone (with empty `connections`) still renders a
 * usable page: every touched pin gets a card saying "no catalog match", never silently dropped.
 */
export function renderExplainHtml(sketchName: string, pins: PinUsage[], connections: GroundedConnection[]): string {
  const byPin = new Map(connections.map((c) => [c.pin, c]));
  const entries: CardEntry[] = pins.map((p) => {
    const conn = byPin.get(p.raw) ?? byPin.get(p.resolved);
    const component = conn && conn.componentId !== 'unknown' ? getArduinoComponent(conn.componentId) ?? null : null;
    const anchor = pinAnchor(p.resolved, BOARD_X, BOARD_Y, BOARD_W, BOARD_H);
    return {
      pinLabel: p.raw === p.resolved ? p.raw : `${p.raw} (${p.resolved})`,
      connectorLabel: conn?.label || p.calls.join('/'),
      component,
      anchor,
    };
  });

  const contentHeight = Math.max(BOARD_Y + BOARD_H + 60, 60 + entries.length * (CARD_H + CARD_GAP));
  const width = BOARD_X + BOARD_W + 130 + CARD_W + 60;

  // Board outline: a simplified Uno silhouette — digital 0-13 along the top edge, A0-A5 along the
  // bottom. Not to scale or pin-accurate to a real Uno's two-header layout; the point is teaching which
  // SIDE a pin lives on, not a fabrication-grade pinout diagram.
  const topPins = Array.from({ length: DIGITAL_SLOTS }, (_, n) => {
    const x = BOARD_X + 20 + (n * (BOARD_W - 40)) / (DIGITAL_SLOTS - 1);
    return `<circle cx="${x.toFixed(1)}" cy="${BOARD_Y}" r="3.5" fill="#dfe3ea"/><text x="${x.toFixed(1)}" y="${BOARD_Y - 8}" font-size="9" fill="#9aa4b2" text-anchor="middle" font-family="Menlo, Consolas, monospace">${n}</text>`;
  }).join('');
  const bottomPins = ANALOG_SLOTS.map((label, i) => {
    const x = BOARD_X + 20 + (i * (BOARD_W - 40)) / (ANALOG_SLOTS.length - 1);
    return `<circle cx="${x.toFixed(1)}" cy="${BOARD_Y + BOARD_H}" r="3.5" fill="#dfe3ea"/><text x="${x.toFixed(1)}" y="${BOARD_Y + BOARD_H + 16}" font-size="9" fill="#9aa4b2" text-anchor="middle" font-family="Menlo, Consolas, monospace">${label}</text>`;
  }).join('');

  let unplacedOffset = 0;
  const wiresAndCards = entries.map((entry, i) => {
    const y = 40 + i * (CARD_H + CARD_GAP);
    const cardAnchor: Point = { x: BOARD_X + BOARD_W + 130, y: y + CARD_H / 2 };
    let from = entry.anchor;
    if (!from) {
      from = { x: BOARD_X + BOARD_W, y: BOARD_Y + BOARD_H / 2 + unplacedOffset * 26 };
      unplacedOffset++;
    }
    return breadcrumbPath(from, cardAnchor, entry.connectorLabel) + renderCard(entry, y);
  }).join('\n');

  const boardLabel = 'ARDUINO UNO (simplified — not to scale)';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Wiring — ${escapeHtml(sketchName)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0f1115; color: #dfe3ea; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { padding: 22px 32px 6px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #9aa4b2; font-size: 13px; }
  .canvas-wrap { overflow-x: auto; padding: 10px 0 40px; }
  .card { box-sizing: border-box; width: ${CARD_W}px; height: ${CARD_H}px; padding: 14px 18px; overflow: auto; font-size: 12.5px; line-height: 1.42; }
  .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .card-title { font-size: 15px; font-weight: 600; color: #f2f4f7; }
  .card-sub { font-size: 11.5px; color: #9aa4b2; font-family: Menlo, Consolas, monospace; }
  .card-row { margin: 6px 0; }
  .card-row b { color: #c8cdd6; }
  .legs { margin: 8px 0; padding: 8px 10px; background: #12151a; border-radius: 8px; }
  .leg { margin: 3px 0; }
  .legname { font-family: Menlo, Consolas, monospace; color: #f2f4f7; }
  .legwhy { color: #838b98; }
  .wiring-note { color: #e0c060; }
  footer { padding: 10px 32px 26px; color: #6b7280; font-size: 11.5px; }
</style>
</head>
<body>
<header>
  <h1>Wiring explainer — ${escapeHtml(sketchName)}</h1>
  <div class="subtitle">${entries.length} pin(s) touched by this sketch · ${entries.filter((e) => e.component).length} matched to the arduino-db catalog · generated by ayin /arduino-explain</div>
</header>
<div class="canvas-wrap">
<svg width="${width}" height="${contentHeight}" viewBox="0 0 ${width} ${contentHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${BOARD_X}" y="${BOARD_Y}" width="${BOARD_W}" height="${BOARD_H}" rx="16" fill="#141821" stroke="#3a4150" stroke-width="2"/>
  <text x="${BOARD_X + BOARD_W / 2}" y="${BOARD_Y + BOARD_H / 2 - 10}" font-size="13" fill="#6b7280" text-anchor="middle" font-family="Menlo, Consolas, monospace">${escapeHtml(boardLabel)}</text>
  <rect x="${BOARD_X - 14}" y="${BOARD_Y + BOARD_H / 2 - 22}" width="16" height="44" rx="3" fill="#3a4150"/>
  ${topPins}
  ${bottomPins}
  ${wiresAndCards}
</svg>
</div>
<footer>Regenerated automatically whenever an Arduino QA pass touches this sketch — edits here do not persist; edit the sketch or arduino-db instead.</footer>
</body>
</html>
`;
}

// ── orchestration ─────────────────────────────────────────────────────

export interface ExplainSketchResult {
  sketch: string;
  htmlPath: string;
  opened: boolean;
  pinsFound: number;
  connectionsMatched: number;
}

export interface ExplainOutcome {
  ok: boolean;
  reason?: string;
  results: ExplainSketchResult[];
}

/**
 * The full pipeline for a project root: early-return if it isn't an Arduino project, else one HTML
 * page per sketch, sketches processed SEQUENTIALLY (never in parallel — one door to the shared model).
 */
export async function runArduinoExplain(root: string, opts: { open?: boolean; only?: Set<string> } = {}): Promise<ExplainOutcome> {
  if (!isArduinoProject(root)) {
    return { ok: false, reason: `${root} does not look like an Arduino project — no .ino/.pde sketch and no platformio.ini/sketch.yaml`, results: [] };
  }
  let sketches = findSketches(root);
  if (opts.only) sketches = sketches.filter((s) => opts.only!.has(s.path));
  if (sketches.length === 0) {
    return { ok: false, reason: 'Arduino project marker found but no matching .ino/.pde sketch to explain', results: [] };
  }

  const readme = readReadme(root);
  const results: ExplainSketchResult[] = [];
  for (const sketch of sketches) {
    let source: string;
    try { source = readFileSync(sketch.path, 'utf-8'); } catch (err) {
      log('WARN', 'arduino_explain_read_failed', { sketch: sketch.path, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const pins = extractPinUsage(source);
    const connections = await groundWiring(sketch.baseName, source, readme, pins);
    const html = renderExplainHtml(sketch.baseName, pins, connections);
    const outPath = join(sketch.dir, `${sketch.baseName}.wiring.html`);
    writeFileSync(outPath, html);
    const opened = opts.open === false ? false : await openInEditor(outPath);
    log('INFO', 'arduino_explain_generated', {
      sketch: sketch.baseName, pins: String(pins.length), connections: String(connections.length), opened: String(opened),
    });
    results.push({
      sketch: sketch.baseName, htmlPath: outPath, opened,
      pinsFound: pins.length, connectionsMatched: connections.filter((c) => c.componentId !== 'unknown').length,
    });
  }
  return { ok: true, results };
}

export interface RegenerateResult {
  results: ExplainSketchResult[];
  /** Sketch paths this call actually regenerated — pass back in as `skip` from a second caller in the
   *  same pass (Presenter runs before the QA-pass hook and both can fire on the same turn) so the
   *  wiring explainer, and its one LLM call per sketch, is never built twice for the same change. */
  regeneratedPaths: Set<string>;
}

/**
 * Regenerate the wiring explainer for exactly the sketches `files` touched — the shared entry point
 * both Presenter (`presenter/index.ts`) and the QA-pass hook (`agent.ts`) call, so "Arduino work being
 * presented/QA'd necessitates a current wiring page" has exactly one implementation. Returns `null`
 * when the change isn't an Arduino sketch touch at all (nothing to do, not an error).
 */
export async function regenerateTouchedSketches(
  root: string,
  files: ChangedFile[],
  skip: Set<string> = new Set(),
): Promise<RegenerateResult | null> {
  const arduino = probeArduinoProject(files, root);
  if (!arduino.applies || arduino.sketches.length === 0) return null;
  const pending = arduino.sketches.map((s) => s.path).filter((p) => !skip.has(p));
  if (pending.length === 0) return { results: [], regeneratedPaths: new Set() };

  const only = new Set(pending);
  const outcome = await runArduinoExplain(root, { open: false, only });
  if (!outcome.ok) return { results: [], regeneratedPaths: new Set() };
  return { results: outcome.results, regeneratedPaths: only };
}

export function formatExplainOutcome(o: ExplainOutcome): string {
  if (!o.ok) return `Not generating a wiring explainer: ${o.reason}`;
  if (o.results.length === 0) return 'No sketch produced output.';
  return o.results
    .map((r) => `${r.sketch}: ${r.connectionsMatched}/${r.pinsFound} pin(s) matched to arduino-db → ${r.htmlPath}${r.opened ? ' (opened in editor)' : ' (no editor found on PATH — open it manually)'}`)
    .join('\n');
}
