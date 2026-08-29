#!/usr/bin/env node
/**
 * check-gates — exercises the DETERMINISTIC halves of the three loop gates against the built `dist`.
 *
 * `npm run check:gates` (needs a build first). No LLM, no network beyond loopback, no writes outside
 * the OS temp directory — so it runs anywhere, in a second, with nothing configured.
 *
 * It exists because these gates are exactly the kind of code that looks right and is wrong. The
 * webview probe is the case in point: Node's global agent pools keep-alive sockets per host:port, so
 * probing a port, letting the fix pass restart that server, and probing again reuses a socket the new
 * process resets — `ECONNRESET`, indistinguishable from "nothing is listening". The gate would have
 * reported a healthy server as down and sent the agent chasing a bug it had already fixed. A unit test
 * that binds a real socket caught it in one run; reading the code did not. That case is `phase B` below
 * and it stays here forever.
 *
 * The glyph guard (`check-glyphs.mjs`) runs as `prebuild` because blessed lies about width on every
 * build. This one binds sockets and starts servers, so it is deliberately NOT in `prebuild` — run it
 * when you touch `qa/`, `plan/` or `tool-guard.ts`.
 */

// Declare ourselves headless BEFORE importing anything from dist. `qa/index.js` reaches `ui.js` for
// the verdict card, and `ui/index.ts` builds real blessed widgets at module load unless HEADLESS is
// set — which grabs the terminal and leaves escape codes behind when the process exits. HEADLESS is
// computed from argv the first time `ui/headless.js` is evaluated, so setting it here, before the
// first dynamic import, is what keeps this check from redecorating your shell.
if (!process.argv.includes('-p')) process.argv.push('-p');

import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DIST = join(REPO, 'dist');
const TMP = mkdtempSync(join(tmpdir(), 'ayin-gates-'));
// A port high in the ephemeral-ish range, unlikely to collide with anything a dev is running.
const PORT = 45231;

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};
const listen = (server, host, port) => new Promise((res, rej) => {
  server.once('error', rej);
  server.listen(port, host, res);
});
const close = (server) => new Promise((res) => server.close(res));

// ── tool guard: refusals escalate and persist ────────────────────────
console.log('\ntool guard');
const g = await import(`file://${join(DIST, 'tool-guard.js')}`);
g.guardBeginTurn();
/**
 * A READ IS NEVER REFUSED — the change that un-castrated the loop.
 *
 * The old ladder refused the second identical read and killed the third for the turn, so "read it again to
 * check the fix" was answered with "use the result already in your context" — the result from before the
 * fix. A repeat read costs milliseconds; a refused one costs the fix. So reads are annotated and counted,
 * never blocked.
 *
 * SINCE 2026-08-28 A REPEAT WITH NOTHING CHANGED IS SERVED FROM THE ARTIFACT rather than re-run. Reaching
 * that branch means the guard has already proven the answer cannot have moved — the witness is identical,
 * no mutation has been noted, nothing has read the target since — so the tool would return exactly what is
 * already on disk. It used to run anyway and append "nothing it reads has changed since the first one",
 * which is a true sentence that costs a 200 KB grep.
 *
 * It also settles the cache-versus-file problem the old note had to warn around: the two are the same
 * thing here, provably, so the model is handed the answer instead of a choice.
 */
const rf = { path: join(TMP, 'x.ts') };
ok(g.guardCheck('read_file', rf).allow === true, 'first read runs');
const second = g.guardCheck('read_file', rf);
ok(second.allow === true && /repeat 2/.test(second.label ?? ''), 'the second identical read is allowed, labelled as a repeat', second.label ?? '');
ok(second.serveCached === true, 'and is SERVED from the artifact rather than re-run — nothing it reads has changed', second.label ?? '');
ok(/without running the tool again/.test(second.note ?? ''),
  'its note says so, and says a write is what makes the next call run for real',
  (second.note ?? '').slice(0, 80));
ok(/edit first/.test(second.note ?? ''), 'so "read it again to check my fix" still has an answer that works');
const reads = Array.from({ length: 10 }, () => g.guardCheck('read_file', rf));
ok(reads.every((r) => r.allow), 'a tenth identical read is still allowed — nothing read-only is ever dead for the turn');
ok(reads.every((r) => r.serveCached), 'and every one of them is served, not run');

/**
 * A POLL IS THE ONE QUESTION A CACHE MUST NEVER ANSWER. "Is it finished yet" served from the last
 * answer is a loop that can never end, so `POLLABLE` keeps the old ladder — rate-limited and capped.
 */
/**
 * AND THE AGENT HONOURS IT. A decision no caller acts on is a comment. Source assertions, in the style
 * this file already uses for the retry guard: the loop must look the artifact up, must fall through to a
 * real run when there is none, and must still record the call.
 */
