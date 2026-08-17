#!/usr/bin/env node
/**
 * sentinaile gate — the scheduler's arithmetic and its power-cut behaviour.
 *
 * Everything asserted here is deterministic: the schedule functions take `now` as an argument, so a
 * six-hour outage is a number rather than a six-hour test. What is NOT asserted here is anything that
 * needs a model — planning is one LLM call and is covered by parsing its output, not by making it.
 */

import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function ok(cond, what, detail = '') {
  if (cond) { console.log(`  ok   ${what}`); return; }
  failures++;
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`);
}

const {
  sanitizeSchedule, isOneShot, firstDueAt, nextDueAfterRun, isExhausted, isDue, describeSchedule,
  MIN_INTERVAL_SECONDS,
} = await import('../dist/sentinaile/schedule.js');
const { parsePlanDraft, extractJsonObject } = await import('../dist/sentinaile/plan.js');
const { renderPlanFile, readPlanFile, writePlanFile } = await import('../dist/sentinaile/planfile.js');

const T0 = 1_700_000_000_000; // a fixed clock — no Date.now() anywhere in these assertions

console.log('schedule: the model\'s numbers are untrusted input');
{
  ok(sanitizeSchedule({ everySeconds: 1 }).everySeconds === MIN_INTERVAL_SECONDS,
    'a 1-second repeat is clamped to the floor — "keep an eye on it" must not become a fork bomb',
    String(sanitizeSchedule({ everySeconds: 1 }).everySeconds));
  ok(sanitizeSchedule({ everySeconds: -5 }).everySeconds === undefined, 'a negative interval is dropped, not negated');
  ok(sanitizeSchedule({ maxRuns: 0 }).maxRuns === undefined, 'maxRuns 0 is dropped — the prompt says omit, and 0 must not mean "never run"');
  ok(sanitizeSchedule({ everySeconds: 600 }).everySeconds === 600, 'a sane interval passes through untouched');
  ok(sanitizeSchedule({ everySeconds: NaN }).everySeconds === undefined, 'NaN cannot reach a timer');
  ok(sanitizeSchedule({ maxRuns: 3.7 }).maxRuns === 3, 'a fractional count is floored');
}

console.log('\nthe three requested forms');
{
  ok(isOneShot({}), 'no interval = run once');
  ok(!isOneShot({ everySeconds: 600 }), 'an interval = repeating');
  // scheduleAt
  ok(firstDueAt({ startAt: T0 + 60_000 }, T0) === T0 + 60_000, 'scheduleAt in the future is honoured');
  ok(firstDueAt({ startAt: T0 - 60_000 }, T0) === T0, 'scheduleAt in the PAST fires now, it does not fire retroactively');
  ok(firstDueAt({}, T0) === T0, 'no start time = due immediately');
  // repeat each N
  ok(nextDueAfterRun({ everySeconds: 600 }, T0) === T0 + 600_000, 'repeat each N schedules from completion');
  ok(nextDueAfterRun({}, T0) === Number.POSITIVE_INFINITY, 'a one-shot is never due again');
  // do N times
  ok(isExhausted({ schedule: { everySeconds: 600, maxRuns: 3 }, runsDone: 3 }), 'do-N-times stops at N');
  ok(!isExhausted({ schedule: { everySeconds: 600, maxRuns: 3 }, runsDone: 2 }), '…and not before');
  ok(isExhausted({ schedule: {}, runsDone: 1 }), 'a one-shot is exhausted after one run');
}

console.log('\nno catch-up: waking after an outage costs ONE run, not the backlog');
{
  // Asleep six hours on a ten-minute schedule: 36 "missed" runs.
  const state = { schedule: { everySeconds: 600 }, runsDone: 5, lastRunAt: T0, nextDueAt: T0 + 600_000, stoppedAt: 0 };
  const wokeAt = T0 + 6 * 3600_000;
  ok(isDue(state, wokeAt), 'it is due immediately on waking');
  const after = nextDueAfterRun(state.schedule, wokeAt);
  ok(after === wokeAt + 600_000,
    'the next one is scheduled from NOW — a six-hour-old check is stale, not 36 times more valuable',
    `got ${after - wokeAt}ms after wake`);
}

console.log('\nthe due-check refuses to double-fire');
{
  const base = { schedule: { everySeconds: 600 }, runsDone: 0, lastRunAt: 0, nextDueAt: T0, stoppedAt: 0 };
  ok(isDue(base, T0), 'due when the time has come');
  ok(!isDue(base, T0 - 1), 'not due one millisecond early');
  ok(!isDue({ ...base, runningPid: 4242 }, T0 + 10_000),
    'never two runs of one sentinel at once, however overdue it is');
  ok(!isDue({ ...base, stoppedAt: T0 }, T0 + 10_000), 'a stopped sentinel is never due');
  ok(!isDue({ ...base, schedule: { everySeconds: 600, maxRuns: 2 }, runsDone: 2 }, T0 + 10_000),
    'an exhausted sentinel is never due');
}

console.log('\nplan parsing: the model reply is untrusted');
{
  const good = '```json\n{"title":"CI watch","schedule":{"everySeconds":600},"steps":[{"instruction":"read the log","rationale":"it is the source"}]}\n```';
  const d = parsePlanDraft(good);
  ok(d && d.steps.length === 1, 'a fenced JSON reply parses');
  ok(d && d.schedule.everySeconds === 600, '…with its schedule');
  ok(parsePlanDraft('I think you should check CI every 10 minutes!') === null,
    'prose with no JSON is a failure, never a silently empty plan');
  ok(parsePlanDraft('{"title":"x","steps":[]}') === null,
    'a plan with NO steps is rejected — "do nothing, forever" is the runaway this must not become');
  ok(parsePlanDraft('{"title":"x","steps":[{"instruction":"  "}]}') === null,
    'a blank instruction does not count as a step');
  const clamped = parsePlanDraft('{"title":"x","schedule":{"everySeconds":1},"steps":[{"instruction":"go"}]}');
  ok(clamped && clamped.schedule.everySeconds === MIN_INTERVAL_SECONDS,
    'the clamp applies to what the MODEL sent, not only to hand-written schedules');
  // Nested braces are why this is a brace matcher and not a regex.
  const nested = extractJsonObject('prefix {"a":{"b":{"c":1}},"d":"}"} suffix');
  ok(nested === '{"a":{"b":{"c":1}},"d":"}"}', 'brace matching survives nesting and a brace inside a string', String(nested));
}

console.log('\nthe plan file is the artifact a human edits');
{
  const dir = mkdtempSync(join(tmpdir(), 'ayin-sentinaile-'));
  const state = {
    id: 'abcdef12-0000', request: 'watch CI every 10 minutes', cwd: dir,
    schedule: { everySeconds: 600 }, planPath: join(dir, 'sentinaile_plan.md'),
    createdAt: T0, runsDone: 0, lastRunAt: 0, nextDueAt: T0,
  };
  const md = renderPlanFile({ title: 'CI watch', schedule: state.schedule, steps: [{ instruction: 'read the log' }] }, state, T0);
  writePlanFile(state.planPath, md);
  ok(existsSync(state.planPath), 'the plan file is written');
  ok(/# CI watch/.test(md), 'it is titled');
  ok(/watch CI every 10 minutes/.test(md), 'it quotes the original request, so intent survives editing');
  ok(/every 10 minutes/.test(md), 'it states the schedule in words a human can check');
  ok(/read the log/.test(md), 'the steps are in it');

  // The edit path: change the file, and the next run must see the change.
  writeFileSync(state.planPath, md.replace('read the log', 'read the OTHER log'), 'utf-8');
  ok(/read the OTHER log/.test(readPlanFile(state.planPath) ?? ''),
    'an edited plan is what gets read back — the file is authoritative, not a rendering');
  ok(readPlanFile(join(dir, 'nope.md')) === null, 'a missing plan reads as null, which the supervisor treats as a stop');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nsafety properties that must hold in the source');
{
  const sup = readFileSync(new URL('../src/sentinaile/supervisor.ts', import.meta.url), 'utf-8');
  ok(/saveState\(next\);[\s\S]{0,400}spawn\(/.test(sup),
    'state is persisted BEFORE the run is spawned — the other order replays a run forever after a crash');
  ok(/AYIN_ACQUIRE_LLM: '0'/.test(sup),
    'a scheduled run yields to a human: it must not take the foreground grant and queue ahead of the operator');
  ok(/isAlive\(/.test(sup), 'a recorded pid is verified, never trusted — a stale pid after a reboot must not wedge the watch');
  ok(/detached: true/.test(sup), 'runs are detached, so closing the session does not kill the watch');
  const idx = readFileSync(new URL('../src/sentinaile/index.ts', import.meta.url), 'utf-8');
  ok(/stopAll\(/.test(idx), 'arming a new sentinel stops the previous one, as specified');
  const prompt = readFileSync(new URL('../prompts/ayin/sentinaileRun.txt', import.meta.url), 'utf-8');
  ok(/MUST say so/.test(prompt), 'a run that finds nothing is required to say so — silence must not look like health');
  ok(/Do not commit, push, or delete/.test(prompt), 'a run is a pair of eyes, not a hand');
}

console.log(failures ? `\nsentinaile check: ${failures} FAILED` : '\nsentinaile check: all good');
process.exit(failures ? 1 : 0);
