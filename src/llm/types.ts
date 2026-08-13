/**
 * Ayin LLM manager — types.
 *
 * A ModelDialect captures everything model-FAMILY-specific about driving a
 * text-tool-calling LLM through ayin's agent loop:
 *   - how the model is TOLD to emit tool calls (system-prompt instructions),
 *   - how tool calls are PARSED out of its raw output,
 *   - how an assistant tool-call turn is RE-RENDERED when replayed into history,
 *   - how a tool RESULT is framed back to the model.
 *
 * Everything else — the agent loop, the tools, the transport — is model-agnostic.
 * Add a model family by implementing this interface and registering it in
 * `manager.ts`. See docs/ARCHITECTURE.md "LLM manager & dialects".
 */

import type { ParseAllResult, ParsedToolCall } from '../parser.js';

export type { ParseAllResult, ParsedToolCall };

export interface LlmMessage {
  role: string;
  content: string;
}

export interface ModelDialect {
  /** Stable id, e.g. 'gemma' | 'qwen'. */
  readonly id: string;
  /** True if this dialect should drive the given backend model id (e.g. "gemma4:26b"). */
  matches(modelId: string): boolean;
  /** Tool-call format instructions injected into the system prompt ({{TOOL_CALL_FORMAT}}). */
  toolCallInstructions(): string;
  /** Extract tool calls (and any leading prose) from a raw model response. */
  parse(raw: string): ParseAllResult;
  /** Re-render an assistant tool-call turn when replaying it into the window. */
  renderToolCall(call: ParsedToolCall): string;
  /** Frame a message (tool output, error, warning) as the model's tool-result turn. */
  renderToolResult(body: string): string;
}
