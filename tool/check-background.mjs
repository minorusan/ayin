#!/usr/bin/env node
/**
 * check-background.mjs — Ctrl+B sends a run away, and the run survives it.
 *
 * WHY THIS GATE EXISTS AT ALL. This repo has already built backgrounding once and torn it out, and
 * the note in `agent.ts` says exactly how it failed: a subagent detached on a 20-second timer, the
 * parent told to poll it, six polls, `blocked (poll cap 6)`, turn over — while the child had finished
 * the job correctly and its report was never read. The work was fine; the DELIVERY was missing. So
 * the assertions here are mostly about the two things that killed it: a detached run must not be
 * cancelled, and its result must arrive without anyone asking for it.
 *
 * Behaviour, not source text, wherever it can be: every run below is a real `startRun` through the
 * real gateway, and the lane is read from inside a tool that is genuinely mid-flight.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Headless — the gate must never try to paint a screen.
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const runs = await import(join(ROOT, 'dist/runs.js'));
const bg = await import(join(ROOT, 'dist/background.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a run in flight moves lanes without being torn down ──────────────────────
{
  /** What the tool saw about its own lane, sampled before and after the operator's key press. */
  const seen = { before: null, after: null };
  let release;
  const gate = new Promise((r) => { release = r; });

  const run = runs.startRun('slow_tool', 'x=1', async () => {
    seen.before = bg.inBackground();
    await gate;
    seen.after = bg.inBackground();
    return 'the work finished';
  });

  await sleep(20);
  ok(seen.before === false, 'a run starts in the foreground');
  ok(runs.currentRuns().some((r) => r.id === run.id && r.background === false),
    '…and says so in the snapshot the UI paints from');

  const moved = runs.backgroundRun(run.id);
  ok(moved === true, 'Ctrl+B moves a live run to the background');

  let detachedFired = false;
  await Promise.race([run.detached.then(() => { detachedFired = true; }), sleep(200)]);
  ok(detachedFired, '…and the turn stops waiting for it immediately — that is the whole point');

  ok(runs.currentRuns().some((r) => r.id === run.id && r.background === true),
    '…the snapshot flips, so "still running" can be painted differently from "you are blocked"');
  ok(runs.backgroundRun(run.id) === false, '…and backgrounding it twice is a no-op, not a second detach');

  // THE RUN IS NOT CANCELLED. This is the assertion the whole feature stands on: detaching changes
  // who is waiting, nothing else. A "background" that quietly killed the work would be indefensible.
  release();
  const outcome = await run.done;
  ok(outcome.ok === true && outcome.cancelled === false,
    'a backgrounded run is NOT cancelled — it runs to completion exactly as it would have');
  ok(outcome.output === 'the work finished', '…and its real output survives, whole');
  ok(seen.after === true,
    'the tool itself sees the new lane MID-FLIGHT — an in-process run re-points its next model call without restarting');
}

// ── started already in the background ────────────────────────────────────────
{
  const run = runs.startRun('born_detached', '', async () => 'done', { background: true });
  let fired = false;
  await Promise.race([run.detached.then(() => { fired = true; }), sleep(200)]);
  ok(fired, 'a run STARTED in the background never holds the turn for even one await');
  await run.done;
}

// ── all of them, because a stage is not one branch ───────────────────────────
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = runs.startRun('phase_a', '', () => gate.then(() => 'a'));
  const b = runs.startRun('phase_b', '', () => gate.then(() => 'b'));
  await sleep(20);
  const moved = runs.backgroundAllRuns();
  ok(moved.length === 2 && moved.includes(a.id) && moved.includes(b.id),
    'every run holding the turn moves, not just one — parallel subagents are ONE stage of work');
  release();
  await Promise.all([a.done, b.done]);
  ok(runs.backgroundAllRuns().length === 0, '…and with nothing running it moves nothing, so the key falls through to the browser');
}

// ── an id that is not running ────────────────────────────────────────────────
{
  ok(runs.backgroundRun(999999) === false,
    'backgrounding a run that already finished is false, not a throw — that race is ordinary, not an error');
}

// ── the lane is off until the operator turns it on ───────────────────────────
{
  // The real, unconfigured state of a fresh install: detaching works, re-pointing does not.
  ok(bg.laneConfigured() === false || typeof bg.backgroundProviderName() === 'string',
    'the lane reports whether it is configured at all');
  if (!bg.laneConfigured()) {
    ok(bg.backgroundEnv && Object.keys(bg.backgroundEnv()).length === 0,
      'with no background model set, a child inherits exactly as before — a key press must not start a bill');
    let target = 'unset';
    await runs.startRun('probe', '', async () => { target = await bg.laneTarget(); return ''; },
      { background: true }).done;
    ok(target === null,
      '…and a backgrounded run with no lane configured stays on this model rather than guessing one');
  }
}

