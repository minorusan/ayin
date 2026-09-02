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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
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
  // How many times the actionable plan (plan/plan.ts) may be sent back to the model after its
  // validator rejects it. 0 ships the first draft with its faults named instead of repairing it.
  planRepairPasses: 1,
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

/**
 * The value only if the OPERATOR set it — no shipped default, no caller fallback.
 *
 * "Unset" and "set to the same number the default happens to be" are different facts, and one
 * feature needs to tell them apart: the round budget is unlimited unless someone deliberately capped
 * it, so reading a shipped default there would reinstate the cap this build removed.
 */
export function getConfigIfSet(key: string): number | undefined {
  const v = loadConfig()[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Every config key this build actually reads. Kept beside the reader so it goes stale loudly rather
 * than quietly: `/set` uses it to tell an operator when a key they just set is one nobody consults.
 * A new `getConfigString('x')` anywhere means a new entry here.
 */
export const KNOWN_CONFIG_KEYS = [
  'llmProvider', 'llmUrl', 'ollamaCtx', 'ollamaModel', 'ollamaUrl',
  'openAiKey', 'openAiModel', 'searxngUrl', 'updateRegistry',
  // Written by the first-run gate: the timestamp AND what was chosen. Its presence is what makes
  // onboarding happen exactly once — see preflight.ts.
  'onboardedAt',
  // 'on' enables wheel scrolling, at the cost of the terminal's native text selection — off by default.
  'mouse',
  // Operator modes (modes.ts), written by /verbose and /logcover as 1/0.
  'verbose', 'logCoverage', 'corpusInject',
  // Embedding model for corpus vectors (indulge/embed.ts). Vectors are only comparable to others
  // from the SAME model, so changing this means re-embedding the corpus.
  'embedModel',
  // Which service embeds. Normally inferred from embedModel; set only to override that.
  'embedProvider',
  // `host:port` of a Unity Accelerator. EMPTY means disabled — no probe, no read, no write. A LAN
  // address is a fact about one machine and never belongs in source (CLAUDE.md §4), so this is the
  // only place it may live. See unity-accelerator.ts for why it is asserted only while reachable.
  'acceleratorEndpoint',
  // Where embeddings are asked for, when that is NOT the endpoint everything else uses. Empty means
  // one door: the configured llmUrl. This is the setting for a small embedder running BESIDE the
  // chat model — a local Ollama on this machine while generation goes to a bigger box — and it is an
  // explicit operator decision, never a fallback the code takes on its own (see indulge/embed.ts,
  // which deleted exactly such a fallback because it silently reached around a remote endpoint).
  'embedUrl',
  // Which provider BUILDS a corpus, separately from the one the agent chats through. A build is
  // hours of reading source; a chat turn is seconds. One global choice makes one of them worse.
  'indulgeProvider', 'indulgeModel',
  // What a SUBAGENT runs on, separately from the agent that arbitrates. Arbitrating reads reports and
  // picks the next phase; a child writes the code. One global choice means paying flagship rates to
  // arbitrate, or implementing on whatever happens to be resident. Empty = the child inherits.
  'subagentProvider', 'subagentModel',
  // Only honoured when the operator sets it — the round budget is otherwise unlimited (agent.ts).
  'maxToolRounds',
  // `ayin launch`: the command that opens a terminal window, with {{SCRIPT}} for the launch script.
  // Every platform default is a guess about someone else's terminal — this is how they replace it.
  'terminalCommand',
  // Anything past this many ms announces itself as [LONG OPERATION] (timing.ts). Default 120000.
  'longOperationMs',
  // `/testrun`: where the NUnit console runner and the matching Unity Editor live. Both are
  // machine-specific paths, so both are config with detection as the fallback.
  'nunitConsole', 'unityPath',
  // The QA gate's Unity compile check: how long `Unity -batchmode` may take before the fact is reported
  // as unverified instead of failed. A first import of a large project can exceed the 20-minute default,
  // and a timeout must never read as "your code does not compile".
  'unityCompileTimeoutMs',
  // How many changed MonoBehaviours the QA gate may send to the model for the no-logic judgement in one
  // pass. Default 3: a refactor touching forty behaviours must not become forty model calls on a shared
  // card, and what was skipped is named in the fact rather than passing silently.
  'unityLogicReviewMax',
];

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
export function resetPromptsToDefaults(): { restored: string[]; backedUp: string[] } {
  const restored = prompts.restoreDefaults(AYIN_NS);
  return { restored, backedUp: prompts.lastBackedUp() };
}

/**
 * Take the SHIPPED prompt pack — every namespace, not just ayin's.
 *
 * `resetPromptsToDefaults` restores one namespace, which is the right thing for `/prompts reset` in
 * a session. `ayin update --prompts` means something different and larger: the operator is saying
 * "this install's prompts are whatever the build ships", across explore, plan, qa, presenter, jira
 * and the rest. A local edit to one of those drifts silently — the code keeps sending variables the
 * local text no longer asks for — and there was no single door back.
 *
 * Every local file that DIFFERS is backed up first by `restoreDefaults` itself, so this is
 * destructive but never lossy. Namespaces are accumulated rather than reported per call because
 * `lastBackedUp()` is reset by each restore, and a partial list read at the end would name only the
 * final namespace's backups.
 */
export function restoreAllPromptsToDefaults(): {
  restored: string[]; backedUp: string[]; namespaces: string[]; failed: Array<{ ns: string; why: string }>;
} {
  const root = packagePath('prompts');
  const restored: string[] = [];
  const backedUp: string[] = [];
  const namespaces: string[] = [];
  const failed: Array<{ ns: string; why: string }> = [];
  let dirs: string[];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch (err) { return { restored, backedUp, namespaces, failed: [{ ns: '*', why: String(err) }] }; }
  for (const ns of dirs) {
    try {
      // Registration is what teaches the service where a namespace's shipped text lives; a namespace
      // no tool has used yet is not registered, and restoring it would throw "no source directory".
      prompts.register(ns, join(root, ns));
      for (const id of prompts.restoreDefaults(ns)) restored.push(`${ns}/${id}`);
      for (const id of prompts.lastBackedUp()) backedUp.push(id);
      namespaces.push(ns);
    } catch (err) {
      // One unreadable namespace must not abandon the rest — and must not be silent either.
      failed.push({ ns, why: err instanceof Error ? err.message : String(err) });
    }
  }
  return { restored, backedUp, namespaces, failed };
}

/**
 * Register EVERY shipped namespace at boot, not lazily on first use.
 *
 * A tool registers its prompts the first time it runs, which means a prompt fix — or a warning that a
 * local copy can no longer carry what the code sends — arrives only after the operator has already
 * used the broken thing. Boot is when it is worth knowing.
 *
 * Returns what changed, so the caller can SAY it. A prompt replaced silently is the same class of
 * problem as one never replaced: the operator cannot reason about text they do not know changed.
 */
export function registerShippedPrompts(): { refreshed: string[]; repaired: Array<{ id: string; backupPath: string }> } {
  const root = packagePath('prompts');
  const refreshed: string[] = [];
  const repaired: Array<{ id: string; backupPath: string }> = [];
  let namespaces: string[];
  try { namespaces = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return { refreshed, repaired }; }
  for (const ns of namespaces) {
    try {
      const r = prompts.register(ns, join(root, ns));
      for (const id of r.refreshed) refreshed.push(`${ns}/${id}`);
      for (const x of r.repaired) repaired.push({ id: `${ns}/${x.id}`, backupPath: x.backupPath });
    } catch { /* one bad namespace must not stop the rest */ }
  }
  return { refreshed, repaired };
}
