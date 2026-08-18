/**
 * GLM dialect — for `glm-*` models, which invent their own tool-call syntax when nobody pins one.
 *
 * WHAT WAS HAPPENING. No dialect claimed `glm-4.7-flash`, so it fell to the gemma DEFAULT, whose
 * format is `<function=name><parameter=p>v</parameter></function>`. GLM does not write that. It
 * writes the plain nesting a person would guess:
 *
 *     <read_file>
 *     <path>Assets/…/Utils.cs</path>
 *     <offset>245</offset>
 *     </read_file>
 *
 * Measured against the real repository: gemma's parser returns ZERO tool calls for that text, so the
 * raw XML was printed to the operator as if it were the answer, and the turn ended having read
 * nothing. Worse, a partially-recognised call trips the "declared no tools" recovery, which re-sends
 * the ENTIRE conversation — 16.8k tokens, ninety-one seconds on this hardware — to ask the model to
 * try again. Two of those in one run is the difference between an 8-second turn and a 2m20s one.
 *
 * SO THE MODEL IS TOLD ITS OWN SYNTAX, and the parser accepts it. Both halves are needed: pinning the
 * format without parsing it leaves the same leak, and parsing without pinning leaves the model free
 * to pick a third shape tomorrow.
 *
 * THE OUTER TAG IS VALIDATED, NOT TRUSTED. `<read_file>` and `<Component>` are the same shape, and a
 * reply that discusses XML must not execute it. A block counts as a tool call only when every child is
 * a simple `<name>value</name>` element and the outer name looks like a tool name — and anything
 * inside a fenced code block is skipped outright, because that is where quoted markup lives.
 */

import { XmlToolCallDialect } from './xml.js';
import type { ParseAllResult, ParsedToolCall } from '../types.js';

const TOOL_CALL_FORMAT = `Tool-call format — use EXACTLY this syntax, no variations:

<tool_name>
<param_name>value</param_name>
</tool_name>

Example — reading part of a file:

<read_file>
<path>src/thing.ts</path>
<offset>120</offset>
<limit>40</limit>
</read_file>

One parameter per line, value between the tags. Emit nothing else on those lines.

Chaining: several tool calls in one response run in order, each result fed back. Do not repeat the same call twice in one response.`;

/** A tool name: lowercase, underscores. Deliberately narrow — it is the guard against parsing prose. */
const TOOL_NAME = /^[a-z][a-z0-9_]{2,40}$/;

/** `<name>…</name>` where the body has at least one `<child>value</child>` and no nested markup. */
const BLOCK = /<([a-z][a-z0-9_]{2,40})>([\s\S]*?)<\/\1>/g;
const CHILD = /<([a-z][a-z0-9_]{0,40})>([\s\S]*?)<\/\1>/g;

/** Character ranges covered by fenced code blocks — quoted markup must never execute. */
function fencedRanges(raw: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /```[\s\S]*?```/g;
  for (let m = fence.exec(raw); m; m = fence.exec(raw)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

export class GlmDialect extends XmlToolCallDialect {
  readonly id = 'glm';

  /**
   * NATIVE TOOLS STAY ON, and this is a reversal worth recording.
   *
   * Ollama's own glm parser was seen returning `read_file` calls with EMPTY arguments — eight in one
   * run, each "missing path". Refusing native tools fixed that run and BROKE a worse thing: with the
   * catalogue moved into the prompt the model started narrating its plan and asking permission
   * instead of calling anything — "Please confirm this approach and proceed" — and repeated it
   * verbatim when told to go. Structured calls it must emit beat a format it may merely describe.
   *
   * So the empty-argument case is handled where it belongs: the parser below recovers the text form
   * when the native path yields nothing usable. One run is not evidence enough to change how a model
   * is driven; it is evidence enough to add a fallback.
   */
  matches(modelId: string): boolean { return /\bglm[-_.]?\d/i.test(modelId); }
  toolCallInstructions(): string { return TOOL_CALL_FORMAT; }

  parse(raw: string): ParseAllResult {
    // The inherited format first: a model told one syntax sometimes emits another, and a reply that
    // IS in the shared format must keep parsing exactly as it did before this dialect existed.
    const inherited = super.parse(raw);
    if (inherited.toolCalls.length > 0) return inherited;

    const fences = fencedRanges(raw);
    const inFence = (at: number): boolean => fences.some(([s, e]) => at >= s && at < e);

    const toolCalls: ParsedToolCall[] = [];
    let firstAt = -1;
    BLOCK.lastIndex = 0;
    for (let m = BLOCK.exec(raw); m; m = BLOCK.exec(raw)) {
      const [whole, name, body] = m;
      if (!TOOL_NAME.test(name) || inFence(m.index)) continue;

      const params: Record<string, string> = {};
      CHILD.lastIndex = 0;
      for (let c = CHILD.exec(body); c; c = CHILD.exec(body)) {
        params[c[1]] = c[2].trim();
      }
      // Every non-blank byte of the body must belong to a parameter. A block with prose in it is
      // someone talking about a tag, not calling a tool.
      if (Object.keys(params).length === 0) continue;
      const bodyChars = body.replace(/\s+/g, '').length;
      const paramChars = Object.entries(params).reduce((n, [k, v]) => n + (`<${k}>${v}</${k}>`).replace(/\s+/g, '').length, 0);
      if (bodyChars !== paramChars) continue;

      if (firstAt === -1) firstAt = m.index;
      toolCalls.push({ name, params });
      void whole;
    }

    if (toolCalls.length === 0) return inherited;
    return { text: raw.slice(0, firstAt).trim(), toolCalls };
  }

  renderToolCall(call: ParsedToolCall): string {
    const params = Object.entries(call.params).map(([k, v]) => `<${k}>${v}</${k}>`).join('\n');
    return `<${call.name}>\n${params}\n</${call.name}>`;
  }
}
