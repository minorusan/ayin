/**
 * Tools — definitions for the LLM system prompt + execution.
 *
 * Each tool has:
 *   - XML definition (for the system prompt, Qwen3 Coder format)
 *   - execute() function that runs it and returns string output
 */

import { log } from './log.js';
import { toolWithheld } from './subagents.js';
import { getConfigString, getPrompt } from './prompts.js';
import { prompts, packagePath } from './prompts-service.js';
import type { Tool } from './tools/base.js';
import { ensureToolRuntime } from './tool-wiring.js';
import { discoverTools, extraToolDirs } from './tools/loader.js';
import { toolCallInstructions, toolMode } from './llm/manager.js';

export { cancelActiveToolExecution } from './tools/lib.js';

/**
 * The registry is DISCOVERED, not declared.
 *
 * Every tool used to be an object literal in this file. That made it the one place both the public repo
 * and any private copy had to edit to add anything — the merge conflict that makes a private fork
 * unworkable, and that a submodule would not have solved either, since a static registry still has to
 * name what it loads. Now a tool is a file in `tools/defs/`, and adding one touches nothing that exists.
 *
 * `AYIN_TOOL_DIRS` (or config `toolDirs`) adds directories, which is how a private or employer-specific
 * tool set is installed WITHOUT a fork, and the seam an MCP client needs: an MCP server's tools are known
 * at runtime and can never appear in a compiled array.
 */
const CWD = process.cwd();

let tools: Tool[] = [];
let ready: Promise<void> | null = null;


// ── Tool registry ───────────────────────────────────────────────────

/**
 * Tool names are GLOBALLY UNIQUE, and a collision is a HARD ERROR at boot.
 *
 * The model calls a tool by its bare name, so two entries sharing one would silently shadow in the
 * map — last registration wins — while the system prompt happily advertises both. The symptom is a
 * tool that "sometimes does the wrong thing", which is about the worst bug shape there is: it looks
 * like the model misbehaving. Failing at import is loud, immediate, and impossible to ship past.
 */
// Built by `loadTools`, not at module scope: the registry no longer exists until discovery has run.
// Left at module scope it stayed EMPTY while `getAllTools()` returned all sixteen — so name lookup
// silently found nothing and every tool call would have failed with "unknown tool" against a catalogue
// the prompt had just advertised. The duplicate check moved with it, into the loader.
const toolMap = new Map<string, Tool>();

// ── prompt provisioning ─────────────────────────────────────────────
// A tool ships its prompt texts next to its own code and declares that directory. Here — at
// registration, once, at boot — ayin copies anything missing into the operator's local store and
// hands the tool back a bundle bound to LOCAL. The tool then loads by id and never learns where
// the files actually are, which is what lets tools live in their own repo.
//
// Materialization NEVER overwrites a local file, so an operator's edit survives every upgrade;
// a newly shipped prompt id appears on the next boot. Failure to provision one tool must not take
// the agent down — the tool throws a clear error if it later asks for a prompt it never got.

/**
 * A TOOL'S DESCRIPTION IS PROMPT TEXT, so it lives in a file like every other prompt.
 *
 * It is the sentence the model reads to decide whether to call the tool — the highest-leverage text
 * in the whole system per character, and it was a string literal in the middle of a TypeScript file:
 * invisible to anyone tuning behaviour, undiffable as content, and unchangeable without a rebuild.
 * That is exactly the rule this repo already applies to every other prompt.
 *
 * `prompts/tools/<tool name>.txt`, materialized into the operator's store like the rest, so it can be
 * edited on a running install and survives upgrades. A tool with no file keeps the description in its
 * source, so nothing breaks and a third-party tool needs no file at all.
 */
function applyDescriptionOverrides(list: Tool[]): void {
  try {
    const { bundle } = prompts.register('tools', packagePath('prompts', 'tools'));
    for (const t of list) {
      if (!bundle.has(t.name)) continue;
      const text = bundle.get(t.name).trim();
      if (text) (t as { description: string }).description = text;
    }
  } catch (err) {
    // A missing or unreadable directory must never stop the agent starting: the inline descriptions
    // are a complete fallback, and a tool that cannot be described is still a tool that runs.
    log('WARN', 'tool_descriptions_unavailable', { error: err instanceof Error ? err.message : String(err) });
  }
}

