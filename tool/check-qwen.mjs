#!/usr/bin/env node
/**
 * check-qwen — the Qwen dialect, and the reasoning channel it leaks into `content`.
 *
 * `npm run check:qwen` (needs a build first). No LLM, no network: every string below is either the
 * shape of a real leaked reply or a shape that MUST survive untouched.
 *
 * What this pins, and why each half matters:
 *
 *   1. The strip fires on what was actually observed — a `qwen3.8` class model opening a reply with a
 *      bare `[thinking]` line and never closing it, with the runtime already told `think: false`.
 *      Replies like it reached a user and were persisted into a conversation history.
 *   2. The strip does NOT fire on prose that mentions the word, on a fenced log excerpt quoting the
 *      header, or on a tool call. Over-stripping eats a real answer, which is the worse failure of
 *      the two — so the negative cases outnumber the positive ones here on purpose.
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

const { QwenDialect } = await import(`file://${join(ROOT, 'dist', 'llm', 'dialects', 'qwen.js')}`);
const d = new QwenDialect();

// ── which models this dialect claims ─────────────────────────────────────────────

console.log('\nmodel matching');
ok(d.matches('qwen3.8:27b'), 'claims qwen3.8:27b — the tag on the card today');
ok(d.matches('qwen3-coder:30b'), 'claims qwen3-coder:30b');
ok(!d.matches('gemma4:26b'), 'does not claim a gemma tag');
ok(!d.matches('glm-4.7-flash:q4_K_M'), 'does not claim a glm tag');

// ── native tools: only the parsers that destroy the tool name ────────────────────
//
// This must NOT cover the whole family. Older qwen parsers keep working in prompt mode, and
// declaring schemas for them buys a round trip nobody needed.

console.log('\nnative-tool requirement');
d.matches('qwen3.8:27b');
ok(d.requiresNativeTools, 'qwen3.8 requires native tools (its parser eats <function=NAME>)');
d.matches('qwen3-coder:30b');
ok(!d.requiresNativeTools, 'qwen3-coder does NOT — it has the len(tools)==0 guard');

// ── the leak, exactly as it arrived ──────────────────────────────────────────────

console.log('\nreasoning channel — it must go');

// The shape of a captured reply: 100% monologue, no answer after it, and no closing marker anywhere.
const OBSERVED = `[thinking]
The user is correcting me - I got the device wrong. Let me look at the photo again...

So they have decorated it themselves. That is worth acknowledging.

Let me reply in their language and own the mistake.`;
ok(d.stripReasoning(OBSERVED) === '',
  'the captured qwen3.8 reply strips to nothing — it contained no answer');

ok(d.stripReasoning('[thinking]\nreasoning here\n') === '',
  'a bare [thinking] header on its own line opens a block that never closes');
ok(d.stripReasoning('[ thinking ]\nreasoning here') === '',
  'spacing inside the brackets is still the header');
ok(d.stripReasoning('Answer first.\n[thinking]\nthen it wandered off') === 'Answer first.',
  'text BEFORE the header is the answer and is kept');
ok(d.stripReasoning('<think>weighing it up</think>The answer is 42.') === 'The answer is 42.',
  'a well-formed <think> block is removed, the answer kept');
ok(d.stripReasoning('<thinking>hmm</thinking>\n\nDone.') === 'Done.',
  '<thinking> is the same shape');
ok(d.stripReasoning('Some answer.\n<think>and then it kept going') === 'Some answer.',
  'an UNCLOSED <think> takes everything after it — the generation never came back');

// ── what must survive byte-for-byte ──────────────────────────────────────────────
//
// A false positive here silently deletes a real answer, which is strictly worse than the leak.

console.log('\nprose and calls must survive');
const MENTIONS = 'The log line is [thinking] and it means the channel leaked — grep for it.';
ok(d.stripReasoning(MENTIONS) === MENTIONS,
  '[thinking] INSIDE a sentence is prose, not a header');

const CALL = '<function=read_file>\n<parameter=path>\nsrc/thing.ts\n</parameter>\n</function>';
ok(d.stripReasoning(CALL) === CALL, 'a tool call is untouched');
ok(d.parse(d.stripReasoning(CALL)).toolCalls[0]?.params.path === 'src/thing.ts',
  'strip → parse still yields the call (the strip must not break the tool path)');

// A JSON reply is data, and several callers (explore, indulge, QA judges, plan) parse it. A reply
// that MENTIONS a tag — which is exactly what a note about this bug looks like — must not be
// truncated from the tag to the end and handed back as a syntax error.
const JSON_MENTION = JSON.stringify({ verdict: 'fail', note: 'the model emitted <think> tags' });
ok(d.stripReasoning(JSON_MENTION) === JSON_MENTION, 'a JSON reply quoting <think> is untouched');
ok(JSON.parse(d.stripReasoning(JSON_MENTION)).note.includes('<think>'), 'and it still parses');
const JSON_ARR = JSON.stringify(['thinking', 'about', 'it']);
ok(d.stripReasoning(JSON_ARR) === JSON_ARR, 'a JSON array is untouched');
ok(d.stripReasoning('[thinking]') === '', 'a bare [thinking] is NOT valid JSON and is still stripped');

// A fenced excerpt is documentation, not a leak — the same rule unexecutedCallText already applies.
const FENCED = 'Here is the leak:\n\n```\n[thinking]\nthe monologue\n```\n\nThat is what to grep for.';
ok(d.stripReasoning(FENCED) === FENCED, 'a fenced [thinking] excerpt is untouched, answer intact');
const FENCED_TAG = 'It looks like:\n\n```\n<think>reasoning\n```\n\nStrip it in the dialect.';
ok(d.stripReasoning(FENCED_TAG) === FENCED_TAG, 'a fenced <think> excerpt is untouched');

const PLAIN = 'The second train catches the first at 6:00 PM.';
ok(d.stripReasoning(PLAIN) === PLAIN, 'an ordinary answer is untouched');
ok(d.stripReasoning('') === '', 'empty in, empty out');

// A reply that leaks AND then calls a tool: the call must survive the strip.
const LEAK_THEN_CALL = `[thinking]
I should read the file first.`;
ok(d.stripReasoning(`Reading it now.\n${LEAK_THEN_CALL}`) === 'Reading it now.',
  'prose kept, trailing monologue dropped');

// ── the round trip the dialect already owed ──────────────────────────────────────

console.log('\nrendering');
const rendered = d.renderToolCall({ name: 'read_file', params: { path: 'src/thing.ts' } });
ok(d.parse(rendered).toolCalls[0]?.params.path === 'src/thing.ts',
  'render → parse round-trips');

console.log(fails ? `\nqwen check: ${fails} FAILURE(S)\n` : '\nqwen check: ok\n');
process.exit(fails ? 1 : 0);
