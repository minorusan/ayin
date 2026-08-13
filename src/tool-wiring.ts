/**
 * Where ayin's core hands `tools/` the model and the log. THE only place the delegates are built.
 *
 * Why this is its own module rather than a few lines in the registry: a tool module is importable
 * without the registry, and three callers do exactly that — `plan/`, `explain/` and the gate harnesses
 * import `exploreExecute` / `diagramExecute` / `webSearch` directly. Wired only inside `tools.ts`, the
 * delegates existed solely because something ELSE in the process happened to have imported the
 * registry first: `-p` and the TUI load `agent.ts`, which loads the registry, so it worked. `ayin
 * explain` and `ayin watch` do not, and would have thrown on the first tool that logs. Initialization
 * that depends on another module's import order is a bug waiting for a refactor to expose it.
 *
 * So: idempotent, callable from any entry point, one implementation. Calling it twice is free.
 */

import { log } from './log.js';
import { spawnShell, killTree } from './shell.js';
import { getConfigString } from './prompts.js';
import { prompts, packagePath } from './prompts-service.js';
import { llmBaseUrl } from './connection.js';
import { initToolRuntime, toolRuntimeReady, type ToolProcess } from './tools/runtime.js';
import { initProviderRuntime, providerRuntimeReady } from './llm/providers/runtime.js';
import { takePendingImages } from './image.js';
import type { ChildProcess } from 'node:child_process';

export function ensureToolRuntime(): void {
  if (toolRuntimeReady()) return;
  initToolRuntime({
    llm: {
      // Imported lazily, not at module scope: `llm/manager` imports the tool registry back (to declare
      // schemas to a native provider), and a top-level cycle leaves one side half-initialized
      // depending on which module the process loaded first.
      async ask(messages) {
        const { llmChat } = await import('./llm/manager.js');
        return llmChat(messages as Parameters<typeof llmChat>[0]);
      },
    },
    log: {
      info: (event, fields) => log('INFO', event, fields),
      warn: (event, fields) => log('WARN', event, fields),
      error: (event, fields) => log('ERROR', event, fields),
      debug: (event, fields) => log('DEBUG', event, fields),
    },
    // LAZY, and that is the point: `ui.js` creates the blessed screen at module scope, so importing it
    // takes over the terminal. Eagerly imported here, merely wiring the runtime painted escape codes
    // into whatever was running — which is how a stray one-line probe script ended up hanging for
    // fourteen hours. Nothing loads the TUI until a tool actually reports something, and by then a real
    // session has loaded it anyway. Reports stay in order: after the first call the module is cached and
    // the callbacks queue as microtasks.
    report: (message) => { void import('./ui.js').then((ui) => ui.addMessage('system', message)); },
    shell: {
      spawn: (command, opts) => spawnShell(command, opts) as unknown as ToolProcess,
      kill: (child, signal) => killTree(child as unknown as ChildProcess, signal as NodeJS.Signals | undefined),
    },
    // Lazy for the same reason as `report`: `editor.js` reads HEADLESS from `ui.js`, so importing it
    // eagerly drags the blessed screen in behind it.
    openInEditor: async (path) => (await import('./editor.js')).openInEditor(path),
    config: (key) => getConfigString(key),
    // The tool names its namespace; core owns where the shipped files live and materializes them into
    // the operator's editable copy. This is the import a tool package must not have.
    prompts: (namespace) => prompts.register(namespace, packagePath('prompts', namespace)).bundle,
    backendUrl: () => llmBaseUrl(),
  });
}

/**
 * The same for the vendor providers (`ollama`, `openai`). Separate from the tool runtime because the two
 * are extracted separately and neither should drag the other's dependencies along; called from the same
 * places, for the same reason — initialization must not depend on another module's import order.
 */
export function ensureProviderRuntime(): void {
  if (providerRuntimeReady()) return;
  initProviderRuntime({
    log: {
      info: (event, fields) => log('INFO', event, fields),
      warn: (event, fields) => log('WARN', event, fields),
      error: (event, fields) => log('ERROR', event, fields),
    },
    config: (key) => getConfigString(key),
    takePendingImages: () => takePendingImages(),
  });
}
