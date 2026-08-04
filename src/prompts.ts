/**
 * ayin's own prompts + runtime config.
 *
 * PROMPT TEXT lives in files, never in this module: source ships at `<pkg>/prompts/ayin/*.txt`,
 * the operator's editable copy at `~/.ayin-cli/prompts/ayin/*.txt`. `prompts-service.ts` owns that
 * relationship; this module is only the `ayin` namespace's registration + a thin accessor so the
 * existing call sites (`getPrompt('system', …)`) keep reading the way they always did.
 *
 * CONFIG (numbers + a few strings like the OpenAI key) stays in `~/.ayin-cli/prompts.json` under
 * `config`. It is settings, not prose — a JSON file is the right shape for it and `/set` already
 * writes there. Prompt entries that used to sit beside it are migrated out on first run.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { prompts, packagePath, writeAtomic, LOCAL_PROMPTS_ROOT } from './prompts-service.js';

const PROMPTS_FILE = join(homedir(), '.ayin-cli', 'prompts.json');

/** ayin's own namespace — "registered privately", ahead of any tool. */
export const AYIN_NS = 'ayin';

/** Defaults for everything under `config` in prompts.json. */
const DEFAULT_CONFIG: Record<string, number> = {
  windowSize: 20,
  maxToolRounds: 10,
  summaryMaxWords: 180,
  summaryRecentMessages: 6,
  // QA gate (qa/) — 0 passes disables it entirely.
  qaMaxPasses: 3,
  qaMinAnswerChars: 400,
  // Tool guard (tool-guard.ts) — polling is the one legitimate repeat.
  pollMinIntervalMs: 15000,
  pollMaxPerTurn: 6,
  // Plan mode (plan/) — 0 chars disables it.
  planMinChars: 2000,
  planExploreCalls: 2,
  planApiSearches: 3,
  // Model picker (model-picker.ts) — hides small/utility models from the `/model` popup so it lists
  // only real choices. 0 disables the filter (shows everything installed).
  modelPickerMinSizeGiB: 15,
};

// ── one-time migration: prompt entries out of prompts.json, into the file store ──────────────
// Older installs kept `{key: {description, content}}` beside `config`. Those are the operator's
// edits; losing them on upgrade would be exactly the failure this whole change exists to prevent.
// Runs BEFORE registration so a migrated file is never overwritten by the shipped default.

function migrateLegacyPromptsJson(): void {
  if (!existsSync(PROMPTS_FILE)) return;
  let data: Record<string, unknown>;
  try { data = JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8')); } catch { return; }

  const dir = join(LOCAL_PROMPTS_ROOT, AYIN_NS);
  const moved: string[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (key === 'config' || !val || typeof val !== 'object') continue;
    const content = (val as { content?: unknown }).content;
    if (typeof content !== 'string' || !content.trim()) continue;
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${key}.txt`);
    if (!existsSync(dest)) {
      writeAtomic(dest, content.endsWith('\n') ? content : content + '\n');
    }
    moved.push(key);
  }
  if (moved.length === 0) return;

  // Rewrite prompts.json with config only, keeping a copy of what we moved. Atomic, because two
  // ayin processes can boot at once and both reach this line before either has finished.
  try {
    writeAtomic(`${PROMPTS_FILE}.pre-filestore`, JSON.stringify(data, null, 2));
    writeAtomic(PROMPTS_FILE, JSON.stringify({ config: data.config ?? {} }, null, 2));
  } catch { /* migration is best-effort; the .txt copies already landed */ }
}

migrateLegacyPromptsJson();

/** ayin's prompts, materialized into the local store at import time. */
export const ayinPrompts = prompts.register(AYIN_NS, packagePath('prompts', AYIN_NS)).bundle;

/**
 * Local prompts whose `{{VAR}}` contract no longer matches the shipped one, across every namespace
 * registered so far — rendered as lines for the caller to SHOW, not just log.
 *
 * The caller shows this at boot because the failure it describes is completely invisible otherwise.
 * A local copy that predates a new variable means the code passes the data, the prompt never asks
 * for it, and the model is never told — no error, no log line, an entire feature silently absent. A
 * degraded LLM call that looks like it worked is worse than a crash, so this is loud on purpose.
 */
export function promptDriftWarnings(): string[] {
  return prompts.drifts().map((d) => {
    const bits: string[] = [];
    if (d.missingVars.length) bits.push(`your copy never receives ${d.missingVars.map((v) => `{{${v}}}`).join(', ')}`);
    if (d.staleVars.length) bits.push(`${d.staleVars.map((v) => `{{${v}}}`).join(', ')} is no longer supplied and will render literally`);
    return `PROMPT OUT OF DATE — ${d.namespace}/${d.id}: ${bits.join('; ')}. `
      + `Fix with /prompts (restore ${d.namespace}/${d.id}), or hand-merge ${d.localPath}.`;
  });
}

// ── accessors ────────────────────────────────────────────────────────────────────────────────

/** Get one of ayin's own prompts by id, substituting `{{VAR}}` placeholders. */
export function getPrompt(key: string, vars: Record<string, string> = {}): string {
  return ayinPrompts.get(key, vars);
}

function loadConfig(): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8'));
    return data && typeof data.config === 'object' && data.config ? data.config : {};
  } catch {
    return {};
  }
}

export function getConfig(key: string, defaultValue: number): number {
  const v = loadConfig()[key];
  if (typeof v === 'number') return v;
  if (typeof DEFAULT_CONFIG[key] === 'number') return DEFAULT_CONFIG[key];
  return defaultValue;
}

export function getConfigString(key: string): string | undefined {
  const v = loadConfig()[key];
  return typeof v === 'string' && v ? v : undefined;
}

/** Write a single config key to prompts.json, creating it if needed. */
export function setConfigValue(key: string, value: string | number): void {
  mkdirSync(dirname(PROMPTS_FILE), { recursive: true });
  let data: Record<string, unknown> = {};
  if (existsSync(PROMPTS_FILE)) {
    try { data = JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8')); } catch { /* start fresh */ }
  }
  if (!data.config || typeof data.config !== 'object') data.config = {};
  (data.config as Record<string, unknown>)[key] = value;
  writeFileSync(PROMPTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/** The config file. Prompt TEXT is not in here — see `getPromptsDir()`. */
export function getPromptsFile(): string {
  return PROMPTS_FILE;
}

/** Where the operator's editable prompt files live. */
export function getPromptsDir(): string {
  return LOCAL_PROMPTS_ROOT;
}

/**
 * Throw away local edits to ayin's prompts and take the shipped text again.
 * Config is untouched — it lives in a different file and is not a prompt.
 */
export function resetPromptsToDefaults(): string[] {
  return prompts.restoreDefaults(AYIN_NS);
}
