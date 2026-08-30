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

  /**
   * True when the reply OPENS a tool call it never closed — the generation was cut off.
   *
   * Without this, a truncated call has no tool calls to run and is therefore indistinguishable from a
   * final answer, so ayin printed half a `str_replace` at the operator as prose and edited nothing.
   * Optional: a dialect that cannot tell says nothing and the old behaviour stands.
   */
  truncated?(raw: string): boolean;
  /**
   * Remove a leaked REASONING channel from a raw reply, for a family whose serving path sometimes
   * fails to split it off (see `dialects/reasoning.ts` for the measured case).
   *
   * Optional, and absent is the right answer for most dialects: when the runtime separates the
   * channels properly the reasoning never reaches `content`, and a strip that runs anyway is only a
   * chance to eat a real answer. A dialect implements this when its own family is measured leaking.
   *
   * Applied in `manager.ts#llmChat`, once, to the reply every consumer shares — NOT in `parse()`.
   * `parse()` would clean the prose and miss the three branches in `agent.ts` that push the RAW
   * response into the window, which is exactly where a monologue must not land.
   */
  stripReasoning?(raw: string): string;
  /** Re-render an assistant tool-call turn when replaying it into the window. */
  renderToolCall(call: ParsedToolCall): string;
  /** Frame a message (tool output, error, warning) as the model's tool-result turn. */
  renderToolResult(body: string): string;
  /**
   * True when this model's SERVER-SIDE format is not the canonical `<function=…>` XML, so native
   * tool declaration cannot be used with it.
   *
   * Native tools round-trip a turn twice: the server parses the model's output into structured calls,
   * the provider renders them back to XML text, and that text returns as an assistant message in the
   * NEXT request's history — where the server re-renders the conversation in the model's own format.
   * If that format is ATEM, the XML is not parseable as ATEM and the server answers
   * `500 parse Glimmer call to <tool>: malformed ATEM parameter` on the second round.
   *
   * Native declaration exists for models whose PARSER destroys the tool name (a renderer missing the
   * `len(tools) == 0` guard consumes the opening tag and emits no name). A dialect that parses its own
   * model correctly does not need it and must not pay this cost.
   */
  readonly rejectsNativeTools?: boolean;
  /**
   * True when prompt-declared tools CANNOT work for this model, so schemas must be declared natively.
   *
   * The mirror of `rejectsNativeTools`, and it exists because a dialect only owns HALF the contract.
   * The server runs a parser chosen by the model's own `PARSER` directive, whether or not the client
   * declared tools. When that parser consumes the very syntax ayin's dialect asks the model to emit,
   * the text is gone before ayin sees it — no dialect can win that, because there is nothing left to
   * parse. `qwen3.5` is exactly this: it eats the opening `<function=NAME>` tag and, with no tools
   * declared, cannot resolve a name, so the call evaporates and the model looks like it ignored its
   * instructions.
   */
  readonly requiresNativeTools?: boolean;
}
