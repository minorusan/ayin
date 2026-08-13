/**
 * Shared base for dialects that speak ayin's XML text-tool-calling convention:
 *   <function=name><parameter=key>value</parameter></function>
 * with results framed in <tool_response>…</tool_response>.
 *
 * Gemma4 and Qwen3-Coder both use this surface; they differ only in the exact
 * wording that elicits the cleanest formatting (toolCallInstructions), which
 * each concrete dialect supplies. The lenient parser (parser.ts#parseResponseAll)
 * already tolerates both the canonical Qwen form and Gemma4's fused-tag variant,
 * so parsing, re-rendering, and result framing are shared here.
 */

import { parseResponseAll } from '../../parser.js';
import type { ModelDialect, ParseAllResult, ParsedToolCall } from '../types.js';

export abstract class XmlToolCallDialect implements ModelDialect {
  abstract readonly id: string;
  abstract matches(modelId: string): boolean;
  abstract toolCallInstructions(): string;

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
