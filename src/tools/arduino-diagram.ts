/**
 * arduino-diagram — the Arduino-specific wiring diagram tool. One rectangle for the board (nested
 * rectangles for the pins actually used), one rectangle per component (nested rectangles for its legs),
 * wires drawn as labeled arrows between exact pins — so the result opens as an editable vector (SVG),
 * not a flattened picture: each rectangle stays its own group, draggable in Inkscape/draw.io/etc., which
 * is the whole point of PUML over the previous hand-rolled HTML/SVG render.
 *
 * REPLACES two overlapping, uncoordinated Arduino-wiring outputs that used to exist side by side:
 *   - `diagram.ts`'s keyword-triggered "wiring mode" (`isWiringRequest`) — a GENERIC, UNGROUNDED
 *     PlantUML ASCII render with no idea what components are actually wired, because diagram.ts never
 *     imported arduino-db at all. Removed from diagram.ts in the same change as this file was added.
 *   - `arduino-explain.ts`'s `renderExplainHtml` — grounded (real pins + real catalog matches) but a
 *     hand-rolled, non-draggable SVG/HTML page. Superseded by `renderArduinoWiringPuml` below; the
 *     extraction/grounding half of arduino-explain.ts (`findSketches`, `extractPinUsage`, `groundWiring`)
 *     is UNCHANGED and reused here directly — only the render target changed, not how wiring is grounded.
 *
 * A turn that touches an Arduino sketch now produces exactly ONE wiring artifact: `<sketch>.wiring.puml`
 * + `<sketch>.wiring.svg`. Still deterministic, no LLM call in this file — `groundWiring`'s one call per
 * sketch (in arduino-explain.ts) is the only model involvement, same split as before.
 *
 * WHAT GETS WIRED, precisely: `groundWiring` only ever maps a pin the SKETCH CODE actually touches to
 * one leg of one component (the code has no idea about GND/power wiring — Arduino sketches never call
 * pinMode on a ground or power pin). So each matched component shows ALL of its catalog legs (nothing
 * hidden), but only the leg the code actually drives gets a real wire to a real board pin. The OTHER
 * legs get a wire to a SYNTHETIC "GND"/"5V" pin on the board ONLY when the catalog's own `connectsTo`
 * text for that leg says so (`GND_RE`/`POWER_RE`) — a plain, deterministic string match against data
 * that's already reviewed content (arduino-components-data.ts), not a guess. A leg whose `connectsTo`
 * doesn't match either pattern (e.g. "another component's output") is still drawn, just unwired — that
 * is more honest than inventing a connection the code and catalog together don't actually establish.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';
import { openInEditor } from '../editor.js';
import {
  findSketches, isArduinoProject, readReadme, extractPinUsage, groundWiring,
  type PinUsage, type GroundedConnection, type Sketch,
} from './arduino-explain.js';
import { getArduinoComponent } from './arduino-db.js';
import type { ArduinoComponent } from './arduino-components-data.js';
import { probeArduinoProject, type ChangedFile } from '../qa/probes.js';

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
async function hasPlantuml(): Promise<boolean> {
  if (_hasPuml !== null) return _hasPuml;
  const { code } = await run(PUML_BIN, ['-version'], undefined, 15_000);
  _hasPuml = code === 0;
  return _hasPuml;
}

// ── PUML text generation (pure — no LLM, no I/O) ────────────────────────────

/** A PlantUML alias must be identifier-shaped; component/pin names are free text ("5V", "top-left leg"). */
function alias(prefix: string, s: string): string {
  const safe = s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
  return `${prefix}_${safe}`;
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** PlantUML note text is one paragraph per `note` block; keep it short and single-line-safe. */
function noteLine(s: string, max = 100): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const GND_RE = /\bGND\b|\bground\b/i;
const POWER_RE = /\b5V\b|\b3\.3V\b|\bVCC\b|\bpower\b/i;

interface ComponentGroup {
  key: string;
  label: string;
  component: ArduinoComponent | null;
  /** legName -> connectsTo text, in catalog order (or a single synthetic "pin" leg for an unmatched pin). */
  legs: Array<{ legName: string; connectsTo: string }>;
  /** The one leg the sketch's own pin actually drives. */
  groundedLeg: string;
  boardPinKey: string;
  boardPinLabel: string;
}

/**
 * `GroundedConnection.leg` is DELIBERATELY free-form project phrasing, not the catalog's exact
 * `legName` string — `groundWiring.txt` explicitly asks for "in this project's own words" (e.g.
 * "cathode", "signal wire"), because that field's original (and still real) consumer is a HUMAN
 * reading the label, not exact-string code. Matching it to a specific catalog leg for wire-drawing
 * therefore needs fuzzy word-overlap, not equality — an exact-match lookup silently drops the wire
 * for nearly every real model response, which is worse than an imprecise pick.
 */
function matchLeg(connLeg: string, legs: Array<{ legName: string }>): string {
  if (legs.length === 0) return 'pin';
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const target = norm(connLeg);
  if (!target) return legs[0].legName;
  const exact = legs.find((l) => norm(l.legName) === target);
  if (exact) return exact.legName;
  const targetWords = new Set(target.split(' ').filter(Boolean));
  let best = legs[0];
  let bestScore = 0;
  for (const l of legs) {
    const score = norm(l.legName).split(' ').filter((w) => w && targetWords.has(w)).length;
    if (score > bestScore) { bestScore = score; best = l; }
  }
  return best.legName;
}

/** Group grounded connections by component so a component with two driven pins (rare, but the catalog
 *  allows it) still renders as ONE box, not two overlapping ones. */
function groupByComponent(pins: PinUsage[], connections: GroundedConnection[]): ComponentGroup[] {
  const byPin = new Map(connections.map((c) => [c.pin, c]));
  const groups = new Map<string, ComponentGroup>();
  let unknownIdx = 0;

  for (const p of pins) {
    const conn = byPin.get(p.raw) ?? byPin.get(p.resolved);
    const pinLabel = p.raw === p.resolved ? p.raw : `${p.raw} (${p.resolved})`;

    if (!conn || conn.componentId === 'unknown') {
      const key = `unknown_${unknownIdx++}`;
      groups.set(key, {
        key, label: conn?.label || p.calls.join('/') || 'Unmatched pin', component: null,
        legs: [{ legName: 'pin', connectsTo: '' }], groundedLeg: 'pin',
        boardPinKey: p.resolved, boardPinLabel: pinLabel,
      });
      continue;
    }

    const existing = groups.get(conn.componentId);
    if (existing) { existing.groundedLeg = matchLeg(conn.leg, existing.legs) || existing.groundedLeg; continue; } // rare 2nd-pin case — first pin wins the drawn wire, kept simple
    const component = getArduinoComponent(conn.componentId) ?? null;
    const legs = component ? component.legs.map((l) => ({ legName: l.legName, connectsTo: l.connectsTo })) : [{ legName: conn.leg || 'pin', connectsTo: '' }];
    groups.set(conn.componentId, {
      key: conn.componentId,
      label: component?.name ?? conn.label,
      component,
      legs,
      groundedLeg: matchLeg(conn.leg, legs),
      boardPinKey: p.resolved,
      boardPinLabel: pinLabel,
    });
  }
  return [...groups.values()];
}

/**
 * Pure renderer: pins + grounded connections → PlantUML source. Board = one rectangle with a nested
 * rectangle per used pin (plus GND/5V if any component's other legs need them); one rectangle per
 * matched component with a nested rectangle per catalog leg; wires as labeled arrows between exact
 * pin-rectangles. `board` only changes the board's own title — pin usage is drawn from what the code
 * actually touches, not a full Uno/Nano pinout, so the physical pin-count difference doesn't matter here.
 */
export function renderArduinoWiringPuml(
  sketchName: string,
  board: 'uno' | 'nano',
  pins: PinUsage[],
  connections: GroundedConnection[],
): string {
  const boardLabel = board === 'nano' ? 'Arduino Nano' : 'Arduino Uno';
  const groups = groupByComponent(pins, connections);

  const needsGnd = groups.some((g) => g.legs.some((l) => l.legName !== g.groundedLeg && GND_RE.test(l.connectsTo)));
  const needsPower = groups.some((g) => g.legs.some((l) => l.legName !== g.groundedLeg && POWER_RE.test(l.connectsTo)));

  const lines: string[] = [];
  lines.push('@startuml');
  lines.push(`title ${quote(`${boardLabel} — ${sketchName}`)}`);
  lines.push('skinparam rectangle {');
  lines.push('  RoundCorner 12');
  lines.push('  BackgroundColor<<board>> #2b2b2b');
  lines.push('  FontColor<<board>> white');
  lines.push('  BorderColor<<board>> #888888');
  lines.push('  BackgroundColor<<pin>> #3c3c3c');
  lines.push('  FontColor<<pin>> #dddddd');
  lines.push('  BorderColor<<pin>> #666666');
  lines.push('  BackgroundColor<<power>> #5a2d2d');
  lines.push('  FontColor<<power>> #ffcccc');
  lines.push('  BorderColor<<power>> #aa6666');
  lines.push('  BackgroundColor<<gnd>> #2d2d2d');
  lines.push('  FontColor<<gnd>> #cccccc');
  lines.push('  BorderColor<<gnd>> #666666');
  lines.push('  BackgroundColor<<comp>> #1e3a5f');
  lines.push('  FontColor<<comp>> white');
  lines.push('  BorderColor<<comp>> #4a7fb5');
  lines.push('}');
  lines.push('skinparam linetype ortho');
  lines.push('skinparam ArrowColor #999999');
  lines.push('');

  lines.push(`rectangle ${quote(boardLabel)} <<board>> as BOARD {`);
  const pinAlias = new Map<string, string>();
  for (const g of groups) {
    if (pinAlias.has(g.boardPinKey)) continue;
    const a = alias('PIN', g.boardPinKey);
    pinAlias.set(g.boardPinKey, a);
    lines.push(`  rectangle ${quote(g.boardPinLabel)} <<pin>> as ${a}`);
  }
  if (needsGnd) lines.push('  rectangle "GND" <<gnd>> as BOARD_GND');
  if (needsPower) lines.push('  rectangle "5V" <<power>> as BOARD_5V');
  lines.push('}');
  lines.push('');

  const wires: string[] = [];
  for (const g of groups) {
    const compAlias = alias('COMP', g.key);
    lines.push(`rectangle ${quote(g.label)} <<comp>> as ${compAlias} {`);
    const legAliases = new Map<string, string>();
    for (const leg of g.legs) {
      const a = `${compAlias}_${alias('LEG', leg.legName)}`;
      legAliases.set(leg.legName, a);
      lines.push(`  rectangle ${quote(leg.legName)} <<pin>> as ${a}`);
    }
    lines.push('}');

    if (g.component) {
      lines.push(`note bottom of ${compAlias}`);
      lines.push(`  ${noteLine(g.component.whatItDoes)}`);
      lines.push(`  ${noteLine(g.component.wiringNotes)}`);
      lines.push('end note');
    } else {
      lines.push(`note bottom of ${compAlias}`);
      lines.push('  Code drives this pin, but no arduino_db catalog component matched — check by hand.');
      lines.push('end note');
    }
    lines.push('');

    const boardAlias = pinAlias.get(g.boardPinKey);
    const groundedAlias = legAliases.get(g.groundedLeg);
    if (boardAlias && groundedAlias) wires.push(`${boardAlias} --> ${groundedAlias} : signal`);

    for (const leg of g.legs) {
      if (leg.legName === g.groundedLeg) continue;
      const legAlias2 = legAliases.get(leg.legName);
      if (!legAlias2) continue;
      if (GND_RE.test(leg.connectsTo)) wires.push(`${legAlias2} --> BOARD_GND : ground`);
      else if (POWER_RE.test(leg.connectsTo)) wires.push(`${legAlias2} --> BOARD_5V : power`);
    }
  }

  lines.push(...wires);
  lines.push('');
  lines.push('legend right');
  lines.push('  |= symbol |= meaning |');
  lines.push('  | <back:#5a2d2d>  </back> | power pin |');
  lines.push('  | <back:#2d2d2d>  </back> | ground pin |');
  lines.push('  | <back:#3c3c3c>  </back> | signal pin |');
  lines.push('  | <back:#1e3a5f>  </back> | component |');
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
}

export interface DiagramOutcome {
  ok: boolean;
  reason?: string;
  results: DiagramSketchResult[];
}

/**
 * One PUML+SVG wiring diagram per sketch. Sequential, never parallel — one door to the shared model
 * for `groundWiring`'s LLM call. `board` is cosmetic (the rectangle's title only) since the diagram
 * only ever shows pins the code actually touches, never a full physical pinout.
 */
export async function runArduinoDiagram(
  root: string,
  opts: { board?: 'uno' | 'nano'; open?: boolean; only?: Set<string> } = {},
): Promise<DiagramOutcome> {
  if (!isArduinoProject(root)) {
    return { ok: false, reason: `${root} does not look like an Arduino project — no .ino/.pde sketch and no platformio.ini/sketch.yaml`, results: [] };
  }
  let sketches: Sketch[] = findSketches(root);
  if (opts.only) sketches = sketches.filter((s) => opts.only!.has(s.path));
  if (sketches.length === 0) {
    return { ok: false, reason: 'Arduino project marker found but no matching .ino/.pde sketch to diagram', results: [] };
  }

  const board = opts.board === 'nano' ? 'nano' : 'uno';
  const readme = readReadme(root);
  const results: DiagramSketchResult[] = [];

  for (const sketch of sketches) {
    let source: string;
    try { source = readFileSync(sketch.path, 'utf-8'); } catch (err) {
      log('WARN', 'arduino_diagram_read_failed', { sketch: sketch.path, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const pins = extractPinUsage(source);
    const connections = await groundWiring(sketch.baseName, source, readme, pins);
    const puml = renderArduinoWiringPuml(sketch.baseName, board, pins, connections);

    mkdirSync(sketch.dir, { recursive: true });
    const pumlPath = join(sketch.dir, `${sketch.baseName}.wiring.puml`);
    writeFileSync(pumlPath, `${puml}\n`);

    let svgPath: string | undefined;
    let verified = false;
    if (await hasPlantuml()) {
      const { code: syntaxCode } = await run(PUML_BIN, ['-syntax'], puml, 15_000);
      verified = syntaxCode === 0;
      const { code: renderCode } = await run(PUML_BIN, ['-tsvg', pumlPath], undefined, 60_000);
      const candidate = pumlPath.replace(/\.puml$/, '.svg');
      if (renderCode === 0 && existsSync(candidate)) svgPath = candidate;
    }

    const opened = opts.open === false ? false : await openInEditor(svgPath ?? pumlPath);
    log('INFO', 'arduino_diagram_generated', {
      sketch: sketch.baseName, pins: String(pins.length), connections: String(connections.length),
      verified: String(verified), rendered: String(!!svgPath), opened: String(opened),
    });
    results.push({
      sketch: sketch.baseName, pumlPath, svgPath, opened, verified,
      pinsFound: pins.length, connectionsMatched: connections.filter((c) => c.componentId !== 'unknown').length,
    });
  }
  return { ok: true, results };
}

export interface RegenerateDiagramResult {
  results: DiagramSketchResult[];
  regeneratedPaths: Set<string>;
}

/**
 * Regenerate the wiring diagram for exactly the sketches `files` touched — the shared entry point
 * for Presenter and the QA-pass hook, mirroring `arduino-explain.ts#regenerateTouchedSketches`'s own
 * skip-set contract so a single Arduino change never re-spends its one-LLM-call-per-sketch grounding
 * twice in the same turn.
 */
export async function regenerateTouchedDiagrams(
  root: string,
  files: ChangedFile[],
  skip: Set<string> = new Set(),
): Promise<RegenerateDiagramResult | null> {
  const arduino = probeArduinoProject(files, root);
  if (!arduino.applies || arduino.sketches.length === 0) return null;
  const pending = arduino.sketches.map((s) => s.path).filter((p) => !skip.has(p));
  if (pending.length === 0) return { results: [], regeneratedPaths: new Set() };

  const only = new Set(pending);
  const outcome = await runArduinoDiagram(root, { open: false, only });
  if (!outcome.ok) return { results: [], regeneratedPaths: new Set() };
  return { results: outcome.results, regeneratedPaths: only };
}

export function formatArduinoDiagramOutcome(o: DiagramOutcome): string {
  if (!o.ok) return `Not generating a wiring diagram: ${o.reason}`;
  if (o.results.length === 0) return 'No sketch produced output.';
  return o.results
    .map((r) => {
      const verify = r.svgPath ? (r.verified ? 'validated by plantuml' : 'rendered, but plantuml -syntax flagged it — check the .puml') : 'plantuml not installed — .puml written, not rendered';
      return `${r.sketch}: ${r.connectionsMatched}/${r.pinsFound} pin(s) matched to arduino-db → ${r.svgPath ?? r.pumlPath} (${verify})${r.opened ? ', opened in editor' : ''}`;
    })
    .join('\n');
}

/** Tool entry point: `arduino_diagram(board=uno|nano)`. */
export async function arduinoDiagramExecute(params: Record<string, string>): Promise<string> {
  const board = params.board?.toLowerCase() === 'nano' ? 'nano' : 'uno';
  const outcome = await runArduinoDiagram(process.cwd(), { board });
  return formatArduinoDiagramOutcome(outcome);
}
