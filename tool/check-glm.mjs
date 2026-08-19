#!/usr/bin/env node
/**
 * check-glm — the GLM dialect against the format GLM is actually TRAINED on.
 *
 * `npm run check:glm` (needs a build first). No LLM, no network: every string below is either taken
 * from `zai-org/GLM-4.7-Flash`'s own `chat_template.jinja` or from a real failure this repo hit.
 *
 * Two things this pins, both of which were WRONG in a shipped build:
 *
 *   1. `<arg_value>` decoding. The template renders arguments through `tojson`, so the trained format
 *      carries `"src/thing.ts"` with the quotes. Passed through, `read_file` opened nothing. Decoding
 *      is deliberately BOUNDED — a bare value that merely starts like JSON, and a quoted string with no
 *      escapes, are left byte-for-byte, because `str_replace` arguments are arbitrary source text and
 *      silently unquoting one edits a file to something subtly wrong.
 *   2. `truncated()`. It answered TRUE for `Dictionary<string, float>` in ordinary prose and for
 *      `List<string>` inside a fenced code block — so in a C# repo any answer mentioning a generic was
 *      read as a cut-off generation and cost a retry round, every time.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p'); // never open a TUI from a gate

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const { GlmDialect } = await import(`file://${join(ROOT, 'dist', 'llm', 'dialects', 'glm.js')}`);
const d = new GlmDialect();

// ── which models this dialect claims ─────────────────────────────────────────────

console.log('\nmodel matching');
ok(d.matches('glm-4.7-flash:q4_K_M'), 'claims glm-4.7-flash:q4_K_M — the tag on this box');
ok(d.matches('GLM-4.6'), 'claims GLM-4.6 (case-insensitive)');
ok(!d.matches('qwen3-coder:30b'), 'does not claim a qwen tag');

// ── the trained envelope, exactly as the template renders it ─────────────────────
//
// Name immediately after the tag, NO newline, key/value pairs with no separator, values tojson'd.

console.log('\nthe trained format');
const official = d.parse('<tool_call>read_file<arg_key>path</arg_key><arg_value>"src/thing.ts"</arg_value></tool_call>');
ok(official.toolCalls.length === 1, 'the template\'s own shape parses as one call');
ok(official.toolCalls[0]?.name === 'read_file', 'the name is read off the opening line');
ok(official.toolCalls[0]?.params.path === 'src/thing.ts',
  'a tojson-quoted string arrives WITHOUT the quotes — a path with quotes opens nothing',
  JSON.stringify(official.toolCalls[0]?.params.path));

const numbers = d.parse('<tool_call>read_file<arg_key>offset</arg_key><arg_value>240</arg_value><arg_key>tail</arg_key><arg_value>true</arg_value></tool_call>');
ok(numbers.toolCalls[0]?.params.offset === '240', 'a JSON number survives as its own text');
ok(numbers.toolCalls[0]?.params.tail === 'true', 'a JSON boolean survives as its own text');

const obj = d.parse('<tool_call>write_file<arg_key>meta</arg_key><arg_value>{"a":1}</arg_value></tool_call>');
ok(obj.toolCalls[0]?.params.meta === '{"a":1}', 'a JSON object is re-encoded, not mangled');

const escaped = d.parse('<tool_call>write_file<arg_key>content</arg_key><arg_value>"line1\\nline2"</arg_value></tool_call>');
ok(escaped.toolCalls[0]?.params.content === 'line1\nline2',
  'an ESCAPED quoted string is decoded — the escape is proof it was encoded');

// ── and the bare format ayin's own instructions ask for ──────────────────────────

console.log('\nthe format the prompt asks for (bare values)');
const bare = d.parse('<tool_call>read_file\n<arg_key>path</arg_key>\n<arg_value>src/thing.ts</arg_value>\n</tool_call>');
ok(bare.toolCalls[0]?.params.path === 'src/thing.ts', 'a bare value is untouched');

// THE ONE THAT MUST NOT REGRESS. Source text that begins and ends with a quote is ordinary; unquoting
// it would not fail loudly, it would write the wrong bytes into someone's file.
const codeish = d.parse('<tool_call>str_replace\n<arg_key>old_str</arg_key>\n<arg_value>"use strict"</arg_value>\n</tool_call>');
ok(codeish.toolCalls[0]?.params.old_str === '"use strict"',
  'a quoted value with NO escapes keeps its quotes — it is source text, not an encoding',
  JSON.stringify(codeish.toolCalls[0]?.params.old_str));

const braceish = d.parse('<tool_call>str_replace\n<arg_key>new_str</arg_key>\n<arg_value>{ not json, just code }</arg_value>\n</tool_call>');
ok(braceish.toolCalls[0]?.params.new_str === '{ not json, just code }',
  'a value that only LOOKS like JSON is passed through byte for byte');

// ── truncation: a cut-off call, and the prose that is not one ────────────────────

console.log('\ntruncation');
ok(d.truncated('<tool_call>read_file\n<arg_key>path</arg_key>\n<arg_value>a.cs'),
  'an unclosed <tool_call> IS a cut-off generation');
ok(d.truncated('<read_file>\n<path>a.cs'), 'an unclosed legacy call at line start IS truncation');
ok(!d.truncated('The field is a `Dictionary<string, float>` and a `List<int>` on line 42.'),
  'a C# generic in PROSE is not a truncated call — this cost a retry round on every mention');
ok(!d.truncated('```csharp\npublic List<string> Names;\n```\nThat is the declaration.'),
  'a generic inside a FENCE is not a truncated call either — parse() already excludes fences');
ok(!d.truncated('<tool_call>read_file<arg_key>path</arg_key><arg_value>"a.cs"</arg_value></tool_call>'),
  'a complete call is not truncated');

// ── what the model is shown when its call is echoed back ────────────────────────

console.log('\nrendering');
const rendered = d.renderToolCall({ name: 'read_file', params: { path: 'src/thing.ts' } });
ok(/^<tool_call>read_file/.test(rendered), 'the render puts the name on the opening line');
ok(rendered.includes('</tool_call>'), 'the render closes the envelope');
ok(d.parse(rendered).toolCalls[0]?.params.path === 'src/thing.ts',
  'render → parse round-trips (a rendered call must not decode into something else)');

console.log(fails ? `\nglm check: ${fails} FAILURE(S)\n` : '\nglm check: ok\n');
process.exit(fails ? 1 : 0);
