#!/usr/bin/env node
/**
 * check-announced — "I'll rewrite that now." And then the turn ended.
 *
 * `node tool/check-announced.mjs` (needs a build first). No LLM, no network, nothing written.
 *
 * The detector's danger is the same as `deferral.ts`'s and the opposite of a missed catch: a false
 * positive nags a reply that was fine, and an operator who learns to ignore the nudge has lost all
 * three of them. So most of what is asserted here is what must NOT fire.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { announcedWithoutActing, worthAsking, saysNotFinished } = await import(`file://${join(DIST, 'announced.js')}`);

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};
/** No tool ran this turn — the condition every real case shares. */
const idle = (t) => announcedWithoutActing(t, false);

console.log('\n— the promises, in both languages the operator uses —');
for (const t of [
  'Сейчас перепишу.',
  'Понял задачу. Погоди секунду.',
  'Я создам файл в ~/shared/naamah-phone/README.md.',
  'Давай я сейчас попробую проверить логи.',
  'Хорошо. Зараз подивлюся.',
  "I'll rewrite that file now.",
  'Got it. Let me take a look at the scheduler.',
  "That makes sense — I am going to check the Dispose path.",
  'One moment.',
]) ok(idle(t), JSON.stringify(t.slice(0, 52)));

console.log('\n— and what must NEVER fire —');
ok(!announcedWithoutActing('Сейчас перепишу.', true),
  'a turn that actually ran a tool is never nudged, whatever it says about what comes next');
ok(!idle('Let me explain: the scheduler batches by priority, then drains oldest-first.'),
  'an intent that DELIVERS in the same sentence is an answer, not a promise');
ok(!idle('I checked three files. The leak is in Dispose() at src/pool.ts:88 — the handle is never released.'),
  'a real finding is not a promise, even though it is short');
ok(!idle('I looked at the scheduler and found the bug at src/queue.ts:31. I will write that up next.'),
  'a promise AFTER a delivered answer is a note about what comes next, not a substitute for the work');
ok(!idle(`The bug is a missing await. ${'Here is the reasoning in full. '.repeat(30)}Сейчас перепишу.`),
  'a long reply is not nothing-but-its-promise, whatever its last sentence says');
ok(!idle('You should rewrite that method — it mutates the argument.'),
  'advice in the second person is deferral territory, and deferral.ts owns it');
ok(!idle('The file will be rewritten by the build step.'),
  'a passive future in a description of the system is not a first-person promise');
ok(!idle(''), 'an empty reply is the empty-answer path, not this one');
ok(!idle('```\nnpm run build\n```'), 'a reply that is a code block delivers something');

console.log('\n— the cheap gate that decides when to spend a model call —');
ok(worthAsking('Сейчас перепишу.', false), 'a short anchorless reply is worth asking about');
ok(!worthAsking('Сейчас перепишу.', true), 'a turn that ran a tool is never asked');
ok(!worthAsking('The leak is at src/pool.ts:88 — the handle is never released.', false),
  'a reply with a file:line delivered something; no call is spent on it');
ok(!worthAsking('```\nnpm run build\n```', false), 'nor on one that returned code');
ok(!worthAsking(`x${'y'.repeat(700)}`, false), 'nor on a long one');
ok(!worthAsking('', false), 'nor on an empty reply — the empty-answer path owns that');

console.log('\n— reading the verdict, which must FAIL SAFE —');
ok(saysNotFinished('no'), '"no" means it stopped short');
ok(saysNotFinished('No.'), 'punctuation and case do not matter');
ok(saysNotFinished('нет'), 'and it answers in the language it was asked in');
ok(!saysNotFinished('yes'), '"yes" means finished');
ok(!saysNotFinished(''), 'AN EMPTY VERDICT MEANS FINISHED — a judge that cannot answer must never hold a turn open');
ok(!saysNotFinished('I think the reply is incomplete because…'),
  'and neither does a paragraph: a false "not done" LOOPS, a false "done" costs one round the operator can ask for');
ok(!saysNotFinished('nonsense'), 'only the whole word counts, not a prefix');

console.log(fails ? `\nannounced check: ${fails} FAILED` : '\nannounced check: all passed');
process.exit(fails ? 1 : 0);
