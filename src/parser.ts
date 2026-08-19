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

/**
 * THE `=` THE MODEL DROPPED.
 *
 * Observed in the wild, not imagined: glm-4.7-flash, session bdf1463c round 12, emitted
 *
 *     <function>bash>
 *     <parameter=command>
 *     find … -type d -name "*family*"
 *     </parameter>
 *     </function>
 *
 * where the form it was instructed in is `<function=bash>`. The scan below looks for the literal
 * `<function=`, so this matched nothing, the round produced no tool call, and the operator was shown a
 * hand-written tool call as though it were prose. Eleven calls in that same session parsed perfectly —
 * the drift happens mid-conversation, which is exactly why it cannot be left to the prompt to prevent.
 *
 * RECOGNISE GENEROUSLY, VERIFY STRICTLY — the same rule the final marker and the GLM envelope learned.
 * The repair fires only when the name looks like a tool name AND the block actually closes with
 * `</function>`, so a sentence containing an angle bracket is never promoted to a call.
 *
 * `<function>NAME>` and `<function=NAME>` are the SAME LENGTH, so this rewrite leaves every downstream
 * index untouched — the text/call split below slices on offsets into this string.
 */
/**
 * THE SHAPES MODELS ACTUALLY EMIT — counted in `~/.ayin-cli/sessions` before any of this was written:
 * 274 canonical openers, and three mangled families.
 *
 *   <function>NAME>            the `=` became `>`   (glm-4.7-flash, session bdf1463c round 12)
 *   <function/NAME>            the `=` became `/`
 *   <function>NAME</function>  a closed empty tag, parameters following it as bare tags
 *
 * The first version of this recognition REWROTE the reply, normalising every mangled opener to the
 * canonical one before scanning. That was wrong in a way worth remembering: a `write_file` whose
 * content DOCUMENTS the mangled shape had its content rewritten too, the documented example became a
 * second real tool call, and the write lost its body. Recognition must never mutate what the model
 * wrote — so the scan below finds openers positionally, skips anything inside a parameter value, and
 * leaves every byte of every value exactly as it arrived.
 */
