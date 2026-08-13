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

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute(params: Record<string, string>): Promise<string>;
  /** Source prompts directory shipped by this tool, if it has prompts. Read-only at runtime. */
  readonly promptsSourceDir?: string;
  /** Called by the registry with the LOCAL bundle once its prompts are materialized. */
  bindPrompts?(bundle: PromptBundle): void;
}

export abstract class BaseTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract parameters: ToolParameter[];
  abstract execute(params: Record<string, string>): Promise<string>;

  /** Override in a tool that ships prompts. Absolute path to its `prompts/` directory. */
  readonly promptsSourceDir?: string;

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
