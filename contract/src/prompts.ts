/**
 * How a tool reads its own prompt texts without knowing where they live.
 *
 * A tool ships prompt files beside its code and declares that directory. The host materializes them
 * into the operator's own store — never overwriting an edited copy — and hands back a bundle. The tool
 * reads by id and never learns the path, which is what lets it live in another repository.
 */
export interface PromptBundle {
  /** Namespace this bundle serves — the owning tool's unique name. */
  readonly namespace: string;
  /** The directory these prompts are read from. Informational; a tool should not need it. */
  readonly dir: string;
  /** Load a prompt by id, substituting `{{VAR}}` placeholders. THROWS on an unknown id: a prompt that
   *  silently resolves to nothing is a degraded model call that looks like it worked. */
  get(id: string, vars?: Record<string, string>): string;
  has(id: string): boolean;
  ids(): string[];
}
