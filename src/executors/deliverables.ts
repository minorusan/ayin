/**
 * Deliverable resolution — turning "this project must end up with `*\/*.ino`" into "here are the
 * files that actually exist, or here is the fact that none do".
 *
 * A deliberately tiny matcher rather than a glob dependency: `*` matches within one path segment and
 * nothing else. That covers every pattern the executors declare, and it means a pattern can never
 * accidentally walk into `node_modules` or take a second to run. When a pattern needs more than this,
 * that is a signal the deliverable is described too loosely, not that the matcher is too weak.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Deliverable } from './types.js';

const SKIP_DIR_RE = /^(node_modules|\.git|dist|build|out|\.pio|\.vscode|\.build|Library|Temp|target|__pycache__|\.venv)$/;

function segmentRe(segment: string): RegExp {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '\u0000' : `\\${c}`));
  return new RegExp(`^${escaped.split('\u0000').join('[^/]*')}$`);
}

/** Every existing path under `root` matching `pattern`. Absolute paths, sorted, capped. */
export function resolvePattern(root: string, pattern: string, limit = 20): string[] {
  const segments = pattern.split('/').filter(Boolean);
  if (segments.length === 0) return [];

  let current: string[] = [root];
  for (let i = 0; i < segments.length; i++) {
    const re = segmentRe(segments[i]);
    const last = i === segments.length - 1;
    const next: string[] = [];
    for (const dir of current) {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        if (SKIP_DIR_RE.test(entry)) continue;
        if (!re.test(entry)) continue;
        const full = join(dir, entry);
        let st: ReturnType<typeof statSync>;
        try { st = statSync(full); } catch { continue; }
        if (last ? st.isFile() : st.isDirectory()) next.push(full);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current.sort().slice(0, limit);
}

/**
 * Does a path a plan CLAIMS it will write match a deliverable pattern? Same single-star, one-segment
 * semantics as `resolvePattern`, against a string instead of the filesystem — because a plan is
 * validated before any of its files exist. Segment counts must match, so `*\/*.ino` rejects a bare
 * `Sketch.ino`: an Arduino sketch outside a folder of its own name cannot compile, and that is exactly
 * the class of mistake a deliverable pattern encodes.
 */
export function patternMatchesPath(path: string, pattern: string): boolean {
  const parts = path.trim().replace(/^\.\//, '').split('/').filter(Boolean);
  const segments = pattern.split('/').filter(Boolean);
  if (parts.length !== segments.length || segments.length === 0) return false;
  return segments.every((seg, i) => segmentRe(seg).test(parts[i]));
}

export interface DeliverableStatus {
  deliverable: Deliverable;
  matches: string[];
  satisfied: boolean;
}

/**
 * Pin tokens a human could wire from this README — THE single implementation.
 *
 * There were three: this file's, `tool/arduino-legit.mjs`'s and `tool/arduino-wiring-audit.mjs`'s. I
 * fixed the audit's through four iterations (first cell only → any cell → header-detected tables →
 * tokens inside a cell) and left the other two on the original narrow regex. They then disagreed on the
 * same file: the audit accepted traffic-light's `| Component | Arduino Pin |` table while legit reported
 * "no pin map". Two instruments that disagree about one artifact cannot both be right, and neither can
 * be trusted. One implementation, imported by both.
 *
 * A HEADER is the row followed by a `|---|` separator — markdown's own rule, and what stops the PARTS
 * table's `| 1 | Arduino Uno |` from contributing a phantom "pin 1". Inside a table already established
 * as a pin map, tokens are harvested from anywhere in a cell, because real pin columns read "Digital 2",
 * "A4 (SDA)", "9 (PWM)".
 */
export function readmePinTokens(text: string): Set<string> {
  const found = new Set<string>();
  const clean = text.replace(/[*`]/g, '');
  for (const m of clean.matchAll(/\b(?:pin|D)\s*(\d{1,2})\b/gi)) found.add(m[1]);
  for (const m of clean.matchAll(/\b(A[0-5])\b/g)) found.add(m[1].toUpperCase());
  if (/LED_BUILTIN|built-?in LED/i.test(clean)) found.add('13');

  const lines = clean.split('\n');
  const PIN_HEADER = /\b(pin|pins|gpio|signal|wiring|connection|connects to)\b/i;
  let inPinTable = false;
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i].match(/^\|(.+)\|\s*$/);
    if (!row) { inPinTable = false; continue; }
    if (/^[\s|:-]+$/.test(lines[i])) continue;
    const cells = row[1].split('|').map((c) => c.trim());
    if (/^[\s|:-]+$/.test(lines[i + 1] ?? '')) { inPinTable = cells.some((c) => PIN_HEADER.test(c)); continue; }
    if (!inPinTable) continue;
    for (const c of cells) for (const m of c.matchAll(/\b(\d{1,2}|A[0-5])\b/gi)) found.add(m[1].toUpperCase());
  }
  return found;
}

export function readmeHasPinMap(text: string): boolean {
  return readmePinTokens(text).size > 0;
}

/**
 * Is the README real documentation, or the scaffold stub with its TODOs still in it?
 *
 * A DELIBERATELY DETERMINISTIC CHECK, because the alternative is hoping. `scaffold()` writes a stub so
 * the file exists and has structure — but an untouched stub is in one respect WORSE than no README at
 * all: it satisfies every check that only asks whether the file is there, while saying nothing.
 * Measured on the benchmark: on the grounding-only path the stub shipped untouched, because the plan
 * document had been the only thing telling the agent to fill it in.
 *
 * The deliverable list now tells the model a stub counts as missing, and this makes the gate enforce it
 * rather than trust it — the same reason the compile probe exists instead of asking a model whether the
 * sketch builds.
 */
export function readmeSubstance(root: string): { ok: boolean; detail: string } {
  const path = join(root, 'README.md');
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch {
    return { ok: false, detail: 'README.md is MISSING at the project root' };
  }
  const todos = (text.match(/\bTODO\b/g) ?? []).length;
  if (todos > 0) {
    return {
      ok: false,
      detail: `README.md still carries ${todos} TODO marker(s) from the scaffold stub — it exists but documents nothing. Replace every TODO with the real parts list, pin map, and build/upload commands.`,
    };
  }
  if (text.trim().length < 200) {
    return { ok: false, detail: `README.md is only ${text.trim().length} chars — too short to carry a parts list and a pin map` };
  }

  // ENFORCE, DO NOT REQUEST — the lesson from the TODO markers, applied to the next soft requirement
  // that turned out to be a coin flip. The confirmation run's reaction-timer shipped a README with a
  // parts list and a pin map and NO way to build the thing; the same project with the same prompt had
  // produced them one run earlier. A requirement the deliverable list asks for and nothing checks is
  // satisfied at the model's discretion, which is another way of saying sometimes.
  //
  // Two facts, both cheap to state and both useless if absent: how do I build this, and which pin goes
  // where. A README missing either is not documentation of an Arduino project, it is a description of
  // one.
  if (!/arduino-cli|Arduino IDE|\bupload\b/i.test(text)) {
    return {
      ok: false,
      detail: 'README.md has no build/upload instructions — no `arduino-cli compile`/`upload` command and no mention of the Arduino IDE. A reader cannot get this onto a board.',
    };
  }
  if (!readmeHasPinMap(text)) {
    return { ok: false, detail: 'README.md names no pins — a wiring section with no pin map cannot be followed' };
  }

  return { ok: true, detail: `README.md is present and filled in (${text.length} chars, no TODO markers, has a pin map and build instructions)` };
}

export function checkDeliverables(root: string, deliverables: Deliverable[]): DeliverableStatus[] {
  return deliverables.map((d) => {
    const matches = [...new Set(d.patterns.flatMap((p) => resolvePattern(root, p)))].sort();
    return { deliverable: d, matches, satisfied: matches.length > 0 };
  });
}

/**
 * The deliverable set as ONE fact line for the judge. Missing REQUIRED deliverables are named with
 * the reason they exist, because "the wiring diagram is missing" without "wiring is shown, never
 * narrated" reads as bureaucracy and gets argued with.
 */
export function renderDeliverables(root: string, statuses: DeliverableStatus[]): { ok: boolean; detail: string } {
  const rel = (p: string) => p.startsWith(root) ? p.slice(root.length).replace(/^\//, '') : p;
  const missing = statuses.filter((s) => !s.satisfied && s.deliverable.required);
  const lines = statuses.map((s) => s.satisfied
    ? `  OK      ${s.deliverable.label}: ${s.matches.map(rel).join(', ')}`
    : `  ${s.deliverable.required ? 'MISSING' : 'absent '} ${s.deliverable.label} (${s.deliverable.patterns.join(' or ')}) — ${s.deliverable.why}`);
  return {
    ok: missing.length === 0,
    detail: [
      missing.length
        ? `${missing.length} REQUIRED deliverable(s) missing from ${root}:`
        : 'every required deliverable is present:',
      ...lines,
    ].join('\n'),
  };
}
