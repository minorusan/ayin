/**
 * Muse Glimmer — the ATEM tool-call dialect.
 *
 * Glimmer speaks none of the three formats ayin already knew. Its calls look like this:
 *
 *     <atem:function_calls>
 *     <atem:invoke name="read_file">
 *     <atem:parameter name="path">src/main.ts</atem:parameter>
 *     </atem:invoke>
 *     </atem:function_calls>
 *
 * and its turns are routed with a channel header — ` to=user<|message|>…` for an answer,
 * ` to=<tool><|message|>…` for a call — closed by `<|eot|>` or `<|eom|>`.
 *
 * NOT GUESSED. Every token here is taken from Ollama 0.32's own reference implementation
 * (`model/parsers/glimmer.go`, `model/renderers/glimmer.go`) rather than from a blog post or a
 * sample reply: a dialect inferred from one observed output is a dialect that breaks on the second.
 * The instruction text below is deliberately near-verbatim from the renderer, because that is the
 * wording the model was trained against — paraphrasing it is a silent quality regression.
 *
 * WHY AYIN NEEDS THIS AT ALL, when Ollama can parse Glimmer itself. Two paths reach the model and
 * only one of them declares tools to the runtime:
 *
 *   - `providers/ollama.ts` sends a `tools` array → Ollama's own parser extracts the calls and ayin
 *     never sees ATEM (`toolMode: 'native'`). This dialect is unused there.
 *   - the RESOURCE gateway forwards messages with NO tools array, because ayin declares its tools in
 *     the prompt. `glimmer.go` bails out of tool extraction on `len(p.tools) == 0`, so the ATEM
 *     markup survives into the reply text — and something has to read it. That something is here.
 *
 * Without it Glimmer resolves to the gemma DEFAULT, gets taught gemma's XML in prose, and its real
 * calls parse to nothing — the exact silent failure that cost a day on qwen3-coder.
 */

import type { ModelDialect, ParseAllResult, ParsedToolCall } from '../types.js';

/**
 * Near-verbatim from `renderers/glimmer.go`. The trailing note about invalid XML is load-bearing:
 * it is why a regex parser is correct here, and why a value may contain `<` without escaping.
 */
const TOOL_CALL_FORMAT = `You can invoke a function by writing a "<atem:function_calls>" block like the following:
<atem:function_calls>
<atem:invoke name="$FUNCTION_NAME">
<atem:parameter name="$PARAMETER_NAME">$PARAMETER_VALUE</atem:parameter>
...
</atem:invoke>
</atem:function_calls>

String and scalar parameters should be specified as is, while lists and objects should use JSON format. Note that spaces for string values are not stripped. The output is not expected to be valid XML and is parsed with regular expressions.

Several invokes may appear in one block; each runs in order and its result comes back inside <tool_output>…</tool_output>.`;

/** `<atem:invoke name="x">` … `</atem:invoke>` — one per call, several per block. */
const INVOKE_RE = /<atem:invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/atem:invoke>/g;
/** `<atem:parameter name="k">v</atem:parameter>` — v may contain `<`, so the close tag terminates. */
const PARAM_RE = /<atem:parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/atem:parameter>/g;
/**
 * The channel header. Ollama's parser normally consumes it, but it survives whenever the runtime
 * did not parse the turn — which is precisely the path this dialect exists for.
 */
const ROUTE_RE = /^\s*to=[^\s<]*\s*<\|message\|>/;
/** Control tokens that must never reach the user or a tool argument. */
const CONTROL_RE = /<\|(?:start|message|eot|eom|channel|end)\|>/g;

/**
 * `example_tool.example_function` → `example_function`.
 *
 * Glimmer is trained to namespace a call when its tool set is namespaced, and its own renderer says
 * to invoke bare when it is not. ayin's tool names are GLOBALLY UNIQUE by construction (the registry
 * hard-errors on a duplicate at boot), so the last dotted segment is the tool — and mirroring
 * `glimmerResolveToolName`'s suffix fallback means a namespaced call still lands.
 */
function bareToolName(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1) : name;
}

export class GlimmerDialect implements ModelDialect {
  readonly id = 'glimmer';

  matches(modelId: string): boolean {
    return /muse|glimmer/i.test(modelId);
  }

  toolCallInstructions(): string {
    return TOOL_CALL_FORMAT;
  }

  parse(raw: string): ParseAllResult {
    const toolCalls: ParsedToolCall[] = [];
    let firstAt = -1;

    INVOKE_RE.lastIndex = 0;
    for (let m = INVOKE_RE.exec(raw); m !== null; m = INVOKE_RE.exec(raw)) {
      const name = bareToolName(m[1].trim());
      if (!name) continue;
      const params: Record<string, string> = {};
      PARAM_RE.lastIndex = 0;
      for (let p = PARAM_RE.exec(m[2]); p !== null; p = PARAM_RE.exec(m[2])) {
        // Only the ONE trailing newline the format adds is removed. The renderer states that spaces
        // in string values are not stripped, and a tool argument is data — trimming it would quietly
        // corrupt an `old_str` whose leading indentation is the whole point.
        params[p[1].trim()] = p[2].replace(/^\n/, '').replace(/\n$/, '');
      }
      toolCalls.push({ name, params });
      if (firstAt < 0) {
        // Text before the WRAPPER, not before the invoke — the `<atem:function_calls>` opener would
        // otherwise be shown to the user as the tail of the model's prose.
        const wrapper = raw.lastIndexOf('<atem:function_calls>', m.index);
        firstAt = wrapper >= 0 ? wrapper : m.index;
      }
    }

    const head = firstAt >= 0 ? raw.slice(0, firstAt) : raw;
    const text = head.replace(ROUTE_RE, '').replace(CONTROL_RE, '').trim();
    return { text, toolCalls };
  }

  renderToolCall(call: ParsedToolCall): string {
    const params = Object.entries(call.params)
      .map(([k, v]) => `<atem:parameter name="${k}">${v}</atem:parameter>`)
      .join('\n');
    return `<atem:function_calls>\n<atem:invoke name="${call.name}">\n${params}\n</atem:invoke>\n</atem:function_calls>`;
  }

  /**
   * `<tool_output>` — what `renderers/glimmer.go` writes for a tool turn.
   *
   * The renderer includes a `name` attribute; this interface is handed only a body, and inventing a
   * name would be worse than omitting one — the parser reads these with regular expressions and the
   * attribute is informational.
   */
  renderToolResult(body: string): string {
    return `<tool_output>\n${body}\n</tool_output>`;
  }
}
