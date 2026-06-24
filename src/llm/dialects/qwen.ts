/**
 * Qwen3-Coder dialect — selected automatically when the backend reports a `qwen*`
 * model (a common choice when a backend serves a coder model for coding tasks).
 *
 * Qwen emits ayin's canonical XML tool-call form cleanly (it's where that form
 * originates), without Gemma4's fused-tag quirk — so the instructions are the
 * tight canonical block and parsing/result-framing are the shared XML base.
 */

import { XmlToolCallDialect } from './xml.js';

const TOOL_CALL_FORMAT = `Tool-call format — emit calls in this exact form:

<function=tool_name>
<parameter=param_name>value</parameter>
</function>

You may emit several calls in one response; each runs in order and its result is fed back to you inside <tool_response>…</tool_response>. Do not repeat an identical call within the same response. Use the cheapest tool that answers the question, and prefer str_replace over write_file when editing an existing file.`;

export class QwenDialect extends XmlToolCallDialect {
  readonly id = 'qwen';
  matches(modelId: string): boolean { return /qwen/i.test(modelId); }
  toolCallInstructions(): string { return TOOL_CALL_FORMAT; }
}
