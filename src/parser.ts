/**
 * Parser — extract tool calls from model output.
 *
 * Canonical format (Qwen3 Coder):
 *   <function=name>
 *   <parameter=key>value</parameter>
 *   </function>
 *
 * Also handled (Gemma4 and other models):
 *   <parameter name="key">value</parameter>   ← HTML attribute style
 *   <parameter name='key'>value</parameter>
 *   {"name":"tool","arguments":{"key":"value"}} ← JSON inside <tool_call>
 *
 * Models may emit MULTIPLE tool calls per response (Gemma4 regularly chains
 * read → write → bash). parseResponseAll returns every call in order.
 * parseResponse remains for single-call callers (returns the first).
 */

export interface ParsedToolCall {
  name: string;
  params: Record<string, string>;
}

export interface ParseResult {
  text: string;
  toolCall: ParsedToolCall | null;
}

export interface ParseAllResult {
  text: string;
  toolCalls: ParsedToolCall[];
}

export function parseResponseAll(raw: string): ParseAllResult {
  const toolCalls: ParsedToolCall[] = [];

  // ── JSON tool calls: <tool_call>{...}</tool_call> (may repeat) ──
  const jsonRe = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let jm: RegExpExecArray | null;
  let firstJsonIdx = -1;
  while ((jm = jsonRe.exec(raw)) !== null) {
    try {
      const obj = JSON.parse(jm[1]);
      const name: string = obj.name ?? obj.function ?? '';
      if (!name) continue;
      const args = obj.arguments ?? obj.parameters ?? obj.params ?? {};
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(args)) params[k] = String(v);
      toolCalls.push({ name, params });
      if (firstJsonIdx === -1) firstJsonIdx = jm.index;
    } catch { /* ignore malformed JSON block, try next */ }
  }

  // ── XML tool calls: <function=name> ... </function> (may repeat) ──
  const funcStarts: number[] = [];
  for (let i = 0; ; ) {
    const idx = raw.indexOf('<function=', i);
    if (idx === -1) break;
    funcStarts.push(idx);
    i = idx + '<function='.length;
  }

  for (let i = 0; i < funcStarts.length; i++) {
    const start = funcStarts[i];
    const nextStart = funcStarts[i + 1] ?? raw.length;
    const rest = raw.slice(start, nextStart);
    const closeIdx = rest.indexOf('</function>');
    const block = closeIdx !== -1 ? rest.slice(0, closeIdx + '</function>'.length) : rest;

    const nameMatch = block.match(/^<function=([^\n>]+)>?/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    const params: Record<string, string> = {};
    // Format 1 (canonical): <parameter=key>value</parameter>
    // Key excludes `<` so we don't greedily eat a fused `<parameter=name</parameter>` form.
    const fmt1 = /<parameter=([a-zA-Z_][a-zA-Z0-9_]*)>\n?([\s\S]*?)\n?<\/parameter>/g;
    let m: RegExpExecArray | null;
    while ((m = fmt1.exec(block)) !== null) {
      params[m[1].trim()] = m[2].trim();
    }
    // Format 2 (HTML attr): <parameter name="key">value</parameter>
    if (Object.keys(params).length === 0) {
      const fmt2 = /<parameter\s+name=["']([^"']+)["']>\n?([\s\S]*?)\n?<\/parameter>/g;
      while ((m = fmt2.exec(block)) !== null) {
        params[m[1].trim()] = m[2].trim();
      }
    }
    // Format 3 (Gemma4 fused): <parameter=name</parameter>\n...VALUE... where
    // VALUE is either <parameter>...</parameter>, <parameter>\n...\n</parameter>,
    // or bare text running until the next <parameter= or </function>. The `<`
    // in <parameter=name</parameter> is ambiguously a close or a new open —
    // gemma fuses them. Only apply if the canonical parser missed params.
    if (Object.keys(params).length === 0) {
      const fmt3 = /<parameter=([a-zA-Z_][a-zA-Z0-9_]*)<\/parameter>\s*([\s\S]*?)(?=(?:<parameter=[a-zA-Z_])|(?:<\/function>)|$)/g;
      while ((m = fmt3.exec(block)) !== null) {
        const key = m[1].trim();
        let raw = m[2];
        // Strip a leading <parameter...>...</parameter> wrapper if present (value-only form)
        const wrap = raw.match(/^\s*<parameter[^>]*>\n?([\s\S]*?)\n?<\/parameter>\s*/);
        if (wrap) raw = wrap[1];
        else raw = raw.replace(/<\/?parameter[^>]*>/g, ''); // strip any stray tags
        params[key] = raw.trim();
      }
    }

    toolCalls.push({ name, params });
  }

  // Leading text = everything before the first tool call of any format.
  const firstXmlIdx = funcStarts.length > 0 ? funcStarts[0] : -1;
  const cutPoints = [firstJsonIdx, firstXmlIdx].filter(i => i >= 0);
  const firstIdx = cutPoints.length > 0 ? Math.min(...cutPoints) : -1;
  const text = firstIdx >= 0 ? raw.slice(0, firstIdx).trim() : raw.trim();

  return { text, toolCalls };
}

export function parseResponse(raw: string): ParseResult {
  const all = parseResponseAll(raw);
  return { text: all.text, toolCall: all.toolCalls[0] ?? null };
}
