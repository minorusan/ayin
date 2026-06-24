/**
 * File-based logger. No console output — blessed owns the terminal.
 * Writes to ~/.ayin-cli/logs/session-<timestamp>.log
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.ayin-cli', 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = join(LOG_DIR, `session-${ts}.log`);
const startTime = Date.now();

export function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', event: string, data?: Record<string, unknown>): void {
  const entry = {
    t: Date.now() - startTime,
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* can't log if file write fails — just drop it */ }
}

/**
 * Redirect suppressed console calls to log file.
 * Call once at startup after suppressing console.
 */
export function captureConsole(): void {
  console.log = (...args: unknown[]) => log('DEBUG', 'console.log', { msg: args.map(String).join(' ') });
  console.error = (...args: unknown[]) => log('ERROR', 'console.error', { msg: args.map(String).join(' ') });
  console.warn = (...args: unknown[]) => log('WARN', 'console.warn', { msg: args.map(String).join(' ') });
}

export function getLogFile(): string {
  return LOG_FILE;
}
