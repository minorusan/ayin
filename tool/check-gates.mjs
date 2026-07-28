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
import { mkdtempSync, writeFileSync } from 'node:fs';
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
const rf = { path: join(TMP, 'x.ts') };
ok(g.guardCheck('read_file', rf).allow === true, 'first call runs');
const second = g.guardCheck('read_file', rf);
ok(second.allow === false && /identical repeat/.test(second.label ?? ''), 'second identical call is skipped, not run again');
const third = g.guardCheck('read_file', rf);
ok(third.allow === false && /blocked/.test(third.label ?? ''), 'third identical call is BLOCKED for the turn');
ok(/BLOCKED/.test(g.guardCheck('read_file', rf).note ?? ''), 'the block persists after it is set');
ok(/read_file/.test(g.guardDirective()), 'the block is stated in the system-prompt directive');

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
ok(/sleep/.test(g.guardCheck('bash', cmd).note ?? ''), 'a blocked bash call is told its wait-escape-hatch');
ok(!/read_file/.test(g.guardDirective()), 'a new turn starts with a clean slate');

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

console.log(fails === 0 ? '\ngate check: ok' : `\ngate check: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
