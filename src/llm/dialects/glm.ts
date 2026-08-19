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

/**
 * Parameters whose value is VERBATIM TEXT — source code, a file body, a replacement string.
 *
 * The distinction matters because unquoting is safe for one kind of argument and destructive for the
 * other, and the parameter NAME is the only signal available here (a dialect has no tool schema).
 * `path` cannot want its quotes; `old_str` routinely can — `"use strict"`, a quoted CSS value, a JSON
 * fixture. Stripping those would not fail loudly, it would write subtly wrong bytes into a file, which
 * is the worst outcome available in this file.
 */
const VERBATIM_PARAMS = new Set(['old_str', 'new_str', 'content', 'text', 'body', 'patch', 'code', 'replacement', 'command']);

/**
 * WHAT AN `<arg_value>` ACTUALLY CONTAINS — and why the rule differs per parameter.
 *
 * GLM-4.7-Flash's own `chat_template.jinja` renders every argument through `tojson`, so the format the
 * model was TRAINED on carries `<arg_value>"src/thing.ts"</arg_value>` — quotes included, numbers bare,
 * objects as JSON. Handed through as-is, `read_file` gets a path with literal quotes and opens nothing.
 * Meanwhile `toolCallInstructions()` asks for BARE values, and in prompt mode the model complies. Both
 * shapes are real, and one rule cannot serve both blindly:
 *
 *   - Non-string JSON (number, boolean, null, object, array) → decoded, always. Unambiguous: no bare
 *     value looks like `{"a":1}` by accident, and a tool wanting `240` cannot want `"240"`.
 *   - A quoted string in a STRUCTURAL parameter (`path`, `pattern`, anything not in VERBATIM_PARAMS)
 *     → unquoted. A quoted path is never what was meant; it is the trained encoding.
 *   - A quoted string in a VERBATIM parameter → unquoted ONLY when it carries a JSON escape
 *     (`\n`, `\"`, `\\`, `\uXXXX`). An escape is proof of encoding — and it is exactly the case that
 *     matters there, since a tojson'd file body arrives with its newlines escaped.
 *   - Anything that merely LOOKS like JSON but does not parse → passed through byte for byte.
 *
 * In native mode none of this runs: Ollama's own glm parser consumes the call and hands over decoded
 * `arguments`. This is the prompt-mode path, where ayin owns the parse.
 */
export function decodeArgValue(raw: string, key = ''): string {
  const t = raw.trim();
  if (!t) return t;
  const starts = t[0];
  const looksJson = starts === '"' || starts === '{' || starts === '[' || t === 'true' || t === 'false' || t === 'null' || /^-?\d/.test(t);
  if (!looksJson) return t;
  let parsed: unknown;
  try { parsed = JSON.parse(t); } catch { return t; } // starts like JSON, is not JSON — a bare value
  if (typeof parsed !== 'string') return typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed);
  if (!VERBATIM_PARAMS.has(key.trim())) return parsed; // a quoted path is an encoding, never a value
  return /\\[nrt"\\u/]/.test(t) ? parsed : t;
}

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
  /**
   * GLM CANNOT DO PROMPT MODE AT ALL, and the reason is the tokenizer, not the prompt.
   *
   * `<tool_call>`, `<arg_key>` and `<arg_value>` are SPECIAL TOKENS in this family's vocabulary. The
   * runtime strips special tokens from the text it returns, and with no `tools` array declared there is
   * no parser to collect them either — so the call is not mangled, it is DELETED. Measured through the
   * gateway on glm-4.7-flash:q4_K_M, three runs: `evalTokens=13, thinkingChars=0, content=""` — the
   * model spoke thirteen tokens and every field came back blank. A fourth run leaked the tail of one
   * call as text (`…</arg_value>\n</tool_call>`), which is the same thing seen from the other side: the
   * opening tokens were consumed, the plain-text remainder was not.
   *
   * The agent's own report of that: "Tool calls: 0 · No evidence gathered — nothing was read", after a
   * task whose first step was to read one file. Nothing in a prompt can fix a token that is removed
   * before the text exists, so the schemas must go to the runtime. Same conclusion the qwen3.5 parser
   * forced (see qwen.ts) — different mechanism, identical remedy.
   */
  readonly requiresNativeTools = true;
  matches(modelId: string): boolean { return /\bglm[-_.]?\d/i.test(modelId); }
  toolCallInstructions(): string { return TOOL_CALL_FORMAT; }

  /**
   * True when the reply opens a call it never closed — a cut-off generation, not a refusal.
   *
   * THE LEGACY SCAN HAS TO BE NARROW, because the shape it looks for (`<word>`) is also ordinary prose
   * in half the languages this agent reads. Measured against the shipped parser: `Dictionary<string,
   * float>` in a sentence returned TRUE, and so did `public List<string> Names;` inside a fenced code
   * block — so in a C# repo any answer that mentioned a generic was classified as a truncated
   * generation and cost a retry round. Two conditions fix it without weakening the real case:
   *
   *   - FENCES ARE EXCLUDED, exactly as `parse()` already excludes them. Code the model is showing you
   *     is not code the model is calling.
   *   - THE OPENER MUST START A LINE. A tool call is emitted at the start of a line; a generic
   *     parameter appears mid-sentence, after a word or an identifier.
   *
   * The `<tool_call>` count above is untouched: that tag is unambiguous, and an unbalanced one is a
   * cut-off call whether it sits in a fence or not.
   */
  truncated(raw: string): boolean {
    const opens = (raw.match(/<tool_call>/g) ?? []).length;
    const closes = (raw.match(/<\/tool_call>/g) ?? []).length;
    if (opens > closes) return true;
    const fences = fencedRanges(raw);
    const inFence = (at: number): boolean => fences.some(([a, b]) => at >= a && at < b);
    for (const m of raw.matchAll(/^[ \t]*<([a-z][a-z0-9_]{2,40})>/gm)) {
      const name = m[1];
      if (inFence(m.index ?? 0)) continue;
      if (!TOOL_NAME.test(name) || ENVELOPE.includes(name)) continue;
      if (!raw.includes(`</${name}>`)) return true;
    }
    return false;
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
      for (let p = PAIR.exec(inner); p; p = PAIR.exec(inner)) params[p[1].trim()] = decodeArgValue(p[2], p[1]);

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
