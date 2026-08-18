/**
 * indulge/hooks/registry.ts — discovery for both hook kinds.
 *
 * Same relationship prompts have: **built-ins ship with ayin, local files override by id.** A pack
 * dropped into `~/.ayin-cli/attributors/unity.mjs` replaces the built-in `unity` completely — that
 * is what "plug and play" has to mean, or every change is a fork.
 *
 * A local pack is executable code the operator wrote, running inside a tool call, so the contract is
 * blunt: **a broken hook degrades the tool, it never breaks it.** Load errors are reported once and
 * the pack is skipped; a throwing hook is caught and its output dropped. `read_file` must keep
 * reading files when someone's attributor has a typo.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log } from '../../log.js';
import type { Attributor, Indulger } from './types.js';
import { unityAttributor } from '../attributors/unity.js';
import { unityIndulger } from '../indulgers/unity.js';
import { typescriptIndulger } from '../indulgers/typescript.js';

const BUILTIN_ATTRIBUTORS: Attributor[] = [unityAttributor];
const BUILTIN_INDULGERS: Indulger[] = [unityIndulger, typescriptIndulger];

const localDir = (kind: 'attributors' | 'indulgers'): string =>
  process.env.AYIN_HOOKS_DIR
    ? join(process.env.AYIN_HOOKS_DIR, kind)
    : join(homedir(), '.ayin-cli', kind);

/** Loaded once per process — a hook directory is not re-scanned mid-session. */
let attributors: Attributor[] | null = null;
let indulgers: Indulger[] | null = null;

async function loadLocal<T extends { id: string }>(kind: 'attributors' | 'indulgers', builtins: T[]): Promise<T[]> {
  const dir = localDir(kind);
  const out = [...builtins];
  if (!existsSync(dir)) return out;

  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js')); } catch { return out; }

  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href) as { default?: T; hook?: T };
      const hook = mod.default ?? mod.hook;
      if (!hook || typeof hook.id !== 'string') {
        log('WARN', 'hook_shape_invalid', { kind, file: f });
        continue;
      }
      // Same id replaces the built-in outright. Overriding by shadowing beats overriding by patching.
      const at = out.findIndex((h) => h.id === hook.id);
      if (at >= 0) out[at] = hook; else out.push(hook);
      log('INFO', 'hook_loaded', { kind, id: hook.id, file: f });
    } catch (err) {
      // One broken pack must not cost the operator every other pack.
      log('ERROR', 'hook_load_failed', { kind, file: f, error: String(err).slice(0, 200) });
    }
  }
  return out;
}

export async function loadHooks(): Promise<void> {
  if (!attributors) attributors = await loadLocal('attributors', BUILTIN_ATTRIBUTORS);
  if (!indulgers) indulgers = await loadLocal('indulgers', BUILTIN_INDULGERS);
}

/** Synchronous accessors — the tool path cannot await a directory scan. Call `loadHooks()` at boot. */
export function attributorsFor(repoPath: string): Attributor[] {
  return (attributors ?? BUILTIN_ATTRIBUTORS).filter((a) => {
    try { return a.applies(repoPath); } catch { return false; }
  });
}

export function indulgersFor(repoPath: string): Indulger[] {
  return (indulgers ?? BUILTIN_INDULGERS).filter((i) => {
    try { return i.applies(repoPath); } catch { return false; }
  });
}

/** Test seam: replace the loaded set. */
export function setHooksForTest(a: Attributor[], i: Indulger[]): void {
  attributors = a;
  indulgers = i;
}
