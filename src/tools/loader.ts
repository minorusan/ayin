/**
 * Tool DISCOVERY — the registry is a directory, not an array.
 *
 * WHY THIS REPLACED A LIST
 *
 * Every tool used to be an object literal in one 900-line file. That file is then the single place both
 * the public repo and any private copy must edit to add anything, so a private fork conflicts on it on
 * every update — which is what made "keep a private fork for our own tools" unworkable, and submodules no
 * better, since a static registry still has to name what it loads. Directory discovery removes the
 * shared edit: a tool is a file, and adding one touches nothing that already exists.
 *
 * That is also the extension point an MCP client needs. An MCP server's tools are known at RUNTIME, so
 * they can never appear in a compiled array; they can be registered by a package that this loader finds.
 *
 * WHERE IT LOOKS
 *
 *   1. `defs/` beside this file — the built-ins that ship with ayin.
 *   2. Every directory or package named in `AYIN_TOOL_DIRS` / config `toolDirs`. This is how a private
 *      or employer-specific tool set is installed WITHOUT forking: it depends on the tool runtime seam
 *      (`runtime.ts`), which is the only thing `tools/` exposes, and nothing in ayin's core.
 *
 * A module contributes tools by exporting `tool` (one) or `tools` (several). Nothing else is inspected,
 * so a helper module in the same directory is simply ignored.
 *
 * FAILURE POLICY. A module that throws on import is REPORTED and skipped, never silent: a tool that
 * vanishes without explanation looks to the operator exactly like a model that forgot it exists. One bad
 * third-party package must not take the agent down, but it must not disappear quietly either.
 *
 * DUPLICATE NAMES ARE FATAL. The model calls a tool by its bare name, so two tools answering to one name
 * means the wrong one runs and the transcript cannot show which. Discovery makes this reachable in a way
 * a hand-written array did not — an installed package can collide with a built-in — so it is checked and
 * refused loudly rather than resolved by load order.
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Tool } from './base.js';

export interface LoadReport {
  tools: Tool[];
  /** Where each tool came from, for `/tools` and for telling a stranger why a name is taken. */
  origin: Map<string, string>;
  /** Modules that failed to import, with the reason. Reported, never swallowed. */
  failed: Array<{ module: string; error: string }>;
  /** Names claimed more than once. Non-empty means the registry refuses to start. */
  duplicates: string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Extra tool directories, from the environment or the operator's config. */
export function extraToolDirs(read: (key: string) => string | undefined): string[] {
  const raw = process.env.AYIN_TOOL_DIRS ?? read('toolDirs') ?? '';
  return raw.split(/[:,]/).map((s) => s.trim()).filter(Boolean);
}

function moduleFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.js') && !f.endsWith('.d.ts'))
      // Sorted so the load order is the same on every machine: a registry whose contents depend on
      // readdir order is a registry that behaves differently on someone else's filesystem.
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export async function discoverTools(dirs: string[]): Promise<LoadReport> {
  const report: LoadReport = { tools: [], origin: new Map(), failed: [], duplicates: [] };
  const seen = new Map<string, string>();

  for (const dir of [join(HERE, 'defs'), ...dirs.map((d) => resolve(d))]) {
    for (const file of moduleFilesIn(dir)) {
      let mod: Record<string, unknown>;
      try {
        mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      } catch (err) {
        report.failed.push({ module: file, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const found: Tool[] = [];
      if (mod.tool) found.push(mod.tool as Tool);
      if (Array.isArray(mod.tools)) found.push(...(mod.tools as Tool[]));
      for (const t of found) {
        if (!t?.name || typeof t.execute !== 'function') {
          report.failed.push({ module: file, error: 'exported a tool with no name or no execute()' });
          continue;
        }
        const prior = seen.get(t.name);
        if (prior) {
          report.duplicates.push(`"${t.name}" claimed by ${prior} and ${file}`);
          continue;
        }
        seen.set(t.name, file);
        report.origin.set(t.name, file);
        report.tools.push(t);
      }
    }
  }
  return report;
}
