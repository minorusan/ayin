/**
 * Prompt history — persisted across sessions at ~/.ayin-cli/history
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HISTORY_FILE = join(homedir(), '.ayin-cli', 'history');
const MAX_ENTRIES = 500;

let entries: string[] = [];
let cursor = -1; // -1 = not navigating
let savedInput = ''; // what user was typing before pressing up

export function loadHistory(): void {
  try {
    if (existsSync(HISTORY_FILE)) {
      entries = readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
    }
  } catch { /* fresh start */ }
}

function save(): void {
  try {
    mkdirSync(dirname(HISTORY_FILE), { recursive: true });
    const trimmed = entries.slice(-MAX_ENTRIES);
    writeFileSync(HISTORY_FILE, trimmed.join('\n') + '\n');
  } catch { /* best effort */ }
}

export function pushEntry(text: string): void {
  // Don't duplicate consecutive entries
  if (entries.length > 0 && entries[entries.length - 1] === text) return;
  entries.push(text);
  save();
  cursor = -1;
  savedInput = '';
}

/**
 * Replace a persisted entry — for a line that turned out to carry a secret.
 *
 * `pushEntry` writes to disk immediately, and whether an argument is a credential is only known once the
 * tool that owns the command has been resolved. So the entry is rewritten rather than prevented: `save()`
 * rewrites the whole file, so the original text is gone from it, not merely appended past.
 *
 * `replacement` is what stays in history — the bare command, so arrow-up still recalls what was run
 * without recalling the token.
 */
export function forgetEntry(text: string, replacement: string): void {
  let changed = false;
  entries = entries.map((e) => {
    if (e !== text) return e;
    changed = true;
    return replacement;
  });
  if (!changed) return;
  // A repeat of the same command would otherwise leave two identical bare entries.
  entries = entries.filter((e, i) => i === 0 || e !== entries[i - 1]);
  save();
  cursor = -1;
  savedInput = '';
}

/**
 * Navigate up (older). Returns the entry to display, or null if at top.
 * On first up press, saves the current input buffer.
 */
export function navigateUp(currentInput: string): string | null {
  if (entries.length === 0) return null;
  if (cursor === -1) {
    // First press — save what user was typing
    savedInput = currentInput;
    cursor = entries.length - 1;
  } else if (cursor > 0) {
    cursor--;
  } else {
    return null; // already at top
  }
  return entries[cursor];
}

/**
 * Navigate down (newer). Returns the entry to display, or the saved input
 * when reaching the bottom.
 */
export function navigateDown(): string | null {
  if (cursor === -1) return null;
  if (cursor < entries.length - 1) {
    cursor++;
    return entries[cursor];
  }
  // Back to bottom — restore saved input
  cursor = -1;
  return savedInput;
}

export function resetNavigation(): void {
  cursor = -1;
  savedInput = '';
}
