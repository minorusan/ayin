#!/usr/bin/env node
/**
 * check-cost — every message shows what it cost, and the number is the SERVER'S, never an estimate.
 *
 * `npm run check:cost` (needs a build). No model, no network: the arithmetic is a pure function and the
 * rest is asserted against the source that renders it.
 *
 * WHAT THIS PREVENTS. A tokenizer-free guess (characters ÷ 4) shown as a token count is a lie in a
 * precise-looking dress, and every runtime already sends the real number — Ollama's `prompt_eval_count`
 * and `eval_count`, OpenAI's `usage`. ayin parsed them away at four places. So: the counts come from the
 * provider, the tool-result price is a SUBTRACTION OF EXACT NUMBERS (`in(n) − in(n−1) − out(n−1)`), and
 * where neither is available nothing is printed — "not reported" must stay distinguishable from zero.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};
const src = (rel) => readFileSync(join(ROOT, rel), 'utf-8');

const { computeUsage } = await import(`file://${join(ROOT, 'dist', 'llm', 'manager.js')}`);

// ── the arithmetic ───────────────────────────────────────────────────────────────

console.log('\nwhat a tool result cost, measured rather than estimated');
const round = (n) => `round ${n} · a-model`;
const first = computeUsage(null, { in: 6600, out: 24 }, round(1));
ok(first.growth === null, 'the first call of a turn has nothing to subtract from', String(first.growth));
ok(first.main === true && first.in === 6600 && first.out === 24, 'and reports the call itself exactly');
const second = computeUsage({ in: 6600, out: 24 }, { in: 8900, out: 41 }, round(2));
ok(second.growth === 8900 - 6600 - 24,
  'the next round prices the tool result: in(n) − in(n−1) − out(n−1) — the reply is subtracted because it is known exactly',
  String(second.growth));
ok(computeUsage({ in: 9000, out: 10 }, { in: 4000, out: 5 }, round(3)).growth === null,
  'a SHRUNK prompt (trimmed or compacted window) reports nothing — the subtraction no longer describes an addition');
ok(computeUsage({ in: 100, out: 0 }, { in: 100, out: 0 }, round(4)).growth === 0,
  'and a round that added nothing is 0, which is a measurement, not a missing one');

console.log('\na sub-call is not a round');
const sub = computeUsage({ in: 6600, out: 24 }, { in: 300, out: 12 }, 'sub-call');
ok(sub.main === false, 'a connector loop, the critic, explore, a QA pass — none of them is a turn round');
ok(sub.growth === null, 'so it prices nothing: its prompt is its own, not this turn"s plus a tool result');
ok(src('src/llm/manager.ts').includes('if (usage.main) _prev'),
  'and it never becomes the baseline — otherwise the next round subtracts two unrelated prompts');

// ── the counts come from the server, at every provider ──────────────────────────

console.log('\nfour providers, four places the number was being dropped');
ok(/prompt_eval_count/.test(src('src/llm/providers/ollama.ts')) && /eval_count/.test(src('src/llm/providers/ollama.ts')),
  'ollama (native) reads both counts off the reply it already parses');
ok(/onUsage/.test(src('src/llm/providers/direct.ts')), 'the HTTP contract provider takes them from the transport');
ok(/onUsage/.test(src('src/llm/providers/resource.ts')), 'and so does the gateway provider on its native-tools path');
ok(/completion\.usage/.test(src('src/llm/providers/openai.ts')) && /TokenUsage/.test(src('src/llm/providers/openai.ts')),
  'openai returns the usage it was already only LOGGING — the operator paying per token is the one who needs it');
ok(/promptTokens/.test(src('src/connection.ts')) && /evalTokens/.test(src('src/connection.ts')),
  'the shared transport parses the fields the gateway now sends');
ok(!/length\s*\/\s*4|chars\s*\/\s*4/.test(src('src/ui/index.ts')),
  'and NOTHING divides characters by four to invent a token count');

// ── where the label lands ───────────────────────────────────────────────────────

console.log('\nwhere the price is printed');
const chat = src('src/ui/widgets/chat.ts');
ok(/private pendingCost/.test(chat),
  'the price waits for the message it produced — usage arrives BEFORE the reply is parsed, so walking backwards found the previous round');
ok(/role === 'tool' && !startsToolCard\(content\)/.test(chat),
  'a tool card is priced on its RESULT, not between its header and its body');
ok(/into the prompt/.test(src('src/ui/index.ts')), 'a tool result says what it will cost every round after it');
ok(/if \(!usage\.main\) return;/.test(src('src/ui/index.ts')),
  'a sub-call prints no label — it prints no message either, so the label would land on someone else"s');
ok(/if \(msg\.cost\)/.test(chat), 'a message with no reported cost prints no line at all');

console.log(fails ? `\ncost check: ${fails} FAILURE(S)\n` : '\ncost check: ok\n');
process.exit(fails ? 1 : 0);
