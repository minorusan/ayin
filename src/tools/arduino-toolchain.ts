/**
 * arduino-toolchain — the one place that knows about `arduino-cli` and about board pin capabilities.
 *
 * WHY IT IS ITS OWN MODULE. Two very different consumers need the same facts and must not each grow
 * their own copy: the plan executor names the verification command before any code is written, and
 * the QA executor RUNS it after. A second copy of "which pins do PWM on an Uno" is a second copy that
 * can be wrong.
 *
 * WHY A COMPILE IS THE POINT. Every other Arduino check in this codebase is either deterministic but
 * shallow (does the filename match its folder) or deep but a model's opinion (does this sketch look
 * right). `arduino-cli compile` is both deep and deterministic: it is the actual toolchain, giving
 * the actual answer, with the actual error text and line number. A QA gate that has one available and
 * asks a language model to eyeball the C++ instead is choosing the worse instrument — and paying GPU
 * time for it. It is also, in practice, the single largest cause of QA fix passes on Arduino work:
 * the loop was failing sketches for reasons a compiler would have named in two seconds.
 *
 * GRACEFUL ABSENCE, LOUD FAILURE. `arduino-cli` not being installed is a fact, reported as such —
 * the gate says "not verified, install arduino-cli" rather than pretending. A compile that RUNS and
 * FAILS is a hard failure with the compiler's own message; that is never softened.
 *
 * NO ENVIRONMENT FACTS IN SOURCE. The board is `AYIN_ARDUINO_FQBN`, or the project's own
 * `sketch.yaml`, or the neutral default below. No path, port or host is written down here.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';

/** Neutral, universally-available default — the board every beginner tutorial is written against. */
export const DEFAULT_FQBN = 'arduino:avr:uno';

const CLI_BIN = process.env.AYIN_ARDUINO_CLI || 'arduino-cli';

export interface RunResult { code: number; out: string }

function run(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

let _hasCli: boolean | null = null;

/** Is `arduino-cli` on PATH? Probed once per process — installing it mid-session is not a case worth
 *  paying a subprocess per call for. */
export async function hasArduinoCli(): Promise<boolean> {
  if (_hasCli !== null) return _hasCli;
  const { code } = await run(CLI_BIN, ['version'], 10_000);
  _hasCli = code === 0;
  return _hasCli;
}

/** Installed board cores, e.g. `["arduino:avr"]`. Empty when the CLI is absent or has none. */
export async function installedCores(): Promise<string[]> {
  if (!(await hasArduinoCli())) return [];
  const { code, out } = await run(CLI_BIN, ['core', 'list'], 15_000);
  if (code !== 0) return [];
  return out.split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((id) => /^[a-z0-9_.-]+:[a-z0-9_.-]+$/i.test(id));
}

/**
 * Which board this project targets. `sketch.yaml`'s `default_fqbn` is the project's own declaration
 * and wins over the environment default; an explicit env override wins over everything, for the
 * operator whose board is not the one the project file names.
 */
export function projectFqbn(root: string): { fqbn: string; source: string } {
  const env = process.env.AYIN_ARDUINO_FQBN?.trim();
  if (env) return { fqbn: env, source: 'AYIN_ARDUINO_FQBN' };
  const yaml = join(root, 'sketch.yaml');
  if (existsSync(yaml)) {
    try {
      const m = readFileSync(yaml, 'utf8').match(/^\s*default_fqbn\s*:\s*["']?([A-Za-z0-9_.:-]+)/m);
      if (m) return { fqbn: m[1], source: 'sketch.yaml' };
    } catch { /* unreadable — fall through to the default */ }
  }
  return { fqbn: DEFAULT_FQBN, source: 'default' };
}

/** The board family a diagram/pin-capability question is really about. */
export type BoardKind = 'uno' | 'nano' | 'mega' | 'other';

export function boardFromFqbn(fqbn: string): BoardKind {
  const tail = fqbn.split(':').pop()?.toLowerCase() ?? '';
  if (tail.includes('mega')) return 'mega';
  if (tail.includes('nano')) return 'nano';
  if (tail.includes('uno')) return 'uno';
  return 'other';
}

/**
 * Pins that can actually do `analogWrite` (hardware PWM).
 *
 * This is the fact a beginner gets wrong most often and that no amount of reading the sketch reveals:
 * `analogWrite(7, 128)` compiles perfectly and produces a pin that is simply on or off. An RGB LED
 * wired to three non-PWM pins can only ever show eight colours.
 */
const PWM_BY_BOARD: Record<BoardKind, string[]> = {
  uno: ['3', '5', '6', '9', '10', '11'],
  nano: ['3', '5', '6', '9', '10', '11'],
  mega: ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '44', '45', '46'],
  other: [],
};

export function pwmPins(board: BoardKind): string[] {
  return PWM_BY_BOARD[board];
}

export function isPwmPin(board: BoardKind, pin: string): boolean {
  return PWM_BY_BOARD[board].includes(pin.trim());
}

export interface CompileResult {
  /** False only when the compiler ran and rejected the sketch. */
  ok: boolean;
  /** True when no compile was attempted — no CLI, or no core for this board. */
  skipped: boolean;
  reason: string;
  /** The compiler's own message, trimmed to the first errors — the useful part is always at the top. */
  output: string;
  fqbn: string;
}

/**
 * Compile one sketch folder. Read-only with respect to the project: `--build-path` sends every object
 * file and binary to a temp directory so a QA probe never leaves a `build/` tree in the operator's
 * project (the probes are read-only by design — see `qa/probes.ts`).
 */
export async function compileSketch(sketchDir: string, fqbn: string, buildPath: string): Promise<CompileResult> {
  if (!(await hasArduinoCli())) {
    return { ok: true, skipped: true, reason: 'arduino-cli is not installed — the sketch was NOT compile-checked', output: '', fqbn };
  }
  const cores = await installedCores();
  const needed = fqbn.split(':').slice(0, 2).join(':');
  if (cores.length && !cores.includes(needed)) {
    return {
      ok: true, skipped: true, fqbn, output: '',
      reason: `board core "${needed}" is not installed (have: ${cores.join(', ') || 'none'}) — run \`arduino-cli core install ${needed}\` to enable compile checking`,
    };
  }

  const { code, out } = await run(CLI_BIN, ['compile', '--fqbn', fqbn, '--build-path', buildPath, sketchDir], 180_000);
  // arduino-cli colours its output even when stdout is a pipe, so the raw text is full of `[92m`.
  // That goes straight into a QA prompt, where it is pure token noise around the one thing that
  // matters — the compiler's error line. Strip it here, once, rather than in each reader.
  const output = out
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, '')
    .split('\n')
    .slice(0, 40)
    .join('\n');
  log('INFO', 'arduino_compile', { sketch: sketchDir, fqbn, code: String(code) });
  return {
    ok: code === 0,
    skipped: false,
    fqbn,
    output,
    reason: code === 0 ? `compiles clean for ${fqbn}` : `COMPILE FAILED for ${fqbn}`,
  };
}
