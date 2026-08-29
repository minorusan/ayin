/**
 * The tool runtime — everything a tool is GIVEN, and the only module in `tools/` that ayin's core
 * talks to.
 *
 * THE RULE THIS EXISTS TO ENFORCE
 *
 * A tool never reaches for the model. There is exactly ONE place in ayin that touches the provider
 * abstraction to generate — `llm/manager.ts` — and a tool must not be a second one. It used to be
 * three: `explore`, `diagram` and `arduino_explain` each imported `llmChat` from the manager, and each
 * import is a hard edge from a tool to ayin's source layout. Now the model arrives as a DELEGATE:
 * core hands this module one function at boot, tools call it, and nothing in `tools/` knows what a
 * provider is, that dialects exist, or that a GPU is being arbitrated somewhere.
 *
 * Logging is the same shape and was worse — seven tools imported the logger directly.
 *
 * WHY A RUNTIME AND NOT CONSTRUCTOR INJECTION
 *
 * The tools here are function modules, not classes (`BaseTool` covers the ones that are, and gets the
 * same services). Threading a services object through every function signature would touch every call
 * site to deliver something none of them vary. One initialization point, set once by core at boot, is
 * the smaller change and the same decoupling: when `tools/` becomes its own package, this file travels
 * with it and `initToolRuntime` is the seam ayin calls.
 *
 * UNSET IS A THROW, NEVER A NO-OP. A tool that silently skipped its model call, or dropped its log
 * lines, would look like it worked. That is the same rule the prompt bundle follows (`base.ts`).
 */

/**
 * One model call. Core owns transport, retries, timeouts, dialect and which provider serves it.
 *
 * Deliberately no sampling options: nothing in `tools/` sets any today, and an accepted-then-ignored
 * `temperature` is the kind of parameter that looks honoured for a year. Add it here and thread it to
 * the provider in the same change, when a tool actually needs it.
 */
export interface ToolLlm {
  ask(messages: Array<{ role: string; content: string }>): Promise<string>;
}

/** Structured logging, fields flattened into the entry. Core decides where it goes and who observes. */
export interface ToolLogger {
  info(event: string, fields?: Record<string, string>): void;
  warn(event: string, fields?: Record<string, string>): void;
  error(event: string, fields?: Record<string, string>): void;
  debug(event: string, fields?: Record<string, string>): void;
}

/**
 * A child process, narrowed to what a tool actually uses. Typed structurally rather than as node's
 * `ChildProcess` so this file stays free of imports — the seam describes what it needs, and core
 * happens to satisfy it with a real spawn.
 */
export interface ToolProcess {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'close', cb: (code: number | null) => void): unknown;
}

export interface ToolShell {
  /** Spawn through whatever shell the host resolved — Git Bash on Windows, /bin/bash elsewhere. */
  spawn(command: string, opts?: { cwd?: string }): ToolProcess;
  /** Kill the whole process group. A tool must not have to know how the host does that. */
  kill(child: ToolProcess, signal?: string): void;
}

/**
 * One of this tool's own prompt files, already materialized into the operator's editable copy.
 * Structurally the `PromptBundle` core hands over; declared here so `tools/` imports no core types.
 */
export interface ToolPrompts {
  get(id: string, vars?: Record<string, string>): string;
  has(id: string): boolean;
  ids(): string[];
}

/** One choice in a `confirm`. `destructive` is what the host may style, or refuse, differently. */
export interface ToolChoice {
  id: string;
  label: string;
  /** The cost of picking this, in the operator's terms — shown under the label. */
  sub?: string;
  destructive?: boolean;
}

