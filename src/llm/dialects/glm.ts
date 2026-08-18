/**
 * GLM dialect — the format the model was actually TRAINED on, not one inferred from a sample.
 *
 * WHAT WAS WRONG FIRST, because it matters more than the fix. No dialect claimed `glm-*`, so it fell to
 * the gemma default and every tool call was lost. One reply was observed emitting
 * `<read_file><path>…</path></read_file>`, and that shape was taught back to the model. It is not GLM's
 * format. It is GLM imitating an instruction badly — and a model writing a syntax it was never trained
 * on drops characters: a `//` comment marker arrived as `/`, and a long call arrived unterminated and
 * was printed to the operator as prose, with the file never edited.
 *
 * GLM-4.5 and 4.6 emit an XML envelope with the NAME on the opening line and alternating key/value tags
 * (zai-org/GLM-4.5 resources, and the llama.cpp parser written against them):
 *
 *     <tool_call>read_file
 *     <arg_key>path</arg_key>
 *     <arg_value>src/thing.ts</arg_value>
 *     </tool_call>
 *
 * The same specification describes a JSON compatibility form for runtimes whose template rewrites the
 * envelope — `<tool_call>{"name": …, "arguments": {…}}</tool_call>` — so both are parsed. The invented
 * shape is accepted too, because a build already shipped teaching it and a session mid-flight must not
 * have its next call dropped because ayin changed its mind.
 *
 * VALUES ARE ARBITRARY TEXT. `old_str` for a source edit carries braces, quotes, newlines and angle
 * brackets. Each tag is closed by its own partner and nothing else, so every scan is non-greedy per tag
 * and never matches across a value. A value that parses as JSON is taken as JSON, and kept as a raw
 * string when it does not — what the reference implementation does.
 *
 * A TRUNCATED CALL IS NOT AN ANSWER. A reply that opens a call and never closes it means the generation
 * was cut off. `truncated()` says so, so the caller can retry instead of printing half a tool call at
 * someone as though it were prose.
 */

import { XmlToolCallDialect } from './xml.js';
import type { ParseAllResult, ParsedToolCall } from '../types.js';

const TOOL_CALL_FORMAT = `Tool-call format — use EXACTLY this syntax:

<tool_call>tool_name
<arg_key>first_parameter</arg_key>
<arg_value>the value</arg_value>
<arg_key>second_parameter</arg_key>
<arg_value>the value</arg_value>
</tool_call>

The tool name goes on the same line as <tool_call>. One <arg_key> then one <arg_value> per parameter. A value may contain anything — code, braces, newlines, angle brackets — and ends only at </arg_value>.

Emit the whole call including the closing tag. Several calls in one reply run in order.`;

/** `<tool_call>NAME …` — the name is whatever follows the tag on that line. */
const CALL = /<tool_call>[ \t]*([A-Za-z_][A-Za-z0-9_.-]*)?[ \t]*\r?\n?([\s\S]*?)<\/tool_call>/g;
/** The pairs inside one call. Each tag closes itself, so a value carrying `<` is safe. */
const PAIR = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;

/** The shape an earlier ayin build taught this model: `<name><param>value</param></name>`. */
const LEGACY = /<([a-z][a-z0-9_]{2,40})>([\s\S]*?)<\/\1>/g;
const LEGACY_CHILD = /<([a-z][a-z0-9_]{0,40})>([\s\S]*?)<\/\1>/g;
const TOOL_NAME = /^[a-z][a-z0-9_]{2,40}$/;
const ENVELOPE = ['tool_call', 'arg_key', 'arg_value'];

function fencedRanges(raw: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /```[\s\S]*?```/g;
  for (let m = fence.exec(raw); m; m = fence.exec(raw)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

export class GlmDialect extends XmlToolCallDialect {
  readonly id = 'glm';
  matches(modelId: string): boolean { return /\bglm[-_.]?\d/i.test(modelId); }
  toolCallInstructions(): string { return TOOL_CALL_FORMAT; }

  /** True when the reply opens a call it never closed — a cut-off generation, not a refusal. */
  truncated(raw: string): boolean {
    const opens = (raw.match(/<tool_call>/g) ?? []).length;
    const closes = (raw.match(/<\/tool_call>/g) ?? []).length;
    if (opens > closes) return true;
    const openLegacy = [...raw.matchAll(/<([a-z][a-z0-9_]{2,40})>/g)].map((m) => m[1]);
    return openLegacy.some((n) => TOOL_NAME.test(n) && !ENVELOPE.includes(n) && !raw.includes(`</${n}>`));
  }

  parse(raw: string): ParseAllResult {
    const toolCalls: ParsedToolCall[] = [];
    let firstAt = -1;
    const mark = (at: number): void => { if (firstAt === -1 || at < firstAt) firstAt = at; };

    CALL.lastIndex = 0;
    for (let m = CALL.exec(raw); m; m = CALL.exec(raw)) {
      const [, name, inner] = m;
      const params: Record<string, string> = {};
      PAIR.lastIndex = 0;
      for (let p = PAIR.exec(inner); p; p = PAIR.exec(inner)) params[p[1].trim()] = p[2].trim();

      if (name) {
        mark(m.index);
        toolCalls.push({ name, params });
        continue;
      }
      try {
        const j = JSON.parse(inner.trim()) as { name?: string; arguments?: Record<string, unknown> };
        if (!j?.name) continue;
        const args: Record<string, string> = {};
        for (const [k, v] of Object.entries(j.arguments ?? {})) {
          args[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
        mark(m.index);
        toolCalls.push({ name: j.name, params: args });
      } catch { /* not the JSON form either — leave it as text */ }
    }
    if (toolCalls.length) return { text: raw.slice(0, firstAt).trim(), toolCalls };

    const inherited = super.parse(raw);
    if (inherited.toolCalls.length > 0) return inherited;

    const fences = fencedRanges(raw);
    const inFence = (at: number): boolean => fences.some(([s, e]) => at >= s && at < e);
    LEGACY.lastIndex = 0;
    for (let m = LEGACY.exec(raw); m; m = LEGACY.exec(raw)) {
      const [, name, inner] = m;
      if (!TOOL_NAME.test(name) || inFence(m.index) || ENVELOPE.includes(name)) continue;
      const params: Record<string, string> = {};
      LEGACY_CHILD.lastIndex = 0;
      for (let c = LEGACY_CHILD.exec(inner); c; c = LEGACY_CHILD.exec(inner)) params[c[1]] = c[2].trim();
      if (Object.keys(params).length === 0) continue;
      // Every non-blank byte of the body must belong to a parameter — otherwise this is prose that
      // happens to contain a tag, and running it would be running a sentence.
      const bodyChars = inner.replace(/\s+/g, '').length;
      const paramChars = Object.entries(params)
        .reduce((n, [k, v]) => n + `<${k}>${v}</${k}>`.replace(/\s+/g, '').length, 0);
      if (bodyChars !== paramChars) continue;
      mark(m.index);
      toolCalls.push({ name, params });
    }
    if (!toolCalls.length) return inherited;
    return { text: raw.slice(0, firstAt).trim(), toolCalls };
  }

  renderToolCall(call: ParsedToolCall): string {
    const pairs = Object.entries(call.params)
      .map(([k, v]) => `<arg_key>${k}</arg_key>\n<arg_value>${v}</arg_value>`)
      .join('\n');
    return `<tool_call>${call.name}\n${pairs}\n</tool_call>`;
  }
}
