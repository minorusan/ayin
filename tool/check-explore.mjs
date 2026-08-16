#!/usr/bin/env node
/**
 * check-explore — proves the `explore` tool stops looping, against the REAL loop.
 *
 * `npm run check:explore` (needs a build first). Not a unit test of the anti-repeat helpers in
 * isolation — those would pass even if the wiring into `exploreExecute` were wrong. Instead this spins
 * up a fake backend implementing the real `/api/status` + `/api/generate` contract, points a child
 * process at it via `AYIN_MODEL_URL`, and scripts a model that deliberately re-suggests a command it already
 * ran — the exact failure mode reported: "it keeps looping". A `spawn`-based subprocess, not an
 * in-process import, because `exploreExecute` shells out for real and a fake backend over HTTP is the
 * only way to drive it end-to-end without also faking the shell.
 *
 * NOT in `npm run check:gates` — that suite is instant and network-free; this one starts a server and
 * a child process and takes a few seconds. Run it whenever `tools/explore.ts` changes.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TMP = mkdtempSync(join(tmpdir(), 'ayin-explore-'));

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

// A small tree to search — one findable string, so a real `grep` has real output.
writeFileSync(join(TMP, 'target.txt'), 'needle: the thing being searched for\n');

const REPEAT_CMD = `grep -rn "needle" ${TMP}`;

// The scripted model: every call re-suggests the SAME command, never commits an answer. If the
// anti-repeat memory works, this must terminate in 2-3 rounds (first run + one "already run" refusal
// noticed for two iterations), not run out the 12-iteration budget.
let generateCalls = 0;
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: 'test-model' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/generate') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      generateCalls++;
      const content = JSON.stringify({
        reasoning: `looking for the needle, attempt ${generateCalls}`,
        commands: [REPEAT_CMD],
        confidence: 0.3,
        answer: null,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

console.log('explore anti-loop (real backend, real shell, scripted repeat)');

const harness = join(TMP, 'harness.mjs');
writeFileSync(harness, `
process.argv.push('-p');
// A tool gets its model and its log as delegates, so a consumer importing the tool module directly —
// which this harness does deliberately, to exercise the real thing — wires the runtime itself. This
// harness standing in for a real entry point is what caught \`ayin explain\` and \`plan\` relying on
// the registry having been imported by somebody else first.
const { ensureToolRuntime } = await import(${JSON.stringify(`file://${join(REPO, 'dist/tool-wiring.js')}`)});
ensureToolRuntime();
const { exploreExecute } = await import(${JSON.stringify(`file://${join(REPO, 'dist/tools/explore.js')}`)});
const start = Date.now();
const result = await exploreExecute({ question: 'find the needle' });
process.stdout.write(JSON.stringify({ result, ms: Date.now() - start }) + '\\n');
`);

/**
 * The child must talk to THIS gate's stub server and nothing else.
 *
 * Two things had to be pinned, and neither was. `prompts.ts` resolves `~/.ayin-cli/prompts.json` at
 * module load, so a child inheriting the real HOME reads the OPERATOR's settings — and this machine's
 * had `llmProvider: ollama`, which selects the native provider, talks to Ollama directly and ignores
 * AYIN_MODEL_URL completely. The gate then measured zero calls against its own server while the child
 * happily got a real 27-second answer from a real model: every assertion about call counts silently
 * meaningless, and the result depending on whose machine it ran on.
 */
function childEnv(p) {
  return {
    ...process.env,
    HOME: mkdtempSync(join(tmpdir(), 'ayin-explore-home-')),
    USERPROFILE: mkdtempSync(join(tmpdir(), 'ayin-explore-home-')),
    AYIN_MODEL_URL: `http://127.0.0.1:${p}`,
    AYIN_LLM_PROVIDER: 'direct',   // never the native path — it does not read AYIN_MODEL_URL
    AYIN_QA: '0',
    AYIN_PLAN: '0',
  };
}

