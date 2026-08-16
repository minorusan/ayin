/**
 * NATIVE dialect — for backends whose API carries the tool schemas itself.
 *
 * THE BUG THIS EXISTS TO FIX. `DIALECTS` held only qwen and gemma, with gemma as the fallback, so an
 * OpenAI model resolved to the **gemma** dialect and had gemma's XML tool-call instructions injected
 * into its system prompt — while `providers/openai.ts` was ALSO declaring the same tools natively.
 * The model was told two incompatible ways to call a tool at once and, being a good instruction
 * follower, used the one written in prose: it replied `<function=grep><parameter=pattern>…` in a loop
 * that had declared no tools at all and merely wanted JSON back. That reply parsed as nothing and the
 * iteration — paid for, per token — was thrown away.
 *
 * So the correction belongs HERE, at the layer that exists to know how a model formats tool calls,
 * not in the tools that suffer from it. One dialect fixes every consumer: the agent loop, explore,
 * indulge, plan, QA.
 *
 * `toolCallInstructions()` returns EMPTY on purpose. The schema travels in the request; describing it
 * again in prose is not redundancy, it is a second contradictory contract, and the model has no way
 * to know which one is real.
 *
 * `parse()` is still the lenient text parser. The provider renders native `tool_calls` back into
 * ayin's canonical text (`providers/openai.ts#renderToolCalls`) so the rest of the loop stays
 * model-agnostic — parsing that text is exactly right, and it also catches a model that emits the
 * text form anyway.
 */

import { parseResponseAll } from '../../parser.js';
import type { ModelDialect, ParseAllResult, ParsedToolCall } from '../types.js';

/**
 * Model ids served by an API that takes function schemas.
 *
 * Matched on the id rather than asked of the provider so that a self-hosted OpenAI-compatible
 * endpoint serving `gpt-4.1` gets the same treatment: the question is what the MODEL expects, and a
 * model trained on native function calling expects it wherever it is hosted.
 */
const NATIVE_MODEL = /^(gpt-|o[134]-|o[134]$|chatgpt-)/i;

export class NativeToolDialect implements ModelDialect {
  readonly id = 'native';

  matches(modelId: string): boolean {
    return NATIVE_MODEL.test((modelId || '').trim());
  }

  /** Empty, deliberately — see the header. The API carries the schema. */
  toolCallInstructions(): string {
    return '';
  }

  parse(raw: string): ParseAllResult {
    return parseResponseAll(raw);
  }

  renderToolCall(call: ParsedToolCall): string {
    const params = Object.entries(call.params)
      .map(([k, v]) => `<parameter=${k}>\n${v}\n</parameter>`)
      .join('\n');
    return `<function=${call.name}>\n${params}\n</function>`;
  }

  renderToolResult(body: string): string {
    return `<tool_response>\n${body}\n</tool_response>`;
  }
}
