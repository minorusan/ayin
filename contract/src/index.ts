/**
 * @ayin/contract — the interfaces between ayin and its tools and model providers.
 *
 * Types only. No runtime, no dependencies. See README.md for the two rules that keep it that way:
 * an absent provider capability renders as nothing, and a tool receives what it needs rather than
 * importing the agent.
 */
export type { PromptBundle } from './prompts.js';
export type { HostServices, HostLlm, HostLogger, HostShell } from './host.js';
export type { Tool, ToolParameter } from './tools.js';
export { BaseTool } from './tools.js';
export type {
  LlmMessage,
  GenerateOptions,
  GenerateResult,
  ProviderStatus,
  ModelEntry,
  ModelCatalog,
  LlmProvider,
} from './llm.js';
