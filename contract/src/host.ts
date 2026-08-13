/**
 * What a tool is GIVEN. The other half of the seam: prompts arrive via `PromptBundle`, and everything
 * that DOES something arrives here.
 *
 * This exists because tools used to import the agent — the TUI to print progress, the LLM manager to
 * make a nested call, the shell helper to run a command. Any one of those imports pins a tool to
 * ayin's source layout and makes it unmovable. A tool asks the host instead.
 *
 * Every member is deliberately narrow: this is the smallest surface that the existing tools needed,
 * not a window onto the agent.
 */

export interface HostLogger {
  info(event: string, fields?: Record<string, string>): void;
  warn(event: string, fields?: Record<string, string>): void;
}

/** One model call. The host owns transport — retries, timeouts, image attachment, which provider. */
export interface HostLlm {
  ask(messages: Array<{ role: string; content: string }>, opts?: { temperature?: number }): Promise<string>;
}

export interface HostShell {
  /** Run a command and return its combined output. The host owns the timeout and the output cap, and
   *  states in the returned text when either was hit — a silently truncated result is a lie. */
  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<string>;
}

export interface HostServices {
  /** Report progress to whatever surface the user is watching — a TUI, a log, nothing at all. */
  report(message: string): void;
  llm: HostLlm;
  shell: HostShell;
  log: HostLogger;
  /** The directory the agent is working in. */
  cwd(): string;
}
