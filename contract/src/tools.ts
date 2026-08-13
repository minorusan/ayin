import type { PromptBundle } from './prompts.js';
import type { HostServices } from './host.js';

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required?: boolean;
}

/**
 * A tool: a name the model calls, typed parameters, and `execute`.
 *
 * The returned string is read by a model, so it carries its own honesty: when a result was capped,
 * cut, or never finished, say so IN the text. A tool that returns a fragment shaped like a whole
 * answer is the most expensive kind of bug — the model cannot detect it and reasons on confidently.
 */
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute(params: Record<string, string>): Promise<string>;
  /** Prompts this tool ships, if any. Read-only at runtime. */
  readonly promptsSourceDir?: string;
  /** Injected at registration once this tool's prompts exist locally. */
  bindPrompts?(bundle: PromptBundle): void;
  /** Injected at registration. A tool needing none of it may ignore this. */
  bindHost?(host: HostServices): void;
}

export abstract class BaseTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract parameters: ToolParameter[];
  abstract execute(params: Record<string, string>): Promise<string>;

  readonly promptsSourceDir?: string;

  #prompts?: PromptBundle;
  #host?: HostServices;

  bindPrompts(bundle: PromptBundle): void {
    this.#prompts = bundle;
  }

  bindHost(host: HostServices): void {
    this.#host = host;
  }

  /** Load one of this tool's prompts. Throws rather than degrade — see `PromptBundle.get`. */
  protected prompt(id: string, vars: Record<string, string> = {}): string {
    if (!this.#prompts) {
      throw new Error(
        `tool "${this.name}" asked for prompt "${id}" but has no bundle — declare promptsSourceDir ` +
          `and register through the registry`,
      );
    }
    return this.#prompts.get(id, vars);
  }

  /** The host's services. Throws if the tool was constructed outside a registry. */
  protected get host(): HostServices {
    if (!this.#host) {
      throw new Error(`tool "${this.name}" used host services but was never bound to a host`);
    }
    return this.#host;
  }
}
