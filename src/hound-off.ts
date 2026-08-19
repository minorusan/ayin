/**
 * hound-off.ts — the kill switch every hound honours, and why it is a FILE.
 *
 * A hound is a Claude Code `Stop` hook: a script sitting in some repo's `.claude/hooks/`, run by a
 * different program (Claude Code), possibly written by a different tool, possibly in a different
 * language. `ayin unwatch` can only end the ones ayin installed and registered — by design, since it
 * refuses to delete another tool's hook entry. So "the dog is still barking after unwatch" has a
 * second cause that no amount of unwatching fixes: a hound ayin never installed.
 *
 * Hence a switch rather than an uninstall: ONE path whose EXISTENCE means "every hound stands down".
 *
 *   - A file, not a config key, because the deciding code is a standalone copy in someone else's
 *     repo. It cannot import this module, must not parse ayin's config, and must answer in the
 *     microseconds before a turn ends. `existsSync(path)` is the whole contract.
 *   - Which also makes it honourable by things that are not ayin at all: a hand-written bash hound
 *     needs `[ -f "$HOME/.ayin-cli/hound.off" ] && exit 0` and it is fully disabled too.
 *   - Its CONTENT is a note for whoever finds it in six weeks wondering why nothing reviews their
 *     commits. Nothing reads it.
 *
 * Absent = hounds run. Present = they exit 0 immediately, before reading a diff or reaching a model.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * WHO the hound is, by filename — the identity `unwatch`, `kill dog` and the installer all test.
 *
 * It lives HERE, in the module with no dependencies, rather than in `watch.ts`: importing `watch.ts`
 * drags in the LLM manager and, behind it, `ui/screen.ts`, which creates a blessed screen at MODULE
 * SCOPE. A command that only wants to know what our hook is called would take over the terminal to
 * find out (measured — a one-line node import of `dist/watch.js` opened the full TUI and hung).
 */
export const HOUND_SCRIPT_NAME = 'ayin-hound.mjs';
/** pre-1.0.224 bash hound — replaced, and its settings.json entry migrated. */
export const LEGACY_HOUND_SCRIPT = 'ayin-hound.sh';
/** Substrings that identify OUR OWN settings.json entry, and nothing else's. */
export const HOUND_MARKERS = [HOUND_SCRIPT_NAME, LEGACY_HOUND_SCRIPT];

/**
 * The switch. Its existence is the signal; `ayin kill dog` creates it, `--off` removes it.
 *
 * `AYIN_HOUND_OFF_FILE` relocates it, which exists for one reason worth stating: a TEST HARNESS has to
 * be able to run a hound on a machine whose operator has killed theirs. `check:watch` installs a real
 * hook and reads its facts — with a global switch and no override, a killed dog turned that gate red
 * (measured) and, worse, the gate's in-process import of the hook source would have hit a bare
 * `process.exit(0)` and ended the run looking green.
 */
export function houndOffPath(): string {
  return process.env.AYIN_HOUND_OFF_FILE || join(homedir(), '.ayin-cli', 'hound.off');
}

/** True when every hound must stand down. Cheap enough to call from a hook's first line. */
export function isHoundOff(): boolean {
  return existsSync(houndOffPath());
}

/** When the switch was thrown, for a status line. Null when it is not thrown or the note is gone. */
export function houndOffSince(): string | null {
  try {
    const m = /^killed: (.+)$/m.exec(readFileSync(houndOffPath(), 'utf-8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Throw or clear the switch. Returns whether this call CHANGED anything, so a repeated `kill dog`
 * says "already dead" instead of pretending it did something.
 */
export function setHoundOff(off: boolean): boolean {
  const path = houndOffPath();
  if (off) {
    if (existsSync(path)) return false;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      'ayin: hounds are disabled while this file exists.',
      '',
      'Every ayin-hound Stop hook exits 0 immediately, `ayin watch` installs no new one, and the',
      'watch daemon stops re-adding it. Delete this file, or run `ayin kill dog --off`, to undo.',
      `killed: ${new Date().toISOString()}`,
      '',
    ].join('\n'));
    return true;
  }
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