function provisionToolPrompts(list: Tool[]): void {
  for (const t of list) {
    if (!t.promptsSourceDir || typeof t.bindPrompts !== 'function') continue;
    try {
      const { bundle, materialized } = prompts.register(t.name, t.promptsSourceDir);
      t.bindPrompts(bundle);
      if (materialized.length > 0) {
        log('INFO', 'prompts_materialized', { tool: t.name, ids: materialized.join(',') });
      }
    } catch (err) {
      log('WARN', 'prompts_provision_failed', {
        tool: t.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}



// Hand `tools/` the model and the log. Nothing under `tools/` imports `llm/manager` or `log` any more,
// so no tool can become a second door to the provider. See `tool-wiring.ts` for why the delegates are
// built there rather than inline here.
ensureToolRuntime();

/**
 * Load once. Duplicate names are FATAL: the model calls a tool by its bare name, so two tools answering
 * to one means the wrong one runs and the transcript cannot say which. Discovery makes that reachable in
 * a way a hand-written array did not — an installed package can collide with a built-in — so it is
 * refused rather than resolved by load order.
 */
export async function loadTools(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const report = await discoverTools(extraToolDirs(getConfigString));
    for (const f of report.failed) {
      // Reported, never silent: a tool that vanishes without explanation looks exactly like a model that
      // forgot it exists, and the operator has no way to tell the difference.
      log('ERROR', 'tool_module_failed', { module: f.module, error: f.error });
    }
    if (report.duplicates.length) {
      throw new Error(`duplicate tool name(s): ${report.duplicates.join('; ')}`);
    }
    assertSlashOnlyReachable(report.tools);
    // WITHHELD, NOT REFUSED. A subagent must not delegate further, and neither must a session the
    // operator started with `--disallow-subagents`. Dropping the tool here means the model never sees
    // it — where letting it exist and refuse would cost a round to discover that. See `subagents.ts`.
    tools = report.tools.filter((t) => !toolWithheld(t.name));
    toolMap.clear();
    for (const t of tools) toolMap.set(t.name, t);
    applyDescriptionOverrides(tools);
    provisionToolPrompts(tools);
    log('INFO', 'tools_loaded', {
      count: String(tools.length),
      modelCallable: String(tools.filter((x) => !x.slashOnly).length),
      failed: String(report.failed.length),
      extraDirs: String(extraToolDirs(getConfigString).length),
    });
  })();
  return ready;
}

export function getTool(name: string): Tool | undefined {
  assertLoaded();
  return toolMap.get(name);
}

/**
 * The tool a slash command runs directly, or undefined. `cmd` may carry the leading slash.
 *
 * Refused on collision for the same reason duplicate NAMES are: two tools answering to `/jira` means the
 * operator cannot tell which one ran, and load order is not an answer an operator can reason about. It
 * throws rather than picking, and names both tools.
 */
export function findToolBySlash(cmd: string): Tool | undefined {
  assertLoaded();
  const want = cmd.replace(/^\//, '').trim().toLowerCase();
  if (!want) return undefined;
  const hits = tools.filter((t) => t.slash?.command.toLowerCase() === want);
  if (hits.length > 1) {
    throw new Error(`slash command "/${want}" is claimed by ${hits.map((t) => t.name).join(' and ')}`);
  }
  return hits[0];
}

/** Every tool that declares a slash command, for `/help`. */
export function slashTools(): Tool[] {
  assertLoaded();
  return tools.filter((t) => t.slash);
}

function assertLoaded(): void {
  if (!ready) {
    throw new Error('tools were read before discovery — core must await loadTools() at boot');
  }
}

/**
 * A slash-only tool with no slash command is reachable by NOBODY — hidden from the model and typed by
 * no one. Caught at boot rather than discovered as a tool that silently never runs.
 */
function assertSlashOnlyReachable(list: Tool[]): void {
  const orphan = list.filter((t) => t.slashOnly && !t.slash).map((t) => t.name);
  if (orphan.length) {
    throw new Error(`tool(s) marked slashOnly with no slash command — unreachable: ${orphan.join(', ')}`);
  }
}

export function getAllTools(): Tool[] {
  assertLoaded();
  return tools;
}

/**
 * The tools the MODEL may choose from — everything except the slash-only ones.
 *
 * One list feeds the prompt catalogue, the native tool schemas and the unknown-tool hint, so a tool
 * hidden from one and offered by another cannot happen. `getAllTools()` stays the full set for name
 * resolution and `/help`: a slash-only tool still exists, it is just not the agent's to reach for.
 */
export function modelTools(): Tool[] {
  assertLoaded();
  return tools.filter((t) => !t.slashOnly);
}

// ── System prompt XML ───────────────────────────────────────────────

export function toolsSystemPrompt(): string {
  assertLoaded();
  // NATIVE tool declaration: the provider hands the schemas to the runtime, which renders them in its
  // own template. Listing them here as well would give the model the same tools twice in two formats,
  // and an instruction to use ours while the template primes its own (measured: ~2K wasted tokens per
  // round for a full tool set, and a visibly worse investigation). One line replaces the catalogue —
  // enough to tell the model tools exist, none of the duplication.
  if (toolMode() === 'native') {
    return getPrompt('system', {
      WORKING_DIR: CWD,
      TOOLS: 'Your tools are declared to the runtime; call them directly.',
      TOOL_CALL_FORMAT: '',
    });
  }
  const toolDefs = modelTools().map(t => {
    const params = t.parameters
      .map(p => `  - ${p.name} (${p.type}${p.required === false ? ', optional' : ''}): ${p.description}`)
      .join('\n');
    return `${t.name}: ${t.description}\n  Parameters:\n${params}`;
  }).join('\n\n');

  return getPrompt('system', {
    WORKING_DIR: CWD,
    TOOLS: toolDefs,
    // The tool-call format is OWNED BY THE ACTIVE DIALECT (gemma/qwen), injected
    // here via the LLM manager. New prompts use {{TOOL_CALL_FORMAT}}; an older
    // persisted prompts.json that hardcodes the format simply ignores this var.
    TOOL_CALL_FORMAT: toolCallInstructions(),
  });
}