export interface ToolServices {
  llm: ToolLlm;
  log: ToolLogger;
  /** Show the user something as the tool works. A host with no UI can drop it. */
  report(message: string): void;
  /**
   * ASK THE OPERATOR. The counterpart to `llm.ask`: same delegate shape, other party.
   *
   * A tool that reaches outside the repo — quitting an editor, deleting a build, restarting a
   * service — must be able to ask before it does, without importing the host's UI. Returns the
   * chosen `id`, or **null when there is nobody to ask**.
   *
   * NULL IS A REFUSAL, NEVER A DEFAULT YES. Headless (`-p`), `ayin watch` and any scheduled run have
   * no answerer, and a tool that quits the operator's editor because a cron job could not be asked
   * is the exact bug this signature exists to prevent. The host returns null; the tool reports why
   * it stopped. Same rule the git gate follows.
   */
  confirm(question: string, choices: ToolChoice[], opts?: { subtitle?: string }): Promise<string | null>;
  shell: ToolShell;
  /** Open a produced artifact for the user. Resolves false when the host has no editor, or
   *  declined — tools report that as `opened: false`, so it must not be swallowed. */
  openInEditor(path: string): Promise<boolean>;
  /** One config value by key. Tools read config; they do not own where it lives. */
  config(key: string): string | undefined;
  /**
   * This tool's prompts, by namespace. Core resolves the shipped directory from the namespace and
   * materializes it — so a tool names WHAT it wants, never where the files are, which is the whole
   * reason a tool package can live in its own repo.
   */
  prompts(namespace: string): ToolPrompts;
  /**
   * The host application's base URL, for the few tools that ask it to do something on their behalf
   * (`send_push`). '' when there is no such host, which those tools report as being unconfigured.
   */
  backendUrl(): string;
  /**
   * DELEGATE A WHOLE TASK to a fresh agent, and get back what it did.
   *
   * A seam rather than a direct import for the usual reason — `tools/` imports nothing outside
   * `tools/`, and `subagents.ts` reaches deep into core to spawn a process. Tools that need an agent
   * rather than an answer (`find_relevant_files`) come through here.
   *
   * The host is responsible for refusing to recurse: at depth ≥ 1 there is no subagent to give, and
   * this throws rather than quietly spawning one. See `subagents.ts`.
   */
  subagent(task: string, opts?: { cwd?: string; plan?: string }): Promise<{ ok: boolean; report: string; toolCalls: number; ms: number }>;
}

let services: ToolServices | null = null;

/**
 * Called ONCE by ayin's core before any tool runs. Calling it again replaces the services, which is
 * what a test needs and what nothing else should do.
 */
export function initToolRuntime(next: ToolServices): void {
  services = next;
}

function require_(): ToolServices {
  if (!services) {
    throw new Error(
      'tool runtime not initialized — a tool asked for the model or the log before ayin wired them. ' +
        'Core must call initToolRuntime() at boot.',
    );
  }
  return services;
}

/** The model, for a tool that needs one. The only route from `tools/` to an LLM. */
export function toolLlm(): ToolLlm {
  return require_().llm;
}

/** The log, for a tool that has something worth recording. */
export function toolSubagent(): ToolServices['subagent'] {
  return require_().subagent;
}

export function toolLog(): ToolLogger {
  return require_().log;
}

/** Progress for the user. */
export function toolReport(message: string): void {
  require_().report(message);
}

export function toolShell(): ToolShell {
  return require_().shell;
}

/** Ask the operator. Resolves null when there is nobody to ask — treat that as "no". */
export function toolConfirm(
  question: string, choices: ToolChoice[], opts?: { subtitle?: string },
): Promise<string | null> {
  return require_().confirm(question, choices, opts);
}

export function toolOpenInEditor(path: string): Promise<boolean> {
  return require_().openInEditor(path);
}

export function toolConfig(key: string): string | undefined {
  return require_().config(key);
}

/**
 * This tool's prompt bundle. Resolved on CALL, never cached at module scope: a tool module can be
 * imported before core wires the runtime, and `const x = toolPrompts('ns')` at module scope would
 * throw at import time instead of at use — turning a wiring mistake into an unloadable module.
 */
export function toolPrompts(namespace: string): ToolPrompts {
  return require_().prompts(namespace);
}

export function toolBackendUrl(): string {
  return require_().backendUrl();
}

/** True once core has wired the runtime. For diagnostics and gates, not for branching in a tool. */
export function toolRuntimeReady(): boolean {
  return services !== null;
}
