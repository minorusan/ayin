/**
 * BaseTool — the common shape every tool implements, and the one way a tool loads a prompt.
 *
 * A tool ships its own prompt texts next to its code (`<tool-package>/prompts/*.txt`) and declares
 * that directory as `promptsSourceDir`. At registration ayin materializes those into the operator's
 * LOCAL store and **injects the resulting bundle back** via `bindPrompts()`. From then on the tool
 * reads prompts by id through `this.prompt(id, vars)` and never touches the filesystem itself.
 *
 * The point of the injection: a tool package can live in its own repo — public or private — and
 * depend only on this interface, not on ayin's filesystem layout or its service singleton. The bundle
 * type comes from `runtime.ts` (this directory), not from core's prompt service — structurally the
 * same object, with no import pointing out of `tools/`. Without
 * ayin a tool has no bundle and cannot run. That is intended; tools are ayin's tools.
 */

import type { ToolPrompts as PromptBundle } from './runtime.js';

/**
 * What a tool is handed so it can narrate and be stopped.
 *
 * DECLARED HERE, not in `runs.ts`, because `tools/` imports nothing outside `tools/` — the boundary
 * `check:gates` enforces, and the reason a tool package can live in its own repo. `runs.ts` imports
 * this instead; the contract belongs to the contract's file.
 */
export interface RunContext {
  /** Aborted when this call is cancelled, or when the turn is. */
  signal: AbortSignal;
  /** Say what you are doing. The only thing between a slow tool and a hung-looking one. */
  onStatus(note: string): void;
}

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required?: boolean;
}

/**
 * A slash command that runs one tool DIRECTLY, bypassing the model's choice of tool.
 *
 * The model deciding which tool to call is the right default and stays the default. But some tools are
 * not a step in a plan — they ARE the answer, and a whole outer round spent on "which tool?" is a round
 * spent on a question the operator already answered by typing the command. A connector is the clearest
 * case: its `execute` is its own agentic loop, so the outer model's only contribution is to relay text
 * into it and text back out, twice, at full prompt cost.
 *
 * The tool declares this itself rather than a central list naming it, because the registry is a
 * DIRECTORY: a list would reintroduce exactly the shared file that directory discovery removed, and an
 * installed third-party tool could never appear in it.
 */
export interface ToolSlash {
  /** Without the leading slash: `jira` → `/jira`. */
  command: string;
  /** Which parameter receives the rest of the line. */
  param: string;
  /** One line shown by `/help` and on a bare invocation. */
  usage: string;
  /**
   * The argument is a SECRET — a token, a key, a password.
   *
   * An ordinary command's text is worth keeping: it goes into the persisted input history so arrow-up
   * re-runs it, and into the agent's conversation window so a follow-up question has context. Both are
   * wrong for a credential. The history file is plaintext on disk and survives the session; the
   * conversation window is sent to the model on every subsequent round, which means the operator's Jira
   * token would be uploaded to whatever is serving the model, repeatedly, for the rest of the session.
   *
   * Set this and the argument is kept out of both — the history entry becomes the bare command, and the
   * turn is never recorded. The result is still shown on screen: the operator typed it, and they need to
   * see whether it worked.
   */
  secret?: boolean;
  /**
   * Parameters pinned for the SLASH path only.
   *
   * A slash command carries one argument, but the same tool can owe its two callers different answers:
   * `prefab_inspect` hands the agent JSON to edit from and the operator a readable tree. Without this the
   * choice would have to be a name check in the dispatcher — which is the shared list that directory
   * discovery exists to remove.
   */
  defaults?: Record<string, string>;
  /**
   * The result is a DOCUMENT: show it in a scrollable overlay rather than as a chat message.
   *
   * A recursive prefab tree is hundreds of lines. In the chat it scrolls the conversation away and cannot
   * be paged back through; in an overlay it is read, scrolled and closed, and the conversation is where it
   * was. The tool declares this because the tool knows how big its answer is.
   */
  overlay?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  /**
   * `ctx` is OPTIONAL so every existing tool compiles unchanged, and is how a tool becomes something
   * other than opaque: `ctx.onStatus(note)` narrates, `ctx.signal` says when to stop. A tool that
   * takes neither is fine — it simply cannot be cancelled mid-flight or report progress, which is the
   * state every tool was in before `runs.ts`. See `runs.ts` for why that mattered.
   */
  execute(params: Record<string, string>, ctx?: RunContext): Promise<string>;
  /** Run this tool directly from a slash command. See ToolSlash. */
  readonly slash?: ToolSlash;
  /**
   * Keep this tool OUT of the model's catalogue — the operator may run it, the agent may not.
   *
   * Not a permission: a slash-only tool is not dangerous, it is EXPENSIVE IN THE WRONG PLACE. `jira`
   * runs its own agentic loop against a REST API, so the agent pays several round trips mid-turn for
   * something the operator can fetch in one command before asking anything. The result still reaches
   * the model — a slash invocation is recorded into the conversation window — so nothing is lost
   * except the waiting.
   *
   * Requires `slash`, or the tool would be unreachable by anyone. The registry enforces that at boot.
   */
  readonly slashOnly?: boolean;
  /** Source prompts directory shipped by this tool, if it has prompts. Read-only at runtime. */
  readonly promptsSourceDir?: string;
  /** Called by the registry with the LOCAL bundle once its prompts are materialized. */
  bindPrompts?(bundle: PromptBundle): void;
}

export abstract class BaseTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract parameters: ToolParameter[];
  abstract execute(params: Record<string, string>, ctx?: RunContext): Promise<string>;

  /** Override in a tool that ships prompts. Absolute path to its `prompts/` directory. */
  readonly promptsSourceDir?: string;

  /** Override in a tool that wants a slash command of its own. */
  readonly slash?: ToolSlash;

  #prompts?: PromptBundle;

  /** Injected by the registry at registration time. */
  bindPrompts(bundle: PromptBundle): void {
    this.#prompts = bundle;
  }

  /**
   * Load one of this tool's prompts by id, substituting `{{VAR}}` placeholders.
   * Throws if the tool declared no prompts directory, or the id does not exist — a tool running on
   * a silently-empty prompt is a degraded LLM call that looks like it worked.
   */
  protected prompt(id: string, vars: Record<string, string> = {}): string {
    if (!this.#prompts) {
      throw new Error(
        `tool "${this.name}" asked for prompt "${id}" but has no prompt bundle — ` +
          `declare promptsSourceDir and register the tool through the registry`,
      );
    }
    return this.#prompts.get(id, vars);
  }

  /** Whether this tool has a given prompt available locally. */
  protected hasPrompt(id: string): boolean {
    return this.#prompts?.has(id) ?? false;
  }
}
