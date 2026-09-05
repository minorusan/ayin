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
import { noKeyMessage, readOpenAiKey, readOpenAiModel } from './tools/credentials/openai.js';
import type { ChildProcess } from 'node:child_process';
import { liveLlm } from './live-mirror.js';

export function ensureToolRuntime(): void {
  if (toolRuntimeReady()) return;
  initToolRuntime({
    llm: {
      // Imported lazily, not at module scope: `llm/manager` imports the tool registry back (to declare
      // schemas to a native provider), and a top-level cycle leaves one side half-initialized
      // depending on which module the process loaded first.
      /**
       * A TOOL asking the model a question — never the agent loop.
       *
       * `declareTools: false` is load-bearing, not a tidy-up. Everything reaching the model through
       * here (explore, indulge's question and answer passes, the QA audit, the connectors' inner
       * loops) wants prose or JSON back and says so in its own prompt. Declaring the tool catalogue
       * on those calls handed a native-tool model a real `grep` it could call — and GPT-4.1 did
       * exactly that, correctly, which arrived as `<function=grep>` inside a reply that was supposed
       * to be JSON and parsed as nothing.
       */
      async ask(messages) {
        const { llmChat } = await import('./llm/manager.js');
        return llmChat(messages as Parameters<typeof llmChat>[0], { declareTools: false });
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
    /**
     * The operator half of `llm.ask`. Lazy for the same reason as `report` — `dialog.js` reaches
     * the blessed screen, and importing it eagerly would take the terminal just to wire a delegate.
     *
     * HEADLESS RETURNS NULL. `-p`, `ayin watch` and every scheduled run have nobody to answer, and a
     * dialog there would either hang forever or, worse, fall through to a default. Null is a refusal
     * the tool must report — never a silent yes. Same rule as the always-confirm git gate.
     */
    confirm: async (question, choices, opts) => {
      const { HEADLESS } = await import('./ui/headless.js');
      if (HEADLESS) return null;
      const { showDialog } = await import('./dialog.js');
      const picked = await showDialog(
        question,
        choices.map((c) => ({ label: c.label, sub: c.sub, danger: c.destructive })),
        { subtitle: opts?.subtitle },
      );
      // showDialog resolves the INDEX, and -1 for Escape. Index 0 is a real answer, so this must be
      // an explicit `< 0` test — `picked ? … : null` would turn "the operator chose the first
      // option" into a refusal, silently, and only for the first option.
      //
      // A cancelled dialog and an unanswerable one are the same answer to the caller: no.
      return picked < 0 || picked >= choices.length ? null : choices[picked].id;
    },
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
    // A tool that needs an AGENT rather than an answer. Imported lazily for the same reason `llm` is:
    // `subagents.ts` pulls in the process spawner and the postmortem handlers, and a top-level import
    // from the wiring would drag them into every entry point that touches a tool.
    // `signal` and `onStatus` pass STRAIGHT THROUGH — `SubagentOpts` has accepted both all along, and
    // this annotation being narrower than the thing it forwards to is what silently discarded them.
    // A field a port cannot name is a field its consumers cannot use, however well the layer below
    // supports it.
    subagent: async (task: string, opts?: {
      cwd?: string; plan?: string; signal?: AbortSignal; onStatus?: (note: string) => void;
    }) => {
      const { runSubagent, subagentsAllowed } = await import('./subagents.js');
      if (!subagentsAllowed()) {
        throw new Error('subagents are not available here — a subagent may not spawn subagents, and this session may have --disallow-subagents');
      }
      return runSubagent(task, opts ?? {});
    },
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
    llmState: (state, detail) => liveLlm(state, detail),
    log: {
      info: (event, fields) => log('INFO', event, fields),
      warn: (event, fields) => log('WARN', event, fields),
      error: (event, fields) => log('ERROR', event, fields),
    },
    config: (key) => getConfigString(key),
    takePendingImages: () => takePendingImages(),
    // Core knows where credentials live; the provider only knows it needs one. The legacy
    // `openAiKey` config entry is still read here so an existing install keeps working — an upgrade
    // that silently forgets a stored key is indistinguishable from one that broke it.
    credential: (vendor) => {
      if (vendor !== 'openai') return { key: '', model: '', setupHint: `no credential source for "${vendor}"` };
      return {
        key: readOpenAiKey() || (getConfigString('openAiKey') ?? '').trim(),
        model: readOpenAiModel() || (getConfigString('openAiModel') ?? ''),
        setupHint: noKeyMessage(),
      };
    },
  });
}