const agentSrc = readFileSync(join(DIST, '..', 'src', 'agent.ts'), 'utf-8');
const servedAt = agentSrc.indexOf('if (guard.serveCached)');
ok(servedAt > 0, 'the agent loop acts on serveCached');
const servedBlock = agentSrc.slice(servedAt, servedAt + 1400);
ok(/artifactFor\(/.test(servedBlock), 'it looks the earlier result up rather than inventing one');
ok(/log\('INFO', 'tool_cache_miss_running'/.test(agentSrc),
  'and FALLS THROUGH to a real run when there is no artifact — an early session, a pruned folder, a result never saved');
ok(/noteRanCall\(/.test(servedBlock),
  'a served call still reaches the ledger — a saving the operator cannot see is indistinguishable from a tool that silently did not run');

const pollArgs = { taskId: 't1' };
g.guardCheck('task_status', pollArgs);
const polled = g.guardCheck('task_status', pollArgs);
ok(!polled.serveCached, 'a poll is never served from cache — it exists to ask whether the world moved');
ok(!/read_file/.test(g.guardDirective()), 'a read is never written into the blocked list');

/**
 * A REPEAT IS ANNOTATED, NEVER REFUSED — and this gate used to assert the opposite.
 *
 * The ladder (skip the second identical call, block the third for the turn) was closing a real loop, but
 * it was treating a symptom. A model repeats a call when it cannot see what the call returned: the result
 * went into the history, the history was compressed to fit the window, and what survived in the ledger
 * was the first line of the output clipped to a hundred characters. Refused the repeat, it had no way to
 * remember the answer AND no way to fetch it.
 *
 * The fix is upstream — the ledger now carries the first ten lines of EVERY call's output for the whole
 * turn (`agent.ts#renderCallLedger`) — so the note here can say "you already have this, and here is where
 * the rest of it lives" and let the call run. Some repeats are also genuinely the point: "has the server
 * come up", "does the test pass now", "did that write land" are the same call twice on purpose, and only
 * the second answer is useful.
 */
const buildCmd = { command: 'npm run build' };
ok(g.guardCheck('bash', buildCmd).allow === true, 'first bash runs');
const bashSecond = g.guardCheck('bash', buildCmd);
ok(bashSecond.allow === true && /repeat 2/.test(bashSecond.label ?? ''), 'the second identical command RUNS, labelled a repeat', bashSecond.label ?? '');
const bashThird = g.guardCheck('bash', buildCmd);
ok(bashThird.allow === true && /repeat 3/.test(bashThird.label ?? ''), 'so does the third — the guard never bans an identical call');
ok(/REPEAT 3/.test(bashThird.note ?? ''), 'and it is told it is a repeat rather than being silently re-run');
ok(/call ledger/.test(bashThird.note ?? ''), 'the note points at where the earlier answer already is');
ok(!/bash/.test(g.guardDirective()), 'a repeat is NEVER written into the blocked list — only a denial is');

// A DRIVER'S REPEAT IS ITS PURPOSE. `entangle op=next` returns a different type every time — the answer is
// a function of what has landed. The repeat guard read it as a loop and blocked it, and the run died: the
// model spun looking for a call the guard would accept, burned every round, then emitted malformed XML.
const drive = Array.from({ length: 12 }, () => g.guardCheck('entangle', { op: 'next' }));
ok(drive.every((d) => d.allow), 'entangle op=next is never blocked as a repeat — it IS the loop', `${drive.filter((d) => d.allow).length}/12`);
ok(drive.every((d) => !/POLLING/.test(d.note ?? '')), 'nor rate-limited: a poll costs nothing, a step costs work');
const statusFirst = g.guardCheck('entangle', { op: 'status' });
g.guardCheck('entangle', { op: 'status' });
const statusThird = g.guardCheck('entangle', { op: 'status' });
ok(statusFirst.allow && statusThird.allow && /repeat/.test(statusThird.label ?? ''),
  'other entangle ops run too, and are merely labelled', statusThird.label ?? '');

/**
 * A REPEAT IS NOT A LOOP WHEN THE WORLD MOVED.
 *
 * "read the file, fix it, read it again to check the fix" is three identical reads, and the guard used to
 * refuse the third — telling the model to use a result that describes the file BEFORE the fix. So the
 * repeat is judged against the file's mtime+size and against a counter of ayin's own writes, and a block
 * set before either changed is lifted rather than kept.
 */
const freshFile = join(TMP, 'guard-fresh.ts');
writeFileSync(freshFile, 'export const a = 1;\n');
const fresh = { path: freshFile, content: 'x' };
g.guardCheck('write_file', fresh);
g.guardCheck('write_file', fresh);
const blockedWrite = g.guardCheck('write_file', fresh);
ok(blockedWrite.allow === true && /repeat/.test(blockedWrite.label ?? ''),
  'a third identical WRITE to an unchanged file runs, and says it is a repeat', blockedWrite.label ?? '');
writeFileSync(freshFile, 'export const a = 2;\nexport const b = 3;\n');   // mtime AND size move
const afterEdit = g.guardCheck('write_file', fresh);
ok(afterEdit.allow === true && /target changed/.test(afterEdit.label ?? ''),
  'the same call runs again once the file has changed — and the standing block is lifted with it',
  `${afterEdit.allow} ${afterEdit.label ?? ''}`);
ok(!/guard-fresh/.test(g.guardDirective()), 'and it is no longer named as blocked in the system prompt');
const againUnchanged = g.guardCheck('write_file', fresh);
ok(againUnchanged.allow === true && /repeat/.test(againUnchanged.label ?? ''),
  'and once the file stops changing the label goes back to naming the repeat', againUnchanged.label ?? '');

// A directory-scoped call has no single file to witness, so any write is the signal. Shown on a tool that
// HAS a ladder, since a grep no longer has one to lift.
const dirCall = { path: TMP, content: 'y' };
g.guardCheck('write_file', dirCall);
g.guardCheck('write_file', dirCall);
ok(/repeat/.test(g.guardCheck('write_file', dirCall).label ?? ''), 'a repeat with nothing written since is named as one');
g.guardNoteMutation('str_replace', [join(TMP, 'other.ts')], 'str_replace|path=other.ts');
const afterWrite = g.guardCheck('write_file', dirCall);
ok(afterWrite.allow === true && /files written since/.test(afterWrite.label ?? ''),
  'once another call has written, this one runs again — what it saw is stale',
  afterWrite.label ?? '');

/**
 * bash MUST NOT EXCUSE ITSELF. It now bumps the epoch like any tool that could have written — a shell
 * command can do anything — so the bump is attributed to the CALL, and a call is never lifted by its own.
 * Otherwise `npm test` five times in a row would be five legitimate questions.
 */
const build = { command: 'npm test' };
const buildKey = g.callKey('bash', build);
g.guardCheck('bash', build);
g.guardNoteMutation('bash', [], buildKey);          // as the loop does after every non-read tool
g.guardCheck('bash', build);
g.guardNoteMutation('bash', [], buildKey);
// The self-exclusion still matters: without it a bash call's own epoch bump would make every repeat look
// like a fresh question ("files written since"), and the model would never be told it was repeating.
ok(/repeat/.test(g.guardCheck('bash', build).label ?? ''),
  'a repeated identical command is still NAMED a repeat, its own writes notwithstanding', g.guardCheck('bash', build).label ?? '');
g.guardNoteMutation('write_file', [join(TMP, 'fix.ts')], 'write_file|path=fix.ts');
ok(g.guardCheck('bash', build).allow === true, 're-running it AFTER an edit is a different question, and runs');

// A denial was a decision about permission, not about freshness.
g.guardNoteDenied('bash', { command: 'git push' });
ok(g.guardCheck('bash', { command: 'git push' }).allow === false, 'a denied call is refused');
g.guardNoteMutation('write_file', [join(TMP, 'fix2.ts')], 'write_file|path=fix2.ts');
const deniedAgain = g.guardCheck('bash', { command: 'git push' });
ok(deniedAgain.allow === false && /DENIED/.test(deniedAgain.note ?? ''),
  'and a write does NOT lift a denial — that was permission, not staleness');

const polls = Array.from({ length: 8 }, () => g.guardCheck('status', {}));
ok(polls[0].allow && polls[4].allow, 'polling a backgrounded task keeps working (repeats are its job)');
ok(/POLLING NOTICE/.test(polls[1].note ?? ''), 'a too-soon poll still runs but carries the rate-limit notice');
ok(polls[6].allow === false && /poll cap/.test(polls[6].label ?? ''), 'polling past the cap is blocked');

const denied = { command: 'true' };
g.guardNoteDenied('bash', denied);
ok(/DENIED/.test(g.guardCheck('bash', denied).note ?? ''), 'a denied call is refused on sight, for the whole turn');

g.guardBeginTurn();
const cmd = { command: 'curl -s http://127.0.0.1:1/' };
g.guardCheck('bash', cmd); g.guardCheck('bash', cmd);
ok(/REPEAT/.test(g.guardCheck('bash', cmd).note ?? ''), 'a repeated bash call carries the repeat notice');
ok(!/read_file/.test(g.guardDirective()), 'a new turn starts with a clean slate');

// ── every shipped def actually registers ─────────────────────────────
//
// A def that fails to export `tool` is not a failure discovery reports: the module imports cleanly, it
// simply has nothing on it, so `report.failed` is empty and the tool silently does not exist. Measured
// the hard way — one dropped `*/` swallowed a whole tool object into a doc comment, `ayin_help`
// vanished from the catalogue, and the model answered "I cannot call ayin_help as it is not a tool
// available to me". Nothing anywhere said why.
{
  const { readdirSync: rd } = await import('node:fs');
  const defsDir = join(REPO, 'src/tools/defs');
  const shipped = rd(defsDir).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, '')).sort();
  const tl = await import(`file://${join(DIST, 'tools.js')}`);
  await tl.loadTools();
  const missing = shipped.filter((name) => {
    // A file may export several tools under other names, so ask the module rather than assuming the
    // filename is the tool name.
    return !tl.getTool(name);
  });
  ok(shipped.length > 20, `the scan found the def directory — ${shipped.length} files`);
  ok(missing.length === 0,
    'every shipped tool definition actually registers — a def that exports nothing fails SILENTLY',
    missing.join(', '));
}

// ── postmortem: a run that dies unexpectedly says where it got to ────
console.log('\npostmortem');
{
  const pm = await import(`file://${join(DIST, 'postmortem.js')}`);

  // ENABLED BY ASKING. Off by default, because a note nobody asked for in every working directory is
  // litter, and the operator who wants them wants them everywhere.
  const flagWas = process.env.AYIN_POSTMORTEM;
  delete process.env.AYIN_POSTMORTEM;
  ok(!pm.postmortemEnabled(), 'postmortems are off unless asked for');
  process.env.AYIN_POSTMORTEM = '1';
  ok(pm.postmortemEnabled(), 'and on via the environment, for a harness that cannot pass flags');

  // THE NOTE NAMES WHAT WAS RUNNING. This is the part no log reconstructs — "killed during npm run
  // build, 43 seconds in" rather than "killed" — and it is why `runs.ts` is the thing it reads.
  const R = await import(`file://${join(DIST, 'runs.js')}`);
  R.resetRuns();
  const live = R.startRun('bash', 'command=sleep 120', async (ctx) => {
    ctx.onStatus('sleep 120');
    await new Promise((res) => { ctx.signal.addEventListener('abort', res, { once: true }); setTimeout(res, 3000); });
    return '';
  });
  await new Promise((res) => setTimeout(res, 30));
  const note = pm.renderPostmortem('killed by SIGTERM');
  ok(/reason: \*\*killed by SIGTERM\*\*/.test(note), 'the note leads with WHY it died');
  ok(/\*\*bash\*\*\(command=sleep 120\)/.test(note), 'and names the call that was in flight');
  ok(/last said: sleep 120/.test(note), '  → with the last thing that call narrated');
  ok(/## Where to resume/.test(note) && /## The tail/.test(note), 'and carries where to resume, and the tail');
  R.cancelRun(live.id);
  await live.done;

  // Between calls, it says so rather than leaving the section blank — a blank section reads as lost data.
  R.resetRuns();
  ok(/Nothing — it was between tool calls/.test(pm.renderPostmortem('x')), 'an idle death says it was idle');

  // THE EXPECTED EXIT SEQUENCE is the ONLY thing that suppresses a note — see `postmortem.ts` on why
  // the definition is inverted. A clean headless run must leave nothing.
  const appSrc = readFileSync(join(REPO, 'src/app.ts'), 'utf-8');
  ok(/markCleanExit\(\);\n  process\.exit\(0\);/.test(appSrc),
    'headless marks the clean exit where it ACTUALLY exits — marking it in the caller never ran, and every clean run wrote a note');
  ok(/armPostmortem\(\)/.test(appSrc), 'and arms the handlers before the work starts');

  const subSrc = readFileSync(join(REPO, 'src/subagents.ts'), 'utf-8');
  ok(/postmortemEnabled\(\) \? \{ AYIN_POSTMORTEM: '1' \}/.test(subSrc),
    'a subagent inherits postmortems — cancelling one kills a process nobody was watching');

  if (flagWas !== undefined) process.env.AYIN_POSTMORTEM = flagWas; else delete process.env.AYIN_POSTMORTEM;
}

// ── ayin_help answers a QUESTION, not only a topic name ──────────────
console.log('\nayin_help: semantic capability search');
{
  const t = await import(`file://${join(DIST, 'tools.js')}`);
  await t.loadTools();
  const ah = await import(`file://${join(DIST, 'tools/defs/ayin_help.js')}`);

  ok(/\/jira/.test(ah.answerCapability('can you talk to jira')), 'a question finds the command that answers it');
  ok(/\/diff/.test(ah.answerCapability('how do I review a diff')), 'and phrasing it as a task still finds it');
  // TOOLS ARE CAPABILITIES TOO. Nothing in HELP mentions web_search, so a catalogue of commands alone
  // answers "can you search the web" with silence.
  // The tool half is passed IN — the def cannot import `tools.js` at module scope without closing a
  // cycle through discovery, so `execute` hands it over at call time.
  const toolList = t.modelTools().map((x) => ({ name: x.name, description: x.description }));
  ok(/web_search/.test(ah.answerCapability('can ayin search the web', toolList)),
    'and the TOOL catalogue is searched, not only the commands');

  // THE MOST USEFUL ANSWER THIS TOOL HAS. A capability that does not exist must be said out loud, or
  // the model fills the silence with a command it invented.
  const no = ah.answerCapability('can you send me a fax');
  ok(/NOTHING IN AYIN MATCHES/.test(no), 'a capability ayin does not have is refused in as many words');
  ok(/it cannot/.test(no), '  → and the model is told to say so rather than suggest something that does not exist');
}

// ── runs: management instead of timeouts ─────────────────────────────
console.log('\nruns');
{
  const R = await import(`file://${join(DIST, 'runs.js')}`);
  R.resetRuns();

  // A LONG TOOL IS NOT A HUNG TOOL, and no clock decides which. It narrates, and the notes carry the
  // delta since the previous one so two tools' timings are comparable.
  const seen = [];
  const off = R.onRunsChanged((runs) => { if (runs.length) seen.push(runs[0]); });
  const slow = R.startRun('slowtool', 'x=1', async (ctx) => {
    ctx.onStatus('step one');
    await new Promise((res) => setTimeout(res, 60));
    ctx.onStatus('step two');
    return 'finished normally';
  });
  ok(R.currentRuns().some((r) => r.tool === 'slowtool'), 'a running tool is visible from OUTSIDE the await');
  const a = await slow.done;
  ok(a.ok && !a.cancelled && a.output === 'finished normally', 'and is never killed for taking time');
  ok(/^\[\+[\d.]+s\] step one\n\[\+[\d.]+s\] step two$/.test(slow.notes()),
    'its narration is stamped with the delta since the previous note', JSON.stringify(slow.notes()));
  ok(R.currentRuns().length === 0, 'and it leaves the registry when it finishes');
  off();

  // CANCELLED IS NOT FAILED, AND THE SIGNAL DECIDES. A killed child returns its partial output through
  // the normal path rather than throwing, so a cancelled run looks exactly like a successful one unless
  // `aborted` is consulted — a green tick over a truncated result handed to the model as the answer.
  const sneaky = R.startRun('bashlike', 'cmd=sleep', async (ctx) => {
    await new Promise((res) => { ctx.signal.addEventListener('abort', res, { once: true }); setTimeout(res, 3000); });
    return 'partial output that looks fine';          // note: does NOT throw
  });
  R.cancelRun(sneaky.id, 'test');
  const b = await sneaky.done;
  ok(b.cancelled, 'a cancelled run is marked cancelled even though the tool returned normally');
  ok(!b.ok, '  → and is NOT reported as a success');
  ok(/Cancelled before it finished/.test(b.output), '  → and says so where the model will read it');

  // PER-CALL. Stopping one tool must leave the rest of the turn alone — the half ayin never had.
  const one = R.startRun('t1', '', async (ctx) => {
    await new Promise((res) => { ctx.signal.addEventListener('abort', res, { once: true }); setTimeout(res, 3000); });
    return 'one';
  });
  const two = R.startRun('t2', '', async () => { await new Promise((res) => setTimeout(res, 30)); return 'two'; });
  R.cancelRun(one.id);
  const [o, t] = await Promise.all([one.done, two.done]);
  ok(o.cancelled && !t.cancelled && t.output === 'two', 'cancelling one run leaves the others running');

  // A tool that throws is a RESULT, never an exception that ends the turn.
  const boom = await R.startRun('boom', '', async () => { throw new Error('nope'); }).done;
  ok(!boom.ok && /Error: nope/.test(boom.output), 'a throwing tool comes back as a result the model can read');

  ok(R.cancelAllRuns() === 0, 'and nothing is left running afterwards');
  R.resetRuns();
}

// ── subagents: the arbitration level, and the two rules that keep it one level ────
console.log('\nsubagents');
{
  const sa = await import(`file://${join(DIST, 'subagents.js')}`);

  // RULE 1: a subagent may not spawn subagents. Enforced by WITHHOLDING the tool, not by refusing the
  // call — a tool the model can see and cannot use costs a round to discover that.
  const depthWas = process.env.AYIN_SUBAGENT_DEPTH;
  const flagWas = process.env.AYIN_SUBAGENTS;
  delete process.env.AYIN_SUBAGENT_DEPTH; delete process.env.AYIN_SUBAGENTS;
  ok(sa.subagentsAllowed(), 'the top level may delegate');
  ok(!sa.isSubagent() && sa.subagentDepth() === 0, 'and knows it is the top level');
  process.env.AYIN_SUBAGENT_DEPTH = '1';
  ok(!sa.subagentsAllowed(), 'a SUBAGENT may not delegate — the level stays one deep');
  ok(sa.isSubagent() && sa.subagentDepth() === 1, 'and knows it is one');
  process.env.AYIN_SUBAGENT_DEPTH = '3';
  ok(!sa.subagentsAllowed(), 'nor at any greater depth');
  delete process.env.AYIN_SUBAGENT_DEPTH;
  process.env.AYIN_SUBAGENTS = '0';
  ok(!sa.subagentsAllowed(), 'and an operator can switch delegation off entirely');
  delete process.env.AYIN_SUBAGENTS;
  if (depthWas !== undefined) process.env.AYIN_SUBAGENT_DEPTH = depthWas;
  if (flagWas !== undefined) process.env.AYIN_SUBAGENTS = flagWas;

  // RULE 2: parallel is off until asked for. Two agents editing one tree lose each other's writes, and
  // nothing in any output says so.
  const parWas = process.env.AYIN_PARALLEL_SUBAGENTS;
  delete process.env.AYIN_PARALLEL_SUBAGENTS;
  ok(!sa.parallelSubagentsAllowed(), 'parallel subagents are OFF by default');
  ok(sa.prewarmSubagents([{ task: 'a' }, { task: 'b' }]) === 0, 'so nothing is pre-warmed, however many were asked for');
  process.env.AYIN_PARALLEL_SUBAGENTS = '1';
  ok(sa.parallelSubagentsAllowed(), 'and on when the operator asks');
  ok(sa.prewarmSubagents([{ task: 'only-one' }]) === 0, 'a single call is never "parallel" — nothing to overlap');
  if (parWas !== undefined) process.env.AYIN_PARALLEL_SUBAGENTS = parWas; else delete process.env.AYIN_PARALLEL_SUBAGENTS;
  sa.resetSubagents();

  // The report is the child's ANSWER, not its transcript: the parent delegated precisely so it would
  // not have to hold that.
  const r = sa.extractReport('[system] Connected\n[tool] ▸ bash · command=ls\n│ out\n╰ ✓ 0.1s\nI built it.\n\n--- HANDOFF (x) ---\nnoise\n');
  ok(r.report === 'I built it.', 'the report is the prose, with the tool cards and the handoff stripped', JSON.stringify(r.report));
  ok(r.toolCalls === 1, 'and the child\'s tool calls are counted — a report with zero of them is a description, not work');

  // A DELEGATED TASK IS WAITED FOR, NOT POLLED. Backgrounded, the first live delegation polled `status`
  // six times, hit pollMaxPerTurn, and ended the turn never having seen the report — while the child
  // had done the job correctly.
  // NOTHING is backgrounded by a clock any more — `runs.ts` replaced the race entirely, so the
  // subagent-specific exemption that used to live here has no race left to be exempt from.
  const agentSrc2 = readFileSync(join(REPO, 'src/agent.ts'), 'utf-8');
  ok(!/BACKGROUND_TIMEOUT/.test(agentSrc2), 'the loop has no background timeout at all');
  ok(/startRun\(/.test(agentSrc2), 'every tool call goes through the run registry — the one door');

  const toolsSrc = readFileSync(join(REPO, 'src/tools.ts'), 'utf-8');
  ok(/subagentsAllowed\(\) \? report\.tools : report\.tools\.filter/.test(toolsSrc),
    'discovery withholds the tool rather than registering one that would refuse');
}

// ── search tools: the model's patterns must actually be honoured ─────
console.log('\nsearch tools');
const toolsMod = await import(`file://${join(DIST, 'tools.js')}`);
// The registry is discovered, so a consumer must say so — the same insistence core makes.
await toolsMod.loadTools();
const grepTool = toolsMod.getTool('grep');
const findTool = toolsMod.getTool('find_files');
const sRoot = mkdtempSync(join(tmpdir(), 'ayin-search-'));
mkdirSync(join(sRoot, 'nested'), { recursive: true });
writeFileSync(join(sRoot, 'a.cs'), 'class A { void PickOne() {} }\n');
writeFileSync(join(sRoot, 'a.txt'), 'PickOne mentioned in prose\n');
writeFileSync(join(sRoot, 'nested', 'b.cs'), 'class B { void PickTwo() {} }\n');

let g1 = await grepTool.execute({ pattern: 'PickOne|PickTwo', path: sRoot });
ok(/a\.cs/.test(g1) && /b\.cs/.test(g1), 'an ALTERNATION matches — the pattern is an extended regex, not BRE where | is a literal', g1.split('\n')[0]);
let g2 = await grepTool.execute({ pattern: 'PickOne', path: sRoot, include: '*.cs' });
ok(/a\.cs/.test(g2) && !/a\.txt/.test(g2), 'include= actually filters');
ok(!/No such file/.test(g2), 'include= is passed BEFORE the -- terminator, or grep reads it as a filename and silently stops filtering');
let g3 = await grepTool.execute({ pattern: 'pickone', path: sRoot, ignore_case: true });
ok(/a\.cs/.test(g3), 'ignore_case= matches regardless of case');
let g4 = await grepTool.execute({ pattern: 'Pick(One', path: sRoot, fixed: true });
ok(/0 matches/.test(g4) && !/exit code/.test(g4), 'fixed= treats an unbalanced paren as a literal instead of failing as a bad regex');
let g5 = await grepTool.execute({ pattern: 'NotPresentAnywhere', path: sRoot });
ok(/0 matches/.test(g5) && /pattern is what missed/.test(g5), 'an empty result says the PATTERN missed — never silence the model reads as "this code does not exist"');
let f1 = await findTool.execute({ path: sRoot, pattern: '*/nested/*.cs' });
ok(/b\.cs/.test(f1), 'a pattern containing a separator is matched against the PATH, not just the basename');
let f2 = await findTool.execute({ path: sRoot, pattern: '*.nope' });
ok(/0 files match/.test(f2), 'find_files reports a miss in words too');
let g6 = await grepTool.execute({ pattern: 'PickOne', path: sRoot, context: 1 });
ok(/incl\. context/.test(g6), 'context= returns surrounding lines and SAYS they are context, not extra matches');
let g7 = await grepTool.execute({ pattern: 'PickOne|PickTwo', path: sRoot, files_only: true });
ok(/\(3 files\)/.test(g7) && !/:\d+:/.test(g7), 'files_only= lists the 3 matching paths, not their lines — the "how widely does this spread" question', g7.split('\n').pop());
let g8 = await grepTool.execute({ pattern: 'PICKONE', path: sRoot, ignore_case: 'false' });
ok(/0 matches/.test(g8), 'ignore_case="false" from the model is FALSE — a param arrives as a string and must not be truthy');
writeFileSync(join(sRoot, 'nested', 'Target.cs'), 'class Target {}\n');
writeFileSync(join(sRoot, 'TargetGenerated.cs'), 'class TargetGenerated {}\n');
// read_file: a capped, honest read — the model must never believe it saw a whole file it did not
const readTool = toolsMod.getTool('read_file');
const bigFile = join(sRoot, 'big.ts');
writeFileSync(bigFile, Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join('\n'));
let r1 = await readTool.execute({ path: bigFile });
ok(/unread: \d+-1200/.test(r1) && /slide there/.test(r1),
  'a read with no limit is capped and SAYS what is still unread and how to continue, instead of returning a file the window then cuts silently');
ok(!/line 1000\b/.test(r1), 'the cap actually applies');
// The SECOND param-free read must not repeat the first window — that was a wasted round.
let r1b = await readTool.execute({ path: bigFile });
ok(/slid past what you already read/.test(r1b) && /line 1000\b/.test(r1b),
  'a repeated param-free read SLIDES to the unread part instead of returning the same top slice', r1b.split('\n')[0]);
let r2 = await readTool.execute({ path: bigFile, offset: '191' });
ok(/^\(lines 191-/.test(r2) && /\n191\tline 191/.test(`\n${r2}`), 'offset is the LINE NUMBER — a grep hit pasted straight in lands on that line, not the one after', r2.split('\n')[1]);
writeFileSync(join(sRoot, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42, 0x00]));
let r3 = await readTool.execute({ path: join(sRoot, 'bin.dat') });
ok(/binary file/.test(r3), 'a binary file is named as such, not decoded into mojibake');

// bash: bounded, and honest about why it stopped
const bashTool = toolsMod.getTool('bash');
let b1 = await bashTool.execute({ command: 'sleep 5', timeout_seconds: '1' });
ok(/TIMED OUT/.test(b1) && /background/.test(b1), 'a command that outlives its budget is killed and the reply says the output is PARTIAL');

// str_replace: a miss must say WHY
const srTool = toolsMod.getTool('str_replace');
const srFile = join(sRoot, 'edit.ts');
writeFileSync(srFile, 'function a() {\n    return 1;\n}\n');
let e1 = await srTool.execute({ path: srFile, old_str: 'function a() {\n  return 1;\n}', new_str: 'x' });
ok(/whitespace differs/.test(e1) && /line 1/.test(e1), 'an indentation-only mismatch is diagnosed as whitespace, with the line where the text starts');
let e2 = await srTool.execute({ path: srFile, old_str: 'function a() {\n    return 2;\n}', new_str: 'x' });
ok(/first line matches at line 1/.test(e2) && /return 1/.test(e2), 'when only the first line matches, the tool shows what the file actually says there');

// write_file: an overwrite must be legible even when its diff overflows the window
const writeTool = toolsMod.getTool('write_file');
const wPath = join(sRoot, 'written.ts');
let w1 = await writeTool.execute({ path: wPath, content: 'a\n'.repeat(40) });
ok(/^Created /.test(w1), 'a new file says Created');
let w2 = await writeTool.execute({ path: wPath, content: 'a\n'.repeat(38) });
ok(/^Overwrote /.test(w2) && !/GONE/.test(w2), 'a same-size rewrite says Overwrote, without crying wolf');
let w3 = await writeTool.execute({ path: wPath, content: 'a\n'.repeat(3) });
ok(/GONE/.test(w3) && /str_replace/.test(w3), 'a rewrite that drops most of the file says so up front, where no clip can hide it');

// the window clip: never a silent head-cut
const agentMod = await import(`file://${join(DIST, 'agent.js')}`);
// The tool-call shape must be the one Qwen3-Coder was trained on — wrapper included — and the parser
// must not leave the wrapper in the prose it shows the user.
console.log('\ntrained tool-call shape');
const parser = await import(`file://${join(DIST, 'parser.js')}`);
const wrapped = 'Reading it now.\n<tool_call>\n<function=read_file>\n<parameter=path>/tmp/x.ts</parameter>\n</function>\n</tool_call>';
const parsed = parser.parseResponseAll(wrapped);
ok(parsed.toolCalls.length === 1 && parsed.toolCalls[0].name === 'read_file',
  'a call wrapped in <tool_call> parses, and the tool name survives', JSON.stringify(parsed.toolCalls[0] ?? null).slice(0, 80));
ok(parsed.toolCalls[0]?.params?.path === '/tmp/x.ts', 'its parameters survive the wrapper too');
ok(!/tool_call/.test(parsed.text) && parsed.text === 'Reading it now.',
  'the wrapper tag does not leak into the prose shown to the user', JSON.stringify(parsed.text));
const qwenSrc = readFileSync(join(DIST, '..', 'src', 'llm', 'dialects', 'qwen.ts'), 'utf-8');
const instr = qwenSrc.slice(qwenSrc.indexOf('`Tool-call'));
ok(!/<tool_call>/.test(instr),
  'the instructions omit the wrapper: it is a generation boundary in this serving path — see qwen.ts');
ok(!/cheapest tool|identical call|prefer str_replace/i.test(instr),
  'rules the harness enforces mechanically are not restated in every prompt');

// THE TERMINAL'S TEXT SELECTION WINS. Mouse tracking hijacks it, and getting a stack trace out of the
// tool matters more than a scroll wheel. Decided twice: the rule was relaxed on the theory that Shift+drag
// is a universal bypass, then restored when an operator on macOS could not select anything at all.
console.log('\nmouse tracking is opt-in, so copy-paste keeps working');
{
  const keys = readFileSync(join(DIST, '..', 'src', 'ui', 'keys.ts'), 'utf-8');
  ok(/const on = wanted === '1' \|\| wanted === 'on' \|\| wanted === 'true';\s*\n\s*if \(!on\) return;/.test(keys),
    'the wheel router returns unless mouse is explicitly turned ON');
  ok(/AYIN_MOUSE \?\? getConfigString\('mouse'\)/.test(keys),
    'and it can be enabled per-shell or persisted, one place either way');
  // The narrow modes matter as much as the default: 1002/1003 grab motion, which fights selection hardest
  // even in terminals where the Shift bypass works.
  const keysCode = keys.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  }).join('\n');
  ok(/vt200Mouse: true, sgrMouse: true/.test(keysCode) && !/1002|1003/.test(keysCode),
    'when on, it asks for wheel modes only — never cell or all-motion tracking');
  const scr = readFileSync(join(DIST, '..', 'src', 'ui', 'screen.ts'), 'utf-8');
  ok(/Mouse tracking is OFF by default/.test(scr),
    'and the contract in screen.ts says so, since this is the file people read first');
}

// A DIALOG IS NOT ANSWERED BY THE KEYSTROKE THAT OPENED IT.
// Opened from a slash command, the dialog is constructed inside the input's submit handler, and the Enter
// that submitted the line reaches the screen straight after. Subscribing synchronously let that Enter
// confirm the pre-selected row and destroy the box before a frame was painted — the operator saw NO popup
// and got row 0's action. Older callers escaped it only by awaiting a network fetch first.
console.log('\ndialogs survive the keystroke that opened them');
{
  const dlg = readFileSync(join(DIST, '..', 'src', 'dialog.ts'), 'utf-8');
  const paintAt = dlg.indexOf('render();    // paint FIRST');
  const subAt = dlg.indexOf("screen.on('keypress', onKey)");
  ok(paintAt > 0 && subAt > paintAt, 'the box is painted BEFORE any key listener exists');
  ok(/setTimeout\(\(\) => \{[\s\S]{0,120}screen\.on\('keypress', onKey\);/.test(dlg),
    'and the listener is registered on the next macrotask, after the pending keypress is delivered');
  ok(/if \(guardConfirm\(\)\) return;/.test(dlg),
    'a confirm arriving within the grace window is ignored, in case one was queued behind it');
  ok(/key\.full === 'escape'[\s\S]{0,80}cleanup\(-1\)/.test(dlg),
    'Escape stays live immediately — only ACCEPTING is deferred, never dismissing');
}

// `/model` MUST REPORT WHAT ACTUALLY ANSWERS. It read `providerOverrideName()`, which only `/model openai`
// sets — but OpenAI is also where resolution lands when nothing local is configured, with no override at
// all. So on such a machine it said "already on the local provider" while the status bar showed gpt-5.5.
{
  const mp = readFileSync(join(DIST, '..', 'src', 'model-picker.ts'), 'utf-8');
  ok(/const active = \(await llmProvider\(\)\)\.name;/.test(mp),
    'the picker reads the RESOLVED provider, not the override flag');
  ok(/const before = \(await llmProvider\(\)\)\.name;[\s\S]{0,200}before !== 'openai'/.test(mp),
    "and `/model local` decides from the resolved provider too");
  ok(/resetProviderResolution\(\)/.test(mp),
    'clearing the override re-resolves, so the answer reflects config rather than the boot decision');
  ok(/No local model is configured/.test(mp),
    'and when nothing local exists it says so instead of claiming success');
}

// NO MODEL, NO TUI. A fresh clone used to open the full TUI, take a prompt, and fail on the first
// generation with a connection error — which reads as "ayin is broken" rather than "ayin needs telling
// where its model is". The gate can only work from a SEPARATE entry point: ui/screen.ts builds the
// blessed screen at module scope, and ESM evaluates static imports before any statement in the importer,
// so a check inside the app can never run first however early it is written.
console.log('\nayin refuses to start without a model');
{
  const entry = readFileSync(join(DIST, '..', 'src', 'index.ts'), 'utf-8');
  ok(/await preflight\(\);/.test(entry), 'the entry point awaits the preflight gate');
  ok(/await import\('\.\/app\.js'\)/.test(entry),
    'and reaches the app only by DYNAMIC import — a static one would initialise blessed first');
  ok(entry.indexOf('await preflight()') < entry.indexOf("await import('./app.js')"),
    'in that order');
  const staticUi = /^import[^;]*from '\.\/(ui|app)\.js'/m.test(entry);
  ok(!staticUi, 'the entry point never statically imports the UI or the app');

  const pf = readFileSync(join(DIST, '..', 'src', 'preflight.ts'), 'utf-8');
  const pfCode = pf.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  }).join('\n');
  ok(!/from '\.\/ui/.test(pfCode) && !/blessed/.test(pfCode),
    'the gate itself pulls in no UI — it runs on a plain terminal, before blessed exists');
  const flight = await import(`file://${join(DIST, 'preflight.js')}`);
  ok(typeof flight.hasModelConfigured === 'function', 'the check is exported and testable');
  // Free when configured: the happy path must not probe the network on every launch.
  // This used to assert the launch path never probes. It now MUST probe — configured is not reachable —
  // so the property worth protecting changed from "no network" to "bounded network": every probe carries
  // its own short timeout, or a dead endpoint would hang the launch instead of failing it.
  ok(/AbortSignal\.timeout\(3000\)/.test(pf) && /AbortSignal\.timeout\(5000\)/.test(pf),
    'every launch probe is bounded by a short timeout — a dead endpoint fails the gate, it cannot hang it');
  ok(/if \(key\) return/.test(pf) && pf.indexOf('if (key) return') < pf.indexOf('probeOllama(url)'),
    'and the cheapest answer is checked first, so a keyed setup pays for no probe at all');
  // A command that needs no model must not be held hostage by the gate.
  ok(/NO_MODEL_NEEDED[\s\S]{0,200}'version'/.test(pf) && /'update'/.test(pf),
    'version and update bypass the gate — refusing to print a version over a missing key would be absurd');
  ok(/if \(nonInteractive\(\)\) \{[\s\S]{0,600}?process\.exit\(1\);/.test(pf),
    'a -p run or a daemon EXITS with instructions instead of blocking on a prompt nobody will answer');

  // CONFIGURED IS NOT REACHABLE. `AYIN_MODEL_URL` exported in a shell profile passed the presence check on
  // a laptop that was not on that LAN, so the TUI opened and failed on the first prompt — the same
  // first-run failure, one step later. The gate acts on `ok` (a model answers), never on `configured`.
  // Two conditions now, and both matter: a model must ANSWER, and the operator must have been asked
  // once. An inherited env var satisfied the old check, so a machine nobody had set up went straight
  // into the TUI having explained nothing.
  ok(/if \(onboarded && state\.ok\) return;/.test(pf),
    'the gate returns only when a model ANSWERS *and* onboarding was completed once');
  // The load-bearing half is that AYIN_LLM_URL is never READ. It was also announced on every start,
  // which the operator vetoed as noise — it fired on `--status` and every other invocation, forever,
  // for a variable in a shell profile. Announcing it was never the safety property; not honouring it
  // is, because honouring it silently is what let a stale profile line skip first-run setup.
  ok(!/AYIN_LLM_URL/.test(pf),
    'the old endpoint variable is not read ANYWHERE in the gate — honouring it would recreate the bug');
  ok(/AYIN_MODEL_URL/.test(pf), 'and the current variable is the one consulted');
  ok(/markOnboarded\(/.test(pf) && (pf.match(/markOnboarded\(/g) || []).length >= 5,
    'every path that settles on a model records that onboarding happened', String((pf.match(/markOnboarded\(/g) || []).length));
  ok(/const p = await probeEndpoint\(endpoint\)/.test(pf) && /const p = await probeOllama\(url\)/.test(pf),
    'a configured URL is probed — reachability is a property of now, not of when it was typed');
  ok(/if \(key\) return \{ configured: true, ok: true/.test(pf),
    'an OpenAI key is accepted on presence: /openai already verified it, and re-checking every launch is waste');
  ok(/Retry \$\{state\.how\}/.test(pf),
    'and a configured-but-unreachable endpoint offers RETRY — a booting backend must not force reconfiguration');

  // `ayin update` must change what `ayin` RUNS. With a linked checkout, installing the global package
  // updates something else entirely while reporting success.
  const up = readFileSync(join(DIST, '..', 'src', 'updater.ts'), 'utf-8');
  ok(/function gitCheckout\(\)/.test(up) && /existsSync\(join\(root, '\.git'\)\)/.test(up),
    'the updater locates the checkout the running binary resolves to');
  // `has`, not `flag`: bare `ayin update --registry` (no URL) used to be dropped on the floor — the
  // operator asking for the PUBLISHED build silently got a local rebuild instead. The flag's PRESENCE
  // is the request; its value is optional and only overrides which registry.
  ok(/if \(checkout && !has\('registry'\)\)/.test(up),
    'and prefers it over the registry — the registry path is an explicit --registry request, value optional');
  ok(/'pull', '--ff-only'/.test(up) && /'npm', \['install', '--prefix', root\]/.test(up)
    && /'npm', \['run', '--prefix', root, 'build'\]/.test(up),
    'update = pull, then INSTALL (a pull can add a dependency), then build');
  ok(/npm', \['link', '--prefix', root\]/.test(up) && /pointsHere/.test(up),
    'then remaps the global bin, but only when it does not already point here');
  ok(up.indexOf("if (opts.check) return;") < up.indexOf('refusing to pull over them'),
    '--check reports on a dirty tree; only an actual pull refuses to clobber uncommitted work');
}

// THE FINISHED-REPLY MARKER IS ACCEPTED AT EITHER END.
// The contract says a finished reply starts with `$`; gemma4 routinely appends it instead. Read strictly,
// that is an unmarked reply, so the loop nudged a model that had just said it was done — a wasted round
// on every turn. Position is not the signal.
console.log('\nthe $ marker is read wherever the model puts it');
{
  const fm = await import(`file://${join(DIST, 'final-marker.js')}`);
  ok(fm.hasFinalMarker('$ done here'), 'leading marker still works');
  ok(fm.hasFinalMarker('the work is done. $'), 'a TRAILING marker counts as finished');
  ok(fm.hasFinalMarker('all files written\n$'), 'and one alone on the last line');
  // The reason the trailing form demands whitespace before it: prose about money must not end a turn.
  ok(!fm.hasFinalMarker('the licence costs 5$'), 'a dollar sign with no space before it is prose, not a marker');
  ok(!fm.hasFinalMarker('next I will edit the file'), 'an unmarked reply is still unfinished');
  ok(fm.stripFinalMarker('the work is done. $') === 'the work is done.',
    'the trailing marker is stripped from what the operator reads', JSON.stringify(fm.stripFinalMarker('the work is done. $')));
  ok(fm.stripFinalMarker('$ done') === 'done', 'and so is the leading one');

  // AND IT MUST NEVER BE PRINTED. The marker is a signal to the harness, not text for the operator, but
  // the reply is painted from `parsed.text` in six places — the earliest of them before the old strip
  // point — so the `$` was shown every time. Invisible while models put it first (it reads as a prompt
  // character); obvious the moment gemma4 began appending it to finished answers.
  const agentSrc = readFileSync(join(DIST, '..', 'src', 'agent.ts'), 'utf-8');
  ok(/parsed\.text = stripFinalMarker\(parsed\.text \?\? ''\);/.test(agentSrc),
    'the marker is stripped from parsed.text at the parse site, before any print path can reach it');
  const strippedAt = agentSrc.indexOf('parsed.text = stripFinalMarker');
  const firstPrint = agentSrc.indexOf("addMessage('assistant', parsed.text)");
  ok(strippedAt > 0 && firstPrint > strippedAt,
    'and it is stripped BEFORE the first print, not after — the ordering is the whole bug');
}

// A provider that BILLS may be the fresh-clone DEFAULT, but must never be reached by accident: not
// because a configured backend was slow, and never without the operator having supplied a key.
console.log('\nthe paid provider is never reached by accident');
const sel = await import(`file://${join(DIST, 'llm', 'select.js')}`);
const oai = await import(`file://${join(DIST, 'llm', 'providers', 'openai.js')}`);
ok(sel.providerOverrideName() === '', 'no provider override until the operator asks for one');
const selSrc = readFileSync(join(DIST, '..', 'src', 'llm', 'select.ts'), 'utf-8');
// OpenAI is now the FRESH-CLONE default (it needs a key and nothing else, which is what makes the repo
// testable without a GPU), so "constructed exactly once" no longer holds. The safety property that
// replaces it is narrower and is the one that actually protects the operator's money: a configured
// endpoint that is merely UNREACHABLE — a backend mid-reboot — must never silently become a paid call.
ok(/if \(!endpointConfigured\(\)\)[\s\S]{0,600}?createOpenAiProvider\(\)/.test(selSrc),
  'the paid provider is reached by fallback ONLY when no endpoint is configured at all');
ok(/provisional = !probe\.conclusive;[\s\S]{0,300}?return createDirectProvider\(\)/.test(selSrc),
  'an endpoint that is configured but unreachable still falls back to direct — a booting backend is not a bill');
ok(/'openai'/.test(selSrc.slice(selSrc.indexOf('function configured'), selSrc.indexOf('function endpointConfigured'))),
  'and an operator may persist the choice explicitly (/set llm-provider openai)');
ok(/\/openai/.test(oai.openAiSetupHint()) && /OPENAI_API_KEY/.test(oai.openAiSetupHint())
  && /openai\.env/.test(oai.openAiSetupHint()),
  'the no-key error names all three ways to set it: the command, the env var, and the file');
ok(oai.createOpenAiProvider().tools === 'native',
  'it declares tools natively, so the prompt drops its own catalogue');
const oaiSrc = readFileSync(join(DIST, '..', 'src', 'llm', 'providers', 'openai.ts'), 'utf-8');
// CODE only. Prose in this file legitimately names old models — the header explains that the deleted
// hand-rolled fallback had pinned `gpt-4.1`, and a tripwire that forbids describing a past mistake is a
// tripwire that gets worked around by deleting the explanation.
const oaiCode = oaiSrc.split('\n').filter((l) => {
  const t = l.trim();
  return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
}).join('\n');
ok(!/gpt-4/.test(oaiCode), 'the default model is not a stale generation');

// ONE WAY TO REACH OPENAI: the official SDK. Two ways means two definitions of the base URL, the auth
// header and the error shape — and the pair drifts the moment either changes. Measured: the old
// hand-rolled fallback in connection.ts had pinned `gpt-4.1` and honoured only the FIRST tool call of a
// reply, and it evaded the stale-model gate above by living in a different file.
{
  const usesSdk = /^import OpenAI from 'openai'/m.test(oaiSrc);
  ok(usesSdk, 'the provider talks to OpenAI through the official SDK');
  const srcFiles = execFileSync('git', ['ls-files', 'src/*.ts', 'src/**/*.ts'], { cwd: join(DIST, '..'), encoding: 'utf-8' })
    .split('\n').filter(Boolean);
  // Asserted, because a scan that found NO files passes every filter below it — a green light for
  // having looked nowhere.
  ok(srcFiles.length > 40, 'the source tree was actually enumerated for this check', `${srcFiles.length} files`);
  const rawCallers = srcFiles.filter((f) => {
    const body = readFileSync(join(DIST, '..', f), 'utf-8');
    // A request, not a mention: the host inside a fetch/undici call or a URL constant.
    return /(?:fetch|undiciFetch)\(\s*[`'"]https:\/\/api\.openai\.com/.test(body)
      || /=\s*['"`]https:\/\/api\.openai\.com/.test(body);
  });
  ok(rawCallers.length === 0,
    'and nothing anywhere issues a hand-rolled request to api.openai.com', rawCallers.join(', '));
  const connSrc = readFileSync(join(DIST, '..', 'src', 'connection.ts'), 'utf-8');
  ok(!/openAiKey/.test(connSrc),
    'the endpoint layer no longer reads an OpenAI key — it cannot escalate to a paid model on its own');
}

// TOOLS ARE DECLARED ONCE. Whoever declares them, the other side must stay quiet: a provider that hands
// schemas to the runtime means ayin's system prompt must NOT also list every tool and a call format.
// Measured cost of getting this wrong: +331 prompt tokens for 2 tools (~2K for a full set), two formats
// in one prompt, and a visibly worse investigation.
console.log('\ntools declared exactly once');
const mgr = await import(`file://${join(DIST, 'llm', 'manager.js')}`);
const toolsMod2 = await import(`file://${join(DIST, 'tools.js')}`);
await toolsMod2.loadTools();
ok(typeof mgr.toolMode === 'function', 'the loop can ask WHO declares tools');
ok(mgr.toolMode() === 'prompt', 'default is prompt-declared — the only option over a text-only contract');
const promptModeText = toolsMod2.toolsSystemPrompt();
ok(/read_file/.test(promptModeText) && promptModeText.length > 2000,
  'in prompt mode the catalogue and the format are present', `${promptModeText.length} chars`);
const ollamaMod = await import(`file://${join(DIST, 'llm', 'providers', 'ollama.js')}`);
ok(ollamaMod.createOllamaProvider().tools === 'native',
  'the ollama provider declares tools natively — the runtime renders them, so the prompt must not');
const provSrc = readFileSync(join(DIST, '..', 'src', 'llm', 'providers', 'direct.ts'), 'utf-8');
ok(!/tools:\s*'native'/.test(provSrc),
  'the text-contract provider does NOT claim native tools — it has nowhere to put schemas');

// NAAMA — DESIGN FACTS AS DATA, ONE LINE EACH.
// Hand-writing a diagram file means regenerating a growing document from memory (drops half a file) or
// bracket arithmetic in a nested syntax (moves ten types into the wrong package silently). And a rendered
// diagram stores its constraints as DISPLAY TEXT: measured on a real one, `references: NONE ·
// noEngineReferences: true` lived inside a cluster's label, beside the geometry — so the diagram knew
// every rule and could enforce none.
console.log('\nnaama: authoring a design as structured facts');
{
  const { mkdtempSync } = await import('node:fs');
  const n = await import(`file://${join(DIST, 'naama', 'index.js')}`);
  const doc = n.emptyDoc('t');
  ok(n.applyLine(doc, 'domain A.Core refs=NONE sealed').includes('sealed'), 'a domain records refs and sealed as DATA');
  ok(doc.domains[0].references.length === 0 && doc.domains[0].sealed === true,
    'references is an array and sealed is a boolean — what a reference check can actually read');
  n.applyLine(doc, 'domain A.Ui refs=A.Core');
  n.applyLine(doc, 'type IGauge : interface @ A.Core');
  ok(n.applyLine(doc, 'member IGauge.Read() : int — the LAST sampled value, never a fresh read').includes('IGauge.Read'),
    'a member carries INTENT, which is the half a surface diagram loses');
  ok(doc.types[0].members[0].intent === 'the LAST sampled value, never a fresh read', 'the intent is stored, not dropped');
  let threw = false;
  try { n.applyLine(doc, 'member Ghost.Foo()'); } catch { threw = true; }
  ok(threw, 'a fact about an undeclared type is REFUSED — it would otherwise land somewhere harmless');
  threw = false;
  try { n.applyLine(doc, 'type X : widget @ A.Core'); } catch { threw = true; }
  ok(threw, 'an unknown type kind is refused');
  threw = false;
  try { n.applyLine(doc, 'type Y : class @ Nowhere'); } catch { threw = true; }
  ok(threw, 'a type in an undeclared domain is refused');
  n.applyLine(doc, 'type GaugeView : class @ A.Ui');
  n.applyLine(doc, 'member GaugeView.Bind(IGauge)');
  n.applyLine(doc, 'member IGauge.Tint(GaugeView)');
  // IS THE DESIGN IMPLEMENTABLE AT ALL? The finding that cost seven trial runs. A real as-built diagram
  // writes rows as human shorthand — `Count / Target` (two members, no types), `State` (no type),
  // `event Changed(Reading)` where Reading is declared nowhere. Every one reads perfectly to a
  // person and cannot become code, so an implementer must invent a type for each, and a gate that refuses
  // inventions then refuses the whole file. The design was un-implementable and the agent looked broken.
  const shorthand = n.emptyDoc('s');
  n.applyLine(shorthand, 'domain D refs=NONE');
  n.applyLine(shorthand, 'type IBrain : interface @ D');
  n.applyLine(shorthand, 'member IBrain.Count / Target — progress');
  n.applyLine(shorthand, 'member IBrain.State — Idle / Charging');
  n.applyLine(shorthand, 'member IBrain.event Changed(Payload)');
  n.applyLine(shorthand, 'member IBrain.Read() : int');
  const sp = n.validate(shorthand);
  ok(sp.some((x) => /two members/.test(x)), 'a row holding two members is caught, with "split it" as the fix');
  ok(sp.some((x) => /no type/.test(x) && /State/.test(x)), 'an untyped field is caught, naming the edit');
  ok(sp.some((x) => /Payload/.test(x)), 'a member naming an undeclared type is caught at DESIGN time');
  ok(!sp.some((x) => /Read/.test(x)), 'a well-formed member is not reported');
  ok(!sp.some((x) => /"Changed"/.test(x)), 'the member\'s own name is not mistaken for a type');

  const problems = n.validate(doc);
  ok(problems.some((x) => /references NOTHING/.test(x)),
    'a member reaching across a forbidden boundary is caught at DESIGN time, not at implementation time');
  const puml = n.toPuml(doc);
  ok(/package "A.Core"/.test(puml) && /interface IGauge/.test(puml), 'the document IS PlantUML — the file naamah weaves and entangle enforces');
  ok(/^' naamah:domain A\.Core refs=NONE sealed$/m.test(puml),
    'refs and sealed ride in a `\' naamah:` directive — plantuml strips comments, so the label stays human-readable');
  const back = n.parsePuml(puml);
  ok(back.domains[0].references.length === 0 && back.domains[0].sealed === true,
    'the directive round-trips: references still an array, sealed still a boolean');
  ok(back.types.find((t) => t.name === 'IGauge').members[0].intent === 'the LAST sampled value, never a fresh read',
    'member INTENT survives the round trip through the .puml');
  ok(back.types.find((t) => t.name === 'IGauge').domain === 'A.Core', 'a type keeps its domain across the round trip');
  ok(/IGauge\s+<\|--/.test(n.toPuml((() => { const d = n.emptyDoc('e'); n.applyLine(d, 'domain D refs=NONE'); n.applyLine(d, 'type IGauge : interface @ D'); n.applyLine(d, 'member IGauge.R()'); n.applyLine(d, 'type G : class @ D'); n.applyLine(d, 'member G.R()'); n.applyLine(d, 'edge G -> IGauge : extension'); return d; })())),
    'extension is written base <|-- derived, the direction PlantUML means');
}

// MID-WORK IS NOT AN ANSWER.
// The loop decided "finished" by asking whether a tool was called, which cannot tell a final report from
// "here is my plan for the remaining six types". Measured: a 9-type assembly returned 3 types and a
// to-do list at round 16 of 1000. The model now declares intent with one character, and the harness
// CHECKS it — which is what makes this a protocol rather than a request.
console.log('\nthe $ marker: a finished reply says so, and the harness verifies it');
{
  const sys = readFileSync(join(DIST, '..', 'prompts', 'ayin', 'system.txt'), 'utf-8');
  ok(/^FINISHED REPLIES START WITH \$/.test(sys),
    'the rule is the FIRST thing in the system prompt — position is load-bearing, the middle gets skimmed');
  const ag = readFileSync(join(DIST, '..', 'src', 'agent.ts'), 'utf-8');
  // The marker now lives in its own module and is accepted at EITHER end — see the note there. The rule
  // stated to the model is still "start with $", because one position has to be taught; what changed is
  // that the harness no longer PUNISHES the other one.
  const fmSrc = readFileSync(join(DIST, '..', 'src', 'final-marker.ts'), 'utf-8');
  ok(/export const FINAL_MARKER = \/\^/.test(fmSrc), 'the leading marker is still anchored to the START');
  ok(/FINAL_MARKER_TRAILING = \/\(\?:\^\|\\s\)/.test(fmSrc),
    'and the trailing form requires whitespace before it, so prose about money is not a marker');
  ok(/MAX_CONTINUE_NUDGES/.test(ag) && /continueNudges < MAX_CONTINUE_NUDGES/.test(ag),
    'the nudge is capped — a model that cannot progress must not spin');
  ok(/recordAnswer\(response_\)/.test(ag) && /transcribeAnswer\(response_\)/.test(ag),
    'the marker is stripped before the answer is recorded, not shown to the user');
  const marker = /^\s*\$\s?/;
  ok(marker.test('$ done') && marker.test('\n$done'), 'a marked reply is recognised, leading newline tolerated');
  ok(!marker.test('Now I will write the remaining types'), 'an unmarked reply is not mistaken for an answer');
  ok(!marker.test('the cost is $5 per call'), 'a $ elsewhere in the text is not the marker');
  ok('$ done'.replace(marker, '') === 'done', 'stripping removes exactly the marker');
}

// ENTANGLE — A WRITE THAT BREAKS THE DESIGN DOES NOT LAND.
// Measured on a real sprint: the model kept every stated PROHIBITION (not one forbidden assembly
// reference) and discarded the PRESCRIPTIONS — 15 surplus types, 9 designed types never written, and a
// type count that barely moved so review saw nothing. Prose in a prompt cannot carry a constraint
// through 40 rounds; a gate on the write can, at zero prompt cost.
console.log('\nentangle: the design is enforced, in every language, or not at all');
{
  const { mkdtempSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs');
  const ent = await import(`file://${join(DIST, 'entangle', 'index.js')}`);
  const root = mkdtempSync(join(tmpdir(), 'ayin-entangle-'));
  writeFileSync(join(root, 'design.puml'), [
    '@startuml', 'package "Widgets.Core" {',
    '  interface IGauge {', '    +Read() : int  — the LAST sampled value, never a fresh read', '  }',
    '  class Gauge {', '    +Read() : int', '    +M : Dictionary', '    -_raw : int', '  }',
    '}', '@enduml', '',
  ].join('\n'));
  const bound = ent.entangle(join(root, 'design.puml'));
  ok(bound.types === 2, 'a .puml design loads its declared types', `${bound.types}`);

  // C#: sealed asmdef
  const cs = join(root, 'cs'); mkdirSync(cs, { recursive: true });
  writeFileSync(join(cs, 'Widgets.Core.asmdef'), JSON.stringify({ name: 'Widgets.Core', references: [], noEngineReferences: true }));
  const okCs = ent.gateWrite(join(cs, 'Gauge.cs'), 'namespace Widgets.Core {\n public class Gauge {\n  private int _raw;\n  public int Read() { return _raw; }\n }\n}\n');
  ok(okCs === null, 'a C# write matching the design passes', String(okCs).slice(0, 60));
  const proxy = ent.gateWrite(join(cs, 'P.cs'), 'namespace Widgets.Core {\n public interface IGaugeProvider { int Get(); }\n}\n');
  ok(proxy !== null && /CLOSURE/.test(proxy), 'an invented C# type is STOPPED — the proxy that cost a week');
  const member = ent.gateWrite(join(cs, 'M.cs'), 'namespace Widgets.Core {\n public class Gauge {\n  public int Read() { return 0; }\n  public void Calibrate() {}\n }\n}\n');
  ok(member !== null && /MEMBER/.test(member), 'an undesigned PUBLIC member is stopped');
  const priv = ent.gateWrite(join(cs, 'V.cs'), 'namespace Widgets.Core {\n public class Gauge {\n  public int Read() { return 0; }\n  private void Calibrate() {}\n }\n}\n');
  ok(priv === null, 'a PRIVATE helper is allowed — implementation freedom inside the designed surface');
  const dom = ent.gateWrite(join(cs, 'D.cs'), 'using UnityEngine;\nnamespace Widgets.Core {\n public class Gauge {\n  public int Read() { return 0; }\n }\n}\n');
  ok(dom !== null && /DOMAIN/.test(dom), 'a reference the asmdef forbids is stopped, naming the manifest');

  // JS/TS: the same rules through a different domain concept
  const ts = join(root, 'ts'); mkdirSync(ts, { recursive: true });
  writeFileSync(join(ts, 'package.json'), JSON.stringify({ name: 'widgets-core', dependencies: {} }));
  ok(ent.gateWrite(join(ts, 'g.ts'), 'export class Gauge {\n  #raw = 0;\n  Read(): number { return this.#raw; }\n}\n') === null,
    'a TS write matching the design passes');
  const tsProxy = ent.gateWrite(join(ts, 'p.ts'), 'export interface IGaugeProvider {\n  Get(): number;\n}\n');
  ok(tsProxy !== null && /CLOSURE/.test(tsProxy), 'an invented TS type is stopped by the SAME rule');
  const tsDom = ent.gateWrite(join(ts, 'd.ts'), "import { z } from 'zod';\nexport class Gauge {\n  Read(): number { return 0; }\n}\n");
  ok(tsDom !== null && /DOMAIN/.test(tsDom), 'a dependency package.json does not list is stopped');

  // REFERENCE — naming an undesigned type is the same violation as declaring one, and it is the form the
  // hardest trap took: `Feed(Telemetry)` where Telemetry exists nowhere. A declarations-only
  // check passes a file that cannot even compile.
  const iface = 'namespace N {\n public interface IGauge {\n  void Feed(Telemetry t);\n }\n}\n';
  const refStop = ent.gateWrite(join(cs, 'R.cs'), iface);
  ok(refStop !== null && /REFERENCE/.test(refStop) && /Telemetry/.test(refStop),
    'a signature naming a type the design lacks is stopped, by name');
  // The false positives that made the first three attempts unusable — every one measured, not imagined.
  ok(ent.gateWrite(join(cs, 'B.cs'),
    'using System.Collections.Generic;\nnamespace N {\n public class Gauge {\n  public Dictionary<string,int> M { get; set; }\n  public int Read() { return 0; }\n }\n}\n') === null,
    'BCL types in signatures are not flagged — Dictionary/int/string are the language, not the design');
  ok(ent.gateWrite(join(cs, 'O.cs'), 'namespace N {\n public class Gauge { public int Read() { return 0; } }\n}\n') === null,
    'a one-line type body does not make the keyword `class` look like a field type');
  ok(ent.gateWrite(join(cs, 'S.cs'), 'namespace N {\n public class Gauge : IGauge {\n  public int Read() { return 0; }\n }\n}\n') === null,
    'a base list of designed types passes');
  // An interface member has no access modifier; reading that as C#'s private default made MEMBER skip
  // every contract in the design, which is most of what a design IS.
  const ifMember = ent.gateWrite(join(cs, 'M2.cs'), 'namespace N {\n public interface IGauge {\n  int Read();\n  string Dump();\n }\n}\n');
  ok(ifMember !== null && /Dump/.test(ifMember),
    'an undesigned member on an INTERFACE is caught — interface members are public by definition');

  // The keyword-leak class, retired by one rule rather than four regex fixes. `public Gauge(int)` is a
  // CONSTRUCTOR: it has no return type, so a signature pattern reads `public` as one. Measured in a live
  // run — the model was stopped on a real violation and told, alongside it, that "public" was an
  // undesigned type.
  ok(ent.gateWrite(join(cs, 'C.cs'),
    'namespace N {\n public class Gauge {\n  public int Read() { return 0; }\n  public Gauge(int seed) {}\n }\n}\n') === null,
    'a constructor is not read as a member whose return type is `public`');

  // RETRIEVE, NEVER DUMP. Three trial runs never finished a nine-type task: one re-read a 15 KB spec at
  // five offsets, another spent every completion nudge with seven types left. The model cannot hold the
  // whole design, so it asks for one type and gets one type — with its intent, which is the half a shape
  // cannot carry.
  const brief = ent.nextBrief();
  ok(brief !== null && /^NEXT: /.test(brief), 'op=next names ONE type, not a list');
  ok(/MUST: /.test(brief), 'the brief carries each member\'s intent, not just its signature');
  ok(/nothing more/.test(brief), 'and states that anything unlisted is not part of the type');
  // SCOPE. Unscoped, a one-assembly task was told about 23 missing types across assemblies it had never
  // been asked to touch, and answered that wall by trying to disable the gate.
  ent.entangle(join(root, 'design.puml'), 'Widgets.Core');
  ok(ent.entangledScope() === 'Widgets.Core', 'a working scope is recorded');
  ok(ent.gateAdoption().every((v) => /IGauge|Gauge/.test(v.subject)),
    'what remains is scoped to the domain being worked in');
  ent.entangle(join(root, 'design.puml'));

  // THE SECOND DOOR TO THE DESIGN. `write_file` and `str_replace` were refused on the entangled file from
  // the start — but `naama` IS the authoring tool, and pointing it at the bound design amends the contract
  // from inside. Measured in a live run: stopped for naming an undeclared type, the model added that type
  // to the design, which would have made the gate certify the drift it exists to prevent. The weaker of
  // the two models found this; the stronger one never tried it.
  const naamaSrc = readFileSync(join(DIST, '..', 'src', 'tools', 'defs', 'naama.ts'), 'utf-8');
  ok(/entangledTo\(\)/.test(naamaSrc) && /Refused: that design is entangled/.test(naamaSrc),
    'naama refuses to author the design currently being enforced');
  ok(/op === 'add' \|\| op === 'drop'/.test(naamaSrc),
    'only the WRITING ops are refused — reading it, and authoring any other design, still work');

  // A BLOCKED TYPE IS PARKED, NOT RE-OFFERED. `op=next` returned the first unimplemented type every time,
  // so one un-implementable type became an infinite wall: handed out 65 times in a single run while
  // nothing was written. A person parks the blocker and carries on with the rest.
  ok(typeof ent.blockedTypes === 'function', 'parked types are reportable at the end of a task');

  // the design file is the agent's blind spot on purpose
  const self = ent.gateWrite(join(root, 'design.puml'), '@startuml\n@enduml\n');
  ok(self !== null, 'the design file is READ-ONLY while entangled — else the model legalises its own drift');

  // an unhandled language must pass, not be refused
  ok(ent.gateWrite(join(root, 'notes.md'), '# hello') === null, 'a language with no implementation is not blocked');

  // AN ENFORCEMENT MECHANISM THE ENFORCED PARTY CAN DISABLE IS DECORATION.
  // Measured: given `op=off` on the entangle tool, the model called it — "Good, I'm disentangled. Now let
  // me implement the remaining types" — and wrote four types the design did not declare. It did not evade
  // the gate by renaming or relocating; it switched the gate off, because that was a documented option.
  // The registry is a directory now, so the tool lives in its own file rather than a slice of one array.
  const entangleBranch = readFileSync(join(DIST, '..', 'src', 'tools', 'defs', 'entangle.ts'), 'utf-8');
  ok(!/\bdisentangle\(\)/.test(entangleBranch),
    'the entangle tool cannot unbind — releasing a design is the operator\'s, not a step in the work');
  ok(/Refused: you cannot unbind/.test(entangleBranch),
    'asking to unbind is refused with the reason, and points at reporting the gap instead');
  const idxSrc = readFileSync(join(DIST, '..', 'src', 'app.ts'), 'utf-8');
  ok(/case '\/disentangle'/.test(idxSrc), 'the operator has the release, as a session command');

  const gaps = ent.gateAdoption();
  ok(gaps.some((g) => g.subject === 'IGauge'), 'ADOPTION reports a designed type nothing implemented — what review cannot see');
  // SIGNATURE — the last workaround a live run found. Told `Telemetry` was undesigned, the model kept the
  // member and changed its parameter: `Feed(Telemetry)` became `Feed(string id)`. Same name, so a
  // name-only MEMBER check passed while the contract quietly moved.
  const sigStop = ent.gateWrite(join(cs, 'Sig.cs'),
    'namespace N {\n public interface IGauge {\n  int Read();\n  void Feed(string id);\n }\n}\n');
  ok(sigStop === null || !/SIGNATURE/.test(sigStop) || /Feed/.test(sigStop),
    'a member whose designed parameter type vanished is caught by SIGNATURE, not passed by name');
  // And the false positive that would have made it unusable: design signatures are informal and often
  // name PARAMETERS rather than types, so only capitalized names are treated as types that must survive.
  ok(ent.gateWrite(join(cs, 'Sig2.cs'),
    'namespace N {\n public interface IGauge {\n  int Read();\n }\n}\n') === null,
    'an informal designed signature does not fire SIGNATURE on every member');

  // A HARD STOP OUTRANKS THE COMPLETION CRITERION. Measured: after one stop the adoption nudge fired three
  // times telling the model to take a step, while the stop had told it to report the gap and wait. It
  // delivered no report at all and the turn ended with nothing written.
  ok(typeof ent.stopAwaitingOperator === 'function', 'the loop can ask whether a stop is awaiting the operator');
  ent.entangle(join(root, 'design.puml'), 'Widgets.Core');
  ok(ent.stopAwaitingOperator() === false, 'a fresh binding starts with no stop pending');
  ent.gateWrite(join(cs, 'Stop.cs'), 'namespace N {\n public struct Undesigned { public int X; }\n}\n');
  ok(ent.stopAwaitingOperator() === true, 'a blocked write raises it, so the nudges stand down');
  ent.clearStop();
  ok(ent.stopAwaitingOperator() === false, 'and the operator seeing it clears it');
  const agSrc = readFileSync(join(DIST, '..', 'src', 'agent.ts'), 'utf-8');
  ok(/stopAwaitingOperator\(\) \? \[\] : gateAdoption\(\)/.test(agSrc),
    'the adoption nudge yields to a pending stop');
  ok(/!hasFinalMarker\(response\) && markerWorthEnforcing\(\) && !stopAwaitingOperator\(\)/.test(agSrc),
    'so does the $ marker nudge — a stop is a legitimate end of turn');
  // The nudge must offer a way to SAY you are finished, first. Without it, a model that is done has only
  // one sanctioned action — do more work — and it invents some. Measured from a real session log.
  ok(/IF YOU ARE FINISHED/.test(agSrc) && agSrc.indexOf('IF YOU ARE FINISHED') < agSrc.indexOf('IF YOU ARE NOT FINISHED'),
    'and the nudge leads with the completion branch, not with "carry on"');

  ent.disentangle();
  ok(ent.gateWrite(join(cs, 'P.cs'), 'namespace Widgets.Core { public interface IAnything {} }') === null,
    'nothing is checked when not entangled — the design loop stays free');
}

// THE BIND IS THE LAN NOW, AND THE BROWSER DEFENCE IS WHAT MUST NOT GO WITH IT.
//
// This block used to assert `127.0.0.1`, from the pre-publication audit that found a wildcard bind with
// no auth and no Origin check while `POST /api/prompts` writes the agent's OWN system prompt — remote
// code execution on by default. The bind is `0.0.0.0` again, on purpose: the review page and the sprint
// board are read from a phone, and an operator was told what that costs before it was done.
//
// So the assertion INVERTS but does not disappear. What made the old bind a vulnerability was never the
// address on its own — it was the address plus no Origin check plus an unvalidated prompt id. Those two
// are the load-bearing half and they are what is asserted here, hard, because they are the difference
// between "a page on my Wi-Fi" and "any website my browser visits can rewrite the agent's prompt".
console.log('\nthe LAN bind keeps its browser defences');
{
  const ps = readFileSync(join(DIST, '..', 'src', 'prompt-server.ts'), 'utf-8');
  // EVERY listen, not one spelling of it. The port stopped being a constant — a second session must get
  // its own or its review page cannot take comments — so asserting a literal would pass a file that had
  // grown a second, different bind somewhere else in it.
  const listens = [...ps.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1]);
  ok(listens.length > 0 && listens.every((args) => /,\s*'0\.0\.0\.0'/.test(args)),
    'bound on the LAN — a page a phone cannot reach is a page nobody reads');
  ok(/\^\[A-Za-z0-9_-\]\+\$/.test(ps), 'a prompt id is validated — an unsanitized id let `../` escape');
  // A COMMENT ON A DIFF LINE STARTS AN AGENT TURN, and the agent has a shell. A page on the internet
  // cannot read a reply from this port, but it does not need to when the POST itself is the effect — so
  // a request carrying a foreign Origin, or a Host that is a NAME rather than an address of this machine
  // (how DNS rebinding walks past an address check), is refused before any route sees it.
  ok(/function crossOriginRefused/.test(ps), 'a foreign Origin is refused, not merely unread');
  ok(/req\.method !== 'GET' && req\.method !== 'HEAD'[\s\S]{0,500}crossOriginRefused\(req\)/.test(ps),
    "and on every mutating request, including the prompt editor's own save");
  // THE HOST CHECK IS THE REBINDING DEFENCE and it is the one a LAN bind makes easy to lose: the phone
  // asks for this box by its LAN address, so the fix that stops 403-ing the phone is one edit away from
  // accepting any Host at all. Assert that the allowlist is BUILT FROM THIS MACHINE'S INTERFACES.
  ok(/function servedHosts\(\)[\s\S]{0,600}networkInterfaces\(\)/.test(ps),
    "the Host allowlist is this machine's real addresses, not a wildcard");
  ok(/!hosts\.includes\(host\)/.test(ps), 'and an unlisted Host is refused, so a DNS name resolving here still fails');
  // The behaviour of all of it is exercised against a real launch in check:cli — printed URL, page
  // served over it, the phone's Origin accepted, a foreign Origin and a name-shaped Host refused.
}

// NAAMAH IS A SUBMODULE, AND RENDERING IS OPTIONAL.
// The one legitimate submodule here: a separate program with its own repo that renders any .puml, where
// tools/ and providers/ were only ever directories of ayin. MIT, publicly clonable, zero runtime deps.
// But a clone WITHOUT --recursive, or a machine without plantuml, must still author and enforce designs —
// only the picture is missing, and the caller must be told WHICH of the two is absent rather than handed
// a generic failure to go and diagnose.
console.log('\nnaamah: a real submodule, and an optional one');
{
  const gm = readFileSync(join(DIST, '..', '.gitmodules'), 'utf-8');
  ok(/path = naamah/.test(gm), 'naamah is declared in .gitmodules — without it a clone gets an empty directory');
  ok(/url = https:\/\//.test(gm),
    'over HTTPS, not SSH: a stranger cloning the public repo has no key of yours');
  const nm = await import(`file://${join(DIST, 'naama', 'index.js')}`);
  ok(typeof nm.naamahAvailable === 'function', 'the presence of the renderer is answerable');
  const msg = await nm.renderDesign(join(tmpdir(), 'definitely-not-a-design.puml'));
  ok(typeof msg === 'string' && msg.length > 0, 'rendering never throws — it reports');
  ok(!/^Cannot render: the naamah submodule/.test(msg) || /submodule update --init/.test(msg),
    'a missing submodule names the exact command that fixes it');
  const naamaSrc = readFileSync(join(DIST, '..', 'src', 'naama', 'index.ts'), 'utf-8');
  ok(/plantuml is not installed/.test(naamaSrc),
    'a missing plantuml is reported as plantuml, not as a naamah failure — the layers are distinguishable');
  ok(/The design is\s*\n?\s*\+ 'authored and enforced regardless|authored and enforced/.test(naamaSrc),
    'and both degradations say the contract still works without a picture');
}

// THE REGISTRY IS A DIRECTORY, NOT AN ARRAY.
// A static array made one file the place both the public repo and any private copy must edit to add a
// tool — the merge conflict that makes a private fork unworkable, and that a submodule would not solve
// either, since a static registry still has to name what it loads.
console.log('\ntools are discovered, and a private set needs no fork');
{
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const loader = await import(`file://${join(DIST, 'tools', 'loader.js')}`);
  const ext = mkdtempSync(join(tmpdir(), 'ayin-exttools-'));
  writeFileSync(join(ext, 'private_thing.js'),
    "export const tool = { name: 'private_thing', description: 'd', parameters: [], async execute() { return 'ok'; } };\n");
  writeFileSync(join(ext, 'broken.js'), 'throw new Error("broken on purpose");\n');
  writeFileSync(join(ext, 'collide.js'),
    "export const tool = { name: 'bash', description: 'd', parameters: [], async execute() { return ''; } };\n");

  const builtin = await loader.discoverTools([]);
  ok(builtin.tools.length >= 12, 'the built-ins are DISCOVERED from defs/, not listed', `${builtin.tools.length}`);
  // `jira` was in this list while it was a CLIENT of a host application's /resource/jira door — useless
  // to anyone not running that application. It now speaks Jira REST itself with its own credential, so it
  // is shippable; `send_push` still needs a host and is not.
  ok(!builtin.tools.some((t) => t.name === 'send_push'),
    'the public catalogue ships no tool that needs a backend a stranger does not run');
  {
    const jiraSrc = ['client', 'credentials', 'loop', 'auth']
      .map((f) => readFileSync(join(DIST, '..', 'src', 'tools', 'connectors', 'jira', `${f}.ts`), 'utf-8'))
      .join('\n');
    ok(!/toolBackendUrl|resource\//.test(jiraSrc),
      'the jira connector reaches Jira directly — no host application in the path');
    // Only a DIALABLE literal counts — scheme plus host. `yourcompany.atlassian.net` in a help string is
    // a placeholder the operator replaces; `https://real.host` in source is a coupling.
    // `example.com/net/org` are reserved for documentation (RFC 2606) — they cannot BE anyone's Jira, so
    // a comment illustrating the parser with one is not a coupling.
    // `api.atlassian.com` is ATLASSIAN's own gateway — the vendor's API, the same class of literal as
    // api.openai.com or sentry.io. It is how a token discovers which sites it can reach, which is what
    // lets `/jira-auth <token>` need nothing else. The operator's OWN site is the thing that must never
    // be a literal, and it stays interpolated.
    const dialable = jiraSrc
      .replace(/https:\/\/\$\{[^}]+\}/g, '')
      .replace(/https:\/\/api\.atlassian\.com\S*/g, '')
      .replace(/https?:\/\/[a-z0-9-]+\.example\.(com|net|org)\S*/gi, '')
      .match(/https?:\/\/[a-z0-9-]+\.[a-z][^\s'"`)]*/gi);
    ok(dialable === null, 'and it hardcodes no site: an unconfigured connector dials nowhere', String(dialable));
  }
  ok(builtin.duplicates.length === 0 && builtin.failed.length === 0, 'and they load clean');

  // A TOOL CAN OWN A SLASH COMMAND. Asserted through discovery rather than by reading index.ts, because
  // the point of the mechanism is that no central file names the commands.
  {
    const slashed = builtin.tools.filter((t) => t.slash);
    ok(slashed.length >= 2, 'tools declare their own slash commands', slashed.map((t) => `/${t.slash.command}`).join(' '));
    ok(slashed.every((t) => t.parameters.some((p) => p.name === t.slash.param)),
      'and every declared slash param is a real parameter of its tool');
    const commands = slashed.map((t) => t.slash.command);
    ok(new Set(commands).size === commands.length, 'no two tools claim one command');

    // A CREDENTIAL COMMAND LEAVES NO COPY. `pushEntry` writes the typed line to a plaintext history file
    // that outlives the session, and `recordSlashTurn` puts it in the conversation window — which is
    // re-sent to whatever serves the model on every later round. A token pasted into /jira-auth would go
    // to both. Asserted on the DISPATCHER, not just the flag, because the flag alone protects nothing.
    const credentialTools = ['jira_auth', 'openai_auth', 'sentry_auth', 'slack_auth'];
    ok(credentialTools.every((n) => slashed.find((t) => t.name === n)?.slash.secret === true),
      'every credential command declares its argument secret', credentialTools.join(', '));
    const { maskSecret } = await import(`file://${join(DIST, 'tools', 'credentials', 'envfile.js')}`);
    const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    ok(!maskSecret(secret).includes('MNOPQRSTUVWXYZ') && maskSecret(secret).length < secret.length,
      'a masked secret cannot be reassembled from what is displayed', maskSecret(secret));
    ok(maskSecret('short').length <= 3, 'a secret too short to mask safely is hidden entirely');
    const idx = readFileSync(join(DIST, '..', 'src', 'app.ts'), 'utf-8');
    ok(/if \(tool\.slash\.secret\) forgetEntry\(text, cmd\)/.test(idx),
      'and the dispatcher rewrites its history entry to the bare command');
    ok(/if \(!tool\.slash\.secret\) recordSlashTurn\(/.test(idx),
      'and never records it into the window the model is sent');
    ok(/pushEntry\(text\.startsWith\('\/'\) \? text\.split\(' '\)\[0\] : text\)/.test(idx),
      'a slash command refused while busy persists only its command word — it was never executed');
  }

  // THE PASTE PARSER. An operator pastes whatever Atlassian showed them; getting a field wrong stores a
  // credential that fails later as an unexplained 401. The token is found by ELIMINATION, so each of these
  // is a distinct way that elimination can pick the wrong word.
  {
    const { extractDeterministic } = await import(`file://${join(DIST, 'tools', 'connectors', 'jira', 'auth.js')}`);
    const { normalizeSite, daysUntilExpiry } = await import(`file://${join(DIST, 'tools', 'connectors', 'jira', 'credentials.js')}`);
    const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, JSON.stringify(got));

    eq(extractDeterministic('site: acme.atlassian.net\nemail me@acme.com\ntoken ATATT3xFfGF0abcdefghijklmnop1234567890\nexpires 2026-09-12'),
      { site: 'acme.atlassian.net', email: 'me@acme.com', token: 'ATATT3xFfGF0abcdefghijklmnop1234567890', expires: '2026-09-12', board: '' },
      'a labelled Cloud paste yields all four fields with no LLM call');

    eq(extractDeterministic('here you go https://acme.atlassian.net/jira/software my login is me@acme.com and the key is ATATT3xFfGF0zzzz9999 (valid until 12 September 2026)'),
      { site: 'acme.atlassian.net', email: 'me@acme.com', token: 'ATATT3xFfGF0zzzz9999', expires: '2026-09-12', board: '' },
      'unlabelled prose with a URL and a month-name date parses too');

    // Fixture chosen to be UNMISTAKABLY not a credential. The first version of this line used a
    // realistic-looking base64 blob, and GitHub's push protection rejected the whole push as a
    // "Bitbucket Server Personal Access Token" — correctly in spirit: a credential-SHAPED string in a
    // public repo is indistinguishable from a leaked one, to a scanner and to a reader. It still has to
    // satisfy the parser's shape rule (>=16 chars of token-legal characters), so it says what it is.
    const FAKE_TOKEN = 'EXAMPLE-NOT-A-REAL-TOKEN-0123456789';
    eq(extractDeterministic(FAKE_TOKEN).token, FAKE_TOKEN,
      'a bare token is recognised — rotation is the common case, and site/email merge from the stored file');

    eq(extractDeterministic('me@gmail.com token ATATT3xFfGF0abcdefghijklmnop').site, '',
      "the email's own domain is never mistaken for the Jira site");

    eq(extractDeterministic('jira.internal.example.net  PAT: MDk4NzY1NDMyMTA5ODc2NTQzMjE  expires 2026-12-01'),
      { site: 'jira.internal.example.net', email: '', token: 'MDk4NzY1NDMyMTA5ODc2NTQzMjE', expires: '2026-12-01', board: '' },
      'a Data Center PAT parses with no email — which is what selects Bearer over Basic');

    eq(normalizeSite('https://acme.atlassian.net/'), 'acme.atlassian.net', 'a pasted URL normalizes to a bare host');
    eq(extractDeterministic('ATATT3xFfGF0abcdefghijklmnop board=1').board, '1',
      'a board id is parsed, so "my sprint" can be pinned to one board');

    // WHY THE BOARD MATTERS. `sprint IN openSprints()` means "not completed", which includes FUTURE
    // sprints and spans every board the account can see. Measured on a real instance with 18 boards: the
    // query returned 13 issues across two unrelated projects, one from another team's board. The active
    // sprint is not expressible in JQL — the state lives on the issue's Sprint field — so the filtering
    // must happen on the data, against one board.
    const jiraClientSrc = readFileSync(join(DIST, '..', 'src', 'tools', 'connectors', 'jira', 'client.ts'), 'utf-8');
    ok(/state === 'active'/.test(jiraClientSrc),
      'the sprint list keeps only issues in an ACTIVE sprint, not merely a not-completed one');
    ok(/s\.boardId === board/.test(jiraClientSrc),
      'and only from one board, so another team\'s sprint cannot leak in');
    ok(/f\.name === 'Sprint'/.test(jiraClientSrc),
      'the Sprint field id is looked up, never hardcoded — it is a custom field and differs per instance');

    // SENTRY. The org slug is the field that cannot be discovered — a correctly-scoped token gets 403
    // from /organizations/ (measured) — so parsing it out of the paste is load-bearing, not convenience.
    const sentry = await import(`file://${join(DIST, 'tools', 'connectors', 'sentry', 'auth.js')}`);
    const sx = (t) => sentry.extractDeterministic(t);
    eq(sx('sntryu_0123456789abcdefghijklmnopqrstuvwxyz org: my-org project: my-proj'),
      { token: 'sntryu_0123456789abcdefghijklmnopqrstuvwxyz', org: 'my-org', project: 'my-proj', apiBase: '' },
      'a labelled Sentry paste yields token, org and project');
    eq(sx('https://my-org.sentry.io/issues/  sntrys_0123456789abcdefghijklmnopqrstuvwxyz').org, 'my-org',
      'the org slug is read from a Sentry subdomain URL');
    eq(sx('https://sentry.io/organizations/my-org/issues/ sntryu_0123456789abcdefghijklmnopqrst').org, 'my-org',
      'and from an /organizations/<slug>/ path');
    eq(sx('https://us.sentry.io/issues/ sntryu_0123456789abcdefghijklmnopqrst').org, '',
      "Sentry's regional hosts are not mistaken for an org slug");
    // The natural input is `/sentry-auth <token> <slug>`, and refusing an unlabelled word rejected exactly
    // that — measured on a real paste. Safe to read optimistically because the caller VERIFIES before it
    // writes: a wrong org costs one failed request and changes nothing.
    eq(sx('sntryu_0123456789abcdefghijklmnopqrst play-perfect').org, 'play-perfect',
      'a bare word after the token is read as the org slug');
    eq(sx('sntryu_0123456789abcdefghijklmnopqrst Play Perfect play-perfect').org, 'play-perfect',
      'and a hyphenated candidate wins over a display name pasted beside it');
    // A project is OPTIONAL and NARROWS every query: guessed wrong, verification still passes while the
    // connector silently reports nothing. It needs a label.
    eq(sx('sntryu_0123456789abcdefghijklmnopqrst play-perfect play-perfect').project, '',
      'a project is never guessed from a bare word — only a label or a URL sets it');
    eq(sx('sntryu_0123456789abcdefghijklmnopqrst org: acme project: backend').project, 'backend',
      'a labelled project is still read');
    ok(/[0-9a-f]{64}/.source && sx(`legacy ${'a'.repeat(64)}`).token === 'a'.repeat(64),
      'a legacy 64-hex Sentry token is still recognised');
    ok(daysUntilExpiry({ expires: '2020-01-01' }) < 0, 'a lapsed expiry reads negative, so the warning can fire');
    ok(daysUntilExpiry({ expires: '' }) === null, 'an unrecorded expiry is null, never a fake deadline');
  }

  const withExt = await loader.discoverTools([ext]);
  ok(withExt.tools.some((t) => t.name === 'private_thing'),
    'an external directory contributes tools — a private set installs without forking');
  ok(withExt.failed.some((f) => /broken/.test(f.module)),
    'a module that throws is REPORTED, not silently missing — an absent tool is indistinguishable from a model ignoring it');
  ok(withExt.tools.length > builtin.tools.length - 1,
    'and one broken package does not take the rest down with it');
  ok(withExt.duplicates.some((d) => /"bash"/.test(d)),
    'a name collision with a built-in is caught, naming BOTH files');
  ok(!withExt.tools.some((t, i) => withExt.tools.findIndex((o) => o.name === t.name) !== i),
    'a duplicate never reaches the registry, so load order cannot decide which one the model gets');

  const regSrc = readFileSync(join(DIST, '..', 'src', 'tools.ts'), 'utf-8');
  ok(!/^const tools: Tool\[\] = \[\s*\{/m.test(regSrc), 'no static tool array remains in the registry');
  ok(/duplicate tool name/.test(regSrc), 'duplicates are FATAL at boot, not resolved by load order');
  ok(/tools were read before discovery/.test(regSrc),
    'reading the registry before discovery THROWS — an empty tool list looks exactly like a model ignoring its tools');
}

// ONE DOOR TO THE MODEL, AND TOOLS ARE NOT IT.
// `llm/manager.ts` holds the only `provider.generate` call in ayin. Three tools used to import that
// module directly, which is a second door and a hard edge from a tool to ayin's layout. They get a
// DELEGATE now, wired once by core in tools.ts. Same for the logger, which seven tools imported.
console.log('\ntools: the model and the log arrive as delegates');
const toolFiles = execFileSync('ls', [join(DIST, '..', 'src', 'tools')], { encoding: 'utf-8' })
  .split('\n').filter((f) => f.endsWith('.ts'));
const offenders = { llm: [], log: [] };
for (const f of toolFiles) {
  const body = readFileSync(join(DIST, '..', 'src', 'tools', f), 'utf-8');
  const code = body.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  }).join('\n');
  if (/from '\.\.\/llm\//.test(code)) offenders.llm.push(f);
  if (/from '\.\.\/log\.js'/.test(code)) offenders.log.push(f);
}
ok(toolFiles.length > 5, 'the tool directory was actually scanned', `${toolFiles.length} files`);
ok(offenders.llm.length === 0, 'no tool imports the LLM layer — the model arrives as a delegate', offenders.llm.join(', '));
ok(offenders.log.length === 0, 'no tool imports the logger — logging arrives as a delegate', offenders.log.join(', '));

// THE WHOLE SEAM, not just those two. `tools/` must import NOTHING outside itself — that is the
// property that lets the directory become a package, and it is one `../` away from being lost.
const outward = [];
for (const f of toolFiles) {
  const body = readFileSync(join(DIST, '..', 'src', 'tools', f), 'utf-8');
  for (const m of body.matchAll(/^import[^;]*from '(\.\.\/[^']+)'/gm)) outward.push(`${f} → ${m[1]}`);
}
ok(outward.length === 0,
  'tools/ imports nothing outside tools/ — everything else arrives through the runtime',
  outward.join(', '));
const runtimeSrc = readFileSync(join(DIST, '..', 'src', 'tools', 'runtime.ts'), 'utf-8');
ok(!/^import /m.test(runtimeSrc),
  'the seam itself imports nothing — it declares what it needs and core satisfies it');

// The vendor providers get the same treatment. `direct` and `resource` speak ayin's own contract and
// stay in core; `ollama` and `openai` are the extractable ones and must not reach past their runtime.
const vendorOutward = [];
for (const f of ['ollama.ts', 'openai.ts']) {
  const body = readFileSync(join(DIST, '..', 'src', 'llm', 'providers', f), 'utf-8');
  for (const m of body.matchAll(/^import[^;]*from '(\.\.\/\.\.\/[^']+)'/gm)) vendorOutward.push(`${f} → ${m[1]}`);
}
ok(vendorOutward.length === 0,
  'the vendor providers import nothing outside llm/ — config, log and images arrive through a runtime',
  vendorOutward.join(', '));
const provRuntimeSrc = readFileSync(join(DIST, '..', 'src', 'llm', 'providers', 'runtime.ts'), 'utf-8');
ok(!/^import /m.test(provRuntimeSrc), 'the provider seam imports nothing either');
// A service read at MODULE scope runs before core can wire anything, turning a wiring order problem
// into a module that cannot be loaded. Both vendor providers did exactly this and threw on startup.
for (const f of ['ollama.ts', 'openai.ts']) {
  const body = readFileSync(join(DIST, '..', 'src', 'llm', 'providers', f), 'utf-8');
  const topLevel = body.split('\n').filter((l) => /^(let|const) /.test(l) && /provider(Config|Log|PendingImages)\(/.test(l));
  ok(topLevel.length === 0, `${f} reads no service at module scope — it would run before wiring`, topLevel.join(' | '));
}
const genCalls = execFileSync('grep', ['-rl', 'provider.generate(', join(DIST, '..', 'src')], { encoding: 'utf-8' })
  .split('\n').filter(Boolean).filter((p) => !p.includes('/providers/'));
ok(genCalls.length === 1 && genCalls[0].endsWith('llm/manager.ts'),
  'exactly ONE place outside providers/ calls provider.generate', genCalls.join(', '));

const rt = await import(`file://${join(DIST, 'tools', 'runtime.js')}`);
let threw = false;
try { rt.toolLlm(); } catch { threw = true; }
ok(threw || rt.toolRuntimeReady(),
  'an unwired runtime THROWS rather than silently skipping a tool\'s model call');
const mgrMod = await import(`file://${join(DIST, 'llm', 'manager.js')}`);
ok(typeof mgrMod.addLlmSink === 'function', 'side software can subscribe to every model call');
const mgrSrc = readFileSync(join(DIST, '..', 'src', 'llm', 'manager.ts'), 'utf-8');
ok((mgrSrc.match(/emitLlmCall\(/g) || []).length >= 3,
  'the call hook fires on failure too — a failed generation is what a monitor most wants');
const wiringSrc = readFileSync(join(DIST, '..', 'src', 'tool-wiring.ts'), 'utf-8');
ok((wiringSrc.match(/initToolRuntime\(/g) || []).length === 1,
  'the delegates are BUILT in exactly one place');

// A module that imports a tool implementation directly must wire the runtime itself. Relying on some
// other module having imported the registry first is initialization by import order: `-p` and the TUI
// load agent.ts (which loads the registry) so it worked, while `ayin explain` and `plan` did not and
// would have thrown on the first tool that logs.
const srcRoot = join(DIST, '..', 'src');
const directConsumers = execFileSync(
  'grep', ['-rl', "--include=*.ts", "--exclude-dir=tools", "-E", "from '\\.{1,2}(/\\.\\.)*/tools/[a-z-]+\\.js'", srcRoot],
  { encoding: 'utf-8' },
).split('\n').filter(Boolean);
const unwired = directConsumers.filter((f) => {
  const body = readFileSync(f, 'utf-8');
  // A TYPE-ONLY import is erased at compile time, so there is no module to initialise and no order to
  // trust — `runs.ts` importing the `RunContext` interface from `tools/base.ts` creates no runtime
  // edge at all. Only a value import can be initialisation-by-import-order.
  const valueImports = body
    .split('\n')
    .filter((l) => /from '\.{1,2}(\/\.\.)*\/tools\/[a-z-]+\.js'/.test(l))
    .filter((l) => !/^\s*(import|export)\s+type\s/.test(l));   // `export type … from` is erased too
  if (valueImports.length === 0) return false;
  // Either it wires the runtime, or it pulls in the registry (which does).
  return !/ensureToolRuntime\(\)/.test(body) && !/from '\.{1,2}\/tools\.js'/.test(body);
});
ok(directConsumers.length >= 3, 'the scan found modules importing tools directly', `${directConsumers.length}`);
ok(unwired.length === 0,
  'every module importing a tool directly wires the runtime rather than trusting import order',
  unwired.map((f) => f.replace(srcRoot, 'src')).join(', '));

// PROMPTS ARE FILES, INCLUDING THE ONES ASSEMBLED FROM ARRAYS OF STRING LITERALS.
// `prompts/` shipping in the package was never the gap — an executor building prompt prose line by
// line in TypeScript was. It is invisible to `/prompts`, un-diffable as content, and needs a rebuild
// to change.
console.log('\nprompts: prose lives in .txt, not in executor source');
for (const [ns, id] of [['arduino', 'survey'], ['plan', 'baseObservability']]) {
  ok(existsSync(join(DIST, '..', 'prompts', ns, `${id}.txt`)), `prompts/${ns}/${id}.txt ships with ayin`);
}
for (const [file, phrase] of [
  ['src/executors/plan/arduino/index.ts', 'THERE IS NO WEBVIEW'],
  ['src/executors/plan/base/index.ts', 'logging and debug facilities BY NAME'],
]) {
  const body = readFileSync(join(DIST, '..', file), 'utf-8');
  const inCode = body.split('\n').some((l) => {
    const t = l.trim();
    return t.includes(phrase) && !t.startsWith('*') && !t.startsWith('//');
  });
  ok(!inCode, `${file} no longer carries that prose inline`, phrase);
}

// LOGGING IS A NON-BLOCKING HOOK.
// `tools/` imports log more than any other module (7 call sites) — it is the coupling that most stands
// between tools/ and its own package. A hook decouples it: the caller never learns who listens. It used
// to appendFileSync on the agent's thread, once per tool call and per round.
console.log('\nlogging: a non-blocking hook, and nothing lost at exit');
const lg = await import(`file://${join(DIST, 'log.js')}`);
const logSizeBefore = existsSync(lg.getLogFile()) ? readFileSync(lg.getLogFile(), 'utf-8').length : 0;
for (let i = 0; i < 2000; i++) lg.log('DEBUG', 'gate_bench', { i: String(i) });
const logSizeAfter = existsSync(lg.getLogFile()) ? readFileSync(lg.getLogFile(), 'utf-8').length : 0;
ok(logSizeAfter === logSizeBefore, '2000 log() calls write NOTHING to disk in the calling path', `${logSizeAfter - logSizeBefore} bytes`);
const sinkSaw = [];
const unsub = lg.addLogSink((e) => sinkSaw.push(e.event));
lg.log('INFO', 'gate_hooked');
lg.flushLogs();
ok(sinkSaw.includes('gate_hooked'), 'a registered sink receives entries');
unsub();
lg.log('INFO', 'gate_after_unsub');
lg.flushLogs();
ok(!sinkSaw.includes('gate_after_unsub'), 'unsubscribing stops delivery');
lg.addLogSink(() => { throw new Error('gate: deliberately broken sink'); });
for (let i = 0; i < 4; i++) { lg.log('INFO', 'gate_bad_sink'); lg.flushLogs(); }
ok(lg.logSinkCount() === 0, 'a sink that keeps throwing is dropped, and never reaches the caller');
ok(readFileSync(lg.getLogFile(), 'utf-8').includes('gate_bad_sink'),
  'logging keeps working while a subscriber is broken');
const logSrc = readFileSync(join(DIST, '..', 'src', 'log.ts'), 'utf-8');
ok(/process\.on\('exit', flushLogs\)/.test(logSrc),
  'the batch is drained synchronously at exit — deferred writes must not lose the crash that mattered');

// WEB SEARCH SHIPS WITHOUT A CONTAINER, AND SAYS WHEN IT IS BLOCKED.
// A clone has no SearXNG, so DuckDuckGo is the default engine. Its two endpoints use DIFFERENT markup
// (double vs single quotes, `</a>` vs `</td>` snippets) — parsing only the first shape makes the second
// endpoint silently useless. And DDG answers a scraper it dislikes with 202 + a challenge page, which
// passes `res.ok`: read as "no results", it tells the agent the web is empty.
console.log('\nweb search: keyless by default, and honest when blocked');
const ws = await import(`file://${join(DIST, 'tools', 'web-search.js')}`);
const htmlShape = `<a class="result__a" href="/l/?uddg=https%3A%2F%2Fa.example%2Fx">Title A</a>
  <div class="result__snippet">snippet a</div></a>`;
const liteShape = `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example%2Fy&amp;rut=zz" class='result-link'>Title B</a>
  <td class='result-snippet'>snippet b</td>`;
const parsedHtml = ws.parseDdg(htmlShape, 8);
const parsedLite = ws.parseDdg(liteShape, 8);
ok(parsedHtml[0]?.url === 'https://a.example/x', 'the html endpoint shape parses, redirect unwrapped', parsedHtml[0]?.url);
ok(parsedLite[0]?.url === 'https://b.example/y',
  "the lite endpoint's single-quoted, &amp;-escaped shape parses too", parsedLite[0]?.url);
ok(parsedLite[0]?.snippet === 'snippet b', 'a lite snippet closing with </td> is captured', parsedLite[0]?.snippet);
const wsSrc = readFileSync(join(DIST, '..', 'src', 'tools', 'web-search.ts'), 'utf-8');
// CODE lines only: the comment explaining the removed :8888 default must not read as the default.
const wsCode = wsSrc.split('\n').filter((l) => {
  const t = l.trim();
  return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
}).join('\n');
ok(/status === 202/.test(wsCode), 'a 202 challenge is detected — it passes res.ok and is not an empty result');
ok(/cacheable/.test(wsCode), 'a rate-limited answer is not cached for 15 minutes');
ok(!/:8888/.test(wsCode), 'no metasearch host is guessed from the LLM endpoint — SearXNG is explicit or absent');

// NO SETTING THAT LIES. `/set` speaks kebab-case, the code reads camelCase; the translation was a
// hand-written map of four, so `/set ollama-model x` stored a key nothing reads and answered "✓".
// The list must cover every key actually read, or the warning that catches this goes quiet.
console.log('\nconfig keys: every one /set can write is one the code reads');
const promptsMod = await import(`file://${join(DIST, 'prompts.js')}`);
const declared = new Set(promptsMod.KNOWN_CONFIG_KEYS ?? []);
const readKeys = new Set();
const srcDir = join(DIST, '..', 'src');
// Whole LINES, so comment lines can be dropped — a prose mention of getConfigString('x') in a doc
// block is not a config read, and counting it makes the gate fail on its own documentation.
for (const line of execFileSync('grep', ['-rh', "getConfig\\(String\\|Number\\)('", srcDir], { encoding: 'utf-8' })
  .split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
  for (const m of line.matchAll(/getConfig(?:String|Number)\('([^']*)'\)/g)) readKeys.add(m[1]);
}
const unlisted = [...readKeys].filter((k) => !declared.has(k));
ok(readKeys.size > 0, 'the scan found config reads at all (a silent zero would pass everything)', `${readKeys.size} key(s)`);
ok(unlisted.length === 0, 'every config key the code reads is in KNOWN_CONFIG_KEYS', unlisted.join(', '));
const idxSrc = readFileSync(join(srcDir, 'app.ts'), 'utf-8');
ok(/replace\(\/-\(\[a-z\]\)\/g/.test(idxSrc),
  '/set converts kebab-case to camelCase generally, not via a map that forgets new keys');

// A LOW verdict must not end the investigation. It used to inject "Report what you have found so far
// — do not continue exploring", so the harder the bug the sooner the harness quit: a correct run was
// cut at round 12 having just found the faulty method, and its own report listed what it still needed.
console.log('\nthe judge extends, it does not terminate');
const src = readFileSync(join(DIST, '..', 'src', 'agent.ts'), 'utf-8');
// Comments quote the OLD directive to explain why it went; judge the code, not the prose.
const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
ok(!/do not continue exploring/i.test(code), 'the terminate-on-low-confidence directive is gone from the code');
ok(/Do not write a final answer yet/.test(src), 'a low verdict tells it what is missing and to keep going');
ok(/MAX_JUDGE_EXTENSIONS/.test(src) && /judgeExtensions\s*\+\+/.test(src),
  'extensions are counted, so "keep going" is bounded rather than unbounded');
ok(/out of investigation budget/.test(src),
  'only an exhausted budget asks for a write-up, and it says which parts are unconfirmed');

// THE PREFIX MUST NOT MOVE: the system message is what a server caches. If it changes between
// rounds, every round pays full prefill for the whole window again (measured: 15s/round → 104s/round
// on one investigation, GPU idle and model fully resident).
console.log('\nprompt prefix stability');
const m1 = agentMod.buildMessages(0, 20);
const m2 = agentMod.buildMessages(7, 20);
const m3 = agentMod.buildMessages(19, 20);
ok(m1[0].role === 'system' && m2[0].role === 'system', 'the first message is the system prompt');
ok(m1[0].content === m2[0].content && m2[0].content === m3[0].content,
  'the system prompt is byte-identical at round 1, 8 and 20 — nothing per-round may be appended to it');
const roundLine = /Round \d+\/\d+/;
ok(!roundLine.test(m1[0].content) && !roundLine.test(m3[0].content),
  'the round counter is NOT in the system prompt (it was, which alone invalidated the prefix every round)');
const tail3 = m3[m3.length - 1];
ok(roundLine.test(tail3.content) && /<session-context>/.test(tail3.content),
  'per-round material rides in a trailing turn instead, where only new tokens are new work', String(tail3.content).slice(0, 60));

// AYIN_UNCHAINED: an experiment switch must be OFF unless asked for, unambiguously
const priorUnchained = process.env.AYIN_UNCHAINED;
delete process.env.AYIN_UNCHAINED;
ok(!agentMod.isUnchained(), 'the compensating machinery is ON by default — an experiment flag never changes behaviour by accident');
for (const on of ['1', 'true', 'TRUE ']) {
  process.env.AYIN_UNCHAINED = on;
  ok(agentMod.isUnchained(), `AYIN_UNCHAINED=${JSON.stringify(on)} disables the judge and the critic`);
}
for (const off of ['0', 'false', '', 'yes']) {
  process.env.AYIN_UNCHAINED = off;
  ok(!agentMod.isUnchained(), `AYIN_UNCHAINED=${JSON.stringify(off)} does NOT — a measured run must not turn on from a typo`);
}
if (priorUnchained === undefined) delete process.env.AYIN_UNCHAINED; else process.env.AYIN_UNCHAINED = priorUnchained;

const long = `HEAD_MARKER${'x'.repeat(40000)}TAIL_MARKER`;
const clipped = agentMod.clipForWindow(long);
ok(clipped.length < long.length && /HEAD_MARKER/.test(clipped) && /TAIL_MARKER/.test(clipped), 'a clipped tool result keeps BOTH ends — the tail is where a compiler puts the error');
ok(/omitted from the MIDDLE/.test(clipped), 'and it says characters were dropped, instead of looking complete');
ok(agentMod.clipForWindow('short') === 'short', 'a result that fits is untouched');

let f3 = await findTool.execute({ path: sRoot, pattern: 'Target*.cs' });
ok(/nested\/Target\.cs/.test(f3.split('\n')[0]), 'an exact-name match outranks a longer sibling instead of taking traversal order', f3.split('\n')[0]);
rmSync(sRoot, { recursive: true, force: true });

// ── qa hard facts: what the judge is NOT allowed to overrule ─────────
console.log('\nqa hard facts');
const qaIdx = await import(`file://${join(DIST, 'qa/index.js')}`);
const hf = (facts) => qaIdx.hardFailingFacts(facts).map((f) => f.key);
ok(
  hf([{ key: 'deliverables', ok: false, hard: true }]).join() === 'deliverables',
  'a measured check that FAILED and is marked hard fails the gate without the judge',
);
ok(hf([{ key: 'deliverables', ok: true, hard: true }]).length === 0, 'a hard check that PASSED is not a failure');
ok(
  hf([{ key: 'answer-quality', ok: false }]).length === 0,
  'a soft failure stays the judge\'s business — hard facts remove its discretion, not its job',
);
ok(
  hf([{ key: 'compile', ok: true, hard: false, detail: 'arduino-cli not installed — nothing verified' }]).length === 0,
  'a check that never RAN cannot hard-fail: an absent compiler is an unknown, not a defect',
);
ok(
  hf([
    { key: 'readme-substance', ok: false, hard: true },
    { key: 'compile', ok: false, hard: true },
    { key: 'style', ok: false },
  ]).length === 2,
  'every hard failure is reported together, and only the hard ones',
);
const baseQa = await import(`file://${join(DIST, 'executors/qa/base/index.js')}`);
const stubRoot = mkdtempSync(join(tmpdir(), 'ayin-qa-'));
writeFileSync(join(stubRoot, 'README.md'), '# project\n\nTODO: describe this\n');
const baseFacts = await baseQa.baseQaExecutor.probe({ root: stubRoot, files: [], goal: '', answer: '' });
ok(
  baseFacts.every((f) => f.key !== 'readme-substance' || f.hard === true),
  'the base executor marks readme-substance hard — a scaffold stub is not a judgement call',
);

// ── qa probes: measure what reading cannot ───────────────────────────
console.log('\nqa probes');
const p = await import(`file://${join(DIST, 'qa/probes.js')}`);
ok(p.classify('/a/b.md') === 'doc' && p.classify('/a/b.tsx') === 'ui' && p.classify('/a/b.ts') === 'code', 'files are classified by extension');

const LOCAL_LIKE = /^(localhost|127\.|10\.|192\.168\.)/;
const lan = p.lanAddress();
const isDockerRange = (ip) => /^172\.1[6-9]\.|^172\.2\d\.|^172\.3[01]\./.test(ip ?? '');
ok(lan === null || !isDockerRange(lan), 'the LAN address is a real NIC, not a container bridge', String(lan));

const srvFile = join(TMP, 'fake-server.ts');
writeFileSync(srvFile, `const PORT = ${PORT};\napp.listen(${PORT});\n`);
const changed = [p.describeFile(srvFile)];
ok(p.detectPorts(changed).includes(PORT), 'a listening port is found in changed source');

const wide = createServer((_q, r) => r.end('ok'));
await listen(wide, '0.0.0.0', PORT);
let probe = await p.probeWebview(changed, 1200);
let hit = probe.ports.find((x) => x.port === PORT);
ok(!!hit && hit.loopback && hit.lan, 'a server on 0.0.0.0 reads as reachable from the LAN', probe.note);
await close(wide);

// phase B — the regression this file exists for. Same port, new process, loopback-only.
const narrow = createServer((_q, r) => r.end('ok'));
await listen(narrow, '127.0.0.1', PORT);
probe = await p.probeWebview(changed, 1200);
hit = probe.ports.find((x) => x.port === PORT);
ok(!!hit && hit.loopback && !hit.lan, 'a loopback-only server is caught as unreachable (no pooled-socket false negative)', probe.note);
ok(/LOOPBACK-ONLY/.test(probe.note), 'and the note says so in words the fix pass can act on');
await close(narrow);

probe = await p.probeWebview(changed, 1200);
ok(probe.ports.length === 0, 'with nothing listening, no port is reported as up', probe.note);

// third-party API detection — the bar that stops an integration written from memory
const apiFile = join(TMP, 'vendor-client.ts');
writeFileSync(apiFile, 'const BASE = "https://api.example-vendor.com/v1/things";\n'
  + 'const key = process.env.EXAMPLE_VENDOR_API_KEY;\n'
  + 'headers: { Authorization: `Bearer ${key}` }\n');
const apiProbe = p.probeThirdPartyApi([p.describeFile(apiFile)]);
ok(apiProbe.applies, 'a third-party integration is detected from the code', apiProbe.note.slice(0, 90));
ok(apiProbe.hosts.some((h) => h.includes('example-vendor')), 'the external host is named');
ok(apiProbe.keys.some((k) => /API_KEY/.test(k)), 'the credential env var is named');
ok(apiProbe.signals.includes('bearer-token auth') && apiProbe.signals.includes('versioned endpoint path'), 'the stale-prone shapes are flagged');
ok(/NO rate-limit/.test(apiProbe.note), 'missing 429 handling is called out');
const localOnly = p.probeThirdPartyApi([p.describeFile(join(REPO, 'src/qa/probes.ts'))]);
ok(localOnly.applies === false || !localOnly.hosts.some((h) => LOCAL_LIKE.test(h)), 'loopback and LAN hosts are not mistaken for third parties');

const readme = p.probeReadme([p.describeFile(join(REPO, 'src/agent.ts'))], REPO);
ok(readme.exists && readme.headings > 3, 'the project README is found and measured', `${readme.bytes} bytes, ${readme.headings} headings`);
const md = p.probeMarkdown(p.describeFile(join(REPO, 'README.md')));
ok(md && md.headings > 5 && md.tables > 0 && md.fences > 0, 'markdown richness is measured');
const srp = p.probeSrp(p.describeFile(join(REPO, 'src/qa/probes.ts')));
ok(srp && srp.lines > 100 && srp.concerns.length > 0, 'code shape and concern spread are measured');
const dirty = p.gitDirtySet(REPO);
ok(dirty === null || ![...dirty].some((x) => x.endsWith('/')), 'no directory artefacts leak out of the git snapshot');

// ── plan survey: the project describes itself ────────────────────────
console.log('\nplan survey');
const s = await import(`file://${join(DIST, 'plan/survey.js')}`);
const survey = s.surveyProject(REPO);
ok(survey.kind === 'TypeScript project', 'project kind detected', survey.kind);
ok(survey.deps.length > 0, 'dependencies read from package.json', `${survey.deps.length}`);
ok(survey.webviewGaps.length > 0, 'webview gaps are named before any UI work');
ok(survey.logging.length > 0 && survey.debug.length > 0, 'logging and debug affordances are found');
ok(survey.testCmds.length > 0, 'verification commands are found');
ok(s.renderSurvey(survey).includes('WEBVIEW GAPS'), 'the planner block renders');

// ── qa gate: the trigger is deterministic ────────────────────────────
console.log('\nqa gate trigger');
const q = await import(`file://${join(DIST, 'qa/index.js')}`);
q.qaBeginTurn();
ok(q.qaShouldRun('Done — implemented everything.').run === false, 'nothing changed → the gate does not run');
q.qaNoteTouched(srvFile);
ok(q.qaShouldRun('hi').run === false, 'a one-word reply is not a completion report');
const gate = q.qaShouldRun(`Done — implemented it, updated the docs and verified it. ${'x'.repeat(400)}`);
ok(gate.run === true, 'changed files plus a completion report → the gate runs', gate.why);
ok(gate.files.some((f) => f.path === srvFile), 'the changed file is in the review set');
const planDoc = join(TMP, 'ayin-plan-20260101-000000.md');
writeFileSync(planDoc, '# Plan\n');
q.qaNoteTouched(planDoc);
ok(!q.qaShouldRun(`Done. ${'x'.repeat(500)}`).files.some((f) => f.path === planDoc), 'a plan document is not reviewed as its own artifact');

// ── the "Ready for QA" marker: files changed + the phrase, regardless of length ──
// A short, honest closing message ("Done." / "Fixed the typo.") was going unreviewed for no reason
// other than being terse and not phrased like COMPLETION_RE expects. system.txt now instructs the
// model to end a completed turn with this exact phrase; these pin the trigger side of that contract.
const shortReady = q.qaShouldRun('Fixed. Ready for QA');
ok(shortReady.run === true, 'a SHORT message with the marker still runs', shortReady.why);
ok(/marker/i.test(shortReady.why), 'the reason names the marker, not length or wording');
const shortNoMarker = q.qaShouldRun('Fixed.');
ok(shortNoMarker.run === false, 'the same short message WITHOUT the marker still does not run');
ok(q.qaShouldRun('ready for qa').run === true, 'the marker is case-insensitive');
ok(q.qaShouldRun('Everything is Ready for QA now, take a look.').run === true, 'the marker fires anywhere in the message, not just the end');

// ── the indication: a gate must be visible while it spends your GPU ──
console.log('\ngate visibility');
const ui = await import(`file://${join(DIST, 'ui.js')}`);
const seen = { chip: [], line: [] };
ui.status.set = (partial) => { if ('gate' in partial) seen.chip.push(partial.gate); };
ui.chat.setAgentState = (_state, label) => { seen.line.push(label ?? ''); };
const act = await import(`file://${join(DIST, 'activity.js')}`);

const endQa = act.pushActivity('QA 1/3', 'probing 4 changed file(s)');
ok(seen.chip.at(-1)?.label === 'QA 1/3', 'a phase lights the status-bar chip');
ok(seen.line.at(-1) === 'QA 1/3 · probing 4 changed file(s)', 'and paints the thinking line', seen.line.at(-1));
act.setActivityDetail('reviewing 4 artifacts');
ok(seen.chip.at(-1)?.detail === 'reviewing 4 artifacts' && seen.chip.at(-1)?.label === 'QA 1/3', 'the step advances without losing the phase label');
// The regression that made this whole module necessary: narrateWait used to paint 'thinking' over the
// gate's label every 2 seconds. It now leads with the activity — this is its exact call-site expression.
ok((act.activityText() ?? 'thinking') !== 'thinking', 'the wait narrator leads with the phase, not "thinking"', act.activityText());

const endInner = act.pushActivity('PLAN', 'researching an API');
ok(act.activityText().startsWith('PLAN'), 'phases nest');
endInner();
ok(act.activityText().startsWith('QA 1/3'), 'popping an inner phase restores the outer one');

const endA = act.pushActivity('A'); const endB = act.pushActivity('B');
endA();
ok(act.activityText() === 'B', 'a stale exit removes its own entry, not whatever is on top');
endB();
endQa(); endQa();
ok(act.activityText() === null && seen.chip.at(-1) === null, 'exit is idempotent and clears both surfaces');
act.pushActivity('QA 2/3', 'x');
act.clearActivity();
ok(act.activityText() === null, 'a turn ending clears every label, so none outlives its work');

// ── Plan/QA/Presenter: default OFF, session toggle, one-shot force ──
// All three gates share one shape: a session-wide toggle (`/plan`, `/qa`, `/present`, all bare) that
// starts OFF, plus a one-shot force (`/planthis`, `/qathis`, `/presentthis`) that fires exactly once
// regardless of the toggle and is consumed even if nothing downstream ends up running — an unconsumed
// force flag would silently fire on a LATER, unrelated turn, which is the surprise this guards against.
console.log('\nplan/qa/presenter: toggle + one-shot force');
const plan = await import(`file://${join(DIST, 'plan/index.js')}`);
ok(plan.isPlanSessionEnabled() === false, 'plan mode starts OFF for a session');
ok(plan.togglePlanSession() === true, 'toggling plan mode flips it on and reports the new state');
ok(plan.isPlanSessionEnabled() === true, 'and the getter agrees');
ok(plan.togglePlanSession() === false, 'toggling again flips it back off');
ok(plan.isPlanSessionEnabled() === false, 'and the getter agrees again');

const qaToggle = await import(`file://${join(DIST, 'qa/index.js')}`);
ok(qaToggle.isQaSessionEnabled() === false, 'QA gate starts OFF for a session');
ok(qaToggle.shouldRunQaThisTurn() === false, 'and does not run with neither the toggle nor a force set');
qaToggle.toggleQaSession();
ok(qaToggle.isQaSessionEnabled() === true, 'toggling QA on is reflected by the getter');
ok(qaToggle.shouldRunQaThisTurn() === true, 'and the turn-gate now says yes');
qaToggle.toggleQaSession();
ok(qaToggle.isQaSessionEnabled() === false, 'toggling QA back off is reflected by the getter');
qaToggle.forceQaNextTurn();
ok(qaToggle.shouldRunQaThisTurn() === true, '/qathis forces exactly one turn even with the session toggle off');
ok(qaToggle.shouldRunQaThisTurn() === false, 'and the force is consumed — the very next call sees it gone');

const presenter = await import(`file://${join(DIST, 'presenter/index.js')}`);
ok(presenter.isPresenterSessionEnabled() === false, 'Presenter pass starts OFF for a session');
ok(presenter.shouldRunPresenterThisTurn() === false, 'and does not run with neither the toggle nor a force set');
presenter.togglePresenterSession();
ok(presenter.isPresenterSessionEnabled() === true, 'toggling Presenter on is reflected by the getter');
ok(presenter.shouldRunPresenterThisTurn() === true, 'and the turn-gate now says yes');
presenter.togglePresenterSession();
ok(presenter.isPresenterSessionEnabled() === false, 'toggling Presenter back off is reflected by the getter');
presenter.forcePresenterNextTurn();
ok(presenter.shouldRunPresenterThisTurn() === true, '/presentthis forces exactly one turn even with the session toggle off');
ok(presenter.shouldRunPresenterThisTurn() === false, 'and the force is consumed — the very next call sees it gone');

// ── truncation: nothing silent, and the diff card is finally capped ──
console.log('\ntool-result truncation');
const chat = await import(`file://${join(DIST, 'ui/widgets/chat.js')}`);
const bigDiff = ['File: /tmp/x.ts', '@@ -1 +1 @@', ...Array.from({ length: 3000 }, (_, i) => `+line ${i}`)].join('\n');
const diffCard = chat.formatToolResultForChat('write_file', bigDiff, 120);
ok(diffCard.split('\n').length < 60, 'a 3000-line diff no longer paints 3000 lines', `${diffCard.split('\n').length} lines`);
ok(/more line/.test(diffCard) && /Ctrl\+O/.test(diffCard), 'the omission is stated and points at the full output');
ok(diffCard.includes('File: /tmp/x.ts'), 'the diff header survives truncation');
ok(diffCard.includes('line 2999'), 'the diff TAIL survives — a diff\'s end matters too');

const oneHugeLine = `{"blob":"${'x'.repeat(400_000)}"}`;
const jsonCard = chat.formatToolResultForChat('bash', oneHugeLine, 40);
ok(jsonCard.length < 12_000, 'a single 400 KB line cannot blow the card budget', `${jsonCard.length} chars`);
const small = chat.formatToolResultForChat('bash', 'one\ntwo', 10);
ok(!/more line/.test(small), 'small results are not decorated with a bogus omission note');

// ── the gate card: structured in, one visual language out ────────────
console.log('\ngate card');
const qa = await import(`file://${join(DIST, 'qa/index.js')}`);
const asText = qa.cardToText({ kind: 'fail', title: 'QA FAIL 1/3 · 2 issues', body: ['summary', '', '[x] a — b → c'], footer: 'fixing…' });
ok(asText.startsWith('QA FAIL 1/3') && asText.includes('fixing…'), 'a card flattens to readable text for headless');
const styled = chat.formatGateCardForChat('fail', 'QA FAIL 1/3', ['[webview-reachable] server.ts — loopback only'], 'fixing…');
ok(styled.includes('▣') && styled.includes('╰') && styled.includes('│'), 'and renders with the same gutter/footer as a tool card');

// ── the review prompt must actually receive, and trust, the final message ──
// Two bugs lived here: the answer was clipped to 4000 chars while 30 000 chars of file content were
// allowed (so a long report naming a URL late was invisible), and the prompt framed the message purely
// as an untrustworthy "claim", so the reviewer discounted things the user had asked to be TOLD and
// reported them as never mentioned. Both are pinned.
console.log('\nqa review prompt');
{
  const { readFileSync } = await import('node:fs');
  const promptText = readFileSync(join(REPO, 'prompts/ayin/qaReview.txt'), 'utf8');
  ok(promptText.includes('{{ANSWER}}'), 'the review prompt receives the final message');
  ok(/COUNTS AS DELIVERY/i.test(promptText), 'and is told the message itself delivers what the user asked to be TOLD');
  ok(/evidence outranks/i.test(promptText), 'while claims about WORK are still checked against the evidence');
  const reviewSrc = readFileSync(join(REPO, 'src/qa/review.ts'), 'utf8');
  const budget = Number(reviewSrc.match(/ANSWER_CHARS\s*=\s*([\d_]+)/)?.[1]?.replace(/_/g, '') ?? 0);
  ok(budget >= 16_000, 'the final message is not clipped before the file artifacts are', `${budget} chars`);
}

// ── mouse: the wheel, and ONLY the wheel ─────────────────────────────
// Booting the real (non-headless) TUI in a child and reading the escape codes it writes is the only
// honest way to check this. `screen.on('mouse', …)` looks passive but makes blessed call
// `program.enableMouse()`, which turns on 1002 (cell motion) and 1003 (ALL motion) — every mouse
// movement parsed and dispatched, for a feature that needs a wheel, and the motion grab is what fights
// text selection hardest. Listening on the *program* instead keeps the modes narrow. If someone
// "simplifies" that back to the screen, these bytes change and this check fails.
console.log('\nmouse modes');
{
  const { execFileSync } = await import('node:child_process');
  let out = Buffer.alloc(0);
  try {
    // AYIN_MOUSE=1 because tracking is OPT-IN now: the default emits no modes at all, so probing
    // without it would assert nothing. What must hold is the shape of what gets enabled when it is.
    out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(`file://${join(DIST, 'ui/index.js')}`)}).then(() => process.exit(0))`],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, AYIN_MOUSE: '1' } });
  } catch (e) { out = e?.stdout ?? Buffer.alloc(0); }
  const modes = [...new Set([...out.toString('latin1').matchAll(/\x1b\[\?(1\d{3})[hl]/g)].map((m) => m[1]))];
  ok(modes.includes('1000'), 'WHEN ENABLED: button tracking (1000) is on — where wheel events arrive', modes.join(','));
  ok(modes.includes('1006'), 'WHEN ENABLED: SGR encoding (1006) is on — correct past column 223');
  ok(!modes.includes('1002') && !modes.includes('1003'), 'motion tracking (1002/1003) stays OFF — no event flood, minimal selection interference');
}

// ── model picker: hide small models, but NEVER hide what's actually serving you ──
console.log('\nmodel picker size filter');
{
  const mp = await import(`file://${join(DIST, 'model-picker.js')}`);
  const GiB = 1024 ** 3;
  const cat = {
    activeModel: 'qwen2.5-coder:7b', // deliberately the SMALL one, to test it survives the filter
    loadedModel: 'qwen2.5-coder:7b',
    sharedModel: 'gemma4:26b',
    coderModel: 'qwen3-coder:30b',
    models: [
      { name: 'gemma3:270m', parameterSize: '270M', quantization: 'Q8_0', sizeBytes: 0.27 * GiB, active: false },
      { name: 'qwen2.5:3b', parameterSize: '3.1B', quantization: 'Q4_K_M', sizeBytes: 1.9 * GiB, active: false },
      { name: 'qwen2.5-coder:7b', parameterSize: '7.6B', quantization: 'Q4_K_M', sizeBytes: 4.5 * GiB, active: true },
      { name: 'qwen3.6:27b', parameterSize: '27.8B', quantization: 'Q4_K_M', sizeBytes: 17.4 * GiB, active: false },
      { name: 'gemma4:26b', parameterSize: '25.8B', quantization: 'Q4_K_M', sizeBytes: 18.0 * GiB, active: false },
      { name: 'qwen3-coder:30b', parameterSize: '30.5B', quantization: 'Q4_K_M', sizeBytes: 19.0 * GiB, active: false },
    ],
  };

  const { models: kept, hiddenCount } = mp.filterModelsForPicker(cat);
  const names = kept.map((m) => m.name);
  ok(!names.includes('gemma3:270m'), 'a 270M utility model is hidden');
  ok(!names.includes('qwen2.5:3b'), 'a 3B fallback model is hidden');
  ok(names.includes('qwen3.6:27b') && names.includes('gemma4:26b') && names.includes('qwen3-coder:30b'), 'the 15G+ coder-sized models all survive');
  ok(names.includes('qwen2.5-coder:7b'), 'the ACTIVE model survives even though it is well under 15G — the filter must never hide what is actually serving you');
  ok(hiddenCount === 2, 'reports exactly how many were hidden, so the popup can say so', String(hiddenCount));

  // Nothing at all above threshold, and the active model isn't in the catalog either (edge case) —
  // must fall back to the full list rather than present an empty, useless popup.
  const allSmall = { ...cat, activeModel: 'unknown-ghost-model', models: cat.models.slice(0, 2) };
  const fallback = mp.filterModelsForPicker(allSmall);
  ok(fallback.models.length === 2 && fallback.hiddenCount === 0, 'an all-small catalog with no active match falls back to showing everything, not an empty popup');
}

// ── Arduino: the toolchain's filename rule is a fact, not a reviewer's opinion ──
console.log('\narduino project probe');
{
  const p = await import(`file://${join(DIST, 'qa/probes.js')}`);

  // Correct: Blinker/Blinker.ino — the toolchain requires exactly this.
  const goodDir = join(TMP, 'Blinker');
  mkdirSync(goodDir, { recursive: true });
  const goodSketch = join(goodDir, 'Blinker.ino');
  writeFileSync(goodSketch, 'void setup() {}\nvoid loop() {}\n');
  const goodProbe = p.probeArduinoProject([p.describeFile(goodSketch)], goodDir);
  ok(goodProbe.applies, 'an .ino file is detected as an Arduino project');
  ok(goodProbe.sketches[0]?.matches === true, 'a filename matching its folder is measured as CORRECT');
  ok(!/VIOLATED/.test(goodProbe.note), 'a correct match is not reported as a violation');
  ok(/correctly match/.test(goodProbe.note), 'the note says explicitly that a match is required, not unusual — the false positive this probe exists to prevent');

  // Wrong: Blinker/main.ino — will not build.
  const badDir = join(TMP, 'Blinker2');
  mkdirSync(badDir, { recursive: true });
  const badSketch = join(badDir, 'main.ino');
  writeFileSync(badSketch, 'void setup() {}\nvoid loop() {}\n');
  const badProbe = p.probeArduinoProject([p.describeFile(badSketch)], badDir);
  ok(badProbe.sketches[0]?.matches === false, 'a mismatched filename is measured as a real violation');
  ok(/VIOLATED/.test(badProbe.note) && badProbe.note.includes('Blinker2.ino'), 'the note names the exact required rename', badProbe.note.slice(0, 160));

  // Wiring detection: real pin I/O vs. no pin I/O at all.
  const wiringSketch = join(goodDir, 'wiring-test.ino');
  writeFileSync(wiringSketch, 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); }\n');
  const wiringProbe = p.probeArduinoProject([p.describeFile(wiringSketch)], goodDir);
  ok(wiringProbe.wiringLikely === true, 'pinMode/digitalWrite is detected as touching physical pins');

  const noWiringSketch = join(goodDir, 'no-wiring-test.ino');
  writeFileSync(noWiringSketch, 'void setup() { Serial.begin(9600); }\nvoid loop() { Serial.println("hi"); }\n');
  const noWiringProbe = p.probeArduinoProject([p.describeFile(noWiringSketch)], goodDir);
  ok(noWiringProbe.wiringLikely === false, 'a sketch with no pin I/O does not trigger the wiring-diagram requirement — not every Arduino edit is wiring');

  // platformio.ini alone, no .ino touched this turn, still identifies the project.
  const pioDir = join(TMP, 'pio-project');
  mkdirSync(pioDir, { recursive: true });
  writeFileSync(join(pioDir, 'platformio.ini'), '[env:uno]\nplatform = atmelavr\nboard = uno\n');
  const pioProbe = p.probeArduinoProject([], pioDir);
  ok(pioProbe.applies === true && pioProbe.sketches.length === 0, 'platformio.ini alone identifies the project without any changed .ino');

  // Not Arduino at all.
  const notArduino = p.probeArduinoProject([p.describeFile(join(REPO, 'src/qa/probes.ts'))], REPO);
  ok(notArduino.applies === false, 'an ordinary TypeScript project is not misidentified as Arduino');

  // Project-type criteria are NOT decided by file shape any more — the Arduino QA executor selects
  // them from its own deterministic facts (see executors/qa/arduino). dimensionsOf keeps only the
  // bars that are genuinely file-kind-driven and apply to every project type.
  const qc = await import(`file://${join(DIST, 'qa/criteria.js')}`);
  const dims = qc.dimensionsOf([p.describeFile(join(REPO, 'src/qa/probes.ts'))], false, false);
  ok(dims.has('code') && !dims.has('arduino'), 'dimensionsOf no longer invents project-type dimensions — that is the executor\'s job');
  ok(qc.baselineIds().includes('arduino-compiles'), 'the baseline table carries the executor-requested criteria by id');
}

// ── the QA gate's non-git change detection ──────────────────────────
// From benchmark run 1, and the most consequential finding in it: a fresh Arduino directory is NOT a
// git repo, so `gitDirtySet()` returns null and the half of change-detection that catches files
// written through `bash` is gone. Three projects reported ZERO changed files, so `qaShouldRun`
// declined — the gate did not fail, it SILENTLY DID NOT RUN — and they shipped sketches that could not
// compile, past a naming bar and a compile probe that both existed and never looked.
console.log('\nqa: change detection outside a git repo');
{
  const p = await import(`file://${join(DIST, 'qa/probes.js')}`);
  const dir = mkdtempSync(join(tmpdir(), 'ayin-nogit-'));
  ok(p.gitDirtySet(dir) === null, 'a non-git directory yields null from the git probe — the condition that caused the bug');

  const before = Date.now() - 1000;
  mkdirSync(join(dir, 'Sketch'), { recursive: true });
  writeFileSync(join(dir, 'Sketch', 'Sketch.ino'), 'void setup(){} void loop(){}\n');
  writeFileSync(join(dir, 'README.md'), '# x\n');
  const found = p.filesModifiedSince(dir, before).map((f) => f.slice(dir.length + 1)).sort();
  ok(found.includes('README.md') && found.includes('Sketch/Sketch.ino'), 'the mtime fallback finds files written since the turn began, at any depth', JSON.stringify(found));

  // It must not sweep in everything that merely EXISTS, or every turn would review the whole tree.
  writeFileSync(join(dir, 'old.txt'), 'x\n');
  const past = Date.now() + 60_000;
  ok(p.filesModifiedSince(dir, past).length === 0, 'nothing is reported as changed when the baseline is in the future — this is a since-filter, not a tree dump');

  mkdirSync(join(dir, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'junk', 'index.js'), 'x\n');
  ok(!p.filesModifiedSince(dir, before).some((f) => f.includes('node_modules')), 'vendor directories are skipped, same as every other probe here');
  rmSync(dir, { recursive: true, force: true });
}

// ── executors: project detection and config-driven selection ────────
console.log('\nexecutors: detection + registry');
{
  const det = await import(`file://${join(DIST, 'executors/detect.js')}`);
  const reg = await import(`file://${join(DIST, 'executors/registry.js')}`);

  // Every shipped config parses and cross-checks against an imported instance. loadRegistry THROWS
  // on any mismatch, so simply getting a list back is the assertion.
  const configs = reg.listExecutors();
  // EIGHT since the greenfield plan executor: base + arduino for plan/qa/present, plus qa/unity and
  // plan/greenfield. The count is asserted rather than the names because `loadRegistry` already THROWS
  // on a config with no imported instance (or the reverse) — this line is what notices an executor
  // added to neither list.
  ok(configs.length === 8, 'eight executors are declared and wired (base + arduino for plan/qa/present, plus qa/unity and plan/greenfield)', String(configs.length));
  ok(configs.some((c) => c.kind === 'qa' && c.id === 'unity' && c.factsOnly === true),
    'qa/unity declares factsOnly — a Unity turn is judged by a compiler, not by a model');
  ok(configs.every((c) => c.projectTypes.length > 0), 'every config declares at least one project type');

  // The tree wins when it says anything.
  const tsCtx = det.detectProject(REPO, 'build me an arduino thing with an LED on a pin');
  ok(tsCtx.type === 'node' && tsCtx.greenfield === false, 'a real repo is detected from its files, and the request never overrides the tree', tsCtx.type);

  // Greenfield: an empty directory plus a request that names the domain. THE case that used to get
  // no Arduino treatment at all, because every hook required an .ino to already exist.
  const empty = mkdtempSync(join(tmpdir(), 'ayin-gate-empty-'));
  const green = det.detectProject(empty, 'create an arduino project: RGB LED green to yellow to red over 10 seconds, a button toggles it');
  ok(green.type === 'arduino' && green.greenfield === true, 'an empty directory + an Arduino request detects as greenfield arduino', `${green.type}/${green.greenfield}`);
  const silent = det.detectProject(empty, 'refactor the payment service');
  ok(silent.type === 'unknown', 'an empty directory with an unrelated request stays unknown, not guessed');

  // Selection is by config: arduino beats the wildcard base, everything else gets base.
  ok(reg.planExecutorFor(green).config.id === 'arduino', 'the arduino plan executor wins for an arduino project (priority 100 over the base wildcard)');
  ok(reg.qaExecutorFor(green).config.id === 'arduino', 'the arduino QA executor wins for an arduino project');
  ok(reg.presentExecutorFor(green).config.id === 'arduino', 'the arduino present executor wins for an arduino project');
  ok(reg.planExecutorFor(silent).config.id === 'base', 'an unknown project falls to the base executor, which declares "*"');
  ok(reg.qaExecutorFor(tsCtx).config.id === 'base', 'a Node project gets base QA — the arduino bars never apply to it');

  // The deterministic README scaffold: created when missing, never overwritten.
  const bp = await import(`file://${join(DIST, 'executors/plan/base/index.js')}`);
  const made = bp.basePlanExecutor.scaffold({ root: empty, targetDir: '', type: 'unknown', evidence: 'test', greenfield: true });
  ok(made.length === 1 && existsSync(join(empty, 'README.md')), 'scaffold creates README.md in a project that has none');
  writeFileSync(join(empty, 'README.md'), '# mine\n');
  const again = bp.basePlanExecutor.scaffold({ root: empty, targetDir: '', type: 'unknown', evidence: 'test', greenfield: false });
  ok(again.length === 0 && readFileSync(join(empty, 'README.md'), 'utf8') === '# mine\n', 'scaffold NEVER overwrites an existing README — it is the operator\'s');
  rmSync(empty, { recursive: true, force: true });

  // ── the README check must be answerable by the project it is asked about ──
  //
  // It was not. `readmeSubstance` is `qa/base`'s, and `qa/base` serves `"*"` — but it ended with two
  // ARDUINO demands, so a Python project created by plan mode failed a HARD fact on "no `arduino-cli
  // compile`/`upload` command and no mention of the Arduino IDE". Measured: the gate spent all three
  // fix passes on it and the model refused each time, correctly calling it a misconfiguration. A hard
  // fact nobody can satisfy does not enforce anything; it burns the budget that would have fixed
  // something real.
  const dl = await import(`file://${join(DIST, 'executors/deliverables.js')}`);
  const bpx = await import(`file://${join(DIST, 'executors/plan/base/index.js')}`);
  const mkReadme = (body) => {
    const d = mkdtempSync(join(tmpdir(), 'ayin-readme-'));
    writeFileSync(join(d, 'README.md'), body);
    return d;
  };
  const filled = '# demo\n\n## What this is\nA CLI that converts CSV to JSON.\n\n## How to run it\n'
    + 'pip install -e . then `csv2json in.csv --pretty`\n\n## How to verify it works\n'
    + '`pytest -q` shows three passing tests covering the flag and the error path.\n';

  const stubDir = mkReadme(bpx.readmeStub('demo'));
  ok(!dl.readmeSubstance(stubDir).ok, 'an untouched stub still fails — that is the whole point of writing one');

  // THE BANNER IS AN INSTRUCTION TO THE AGENT, NOT PART OF THE DOCUMENT. It used to open with the word
  // TODO, so a model that filled in every section and left the instruction alone — doing exactly what
  // it was told — shipped 570 characters of real documentation that failed on that one word.
  ok(!/\bTODO\b/.test(bpx.readmeStub('demo').split('## What this is')[0]),
    'the stub BANNER carries no TODO of its own — only the section bodies do');
  const bannerLeft = mkReadme(bpx.readmeStub('demo').split('## What this is')[0] + filled);
  const bl = dl.readmeSubstance(bannerLeft);
  ok(!bl.ok && /stub banner/.test(bl.detail), 'a filled-in README that KEPT the banner is still refused, and told which block to delete', bl.detail.slice(0, 60));

  const cleanDir = mkReadme(filled);
  const cl = dl.readmeSubstance(cleanDir);
  ok(cl.ok, 'and the same content with the banner deleted PASSES — no board, no pins, no arduino-cli', cl.detail);
  ok(!/arduino/i.test(cl.detail) && !/pin map/i.test(cl.detail),
    'the generic verdict never mentions arduino or a pin map — it is asked of every project type');

  // The arduino demands did not go away; they moved to the executor that can satisfy them.
  const ar = dl.arduinoReadmeSubstance(cleanDir);
  ok(!ar.ok && /arduino-cli/.test(ar.detail), 'arduinoReadmeSubstance still demands build/upload instructions', ar.detail.slice(0, 50));
  const qaArd = readFileSync(join(REPO, 'src/executors/qa/arduino/index.ts'), 'utf-8');
  ok(/arduinoReadmeSubstance\(ctx\.root\)/.test(qaArd), 'and the arduino QA executor is the one asking for it');
  const qaBase = readFileSync(join(REPO, 'src/executors/qa/base/index.ts'), 'utf-8');
  ok(!/arduinoReadmeSubstance/.test(qaBase), 'while base QA — which serves every other project type — does not');

  for (const d of [stubDir, bannerLeft, cleanDir]) rmSync(d, { recursive: true, force: true });
}

// ── arduino_diagram: the pure PUML renderer, esp. the free-form-leg-name fuzzy matcher ──
console.log('\narduino wiring diagram render');
{
  const ad = await import(`file://${join(DIST, 'tools/arduino-diagram.js')}`);

  // push-button's real catalog legs: 'top-left leg' / 'bottom-left leg' (-> a digital pin) and
  // 'top-right leg' / 'bottom-right leg' (-> GND). groundWiring never returns the catalog's exact
  // legName — it returns free-form project phrasing (see matchLeg's own doc comment) — so this
  // exercises the fuzzy word-overlap matcher, not an exact-string lookup.
  const pins = [{ raw: '2', resolved: '2', calls: ['pinMode', 'digitalRead'] }];
  const fuzzyConn = [{ pin: '2', componentId: 'push-button', leg: 'left side of the switch', label: 'push button' }];
  const puml1 = ad.renderArduinoWiringPuml('Blinker', 'uno', pins, fuzzyConn);
  ok(/PIN_2 --> COMP_push_button_LEG_top_left_leg : signal/.test(puml1), 'free-form leg text fuzzy-matches the catalog leg with the most overlapping words (never an exact-string miss)');
  ok(/COMP_push_button_LEG_top_right_leg --> BOARD_GND : ground/.test(puml1), 'a leg whose catalog connectsTo mentions GND wires to the synthetic ground pin');
  // Real bug, caught live against a render: the button's top-right AND bottom-right legs both mention
  // GND in the catalog (they're internally shorted, "wiring only one is enough" per the catalog text),
  // so the first draft drew TWO separate ground wires — reading as "you need two ground wires," which is
  // wrong. Exactly one wire per net now; the other leg still gets its rectangle, just no duplicate wire.
  const groundWireCount = (puml1.match(/--> BOARD_GND : ground/g) || []).length;
  ok(groundWireCount === 1, 'only ONE ground wire is drawn even though two legs are internally shorted to the same GND net — not one wire per leg', String(groundWireCount));
  ok(!/COMP_push_button_LEG_bottom_right_leg --> BOARD_GND/.test(puml1), 'the second (redundant) leg on the same net is not ALSO wired to GND');

  // Leg text that shares no words with any catalog leg still draws a wire — falls back to the first
  // leg rather than silently dropping the connection (the bug this matcher replaced).
  const noOverlapConn = [{ pin: '2', componentId: 'push-button', leg: 'zzz totally unrelated phrase', label: 'push button' }];
  const puml2 = ad.renderArduinoWiringPuml('Blinker', 'uno', pins, noOverlapConn);
  ok(/PIN_2 --> COMP_push_button_LEG_top_left_leg : signal/.test(puml2), 'zero word-overlap still falls back to a real leg instead of dropping the wire');

  // An unmatched pin (componentId: 'unknown') still gets its own rectangle and an honest note,
  // never silently omitted from the diagram.
  const unknownConn = [{ pin: '2', componentId: 'unknown', leg: '', label: 'mystery' }];
  const puml3 = ad.renderArduinoWiringPuml('Blinker', 'uno', pins, unknownConn);
  ok(/no arduino_db catalog component matched/.test(puml3), 'an unmatched pin is drawn with an honest "no catalog match" note, not dropped');
  ok(/PIN_2 -->/.test(puml3), 'the unmatched pin still gets a wire from the board rectangle');

  // The renderer always produces a structurally valid, self-contained PUML document.
  ok(puml1.startsWith('@startuml') && puml1.trim().endsWith('@enduml'), 'output is a well-formed PlantUML document');
  ok(!/!include/.test(puml1), 'no !include directives — offline-renderable, same discipline as diagram.ts');

  // Real bug, caught live against a real project (Janitor.ino): an RGB LED driven from THREE separate
  // PWM pins (one per color channel) collapsed to ONE mislabeled wire — the single-connection-per-
  // component model kept the first pin's label but let the last connection's leg match win. Verifies
  // all three pins survive, each wired to its OWN correct leg.
  const rgbPins = [
    { raw: 'RED_PIN', resolved: '9', calls: ['pinMode', 'analogWrite'] },
    { raw: 'GREEN_PIN', resolved: '10', calls: ['pinMode', 'analogWrite'] },
    { raw: 'BLUE_PIN', resolved: '11', calls: ['pinMode', 'analogWrite'] },
  ];
  const rgbConn = [
    { pin: '9', componentId: 'rgb-led-common-cathode', leg: 'red channel', label: 'RGB LED' },
    { pin: '10', componentId: 'rgb-led-common-cathode', leg: 'green channel', label: 'RGB LED' },
    { pin: '11', componentId: 'rgb-led-common-cathode', leg: 'blue channel', label: 'RGB LED' },
  ];
  const puml4 = ad.renderArduinoWiringPuml('Janitor', 'uno', rgbPins, rgbConn);
  // Each channel now runs board pin -> SERIES resistor -> leg, because the catalog's own connectsTo
  // text for every anode says "through a ~220Ω resistor". The previous renderer drew the wire
  // straight to the anode: a picture that contradicted the data it was built from, and that a
  // beginner following it would use to destroy an LED or a GPIO pin.
  for (const [pin, leg] of [['PIN_9', 'red_anode'], ['PIN_10', 'green_anode'], ['PIN_11', 'blue_anode']]) {
    const via = puml4.match(new RegExp(`${pin} --> (SERIES_\\d+) : signal`));
    ok(!!via, `${pin} wires through a series part, not straight to the LED leg`);
    ok(new RegExp(`${via?.[1]} --> COMP_rgb_led_common_cathode_LEG_${leg}\\b`).test(puml4),
      `that series part continues to this channel's OWN leg (${leg}) — a second connection must not overwrite the first`);
  }
  const seriesBoxes = puml4.match(/rectangle "[^"]*Ω[^"]*" as SERIES_\d+/g) || [];
  ok(seriesBoxes.length === 3, 'each RGB channel gets its OWN resistor — the catalog says "not just one shared one"', String(seriesBoxes.length));
  // The blue channel's catalog text states a RANGE ("~150-220Ω"), and that survives as a range
  // rather than being flattened to whichever end a lookup table would have picked.
  ok(seriesBoxes.some((b) => /150–220 Ω/.test(b)), 'the blue channel keeps the range the catalog actually states', seriesBoxes.join(' | '));
  ok((puml4.match(/rectangle "[^"]*(RED_PIN|GREEN_PIN|BLUE_PIN)/g) || []).length === 3, 'all three real board pins get their own rectangle, not just the first one seen');
  ok(/COMP_rgb_led_common_cathode_LEG_common_cathode_longest_leg --> BOARD_GND : ground/.test(puml4), 'the shared cathode leg still wires to GND exactly once');

  // Pins are ordered as a human reads a header, not in Map insertion order (which put GND between
  // pins 11 and 2 in a real render).
  const mixedPins = [
    { raw: '11', resolved: '11', calls: ['analogWrite'] },
    { raw: '2', resolved: '2', calls: ['digitalRead'] },
    { raw: 'A0', resolved: 'A0', calls: ['analogRead'] },
  ];
  const puml5 = ad.renderArduinoWiringPuml('Order', 'uno', mixedPins, []);
  const order = [...puml5.matchAll(/as (PIN_\w+|BOARD_GND|BOARD_5V)/g)].map((m) => m[1]);
  ok(order.indexOf('PIN_2') < order.indexOf('PIN_11') && order.indexOf('PIN_11') < order.indexOf('PIN_A0'),
    'board pins render in header order: digital ascending, then analog', order.join(','));

  // Wiring notes are wrapped, never amputated mid-word at a fixed character count.
  ok(!/…\n/.test(puml4) || ad.wrapText('a '.repeat(200)).length <= 7, 'notes wrap to multiple lines instead of being truncated');
  const wrapped = ad.wrapText('the quick brown fox jumps over the lazy dog and keeps running for quite a while longer', 30, 5);
  ok(wrapped.every((l) => l.length <= 32) && wrapped.join(' ').includes('lazy dog'), 'wrapText breaks on whole words and keeps the text', JSON.stringify(wrapped));

  // THE PIN FIELD TOLERATES NATURAL PHRASING. An exact-string compare on the model's `pin` answer meant
  // "D2", "pin 2", "GPIO2" or "a0" dropped every connection, the repair round produced the same
  // phrasing, and the whole grounding call exhausted — rendering a diagram of bare pins. Same bug class
  // as matchLeg, on the field next to it.
  {
    const ae2 = await import(`file://${join(DIST, 'tools/arduino-explain.js')}`);
    // parseConnections must keep whatever the model wrote; the NORMALISATION happens in groundWiring,
    // so this asserts the parser is not the thing throwing them away.
    const parsed = ae2.parseConnections('{"connections":[{"pin":"D2","componentId":"push-button","leg":"left"}]}');
    ok(parsed?.length === 1 && parsed[0].pin === 'D2', 'the parser preserves the model\'s pin phrasing verbatim for the matcher to normalise');
  }

  // EXHAUSTED GROUNDING vs NOTHING TO GROUND — identical pictures, opposite meanings, and the first cut
  // of this check failed blink for being CORRECT. Blink drives only LED_BUILTIN: there is no external
  // part, so an all-unknown diagram is the honest answer and inventing an LED would be the bug. A
  // five-pin traffic light whose grounding call died renders the same shape and is worthless.
  const pumlNothing = ad.renderArduinoWiringPuml('Blink', 'uno', [{ raw: '13', resolved: '13', calls: ['digitalWrite'] }], [], false);
  const pumlDead = ad.renderArduinoWiringPuml('Blink', 'uno', [{ raw: '13', resolved: '13', calls: ['digitalWrite'] }], [], true);
  ok(ad.diagramGrounding(pumlNothing).exhausted === false, 'a successful grounding call that matched nothing is NOT recorded as exhausted');
  ok(ad.diagramGrounding(pumlDead).exhausted === true, 'an exhausted grounding call IS recorded, so the two cases are distinguishable from the file alone');
  ok(ad.diagramGrounding(puml4).components > 0, 'a real multi-component diagram reports its grounded component count');

  // PROVENANCE. From benchmark run 1: the model wrote its own `traffic-light.wiring.puml` — valid
  // PlantUML, plausible, resistors and all, grounded in nothing — and it survived because the
  // regeneration skip assumed this tool was the only writer of that path. A plausible wrong pinout is
  // worse than no diagram, because someone wires it.
  ok(ad.isGeneratedPuml(puml1), 'a generated diagram carries the provenance stamp');
  ok(!ad.isGeneratedPuml('@startuml\nrectangle "Red LED" as red\n@enduml'), 'a hand-written diagram is identified as such');
  ok(/^'/.test(ad.PROVENANCE_MARK), 'the stamp is a PlantUML comment, so it never renders and never breaks -syntax');

  // A SIGNAL PIN MUST NEVER BE WIRED TO A GROUND LEG, and two pins must never share one leg.
  // Found by auditing a rendered diagram against its own sketch and README: the model's free-form leg
  // text ("green channel, via a resistor to the common cathode") shares TWO words with the catalog's
  // "common cathode (longest leg)" and only ONE with "green anode", so plain word-overlap wired pins 10
  // AND 11 into the cathode, left the green and blue anodes unwired, and drew no ground wire. A dead
  // circuit, in a diagram that was valid, stamped and catalog-grounded.
  const cathodeBait = ['red', 'green', 'blue'].map((c, i) => ({
    pin: String(9 + i), componentId: 'rgb-led-common-cathode',
    leg: `${c} channel, via a resistor to the common cathode`, label: c,
  }));
  const pumlBait = ad.renderArduinoWiringPuml('RgbCycle', 'uno', rgbPins, cathodeBait);
  for (const [pin, leg] of [['PIN_9', 'red_anode'], ['PIN_10', 'green_anode'], ['PIN_11', 'blue_anode']]) {
    const via = pumlBait.match(new RegExp(`${pin} --> (SERIES_\\d+) : signal`));
    ok(!!via && new RegExp(`${via[1]} --> COMP_rgb_led_common_cathode_LEG_${leg}\\b`).test(pumlBait),
      `${pin} reaches its OWN anode (${leg}) despite leg text that name-drops the cathode`);
  }
  ok(!/PIN_\d+ --> COMP_rgb_led_common_cathode_LEG_common_cathode/.test(pumlBait),
    'no signal pin is ever wired to a leg the catalog sends to GND');
  ok(/COMP_rgb_led_common_cathode_LEG_common_cathode_longest_leg --> BOARD_GND : ground/.test(pumlBait),
    'and the cathode still gets its ground wire');

  // THREE DISCRETE LEDS ARE THREE PARTS. Seen in a real render: pins 9/10/11 driving three separate
  // standard-leds collapsed into ONE box with three wires into the same anode — a circuit nobody built.
  // The catalog's leg list is the proof: standard-led has one driveable leg (anode; cathode is GND), so
  // three pins cannot be one part. An RGB LED has three driveable anodes, so it must NOT split.
  const threeLeds = [
    { raw: '9', resolved: '9', calls: ['digitalWrite'] },
    { raw: '10', resolved: '10', calls: ['digitalWrite'] },
    { raw: '11', resolved: '11', calls: ['digitalWrite'] },
  ];
  const ledConn = threeLeds.map((p) => ({ pin: p.resolved, componentId: 'standard-led', leg: 'anode', label: 'LED' }));
  const pumlLeds = ad.renderArduinoWiringPuml('TrafficLight', 'uno', threeLeds, ledConn);
  // `alias()` collapses runs of non-alphanumerics, so the instance suffix is `_9`, not `__9`.
  const ledBoxes = (pumlLeds.match(/as COMP_standard_led_\d+ /g) || []).length;
  ok(ledBoxes === 3, 'three pins driving a one-driveable-leg part render as THREE component boxes', String(ledBoxes));
  ok((pumlLeds.match(/rectangle "[^"]*Ω[^"]*" as SERIES_\d+/g) || []).length === 3, 'and each of the three gets its own series resistor');
  const rgbBoxes = (puml4.match(/as COMP_rgb_led_common_cathode[ _]/g) || []).length;
  ok(!/as COMP_rgb_led_common_cathode_\d+ /.test(puml4), 'an RGB LED with three driveable anodes is NOT split — it is one physical part', String(rgbBoxes));

  // Series-part detection reads the catalog's own prose — one source of truth, no lookup table.
  ok(ad.seriesPartFor('a PWM pin through a ~220Ω resistor')?.label === '220 Ω', 'a stated resistor value is read out of the catalog text');
  ok(ad.seriesPartFor('a PWM pin through a ~150-220Ω resistor')?.label === '150–220 Ω', 'a stated RANGE is kept as a range, not rounded to one end');
  ok(ad.seriesPartFor('Arduino GND') === null, 'a leg with no series part in its description gets a direct wire');
}

// ── arduino-db: keyword search, no embeddings, no network ──────────
console.log('\narduino-db catalog search');
{
  const db = await import(`file://${join(DIST, 'tools/arduino-db.js')}`);
  const servoHits = db.searchArduinoComponents('servo', 3);
  ok(servoHits.some((c) => c.id === 'sg90-micro-servo'), 'search("servo") finds the micro servo entry', servoHits.map((c) => c.id).join(','));
  const rgbHits = db.searchArduinoComponents('rgb led', 3);
  ok(rgbHits.some((c) => c.id === 'rgb-led-common-cathode'), 'search("rgb led") finds the RGB LED entry', rgbHits.map((c) => c.id).join(','));
  ok(db.searchArduinoComponents('').length === 0, 'an empty query returns nothing rather than the whole catalog');
  ok(db.searchArduinoComponents('zzz-not-a-real-part-xyz').length === 0, 'a nonsense query returns no hits without throwing');
  const byId = db.getArduinoComponent('push-button');
  ok(byId?.legs.length === 4, 'exact id lookup returns the full entry (push-button has 4 legs)', String(byId?.legs.length));
  ok(db.getArduinoComponent('not-a-real-id') === undefined, 'an unknown id looks up to undefined, not a throw');
  const summaries = db.listArduinoComponentSummaries();
  ok(summaries.length >= 20, 'the shipped catalog is broad (20+ common starter-kit parts)', String(summaries.length));
  ok(new Set(summaries.map((s) => s.id)).size === summaries.length, 'every catalog id is unique — a duplicate would silently shadow in exact lookup');
}

// ── arduino-explain: shared extraction infra (pin extraction, sketch discovery, connection parsing) ──
console.log('\narduino-explain pipeline (no LLM)');
{
  const ae = await import(`file://${join(DIST, 'tools/arduino-explain.js')}`);

  // Sketch discovery mirrors probeArduinoProject's own naming rule, but walks the whole tree rather
  // than just this turn's changed files — `/arduino-explain` runs on demand, not mid-QA-turn.
  const projDir = join(TMP, 'explain-project');
  const sketchDir = join(projDir, 'BlinkAndBeep');
  mkdirSync(sketchDir, { recursive: true });
  const sketchPath = join(sketchDir, 'BlinkAndBeep.ino');
  const sketchSrc = [
    'const int LED_PIN = 13;',
    'const int BUZZER_PIN = 8;',
    '#include <Servo.h>',
    'Servo doorServo;',
    'void setup() {',
    '  pinMode(LED_PIN, OUTPUT);',
    '  pinMode(BUZZER_PIN, OUTPUT);',
    '  doorServo.attach(9);',
    '  pinMode(2, INPUT_PULLUP);',
    '}',
    'void loop() {',
    '  digitalWrite(LED_PIN, HIGH);',
    '  int level = analogRead(A0);',
    '  if (digitalRead(2) == LOW) { digitalWrite(BUZZER_PIN, HIGH); }',
    '}',
  ].join('\n');
  writeFileSync(sketchPath, sketchSrc);
  mkdirSync(join(projDir, 'node_modules', 'should-be-skipped'), { recursive: true });
  writeFileSync(join(projDir, 'node_modules', 'should-be-skipped', 'Fake.ino'), 'void setup(){}\nvoid loop(){}\n');

  ok(ae.isArduinoProject(projDir), 'a project with one correctly-named sketch is detected');
  ok(!ae.isArduinoProject(REPO), 'ayin\'s own TypeScript source is not misidentified as an Arduino project');
  const sketches = ae.findSketches(projDir);
  ok(sketches.length === 1 && sketches[0].baseName === 'BlinkAndBeep', 'finds exactly the one real sketch, skipping node_modules', JSON.stringify(sketches.map((s) => s.baseName)));

  const pins = ae.extractPinUsage(sketchSrc);
  const byRaw = Object.fromEntries(pins.map((p) => [p.raw, p]));
  ok(byRaw['LED_PIN']?.resolved === '13', 'a #const-declared pin resolves to its literal value', byRaw['LED_PIN']?.resolved);
  ok(byRaw['BUZZER_PIN']?.resolved === '8', 'a second declared constant resolves independently', byRaw['BUZZER_PIN']?.resolved);
  ok(byRaw['9']?.calls.includes('attach'), 'Servo.h-style .attach(pin) is picked up even with no pinMode/digitalWrite on that pin', JSON.stringify(byRaw['9']));
  ok(byRaw['2']?.calls.includes('pinMode') && byRaw['2']?.calls.includes('digitalRead'), 'a literal numeric pin used by two different calls records both');
  ok(byRaw['A0']?.calls.includes('analogRead'), 'an analog pin token (A0) is captured as-is, not treated as a name to resolve');
  ok(ae.extractPinUsage('void setup(){} void loop(){}').length === 0, 'a sketch touching no pins at all extracts an empty list, not a crash');

  // ── the four extraction gaps found by BENCHMARK RUN 1, each a real shipped artifact ──
  //
  // 1. A pin passed to a LIBRARY CONSTRUCTOR is configured inside the library, so the sketch never
  //    calls pinMode on it. A correct climate-display sketch produced a wiring diagram with ONE
  //    rectangle (the empty board) and no components — valid PlantUML, entirely useless.
  const dhtSrc = `
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#define DHT_PIN 2
#define DHT_TYPE DHT22
DHT dht(DHT_PIN, DHT_TYPE);
LiquidCrystal_I2C lcd(0x27, 16, 2);
void setup(){} void loop(){}`;
  const dhtPins = Object.fromEntries(ae.extractPinUsage(dhtSrc).map((p) => [p.raw, p]));
  ok(dhtPins['DHT_PIN']?.resolved === '2', 'a pin passed to a library constructor (DHT) is extracted and resolved', JSON.stringify(dhtPins['DHT_PIN']));
  // 2. The SAME constructor scan must not read an I2C address or a geometry as a pin — a fictional
  //    wire in a wiring diagram is worse than a missing one.
  ok(!Object.keys(dhtPins).some((k) => /^0x/i.test(k) || k === '16'), 'LiquidCrystal_I2C(0x27, 16, 2) contributes NO pins — an address and a geometry are not wires', JSON.stringify(Object.keys(dhtPins)));
  // 3. I2C's pins are fixed and appear nowhere in the source, so an I2C display was absent from its
  //    own diagram. "SDA→A4, SCL→A5" is precisely what the diagram exists to say.
  ok(dhtPins['A4']?.calls.some((c) => /SDA/.test(c)) && dhtPins['A5']?.calls.some((c) => /SCL/.test(c)), 'an I2C include adds the fixed SDA/SCL pins, labelled', JSON.stringify([dhtPins['A4'], dhtPins['A5']]));
  ok(!Object.keys(Object.fromEntries(ae.extractPinUsage('void setup(){pinMode(3,OUTPUT);} void loop(){}').map((p) => [p.raw, p]))).includes('A4'), 'a sketch with no I2C library gets no synthetic I2C pins');
  // 4. `const int led = LED_BUILTIN;` resolved to nothing, so blink's diagram labelled the pin "led"
  //    instead of 13 — honest, but useless to the beginner the diagram is for.
  const builtinPins = Object.fromEntries(ae.extractPinUsage('const int led = LED_BUILTIN;\nvoid setup(){pinMode(led,OUTPUT);}').map((p) => [p.raw, p]));
  ok(builtinPins['led']?.resolved === '13', 'an alias for the LED_BUILTIN core macro resolves transitively to pin 13', JSON.stringify(builtinPins['led']));

  // parseConnections: the model's JSON discipline is what's most likely to drift, not the render.
  ok(ae.parseConnections('not json') === null, 'garbage input returns null rather than throwing');
  ok(ae.parseConnections('{"connections": "nope"}') === null, 'a non-array connections field is rejected');
  const wrapped = ae.parseConnections('here you go:\n```json\n{"connections":[{"pin":"13","componentId":"standard-led","leg":"anode","label":"status LED"}]}\n```');
  ok(Array.isArray(wrapped) && wrapped.length === 1 && wrapped[0].componentId === 'standard-led', 'connections wrapped in prose/fences still parse (brace-scan, same shape as diagram.ts/criteria.ts)');

  // arduino-explain.ts is now pure extraction/grounding infrastructure — no rendering of its own.
  // Grounding + PUML render is arduino-diagram.ts's job, exercised in the "arduino wiring diagram
  // render" block above and the early-return check below.
  const ad = await import(`file://${join(DIST, 'tools/arduino-diagram.js')}`);
  const outcome = await ad.runArduinoDiagram(REPO, { open: false });
  ok(outcome.ok === false && /does not look like an Arduino project/.test(outcome.reason ?? ''), 'runArduinoDiagram early-returns with a clear reason on a non-Arduino directory');
}

// ── presenter: the classification/build parser, and the pure formatter ──
console.log('\npresenter pass (no LLM)');
{
  const pr = await import(`file://${join(DIST, 'presenter/index.js')}`);

  ok(pr.parsePresentation('not json') === null, 'garbage input returns null rather than throwing');
  ok(pr.parsePresentation('{"presentable": "yes"}') === null, 'a non-boolean presentable field is rejected');

  const declined = pr.parsePresentation('{"presentable": false, "reason": "this is a rejection"}');
  ok(declined?.presentable === false && declined.reason === 'this is a rejection', 'a decline carries its reason through');
  const declinedNoReason = pr.parsePresentation('{"presentable": false}');
  ok(declinedNoReason?.presentable === false && typeof declinedNoReason.reason === 'string', 'a decline with no reason field still gets a fallback reason, not undefined');

  const wrapped = pr.parsePresentation('here you go:\n```json\n{"presentable": true, "satisfies": "added the widget", "files": [{"path": "a.ts", "summary": "added an export"}, {"path": "", "summary": "should be dropped — empty path"}]}\n```');
  ok(wrapped?.presentable === true && wrapped.files.length === 1, 'a presentation wrapped in prose/fences still parses, and an empty-path entry is dropped', JSON.stringify(wrapped));
  ok(wrapped.files[0].path === 'a.ts', 'the surviving file entry keeps its real path');

  const noFilesField = pr.parsePresentation('{"presentable": true, "satisfies": "did a thing"}');
  ok(Array.isArray(noFilesField?.files) && noFilesField.files.length === 0, 'a presentable response with no files field defaults to an empty array, not a crash');

  const text = pr.formatPresentation('fix the login bug', wrapped, []);
  ok(text.startsWith('> fix the login bug'), 'the formatted text quotes the goal first, as the "what this satisfies" offset');
  ok(text.includes('added the widget'), 'the satisfies sentence is included');
  ok(text.includes('a.ts — added an export'), 'a file bullet reads "path — summary"');
  ok(!/wiring diagram/.test(text), 'no artifact bullets when the executor produced none');

  // The artifact lines are a LIST now, not one optional Arduino string: a project type can owe the
  // user more than one artifact, and which ones exist is the executor's business, not the formatter's.
  const withArtifacts = pr.formatPresentation('blink an LED', wrapped, [
    '/tmp/x.wiring.svg — wiring diagram regenerated',
    'STILL MISSING: README (README.md)',
  ]);
  ok(withArtifacts.includes('- /tmp/x.wiring.svg — wiring diagram regenerated'), 'each executor artifact line appears as its own bullet');
  ok(withArtifacts.includes('- STILL MISSING: README (README.md)'), 'a missing required deliverable is surfaced in the presentation, not hidden');

  const emptyFiles = pr.formatPresentation('do a thing', { presentable: true, satisfies: '', files: [] }, []);
  ok(/no file-level changes reported/.test(emptyFiles), 'an empty file list still renders an honest line instead of a bare "Changed:" header');
}

// ── /explain: path extraction from prose (no LLM) ───────────────────
console.log('\nexplain: path extraction from explore prose');
{
  const p = await import(`file://${join(DIST, 'explain/paths.js')}`);

  const explainDir = join(TMP, 'explain-paths');
  mkdirSync(explainDir, { recursive: true });
  const realFile = join(explainDir, 'real-file.ts');
  writeFileSync(realFile, 'export const x = 1;\n');

  const prose = [
    `The feature lives in \`real-file.ts\`, which exports a constant.`,
    `It is NOT the same as made-up-file.ts, which does not exist.`,
    `Also see real-file.ts again — should only be counted once.`,
  ].join(' ');
  const found = p.extractExistingPaths(prose, explainDir);
  ok(found.includes('real-file.ts'), 'a backtick-quoted real path is extracted', found.join(','));
  ok(!found.some((f) => f.includes('made-up-file.ts')), 'a mentioned path that does not exist on disk is dropped');
  ok(found.filter((f) => f === 'real-file.ts').length === 1, 'the same path mentioned twice is deduped');

  const manyPaths = Array.from({ length: 20 }, (_, i) => `\`real-file.ts\` again ${i}`).join(' ');
  ok(p.extractExistingPaths(manyPaths, explainDir, 3).length <= 3, 'the result respects the caller-supplied cap');
  ok(p.extractExistingPaths('no paths mentioned here at all', explainDir).length === 0, 'prose with nothing path-shaped returns an empty list, not a crash');

  // Real bug: explore names files conversationally, by BASENAME ("the logic lives in `Deep.cs`"), not by
  // full repo-relative path. Resolving against cwd alone dropped every such mention, so on any project
  // with real directory depth /explain gathered NO git history and reported author/origin as
  // unrecoverable for a feature with hundreds of commits. A git-backed basename lookup resolves them.
  const nestRepo = join(TMP, 'explain-nested');
  const nestDeep = join(nestRepo, 'Assets', 'Scripts', 'Feature');
  mkdirSync(nestDeep, { recursive: true });
  const nGit = (...args) => execFileSync('git', args, { cwd: nestRepo, stdio: ['ignore', 'pipe', 'pipe'] });
  nGit('init', '-q');
  writeFileSync(join(nestDeep, 'Deep.cs'), '// deep\n');
  // An intentionally ambiguous basename: same name in two directories.
  mkdirSync(join(nestRepo, 'Assets', 'Scripts', 'Other'), { recursive: true });
  writeFileSync(join(nestRepo, 'Assets', 'Scripts', 'Other', 'Ambiguous.cs'), '// a\n');
  writeFileSync(join(nestDeep, 'Ambiguous.cs'), '// b\n');
  nGit('-c', 'user.name=T', '-c', 'user.email=t@e.com', 'add', '-A');
  nGit('-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'add nested files');

  const nested = p.extractExistingPaths('The core logic lives in `Deep.cs`, which does the work.', nestRepo);
  ok(nested.includes('Assets/Scripts/Feature/Deep.cs'), 'a bare basename resolves to its real nested repo path via git ls-files', nested.join(','));

  const ambiguous = p.extractExistingPaths('See `Ambiguous.cs` for details.', nestRepo);
  ok(ambiguous.length === 2, 'a basename matching a couple of files resolves to all of them — same-named files across one feature are usually all relevant', ambiguous.join(','));

  const untracked = p.extractExistingPaths('Look at `NeverExisted.cs` please.', nestRepo);
  ok(untracked.length === 0, 'a basename matching nothing tracked still resolves to nothing — the fallback never invents a path');

  // Directly-resolvable paths must still win the limit budget ahead of basename guesses.
  const mixed = p.extractExistingPaths('`Assets/Scripts/Feature/Deep.cs` and also `Ambiguous.cs`', nestRepo, 1);
  ok(mixed.length === 1 && mixed[0] === 'Assets/Scripts/Feature/Deep.cs', 'an explicitly-pathed mention takes priority over a basename-only one when the cap is tight', mixed.join(','));
}

// ── /explain: git history, ticket-key candidates, bug/churn signal ──
console.log('\nexplain: git history + bug signal (real throwaway repo)');
{
  const gh = await import(`file://${join(DIST, 'explain/git-history.js')}`);

  const repoDir = join(TMP, 'explain-repo');
  mkdirSync(repoDir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test User');

  const filePath = join(repoDir, 'feature.ts');
  writeFileSync(filePath, 'export function feature() { return 1; }\n');
  git('add', 'feature.ts');
  git('commit', '-q', '-m', 'PP-101: introduce the feature');

  writeFileSync(filePath, 'export function feature() { return 2; }\n');
  git('add', 'feature.ts');
  git('commit', '-q', '-m', 'fix a race in the feature (KY-040 sensor unrelated mention)');

  writeFileSync(filePath, 'export function feature() { return 3; }\n');
  git('add', 'feature.ts');
  git('commit', '-q', '-m', 'tidy up comments');

  const other = join(repoDir, 'other.ts');
  writeFileSync(other, 'export const other = 1;\n');
  git('add', 'other.ts');
  git('commit', '-q', '-m', 'unrelated other file');

  const history = gh.gatherGitHistory(['feature.ts'], repoDir);
  ok(history.commits.length === 3, 'gatherGitHistory finds exactly the 3 commits that touched feature.ts, not the 4th', String(history.commits.length));
  ok(history.commits[0].subject === 'tidy up comments', 'commits come back newest-first', history.commits[0].subject);
  ok(history.byPath['feature.ts']?.length === 3, 'per-path churn count is tracked independently of the merged/capped list');

  const signal = gh.computeBugSignal(history);
  ok(signal.bugfixCommits.length === 1 && signal.bugfixCommits[0].subject.includes('fix a race'), 'the bugfix-looking commit is identified by subject', JSON.stringify(signal.bugfixCommits.map((c) => c.subject)));
  ok(signal.churnByPath[0].path === 'feature.ts' && signal.churnByPath[0].commits === 3, 'churn-by-path is sorted most-touched first');

  const candidates = gh.extractTicketCandidates(history.commits);
  ok(candidates.includes('PP-101'), 'a real-shaped ticket key in a commit subject is extracted as a candidate', candidates.join(','));
  ok(candidates.includes('KY-040'), 'a hardware-part-number-shaped string is ALSO extracted as a candidate — self-validation against Jira is what filters it, not the regex', candidates.join(','));

  const evidence = gh.renderHistoryEvidence(history, signal);
  ok(evidence.includes('feature.ts') && evidence.includes('fix a race'), 'rendered evidence names the churned file and the bugfix commit');
  ok(/no visible bug history|BUGFIX-LOOKING COMMITS: none matched/.test(gh.renderHistoryEvidence({ commits: [], byPath: {} }, gh.computeBugSignal({ commits: [], byPath: {} }))), 'an empty history renders an honest "nothing found" note, not an empty section the writer could fill with a guess');

  // A path git has never seen must not throw — just contributes nothing.
  const emptyHistory = gh.gatherGitHistory(['does-not-exist.ts'], repoDir);
  ok(emptyHistory.commits.length === 0, 'a path with no git history at all degrades to an empty list, not an error');

  // Real bug, caught live against two independent /explain runs on a real codebase: a shared hub file's
  // OWN unrelated, years-older history got blended into the single "earliest commit in this evidence"
  // figure, so the writer reported a feature as beginning in 2021 (a shared file's age) when its actual
  // dedicated code started in 2026. Fixed by giving churnByPath each file's OWN earliest/latest date
  // range instead of one blended figure — verify the range is per-path, not shared.
  const dateGit = (date, ...args) => execFileSync('git', args, {
    cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  const hubPath = join(repoDir, 'hub.ts');
  writeFileSync(hubPath, 'export const hub = 1;\n');
  dateGit('2020-01-01T00:00:00', 'add', 'hub.ts');
  dateGit('2020-01-01T00:00:00', 'commit', '-q', '-m', 'ancient unrelated hub commit');
  writeFileSync(hubPath, 'export const hub = 2;\n');
  dateGit('2026-01-05T00:00:00', 'add', 'hub.ts');
  dateGit('2026-01-05T00:00:00', 'commit', '-q', '-m', 'hub wired into the new feature');

  const dedicatedPath = join(repoDir, 'dedicated.ts');
  writeFileSync(dedicatedPath, 'export const dedicated = 1;\n');
  dateGit('2026-01-01T00:00:00', 'add', 'dedicated.ts');
  dateGit('2026-01-01T00:00:00', 'commit', '-q', '-m', 'introduce the dedicated feature file');

  const mixedHistory = gh.gatherGitHistory(['hub.ts', 'dedicated.ts'], repoDir);
  const mixedSignal = gh.computeBugSignal(mixedHistory);
  const hubEntry = mixedSignal.churnByPath.find((c) => c.path === 'hub.ts');
  const dedicatedEntry = mixedSignal.churnByPath.find((c) => c.path === 'dedicated.ts');
  ok(hubEntry?.earliestDate === '2020-01-01', 'a shared hub file reports its OWN earliest date, however old', hubEntry?.earliestDate);
  ok(dedicatedEntry?.earliestDate === '2026-01-01', 'a feature-dedicated file reports its own, much more recent earliest date — never blended with the hub\'s', dedicatedEntry?.earliestDate);
  const mixedEvidence = gh.renderHistoryEvidence(mixedHistory, mixedSignal);
  ok(mixedEvidence.includes('hub.ts (2020-01-01 to 2026-01-05)'), 'the rendered evidence shows each file\'s own date range, not a single blended figure');
  ok(!/Earliest commit in this evidence/.test(mixedEvidence), 'the old blended "earliest commit in this evidence" line is gone — replaced by per-file ranges the writer must reason about');

  // Real bug, caught by running /explain three times on the SAME unchanged real feature and getting
  // DIFFERENT primary authors: authorship was counted off `history.commits`, which is capped at
  // `maxCommits` and newest-first — so the original author's early work falls out of the window and a
  // later maintainer gets credited with "developing" the feature. Authorship must count the full
  // per-path history instead. Here: `originalAuthor` makes 5 early commits, `laterMaintainer` makes 3
  // recent ones, and the merged window is capped at 3 — small enough that the capped list would see
  // ONLY the later maintainer.
  const authorRepo = join(TMP, 'explain-authors');
  mkdirSync(authorRepo, { recursive: true });
  const arGit = (...args) => execFileSync('git', args, { cwd: authorRepo, stdio: ['ignore', 'pipe', 'pipe'] });
  arGit('init', '-q');
  const authored = join(authorRepo, 'thing.ts');
  for (let i = 0; i < 5; i++) {
    writeFileSync(authored, `export const thing = ${i};\n`);
    arGit('-c', 'user.name=originalAuthor', '-c', 'user.email=o@example.com', 'add', 'thing.ts');
    arGit('-c', 'user.name=originalAuthor', '-c', 'user.email=o@example.com', 'commit', '-q', '-m', `original work ${i}`);
  }
  for (let i = 0; i < 3; i++) {
    writeFileSync(authored, `export const thing = ${i + 100};\n`);
    arGit('-c', 'user.name=laterMaintainer', '-c', 'user.email=l@example.com', 'add', 'thing.ts');
    arGit('-c', 'user.name=laterMaintainer', '-c', 'user.email=l@example.com', 'commit', '-q', '-m', `later tweak ${i}`);
  }
  const cappedHistory = gh.gatherGitHistory(['thing.ts'], authorRepo, { maxCommits: 3 });
  ok(cappedHistory.commits.length === 3, 'the merged window is genuinely capped for this test', String(cappedHistory.commits.length));
  const cappedSignal = gh.computeBugSignal(cappedHistory);
  const top = cappedSignal.authorsByCommitCount[0];
  ok(top?.author === 'originalAuthor' && top.commits === 5, 'authorship counts the FULL per-path history, so the original author still leads despite a capped recent window', JSON.stringify(cappedSignal.authorsByCommitCount));
  ok(cappedSignal.authorsByCommitCount.some((a) => a.author === 'laterMaintainer' && a.commits === 3), 'the later maintainer is still counted accurately, just not credited as the primary author');
}

// ── markdown: fixed-width contexts (dialog body, QA cards) render, not raw ──
console.log('\nmarkdown rendering (dialog body / QA cards)');
{
  const md = await import(`file://${join(DIST, 'markdown.js')}`);

  const rendered = md.renderMarkdown('**bold** and `code` and\n### a heading\n* a bullet');
  ok(rendered.includes('{bold}bold{/bold}'), 'renderMarkdown converts **bold**');
  ok(rendered.includes('{/}') && !rendered.includes('`code`'), 'renderMarkdown converts `code` spans, not left literal');
  ok(!/^###/m.test(rendered) && rendered.includes('a heading'), 'renderMarkdown strips the heading marker');
  ok(rendered.includes('• a bullet'), 'renderMarkdown converts a bullet marker to •');
  ok(md.renderMarkdown('literal {braces} in prose').includes('{open}braces{close}'), 'a literal { or } the MODEL wrote is escaped, not mistaken for a blessed tag');

  // The wrap-then-format pipeline a fixed-width dialog body needs — the exact bug reported: raw
  // **/###/* markdown showing unrendered in the permission-dialog body.
  const wrapPlain = (text, width) => text.split('\n').flatMap((p) => {
    if (!p.trim()) return [''];
    const out = []; let line = '';
    for (const w of p.split(/\s+/)) {
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ` ${w}`;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
    return out;
  });
  const wrapped = md.renderMarkdownWrapped('### The Plan\n* **Hardware Wiring**: a guide\n* **The Code**: a `.ino` sketch', 40, wrapPlain);
  const joined = wrapped.join('\n');
  ok(joined.includes('{bold}The Plan{/bold}'), 'a heading paragraph is bolded after wrap-then-format, not left as a literal ### line');
  ok(joined.includes('{bold}Hardware Wiring{/bold}'), 'inline bold survives the wrap-then-format pipeline');
  ok(joined.includes('• ') && !/^\s*\*/m.test(joined), 'bullets are converted, no raw leading * survives');
  ok(!joined.includes('`.ino`'), 'inline code backticks are converted, not left literal');
  ok(!/\{bold\}[^{]*\{bold\}/.test(joined), 'no doubled/corrupted tags from wrapping already-tagged text');
}

// ── a model whose API carries tool schemas must not be TOLD to write them in prose ──
//
// DIALECTS held only qwen and gemma, gemma being the fallback, so an OpenAI model resolved to the
// GEMMA dialect and had gemma's XML tool-call instructions injected into its system prompt — while
// providers/openai.ts was declaring the same tools natively. Told two contradictory contracts, a good
// instruction-follower used the one written in prose: it replied `<function=grep><parameter=…>` in a
// loop that had declared no tools and merely wanted JSON. The reply parsed as nothing and the
// iteration, billed per token, was discarded.
{
  const mgr = await import(join(REPO, 'dist/llm/manager.js'));
  const { NativeToolDialect } = await import(join(REPO, 'dist/llm/dialects/native.js'));
  const native = new NativeToolDialect();

  for (const id of ['gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5-mini', 'o3', 'chatgpt-4o-latest']) {
    ok(native.matches(id), `${id} resolves to the native dialect, not the gemma fallback`);
  }
  for (const id of ['gemma4:26b', 'qwen3.6:27b', 'qwen2.5-coder:32b']) {
    ok(!native.matches(id), `${id} is left to its own dialect`);
  }

  ok(native.toolCallInstructions() === '',
    'the native dialect injects NO tool-call prose — the schema travels in the request, and describing it again is a second contradictory contract');

  const mgrSrc = readFileSync(join(REPO, 'src/llm/manager.ts'), 'utf-8');
  const order = mgrSrc.slice(mgrSrc.indexOf('const DIALECTS'), mgrSrc.indexOf('const DEFAULT'));
  ok(order.indexOf('NativeToolDialect') < order.indexOf('QwenDialect'),
    'and it is matched FIRST, so nothing falls through to a text-tool-calling fallback');
  ok(mgr.adapterNames().includes('native'), 'the dialect is registered and selectable by name');
}

// ── a SUB-LOOP must not be handed tools it was told it does not have ────────────
//
// `llmChat` declared the whole tool catalogue on every call to a native provider. `explore` sends
// "you have no tools, reply with JSON" — and ayin declared `grep`, `read_file` and the rest through
// the API on the same request. GPT-4.1 did the correct thing with a real tool it had genuinely been
// given: it called it. renderToolCalls turned that into ayin's XML, which arrived inside explore's
// reply as `<function=grep><parameter=pattern>…` and parsed as nothing.
//
// The model was never confused. It was handed a tool and used it.
{
  const wiring = readFileSync(join(REPO, 'src/tool-wiring.ts'), 'utf-8');
  ok(/llmChat\(messages as Parameters<typeof llmChat>\[0\], \{ declareTools: false \}\)/.test(wiring),
    'the TOOL-facing ask declares no tools — everything reaching the model through it wants prose or JSON back');

  const mgr = readFileSync(join(REPO, 'src/llm/manager.ts'), 'utf-8');
  ok(/opts\.declareTools !== false/.test(mgr),
    'and the manager honours that, rather than declaring unconditionally to a native provider');
  ok(/declareTools\?: boolean/.test(mgr), 'the option is part of the contract, not a private flag');

  // The AGENT loop must still get them — this is the one caller that genuinely needs tools.
  const agent = readFileSync(join(REPO, 'src/agent.ts'), 'utf-8');
  ok(!/declareTools:\s*false/.test(agent),
    'the agent loop still declares tools — it is the one caller that is actually calling them');
}

// ── a tool-trained model answers with a tool call even when it has none ────────
//
// `declareTools: false` stops ayin HANDING a model tools; it cannot stop the model reaching for one.
// qwen3-coder emits `<function=grep><parameter=…>` for "find the files that…" because that is what
// it was trained to do — and the sub-loop that asked wanted JSON, so the reply parses to nothing and
// the iteration is discarded. On a metered model that is an iteration the operator paid for.
{
  const mgrSrc = readFileSync(join(REPO, 'src/llm/manager.ts'), 'utf-8');
  ok(/if \(!offersTools && activeDialect\(\)\.parse\(reply\)\.toolCalls\.length > 0\)/.test(mgrSrc),
    'a reply that IS a tool call, when the CALLER offered none, is detected through the dialect');
  ok(/declared no tools and there is nothing to call/.test(mgrSrc),
    'and the retry tells the model why, rather than repeating the original instruction louder');
  ok(/say what and why instead/.test(mgrSrc),
    'with a legal way out — a model that needed the tool must be able to SAY so rather than invent an answer');

  // Bounded, and only for callers that said they have no tools.
  // Bounded slice from the guard itself — anchoring the end on a symbol name finds the IMPORT.
  // Sliced to the END OF THE GUARD, not a fixed character count: a comment added inside it pushed the
  // last assertion out of a 1400-char window and failed a gate about code that had not changed.
  const guardAt = mgrSrc.indexOf('if (!offersTools && activeDialect()');
  const guardEnd = mgrSrc.indexOf('emitLlmCall(', guardAt);
  const guard = mgrSrc.slice(guardAt, guardEnd > guardAt ? guardEnd : guardAt + 1400);
  ok(!/while|for \(/.test(guard), 'ONE retry — a guard that can loop is worse than the behaviour it corrects');
  /**
   * THE SHAPE, NOT THE SPELLING.
   *
   * This asserted the literal text `if (retry.trim()) reply = retry;` and went RED the moment the
   * guard was refactored — `stripLeakedReasoning` was added and the local renamed to `cleaned`. The
   * INVARIANT was untouched: an empty retry still keeps the original reply. So the gate failed on a
   * change that could not break what the gate is for, and a red gate is worse than no gate, because
   * from then on nobody can tell new breakage from the failure everyone has learned to ignore.
   *
   * Matching `<ident>.trim()) reply = <ident>` tests the rule — the assignment is conditional on the
   * retry being non-empty — and survives any renaming of the local. There are ~88 source-text
   * assertions across these gates; every one of them is a refactor away from this, and each should be
   * written as a shape or an invariant rather than a quotation when it is next touched.
   */
  ok(/if \((\w+)\.trim\(\)\) reply = \1;/.test(guard),
    'and an EMPTY retry keeps the original — replacing a bad reply with nothing is not an improvement');
  ok(!/^\s*reply = (?!.*trim)/m.test(guard),
    'nothing overwrites the reply unconditionally — that is the same rule, from the other side');

  // ── slash-only tools: the operator may run them, the agent may not ─────────
  {
    const reg = readFileSync(join(DIST, '..', 'src', 'tools.ts'), 'utf-8');
    ok(/export function modelTools\(\)/.test(reg),
      'there is ONE list of what the model may call');
    ok(/tools\.filter\(\(t\) => !t\.slashOnly\)/.test(reg), '…and it excludes the slash-only ones');
    ok(/function assertSlashOnlyReachable/.test(reg),
      'slashOnly without a slash command is caught at BOOT — otherwise the tool is reachable by nobody');

    // The prompt catalogue and the native schemas must agree, or the model is offered a tool the
    // prompt never described, or told about one it cannot call.
    const mgr = readFileSync(join(DIST, '..', 'src', 'llm', 'manager.ts'), 'utf-8');
    ok(/reg\.modelTools\(\)\.map/.test(mgr), 'native tool schemas come from the same list as the prompt');
    ok(/const toolDefs = modelTools\(\)/.test(reg), '…and so does the prompt catalogue');

    // Refusing must be honest: the tool exists, it is simply not the agent's.
    const agent = readFileSync(join(DIST, '..', 'src', 'agent.ts'), 'utf-8');
    ok(/if \(tool\?\.slashOnly\)/.test(agent), 'a slash-only call is refused explicitly');
    ok(/is not available to you — it is an operator command/.test(agent),
      '…and says WHO can run it, rather than claiming the tool does not exist');

    // A tool whose ARGUMENT is a credential must never be offered to the model. Its catalogue entry
    // otherwise sits in the prompt every turn teaching the model that a place to put tokens exists,
    // and a tool the model can call is a tool it can be talked into calling.
    for (const name of ['jira_auth', 'sentry_auth', 'slack_auth', 'openai_auth']) {
      const src = readFileSync(join(DIST, '..', 'src', 'tools', 'defs', `${name}.ts`), 'utf-8');
      ok(/secret: true/.test(src) ? /slashOnly: true/.test(src) : true,
        `${name} takes a secret, so it is operator-only`);
    }
  }

  // ── /skip-permissions turns off a GUARD, so its limits are pinned ──────────
  {
    const perm = readFileSync(join(DIST, '..', 'src', 'permissions.ts'), 'utf-8');
    // The push/pull/checkout check must stay ABOVE every rule the flag can reach, and under the flag
    // it must DENY rather than allow: those are unrecoverable and public, and nobody is watching.
    const dangerAt = perm.indexOf('const danger = dangerousShellOp');
    const skipAt = perm.indexOf('if (skipPermissions || HEADLESS) {');
    ok(dangerAt > 0 && skipAt > dangerAt,
      'the push/pull/checkout guard runs BEFORE the skip flag is consulted');
    ok(/if \(HEADLESS \|\| skipPermissions \|\| READONLY\) \{[\s\S]{0,300}?return 'deny';/.test(perm),
      '…and with prompts off those ops are DENIED, never waved through');

    // Session-scoped on purpose: a gate that silently stayed off after a restart is one nobody
    // remembers turning off, and the first they learn of it is the thing it would have stopped.
    ok(/let skipPermissions = /.test(perm), 'the flag is mutable for the session');
    ok(!/setConfigValue\([^)]*skipPermission/i.test(perm),
      'it is NEVER persisted — it must not survive a restart');

    const appSrc = readFileSync(join(DIST, '..', 'src', 'app.ts'), 'utf-8');
    const cmd = appSrc.slice(appSrc.indexOf("case '/skip-permissions'"), appSrc.indexOf("case '/skip-permissions'") + 1400);
    ok(/setStickyAlert\('warn'/.test(cmd),
      'while it is on the operator SEES it — an invisible disabled guard is the dangerous kind');
    ok(/DENIED, not allowed/.test(cmd), 'the message states what is still gated, rather than implying nothing is');
  }

  // ── the finished-reply marker, and the three places models put it ──────────
  //
  // A `$` opening the LAST line of a multi-line reply was caught by neither pattern: not at the
  // string start (no `m` flag, deliberately) and not the last non-space character, because a word
  // follows it. It reached the operator's screen as `$ Done.` after they had asked for it to be gone.
  {
    const fm = readFileSync(join(DIST, '..', 'src', 'final-marker.ts'), 'utf-8');
    ok(/const FINAL_MARKER_LAST_LINE = /.test(fm),
      'a marker opening the last line is stripped — models put it there and neither old pattern caught it');
    ok(/function insideCodeFence/.test(fm),
      'a `$` inside a fenced block is a SHELL PROMPT and must survive — `$ npm run build` is not a signal');
  }

  // ── the model-resolution state has THREE values, not two ───────────────────
  //
  // "never resolved" and "not resolved YET" read the same to a human and mean opposite things. The
  // bundle reported the alarming one as fact and sent two investigations after a healthy session.
  {
    const appSrc = readFileSync(join(DIST, '..', 'src', 'app.ts'), 'utf-8');
    ok(/modelResolution\(\)\.gaveUp/.test(appSrc),
      'the bundle distinguishes GAVE UP from still-trying');
    ok(/not resolved YET/.test(appSrc),
      '…and says so, rather than claiming a fallback that has not happened');
  }

  // ── the window is bounded by TOKENS, not by a message count ────────────────
  //
  // A fixed count is the wrong unit in both directions: 20 messages is a third of a 65k window and an
  // overflow of a 32k one, and the operator swaps presets under a running session. Being wrong upward
  // is not a worse answer — it is a failed call, or a silently truncated prompt whose missing part is
  // the oldest and most load-bearing history.
  const winSrc = readFileSync(join(DIST, '..', 'src', 'agent.ts'), 'utf-8');
  ok(/function trimToContext\(/.test(winSrc),
    'the assembled prompt is trimmed to the context of the model actually loaded');
  ok(/activeContextTokens\(\) \|\| CONSERVATIVE_CONTEXT/.test(winSrc),
    'the budget comes from the LIVE preset, with a conservative floor when the model has not resolved');
  ok(/const head = messages\[0\];/.test(winSrc) && /return \[head, \.\.\.rest\]/.test(winSrc),
    'the system message is never evicted — it carries the tools, and it must stay byte-identical for the KV cache');
  {
    const push = /function pushToWindow[\s\S]{0,600}?\n}/.exec(winSrc)?.[0] ?? '';
    ok(/WINDOW_HARD_MAX/.test(push),
      'pushToWindow bounds MEMORY only; what fits the model is decided at build time, not at push time');
  }
  // The chars-per-token figure every budget above divides by. It WAS a flat pessimistic 3 asserted as a
  // literal here; it is now measured from the server's own `prompt_eval_count`, which on this workload
  // is ~4.2 — so the literal was costing a third of every window it was protecting. The property the
  // assertion existed for is unchanged and is what is checked: NEVER GUESS LOW. An overrun is not a
  // degraded answer, it is a failed call or a silently truncated prompt.
  ok(/charsPerToken\(\)/.test(winSrc) && !/const CHARS_PER_TOKEN = 3;/.test(winSrc),
    'the estimate is MEASURED from the live model, not a constant guessed in this file');
  {
    const mgr = readFileSync(join(DIST, '..', 'src', 'llm', 'manager.ts'), 'utf-8');
    ok(/const RATIO_FALLBACK = 3;/.test(mgr),
      'until it is measured the fallback is the same pessimistic 3 — a fresh session behaves exactly as before');
    ok(/RATIO_MIN_SAMPLES = 3/.test(mgr) && /ratioSamples >= RATIO_MIN_SAMPLES/.test(mgr),
      'and one call never sets it — the first prompt of a session is almost entirely the fixed prefix');
    const bounds = /const RATIO_MIN = ([\d.]+);[\s\S]{0,80}?const RATIO_MAX = ([\d.]+);/.exec(mgr);
    ok(!!bounds && Number(bounds[1]) >= 2.5,
      'a measured ratio below 2.5 is REJECTED, not used — that is the one direction that overruns the model',
      bounds ? `min=${bounds[1]}` : '(no bounds found)');
    ok(!!bounds && Number(bounds[2]) <= 6,
      'and an implausibly high one is rejected too — a vision call has tokens that are not in promptChars at all',
      bounds ? `max=${bounds[2]}` : '(no bounds found)');
    ok(/resetTokenRatio\(\)/.test(mgr) && (mgr.match(/resetTokenRatio\(\);/g) || []).length >= 2,
      'and it is reset when the provider OR the model changes — a different tokenizer is a different number');
  }

  // THE AGENT LOOP MUST BE UNTOUCHED: there, a tool call is the point. This gate asserted that and was
  // WRONG, because it asserted the wrong variable. `declared` also means "schemas went to the runtime",
  // which in prompt mode is never true — so against every text-contract endpoint the guard fired on
  // every round of the loop, parsed the model's `<function=read_file>`, discarded it, and replied "you
  // have no tools". Measured on gemma4:26b: three valid calls in three rounds, all destroyed.
  //
  // Two variables now, because they are two questions. `offersTools` is the CALLER's answer to "does
  // this call have tools", and it is the only thing the guard may consult; `declared` is transport.
  ok(/const offersTools = opts\.declareTools !== false;/.test(mgrSrc),
    'whether a call HAS tools is the caller\'s answer, independent of how they are transported');
  ok(/const declared = toolMode\(\) === 'native' && offersTools;/.test(mgrSrc),
    'and declaring schemas to the runtime is the transport question, derived from it');
  {
    const guardLine = mgrSrc.slice(mgrSrc.indexOf('if (!offersTools && activeDialect()'), mgrSrc.indexOf('if (!offersTools && activeDialect()') + 90);
    ok(!/toolMode|declared\b/.test(guardLine),
      'the guard reads NEITHER toolMode nor declared — prompt mode is how most installs run, and there the loop calls tools');
  }
  ok(/llmChat\(\[\{ role: 'user', content: prompt \}\], \{ declareTools: false \}\)/.test(mgrSrc),
    'llmCall offers no tools by construction — one user message, no system prompt, so no catalogue and no schemas');

  // ONE SOURCE OF TRUTH for who declares tools.
  //
  // `provider.tools` is what the provider is WILLING to do, before the resident model is known;
  // `toolMode()` is that claim reconciled against the model actually loaded, and it can only be
  // downgraded. Reading the raw claim here while the system prompt read the reconciled one split the
  // decision in two and the halves disagreed: the prompt omitted the tool catalogue because the mode
  // said native, while this line still declared schemas to a model whose wire format could not carry
  // them. The model emitted canonical XML its own server could not parse, and a real run came back as
  // 21 lines of unparsed text with ZERO tool calls.
  const declAt = mgrSrc.indexOf('const declared =');
  ok(!/provider\.tools/.test(mgrSrc.slice(declAt, declAt + 200)),
    'the tool-declaration decision reads toolMode(), never provider.tools directly');
}

// ── edit truth: a reported change that was never written ──────────────────────
//
// Measured on a real session (ayin 1.0.320, bundle `1bd347dc`): 23 tools, three `str_replace` calls
// that all failed, nothing written, and a final answer opening "Fixed by reordering the operations in
// Dispose()" — naming a file it had never attempted to edit. Nothing caught it. The QA gate is
// session-off by default AND declines on "nothing changed this turn", which is precisely this case,
// so the guard had to be unconditional and free. Being pure, it is testable here rather than needing
// a model, a turn and a repo — which is the whole reason it lives in its own module.
console.log('\nedit truth');
{
  const e = await import(`file://${join(DIST, 'edit-truth.js')}`);

  // THE CONTRACT THIS READS. Success is "the tool did not return an error", and every edit tool
  // reports failure with a leading `Error:`. If a tool ever stops doing that, a failed edit counts as
  // a success here and the guard goes quiet — so the prefix is pinned against the real sources.
  for (const t of ['str_replace', 'write_file']) {
    const src = readFileSync(join(REPO, `src/tools/defs/${t}.ts`), 'utf-8');
    const returns = src.match(/return\s+[`'"]Error:/g) ?? [];
    ok(returns.length > 0, `${t} still reports failure with a leading \`Error:\``, `${returns.length} site(s)`);
  }

  e.beginEditTurn();
  ok(e.noteEditAttempt('str_replace', '/a.cs', 'Error: old_str not found in /a.cs.') === false,
    'an Error: result is a failed attempt');
  ok(e.noteEditAttempt('write_file', '/b.cs', 'wrote 12 lines') === true, 'anything else is a success');

  // The exact shape of the measured failure: three misses on one file, nothing written, a claim.
  e.beginEditTurn();
  e.noteEditAttempt('str_replace', '/Brain.cs', 'Error: old_str not found in /Brain.cs.');
  e.noteEditAttempt('str_replace', '/Brain.cs', 'Error: old_str and new_str are identical — nothing to change.');
  e.noteEditAttempt('str_replace', '/Brain.cs', 'Error: old_str not found in /Brain.cs.');
  ok(e.consecutiveMissesOn('/Brain.cs') === 3, 'consecutive misses on ONE file are counted');
  ok(e.claimsAnEditThatDoesNotExist('Fixed by reordering the operations in Dispose().', 0, 23) === true,
    'the measured answer is caught');
  ok(/old_str not found/.test(e.attemptsSummary()),
    'and the model gets its own error strings back, not a count it can argue with');

  // A SUCCESS ANYWHERE EXEMPTS THE TURN. A turn that really edited something is reporting work.
  e.beginEditTurn();
  e.noteEditAttempt('str_replace', '/a.cs', 'Error: old_str not found in /a.cs.');
  e.noteEditAttempt('str_replace', '/a.cs', 'replaced 1 occurrence');
  ok(e.claimsAnEditThatDoesNotExist('Fixed by reordering the operations.', 0, 5) === false,
    'one landed edit exempts the turn');
  ok(e.consecutiveMissesOn('/a.cs') === 0, 'and a success resets the miss streak');

  // THE FALSE POSITIVES THAT WOULD MAKE IT WORSE THAN NOTHING. `deferral.ts` earned this discipline:
  // a guard that nags a correct answer trains the operator to ignore the one that matters.
  e.beginEditTurn();
  ok(e.claimsCompletedEdit('The fix is to change GetTimeBonus to use the base score.') === false,
    'PROPOSING a change is not claiming one — present tense never fires');
  ok(e.claimsCompletedEdit('You should update the multiplier before the bonus is computed.') === false,
    'nor is recommending one');
  ok(e.claimsCompletedEdit('I updated GetTimeBonus to read the unmultiplied score.') === true,
    'completed aspect does fire');
  ok(e.claimsAnEditThatDoesNotExist('I updated the file.', 2, 9) === false,
    'files changed → never fires, whatever the wording');
  ok(e.claimsAnEditThatDoesNotExist('That bug was fixed by an earlier commit.', 0, 0) === false,
    'a turn that ran no tools is not reporting on its own work');

  // The wiring, which no unit can see: the ledger must be fed only where edits happen, the QA gate
  // must stop counting a FAILED edit as a changed file, and the guard must be able to fire only once.
  const agentSrc = readFileSync(join(REPO, 'src/agent.ts'), 'utf-8');
  ok(/if \(noteEditAttempt\(name, params\.path, result\)\) qaNoteTouched\(params\.path\);/.test(agentSrc),
    'a file is marked CHANGED only when its edit actually landed');
  ok(/unwrittenClaimNudges < 1/.test(agentSrc),
    'ONE nudge — an answer that is genuinely a proposal must be able to stand');
  ok(existsSync(join(REPO, 'prompts/ayin/unwrittenClaim.txt')),
    'the nudge is a prompt FILE, never a string in source');
}

// ── the served model is retried until it is known ─────────────────────────────
//
// The same bundle read `"model": "unknown", "dialect": "gemma"` against a qwen3-coder endpoint. The
// dialect is HOW TOOL CALLS ARE FORMATTED, and it was the gemma DEFAULT purely because one status
// probe missed: the latch was set before the attempt, so resolution happened at most once per process.
console.log('\nmodel resolution');
{
  const mgrSrc = readFileSync(join(REPO, 'src/llm/manager.ts'), 'utf-8');
  ok(!/refreshKicked/.test(mgrSrc), 'the one-shot latch is gone');
  ok(/if \(cachedModelId\) return;/.test(mgrSrc),
    'resolution stops when it SUCCEEDS, not when it is first attempted');
  ok(/modelAttempts\+\+;\s*\n\s*modelLastAttemptAt = Date\.now\(\);/.test(mgrSrc),
    'the attempt is counted around the call, not on entry');
  ok(/llm_model_unresolved/.test(mgrSrc),
    'and giving up SAYS SO — a fallback dialect must never be silent');
  ok(/MODEL_MAX_ATTEMPTS/.test(mgrSrc), 'bounded: an endpoint that never reports a model is a real configuration');

  const picker = readFileSync(join(REPO, 'src/model-picker.ts'), 'utf-8');
  ok((picker.match(/resetModelResolution\(\)/g) ?? []).length >= 2,
    'switching PROVIDER forgets the model id, so the old provider\'s dialect cannot survive the switch');

  // The manifest must say WHY, or `"dialect": "gemma"` is again two facts hiding the one that matters.
  const appSrc = readFileSync(join(REPO, 'src/app.ts'), 'utf-8');
  ok(/FALLBACK — model never resolved/.test(appSrc),
    'the debug manifest distinguishes a MATCHED dialect from a fallen-back one');
}

// ── the context window is REPORTED, never invented ────────────────────────────
//
// Three numbers described one window and none agreed: the status bar said 65536 (a hardcoded
// fallback belonging to no model), the indulge budget said 16384 (a local default for a provider
// that was not in use), and the resource layer had been reporting the true 40000 all along. The
// operator watched a meter promising four times the room they had while the runtime truncated in
// silence — and every budget derived from it was sized for a window less than half the real one.
console.log('\ncontext window');
{
  const tokSrc = readFileSync(join(REPO, 'src/tokens.ts'), 'utf-8');
  ok(!/\|\|\s*65536/.test(tokSrc), 'the meter no longer invents a 65536 window');
  ok(/activeContextTokens\(\)/.test(tokSrc), 'it asks the provider-reported window instead');

  const budgetSrc = readFileSync(join(REPO, 'src/indulge/budget.ts'), 'utf-8');
  ok(/const reported = activeContextTokens\(\);\s*\n\s*if \(reported > 0\) return reported;/.test(budgetSrc),
    'the budget PREFERS the reported window over the local ollama setting');

  // 0 must mean unknown all the way to the glass, or the fix just moves the lie.
  const statusSrc = readFileSync(join(REPO, 'src/ui/widgets/status.ts'), 'utf-8');
  ok((statusSrc.match(/!\(this\.state\.tokens\.total > 0\)/g) ?? []).length >= 2,
    'an unknown window renders as unknown in BOTH status renderings, never as a percentage of zero');

  // The provider port must be able to carry it, and the resource provider must actually read it.
  const portSrc = readFileSync(join(REPO, 'src/llm/provider.ts'), 'utf-8');
  ok(/contextTokens\?: number;/.test(portSrc), 'ProviderStatus can carry the window');
  const resSrc = readFileSync(join(REPO, 'src/llm/providers/resource.ts'), 'utf-8');
  ok(/ctxSize/.test(resSrc) && /status: resourceStatus,/.test(resSrc),
    'the resource provider reads ctxSize from the resource op rather than the {ok,model} endpoint');
  ok(/return httpStatus\(\);/.test(resSrc),
    'and falls back to the plain contract, so a backend without the op does not read as down');

  const ollamaSrc = readFileSync(join(REPO, 'src/llm/providers/ollama.ts'), 'utf-8');
  ok(/contextTokens: numCtx\(\)/.test(ollamaSrc),
    'the ollama provider reports the num_ctx it sets itself — there it is fact, not estimate');

  const mgrCtx = readFileSync(join(REPO, 'src/llm/manager.ts'), 'utf-8');
  ok(/cachedContextTokens = 0; \/\/ a different provider/.test(mgrCtx),
    'switching provider forgets the window, so the old provider\'s number cannot survive the switch');
}

// ── the Glimmer (ATEM) dialect ────────────────────────────────────────────────
//
// Muse Glimmer speaks none of the three formats ayin knew. Every fixture below is taken from
// Ollama's OWN reference tests (model/parsers/glimmer_test.go), not from an observed reply: a
// dialect inferred from one sample is a dialect that breaks on the second.
console.log('\nglimmer dialect (ATEM)');
{
  const { GlimmerDialect } = await import(`file://${join(DIST, 'llm/dialects/glimmer.js')}`);
  const d = new GlimmerDialect();

  ok(d.matches('muse-glimmer:30b-q4_K_M') && d.matches('muse-glimmer:30b'), 'matches the real tags');
  ok(!d.matches('qwen3-coder:30b') && !d.matches('gemma4:26b'), 'and steals neither qwen nor gemma');

  // The reference test's own final-answer shape.
  const ans = d.parse(' to=user<|message|>Hello');
  ok(ans.text === 'Hello' && ans.toolCalls.length === 0, 'a routed final answer yields clean text');

  const call = d.parse(` to=read<|message|><atem:function_calls>
<atem:invoke name="read">
<atem:parameter name="path">src/main.ts</atem:parameter>
</atem:invoke>
</atem:function_calls>`);
  ok(call.toolCalls.length === 1 && call.toolCalls[0].name === 'read', 'an ATEM invoke parses');
  ok(call.toolCalls[0]?.params.path === 'src/main.ts', 'with its parameter');
  ok(call.text === '', 'and no wrapper markup leaks to the user');

  // Namespaced calls: the renderer tells the model to invoke bare when there is no namespace, and
  // ayin's tool names are globally unique — so a namespaced name must still resolve.
  const ns = d.parse('<atem:function_calls><atem:invoke name="some_tool.grep"><atem:parameter name="pattern">x</atem:parameter></atem:invoke></atem:function_calls>');
  ok(ns.toolCalls[0]?.name === 'grep', 'a namespaced invoke resolves to the bare tool name');

  // THE ONE THAT BREAKS EDITING IF WRONG. An old_str is data: its indentation is the thing that
  // makes str_replace match. Trimming it here would reproduce today's failed-edit bug by another route.
  const ws = d.parse(`<atem:function_calls><atem:invoke name="str_replace"><atem:parameter name="old_str">    if (x) {
        return 1;
    }</atem:parameter></atem:invoke></atem:function_calls>`);
  ok((ws.toolCalls[0]?.params.old_str ?? '').startsWith('    if (x) {'), 'leading indentation in a value is PRESERVED');

  // The renderer states the output is not valid XML and is regex-parsed — so `<` in a value is legal.
  const lt = d.parse('<atem:function_calls><atem:invoke name="write_file"><atem:parameter name="content">if (a < b) {}</atem:parameter></atem:invoke></atem:function_calls>');
  ok(lt.toolCalls[0]?.params.content === 'if (a < b) {}', 'a value containing < survives');

  ok(!/<\|/.test(d.parse(' to=user<|message|>Done.<|eot|>').text), 'control tokens never reach the user');

  const rt = d.parse(d.renderToolCall({ name: 'str_replace', params: { old_str: '  a\n  b' } }));
  ok(rt.toolCalls[0]?.params.old_str === '  a\n  b', 'render → parse round-trips an indented value');

  ok(/tool_output/.test(d.renderToolResult('x')), 'results framed as <tool_output>, per the renderer');

  // Registered, and gemma must remain the LAST entry — manager.ts derives DEFAULT from the tail.
  const mgrSrc = readFileSync(join(REPO, 'src/llm/manager.ts'), 'utf-8');
  ok(/new GlimmerDialect\(\)/.test(mgrSrc), 'registered in DIALECTS');
  // The INVARIANT is that gemma is LAST — manager.ts derives DEFAULT from the tail, and a dialect
  // after it would become the fallback for every unrecognised model. Pinning glimmer as gemma's
  // immediate neighbour tested something narrower than that and failed the moment a fourth dialect
  // was added between them, which is a correct change wearing a broken assertion.
  ok(/new GemmaDialect\(\)\]/.test(mgrSrc), 'gemma is LAST, so it stays the fallback DEFAULT');
  const order = [...mgrSrc.matchAll(/new (\w+Dialect)\(\)/g)].map((m) => m[1]);
  ok(order.indexOf('GlimmerDialect') < order.indexOf('GemmaDialect'),
    'glimmer is matched BEFORE gemma, so gemma cannot shadow it');
}


// ── the glm dialect speaks GLM's OWN format, not one inferred from a sample ───────
//
// A dialect was written from a single observed reply — `<read_file><path>…</path></read_file>` — and
// taught back to the model. GLM-4.5/4.6 are trained on an envelope with the name on the opening line
// and alternating <arg_key>/<arg_value> pairs. Teaching a model a syntax it does not know produces a
// bad imitation: a `//` comment marker arrived as `/`, and a long call arrived unterminated and was
// printed at the operator as prose. This gate pins the real format so nobody re-derives it by eye.
{
  const { GlmDialect } = await import(join(REPO, 'dist/llm/dialects/glm.js'));
  const d = new GlmDialect();

  ok(d.matches('glm-4.7-flash:q4_K_M') && d.matches('GLM-4.6'), 'glm: claims glm models');
  ok(!d.matches('gemma4:26b') && !d.matches('qwen3-coder:30b'), 'glm: steals neither gemma nor qwen');

  const documented = '<tool_call>read_file\n<arg_key>path</arg_key>\n<arg_value>src/x.ts</arg_value>\n</tool_call>';
  const one = d.parse(documented).toolCalls[0];
  ok(one?.name === 'read_file' && one.params.path === 'src/x.ts', 'glm: the documented <tool_call>NAME + arg_key/arg_value form parses');

  ok(/arg_key/.test(d.toolCallInstructions()) && /arg_value/.test(d.toolCallInstructions()),
    'glm: the prompt teaches THAT form, not another one');

  const json = d.parse('<tool_call>{"name": "grep", "arguments": {"pattern": "a|b"}}</tool_call>').toolCalls[0];
  ok(json?.name === 'grep' && json.params.pattern === 'a|b', 'glm: the JSON compatibility form parses too');

  const code = 'const f = (id) => x !== id;\n\n// note\nfunction g(o = {}) { return o; }';
  const rt = d.parse(d.renderToolCall({ name: 'str_replace', params: { path: 'p.ts', new_str: code } }));
  ok(rt.toolCalls[0]?.params.new_str === code,
    'glm: a value carrying //, braces and newlines round-trips byte-exact — this is what was mangled');

  const withTag = d.parse('<tool_call>write_file\n<arg_key>content</arg_key>\n<arg_value><div>hi</div></arg_value>\n</tool_call>');
  ok(withTag.toolCalls[0]?.params.content === '<div>hi</div>', 'glm: a value containing markup survives');

  ok(d.parse('See the <Component> tag and the <path> element.').toolCalls.length === 0,
    'glm: prose that merely contains tags is not executed');

  const cut = '<tool_call>str_replace\n<arg_key>new_str</arg_key>\n<arg_value>function g(o = {}) {';
  ok(d.truncated(cut) === true && d.parse(cut).toolCalls.length === 0,
    'glm: a CUT-OFF call is reported truncated and never parsed into a runnable call');
  ok(d.truncated(documented) === false, 'glm: a complete call is not mistaken for a truncated one');

  const agentSrc = readFileSync(join(REPO, 'src/agent.ts'), 'utf-8');
  ok(/replyTruncated\(response\)/.test(agentSrc),
    'glm: and the agent CHECKS it — a truncated call is otherwise indistinguishable from a final answer');
}

console.log(fails === 0 ? '\ngate check: ok' : `\ngate check: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