// ── what the model is told, and the mistake it must not repeat ───────────────
{
  const notice = bg.detachNotice(7, 'subagent', true);
  ok(/#7/.test(notice) && /subagent/.test(notice), 'the model is told which run left, by id and by name');
  // THE SCAR. The previous mechanism handed the model a task id and told it to poll; the poll cap
  // ended a turn while a correct report sat unread. Nothing here may ever say "poll" again.
  ok(!/\bpoll\b/i.test(notice) || /nothing to poll/i.test(notice),
    'the notice NEVER asks the model to poll — that is precisely how the last backgrounding lost a finished report');
  ok(/not? start it again|do not start it again/i.test(notice),
    '…and it forbids re-running the work, which is what a model does when a result goes missing');
  ok(/deliver|arrive/i.test(notice),
    '…because the result is PUSHED when it lands; the model has nothing to do but carry on');

  const honest = bg.detachNotice(7, 'subagent', false);
  ok(honest !== notice && !/separate model/.test(honest),
    'with no lane configured the notice does NOT claim the run moved model — it says only what is true');
}

// ── the completion the operator and the model both get ───────────────────────
{
  const msg = bg.completionMessage('subagent', 3, 12_000, true, 'REPORT: it worked');
  ok(/#3/.test(msg) && /12s/.test(msg) && /REPORT: it worked/.test(msg),
    'a finished background run reports its id, how long it took, and its FULL output');
  ok(/failed/.test(bg.completionMessage('x', 1, 1000, false, '')),
    '…and a failure says so rather than arriving as a silent empty result');
}

// ── the QA third-party-API probe: a URL is not an integration ────────────────
//
// Lives here rather than in check-gates because it needs a real temp tree to read. The bug it pins
// was measured twice on freshly scaffolded projects: the probe fired on ANY url-shaped string, so a
// page containing an inline SVG (`xmlns="http://www.w3.org/2000/svg"`) was judged to integrate a
// third-party API, failed for missing 429/401 handling, and the fix pass ADDED an `/api/proxy` route
// nobody asked for. See docs/TechDebt.md.
{
  const { mkdtempSync, writeFileSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const probes = await import(join(ROOT, 'dist/qa/probes.js'));

  const dir = mkdtempSync(join(tmpdir(), 'ayin-apiprobe-'));
  const file = (name, body) => {
    const p2 = join(dir, name);
    writeFileSync(p2, body);
    return { path: p2, exists: true, bytes: statSync(p2).size, kind: 'code' };
  };

  const svgPage = file('index.html',
    '<!DOCTYPE html>\n<html><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
    + '<path d="M0 0h16v16H0z"/></svg><p>hello</p></body></html>\n');
  ok(probes.probeThirdPartyApi([svgPage]).applies === false,
    'an inline SVG namespace is NOT a third-party integration — the exact string that failed two scaffolds');

  const localServer = file('server.ts',
    'import http from "node:http";\nexport const s = http.createServer((_q, r) => r.end("hi"));\n'
    + '// listens on http://localhost:3000\n');
  ok(probes.probeThirdPartyApi([localServer]).applies === false,
    'a local http server that calls nothing out is not an integration either');

  const readmeLink = file('README.md', 'See the docs at https://nodejs.org/api/http.html for details.\n');
  ok(probes.probeThirdPartyApi([readmeLink]).applies === false,
    'a documentation link in a README is a link, not an API this project integrates');

  // …and the probe must still SEE a real one, or the fix is just a way to skip the check.
  const realCall = file('client.ts',
    'export async function rates() {\n  const r = await fetch("https://api.example.com/v1/rates");\n  return r.json();\n}\n');
  const realProbe = probes.probeThirdPartyApi([realCall]);
  ok(realProbe.applies === true,
    'a genuine fetch() to an external host IS still detected — the point is precision, not silence');
  ok(realProbe.hosts.includes('api.example.com'), '  → and the host is named for the criterion to use');

  const credOnly = file('cfg.ts', 'export const key = process.env.STRIPE_API_KEY;\n');
  ok(probes.probeThirdPartyApi([credOnly]).applies === true,
    'a credential-shaped env var stands on its own — however the request is made, that is an integration');
}

console.log(fails === 0 ? '\nbackground check: ok' : `\nbackground check: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