export function parseResponseAll(input: string): ParseAllResult {
  const raw = input;
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
  //
  // A PARAMETER VALUE IS NOT A CALL SITE. write_file'\''s content is arbitrary text, and the moment ayin
  // learned to recognise mangled openers, a file DOCUMENTING one ("models sometimes emit
  // <function>read_file>…") parsed as a second call and the write lost its content. The value ranges are
  // computed first and every opener inside one is ignored — which also closes the same hole for the
  // canonical form, where it was always open.
  const valueRanges: Array<[number, number]> = [];
  {
    const open = /<parameter(?:=[a-zA-Z_][a-zA-Z0-9_]*|\s+name=["'][^"']+["'])>/g;
    for (let m = open.exec(raw); m; m = open.exec(raw)) {
      const from = m.index + m[0].length;
      const to = raw.indexOf('</parameter>', from);
      if (to === -1) break;
      valueRanges.push([from, to]);
      open.lastIndex = to;
    }
  }
  const insideValue = (at: number): boolean => valueRanges.some(([a, b]) => at >= a && at < b);

  const openers: Array<{ at: number; len: number; name: string }> = [];
  {
    // `=` is what the model was told to emit. `>` and `/` are what it emits when it drops the `=`;
    // both were counted in real sessions before being accepted here.
    const any = /<function(=|>|\/)([a-z][a-zA-Z0-9_.-]{2,40})>/g;
    for (let m = any.exec(raw); m; m = any.exec(raw)) {
      if (insideValue(m.index)) continue;
      if (m[1] !== '=') {
        // RECOGNISE GENEROUSLY, VERIFY STRICTLY. A repaired opener must close, and must carry
        // arguments — `<function>bash>` wrapped around a sentence is a model thinking in the shape of
        // a tag, and promoting it spends a round running `bash()` with nothing in it.
        const end = raw.indexOf('</function>', m.index);
        if (end === -1) continue;
        const body = raw.slice(m.index + m[0].length, end);
        if (!/<parameter[=\s]/.test(body) && !/<([a-z][a-z0-9_]*)>[\s\S]*?<\/\1>/.test(body)) continue;
      }
      openers.push({ at: m.index, len: m[0].length, name: m[2].trim() });
    }
  }
  /**
   * `<function>explore</function>` followed by bare parameter tags — the whole call turned inside out.
   * Strictest of the three: every non-blank byte between the close tag and the next opener must belong
   * to a complete `<key>…</key>` pair, or this is prose that happens to contain a tag.
   */
  {
    const closed = /<function>([a-z][a-z0-9_]{2,40})<\/function>/g;
    for (let m = closed.exec(raw); m; m = closed.exec(raw)) {
      if (insideValue(m.index)) continue;
      const from = m.index + m[0].length;
      const nextOpen = raw.indexOf('<function', from);
      const tail = raw.slice(from, nextOpen === -1 ? raw.length : nextOpen);
      const params: Record<string, string> = {};
      let accounted = 0;
      const pair = /<([a-z][a-z0-9_]*)>\n?([\s\S]*?)\n?<\/\1>/g;
      for (let p = pair.exec(tail); p; p = pair.exec(tail)) {
        params[p[1]] = unwrapValue(p[2]);
        accounted += p[0].replace(/\s+/g, '').length;
      }
      if (!Object.keys(params).length) continue;
      if (accounted !== tail.replace(/\s+/g, '').length) continue;
      openers.push({ at: m.index, len: m[0].length, name: m[1] });
      toolCalls.push({ name: m[1], params });
    }
    openers.sort((a, b) => a.at - b.at);
  }

  const funcStarts = openers.map((o) => o.at);

  for (let i = 0; i < openers.length; i++) {
    if (raw.startsWith(`<function>${openers[i].name}</function>`, openers[i].at)) continue; // handled above
    const start = openers[i].at;
    const nextStart = openers[i + 1]?.at ?? raw.length;
    const rest = raw.slice(start, nextStart);
    const closeIdx = rest.indexOf('</function>');
    const block = closeIdx !== -1 ? rest.slice(0, closeIdx + '</function>'.length) : rest;
    const name = openers[i].name;

    const params: Record<string, string> = {};
    // Format 1 (canonical): <parameter=key>value</parameter>
    // Key excludes `<` so we don't greedily eat a fused `<parameter=name</parameter>` form.
    const fmt1 = /<parameter=([a-zA-Z_][a-zA-Z0-9_]*)>\n?([\s\S]*?)\n?<\/parameter>/g;
    let m: RegExpExecArray | null;
    while ((m = fmt1.exec(block)) !== null) {
      params[m[1].trim()] = unwrapValue(m[2]);
    }
    // Format 2 (HTML attr): <parameter name="key">value</parameter>
    if (Object.keys(params).length === 0) {
      const fmt2 = /<parameter\s+name=["']([^"']+)["']>\n?([\s\S]*?)\n?<\/parameter>/g;
      while ((m = fmt2.exec(block)) !== null) {
        params[m[1].trim()] = unwrapValue(m[2]);
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
        params[key] = unwrapValue(raw);
      }
    }

    // Format 4 (bare child tags): <path>/tmp/x.cs</path> instead of <parameter=path>…</parameter>.
    // Seen alongside the mangled openers — a model that drops the `=` from <function=> drops it from
    // <parameter=> too, and the call then arrived with NO arguments at all, which is worse than not
    // parsing: read_file was invoked with an empty path instead of the path sitting right there.
    //
    // VERIFY STRICTLY. Every non-blank byte between the opener and </function> must belong to one of
    // these pairs, or this is prose that happens to contain a tag and running it would be running a
    // sentence. Same rule the GLM legacy shape already uses, for the same reason.
    if (Object.keys(params).length === 0) {
      const body = block.replace(/^<function(?:=|>|\/)[^\n>]+>?/, '').replace(/<\/function>\s*$/, '');
      const bare: Record<string, string> = {};
      const fmt4 = /<([a-z][a-z0-9_]*)>\n?([\s\S]*?)\n?<\/\1>/g;
      let b: RegExpExecArray | null;
      let accounted = 0;
      while ((b = fmt4.exec(body)) !== null) {
        bare[b[1].trim()] = unwrapValue(b[2]);
        accounted += b[0].replace(/\s+/g, '').length;
      }
      if (Object.keys(bare).length > 0 && accounted === body.replace(/\s+/g, '').length) {
        Object.assign(params, bare);
      }
    }

    toolCalls.push({ name, params });
  }

  // Leading text = everything before the first tool call of any format.
  const firstXmlIdx = funcStarts.length > 0 ? funcStarts[0] : -1;
  const cutPoints = [firstJsonIdx, firstXmlIdx].filter(i => i >= 0);
  const firstIdx = cutPoints.length > 0 ? Math.min(...cutPoints) : -1;
  // The trained Qwen3-Coder shape wraps calls in <tool_call>…</tool_call>, and the XML scan below keys
  // on `<function=`, so the opening wrapper tag falls on the TEXT side of the split. Strip the wrapper
  // tags from the prose rather than showing the user a message that ends in "<tool_call>".
  const text = (firstIdx >= 0 ? raw.slice(0, firstIdx) : raw).replace(/<\/?tool_call>/g, '').trim();

  return { text, toolCalls };
}

/**
 * Unwrap a parameter value. gemma4 (and some other models) nest the scalar inside a
 * `<value>…</value>` tag — `<parameter=path><value>.</value></parameter>` — which, left
 * as-is, reaches the tool as the literal string `<value>.</value>` and every path/pattern
 * fails. We only unwrap when the ENTIRE trimmed value is one `<value>…</value>`, so real
 * content that merely contains the word "value" is never touched.
 */
function unwrapValue(v: string): string {
  const s = v.trim();
  const m = s.match(/^<value>\n?([\s\S]*?)\n?<\/value>$/);
  return (m ? m[1] : s).trim();
}

export function parseResponse(raw: string): ParseResult {
  const all = parseResponseAll(raw);
  return { text: all.text, toolCall: all.toolCalls[0] ?? null };
}
