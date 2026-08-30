/**
 * Qwen3-Coder dialect — selected automatically when the backend reports a `qwen*`
 * model (a common choice when a backend serves a coder model for coding tasks).
 *
 * Qwen emits ayin's canonical XML tool-call form cleanly (it's where that form
 * originates), without Gemma4's fused-tag quirk — so the instructions are the
 * tight canonical block and parsing/result-framing are the shared XML base.
 */

import { XmlToolCallDialect } from './xml.js';
import { stripReasoning } from './reasoning.js';

/**
 * The inner block, WITHOUT the `<tool_call>` wrapper the model was trained to emit. That looks wrong
 * and is correct here, for a measured reason.
 *
 * `<tool_call>` is a BOUNDARY token in this serving path. Instructed, the model emits it and generation
 * ends there: three runs in a row answered "Let me start by checking the container…" and finished at
 * round 1 with zero tool calls. The call does not arrive in `message.content`, and it does not arrive in
 * `message.tool_calls` either — Ollama only fills that field when the REQUEST declares `tools`, and the
 * `/api/generate` contract carries messages and nothing else.
 *
 * Declaring tools would mean the gateway holding every client's schemas, which is exactly the coupling
 * the tiny text contract exists to avoid — the thing that lets ayin run against any endpoint. So the
 * un-wrapped form is not a workaround; it is what the contract costs, and it is cheap. The gateway does
 * relay `message.tool_calls` as canonical text when they ever appear, and `parser.ts` tolerates the
 * wrapper, so nothing has to change here if a future runtime hands them over.
 *
 * What is deliberately NOT here: "do not repeat an identical call" (tool-guard refuses repeats before
 * a shell is spawned), "use the cheapest tool" (unmeasurable), and "prefer str_replace over
 * write_file" (that preference is in str_replace's own description, where the model reads it while
 * choosing). A rule the harness enforces does not need to be paid for again in every prompt.
 */
const TOOL_CALL_FORMAT = `Tool-call format:

<function=tool_name>
<parameter=param_name>value</parameter>
</function>

Several calls may be emitted in one response; each runs in order and its result comes back inside <tool_response>…</tool_response>.`;

export class QwenDialect extends XmlToolCallDialect {
  readonly id = 'qwen';
  /**
   * Only the qwen3.5-parser models. Proven from the runtime's source: that parser consumes the
   * opening `<function=NAME>` tag with no `len(tools) == 0` guard, so with tools undeclared the name
   * is deleted upstream and nothing downstream can recover it. Older qwen parsers do not collide with
   * this syntax and keep working in prompt mode, so this must not cover the whole family.
   */
  get requiresNativeTools(): boolean { return /qwen3\.[58]/i.test(this.servedModel); }
  private servedModel = '';
  matches(modelId: string): boolean { this.servedModel = modelId; return /qwen/i.test(modelId); }
  toolCallInstructions(): string { return TOOL_CALL_FORMAT; }
  /**
   * Qwen is the family measured leaking its reasoning into `content` on this serving path — with
   * `think` already OFF, because the flag stops the runtime SPLITTING the channel, not the model
   * THINKING. See `reasoning.ts` for the shapes and why the monologue costs more than it looks like
   * it does.
   */
  stripReasoning(raw: string): string { return stripReasoning(raw); }
}
