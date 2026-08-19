#!/usr/bin/env node
/**
 * check-parser — the tool-call shapes models ACTUALLY emit, not the one they were told to.
 *
 * `npm run check:parser` (needs a build first). No LLM, no network.
 *
 * WHY IT EXISTS. On 2026-08-18 the first request of a fresh session on the nuk ended with this printed
 * into the chat as prose, having done nothing:
 *
 *     I'll search for the family dashboard project…
 *     <function>bash>
 *     <parameter=command>
 *     find /home/… -type d -name "*family*"
 *     </parameter>
 *     </function>
 *
 * The model dropped the `=` from `<function=bash>`. The scanner looks for the literal string
 * `<function=`, matched nothing, and the round was recorded `"why": "no tool call and no final marker"`.
 * Eleven calls earlier in that same session parsed perfectly — the drift arrives mid-conversation, so no
 * amount of prompt wording prevents it and only the parser can.
 *
 * (Paths redacted — this repo is public. Everything else is byte-for-byte the session record.)
 *
 * Counted before fixing, across 505 session files: 274 canonical openers and three mangled families,
 * each of which is a case below. Every string here is verbatim from a real session record.
 *
 * RECOGNISE GENEROUSLY, VERIFY STRICTLY. The last two cases are the ones that matter most: prose that
 * merely contains a tag must never become an executable call, and a name that does not look like a tool
 * name is not one. A parser that guesses runs `bash` on a sentence.
 */

const DIST = new URL('../dist/', import.meta.url).pathname;
const { GlmDialect } = await import(`${DIST}llm/dialects/glm.js`);
const { QwenDialect } = await import(`${DIST}llm/dialects/qwen.js`);
const { GemmaDialect } = await import(`${DIST}llm/dialects/gemma.js`).catch(() => ({ GemmaDialect: null }));

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

/** Verbatim from session bdf1463c, round 12 — the reply that started all of this. */
const SESSION_BDF1463C = "I'll search for the family dashboard project with missile alarm map, walled display, and Tapo connection.\n\n<function>bash>\n<parameter=command>\nfind /home/you -type d -name \"*family*\" 2>/dev/null\n</parameter>\n</function>";

const CALLS = [
  ['canonical <function=name>', '<function=bash>\n<parameter=command>\nls\n</parameter>\n</function>', 'bash', { command: 'ls' }],
  ['the = became > (session bdf1463c)', SESSION_BDF1463C, 'bash', { command: 'find /home/you -type d -name "*family*" 2>/dev/null' }],
  ['the = became > with bare child tags', '<function>read_file>\n<path>/tmp/x.cs</path>\n</function>', 'read_file', { path: '/tmp/x.cs' }],
  ['the = became /', '<function/read_file>\n<parameter=path>\n/tmp/x.cs\n</parameter>\n</function>', 'read_file', { path: '/tmp/x.cs' }],
  ['a closed empty tag, parameters after it', '<function>explore</function>\n<question>popup rules</question>', 'explore', { question: 'popup rules' }],
];

const NOT_CALLS = [
  ['prose containing an opener but never closing', 'the <function>bash> idea is bad and there is no closing tag here'],
  ['a name that is not a tool name shape', '<function>B</function>\n<x>1</x>'],
  ['a tag in prose with words around it inside the block', '<function>bash>\nI think we should run something here\n</function>'],
];

for (const D of [GlmDialect, QwenDialect, GemmaDialect].filter(Boolean)) {
  const d = new D();
  console.log(`\n${d.id}: every shape a model has actually emitted`);
  for (const [label, text, name, params] of CALLS) {
    const r = d.parse(text);
    const got = r.toolCalls[0];
    ok(r.toolCalls.length === 1 && got.name === name && JSON.stringify(got.params) === JSON.stringify(params),
      `${label} → ${name}(${Object.keys(params).join(',')})${got ? '' : ' — GOT NOTHING'}`);
  }
  console.log(`${d.id}: and nothing a model merely wrote about`);
  for (const [label, text] of NOT_CALLS) {
    ok(d.parse(text).toolCalls.length === 0, label);
  }
  // The prose half of a repaired reply must survive: the operator still reads what the model said.
  const r = d.parse(SESSION_BDF1463C);
  ok(r.text.startsWith("I'll search for the family dashboard"), `${d.id}: the sentence before the call is still shown to the operator`);
}


/**
 * THE ONE THAT CAUGHT A REGRESSION IN THIS VERY FIX.
 *
 * The first attempt at recognising mangled openers REWROTE the reply before scanning it. A write_file
 * whose content documents the mangled shape — ayin's own docs and this gate both do — then had its
 * content rewritten too: the documented example became a second, real tool call and the write lost its
 * body. Recognition must never mutate what the model wrote.
 */
console.log('\na documented call inside a parameter value is text, not a call');
{
  const { parseResponseAll } = await import(`${DIST}parser.js`);
  const documented = '<function>read_file>\n<parameter=path>\n/tmp/x.cs\n</parameter>\n</function>';
  const reply = '<function=write_file>\n<parameter=path>\n/tmp/doc.md\n</parameter>\n<parameter=content>\n'
    + documented + '\n</parameter>\n</function>';
  const r = parseResponseAll(reply);
  ok(r.toolCalls.length === 1, `exactly one call, not one per documented example (got ${r.toolCalls.length})`);
  ok(r.toolCalls[0]?.name === 'write_file', 'and it is the call the model actually made');
  ok(!r.toolCalls.some((c) => c.name === 'read_file'), 'the example in the content did NOT become a call');
  const content = r.toolCalls[0]?.params?.content ?? '';
  ok(content.startsWith('<function>read_file>'),
    'and the value reaches the tool with its mangled text intact — never normalised on the way through');
}


/**
 * THE CAUSE, not the symptom. In native mode the runtime parses a structured call and this loop used to
 * write it back into the conversation window as ayin XML — so a model that never emitted a tag read its
 * own turns written in one, eleven times, and then imitated it badly. Everything above is the backstop
 * for when a model emits text anyway; this is the assertion that stops ayin TEACHING it to.
 */
console.log("\nnative mode does not write tool-call syntax into the transcript");
{
  const { readFileSync } = await import("node:fs");
  const agent = readFileSync(new URL("../src/agent.ts", import.meta.url).pathname, "utf-8");
  ok(/const nativeMode = toolMode\(\) === .native.;/.test(agent), "the loop asks which mode it is in");
  // The assistant turn must carry ONLY what the model said. Two shapes were tried in one evening and
  // both were imitated back: ayin XML (<function>bash>) and a neutral [called read_file(...)] line,
  // the latter copied verbatim including its truncation. Anything describing a call is a worked example.
  ok(/if \(nativeMode\) \{\s*\n\s*if \(textPrefix\) pushToWindow\(.assistant., textPrefix\);/.test(agent),
    "and in native mode the assistant turn holds only the model's own prose — nothing to copy");
  ok(!/nativeMode[\s\S]{0,120}\[called /.test(agent), "no call description in the assistant turn, in any shape");
  ok(/const resultHead = nativeMode/.test(agent), "the RESULT names the call instead — user-role text is read, not imitated");
  ok(/const callXml = renderToolCall\(\{ name, params \}\)/.test(agent), "while prompt mode still sees its own transcript verbatim");
}

console.log(failures ? `\nparser check: ${failures} FAILED` : '\nparser check: ok');
process.exit(failures ? 1 : 0);