const child = spawn(process.execPath, [harness], {
  env: childEnv(port),
  cwd: TMP,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
child.stdout.on('data', (d) => { stdout += d; });
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 45_000);
  child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
});

server.close();

ok(exitCode !== 'timeout', 'the investigation terminated on its own (did not hang)', String(exitCode));
ok(generateCalls <= 4, 'stopped within a few rounds instead of exhausting the 12-round budget', `${generateCalls} model call(s)`);
ok(generateCalls >= 1, 'the backend was actually reached at least once', `${generateCalls} call(s)`);

let parsed = null;
try { parsed = JSON.parse(stdout.trim().split('\n').pop() ?? ''); } catch { /* leave null */ }
ok(!!parsed, 'the tool returned a result at all', stdout.slice(0, 200) || stderr.slice(0, 200));
if (parsed) {
  ok(/circling|already run/i.test(parsed.result), 'the returned text explains it stopped because of a repeat', parsed.result.slice(0, 160));
}

// ── control: a normal investigation (new command each round, then an answer) must NOT be affected ──
console.log('\nexplore normal case (must still work — the fix must not break ordinary use)');
{
  let calls = 0;
  const server2 = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: 'test-model' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/generate') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls++;
        // Round 1: a genuinely new command. Round 2: commit the answer — never repeats anything.
        const content = calls === 1
          ? JSON.stringify({ reasoning: 'first look', commands: [`cat ${join(TMP, 'target.txt')}`], confidence: 0.3, answer: null })
          : JSON.stringify({ reasoning: 'found it', commands: [], confidence: 0.9, answer: 'needle: the thing being searched for — found in target.txt' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const port2 = server2.address().port;

  const child2 = spawn(process.execPath, [harness], {
    env: childEnv(port2),
    cwd: TMP,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout2 = '';
  child2.stdout.on('data', (d) => { stdout2 += d; });
  const code2 = await new Promise((resolve) => {
    const timer = setTimeout(() => { child2.kill('SIGKILL'); resolve('timeout'); }, 45_000);
    child2.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  server2.close();

  ok(code2 !== 'timeout', 'a normal two-round investigation still terminates');
  ok(calls === 2, 'it took exactly the two rounds it needed — no extra refusals for genuinely new commands', `${calls} call(s)`);
  let parsed2 = null;
  try { parsed2 = JSON.parse(stdout2.trim().split('\n').pop() ?? ''); } catch { /* leave null */ }
  ok(!!parsed2?.result?.includes('found in target.txt'), 'the real answer is returned, not a repeat-guard message', parsed2?.result?.slice(0, 120));
}

// ── a tool-trained model answers with a TOOL CALL; recover it, don't burn the turn ──
//
// Measured on GPT-4.1: the explore loop asks for shell commands inside a JSON field, and a
// function-calling model reads "run grep" as a tool call and emits its own syntax —
// `<function=grep><parameter=pattern>…`. Nothing is wrong with the model; it is being asked to
// describe a tool invocation in prose, which is exactly what a tool-trained model is built not to do.
{
  const EX = await import(join(REPO, 'dist/tools/explore.js'));
  const src = readFileSync(join(REPO, 'src/tools/explore.ts'), 'utf-8');
  ok(/function recoverToolCall/.test(src), 'a tool-shaped reply is recovered rather than discarded');
  ok(src.indexOf('recoverToolCall(cleaned)') < src.indexOf("cleaned.indexOf('{')"),
    'and recovery is tried BEFORE the JSON path — such a reply contains no JSON to find');

  const sys = readFileSync(join(REPO, 'prompts/explore/investigatorSystem.txt'), 'utf-8');
  ok(/NEVER emit a tool call/i.test(sys),
    'the system prompt forbids tool calls explicitly — one line saying "only JSON" is not a contract a function-calling model holds');
  ok(/"commands" array/.test(sys), 'and says where commands actually go');
}

console.log(fails === 0 ? '\nexplore check: ok' : `\nexplore check: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
