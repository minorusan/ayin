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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

// ── plan mode's explicit door: the literal substring `/plan`, nothing fuzzier ──
// A prior version matched natural-language phrases ("plan it", "deep investigate the codebase", …).
// Retired: plan mode is the single most expensive gate in the system, and a fuzzy phrase match on it
// is exactly the kind of thing that misfires unpredictably outside one specific conversation. Now it
// is one unambiguous string — these cases exist to catch a REGRESSION back to fuzzy matching, not to
// re-litigate English usage.
console.log('\nplan trigger');
const plan = await import(`file://${join(DIST, 'plan/index.js')}`);
ok(plan.hasExplicitPlanMarker('/plan build the auth rewrite'), 'fires on a leading /plan');
ok(plan.hasExplicitPlanMarker('do the migration, /plan it first'), 'fires on /plan anywhere in the prompt');
ok(!plan.hasExplicitPlanMarker('plan it'), 'plain English "plan it" no longer fires (fuzzy trigger retired)');
ok(!plan.hasExplicitPlanMarker('deep investigate the codebase'), '"deep investigate" no longer fires either');
ok(!plan.hasExplicitPlanMarker("what's the plan?"), 'ordinary use of the word "plan" never fired and still does not');
ok(!plan.hasExplicitPlanMarker('planning ahead'), 'a prefix match on "plan" does not count — the marker is literally "/plan"');

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
    out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(`file://${join(DIST, 'ui/index.js')}`)}).then(() => process.exit(0))`],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { out = e?.stdout ?? Buffer.alloc(0); }
  const modes = [...new Set([...out.toString('latin1').matchAll(/\x1b\[\?(1\d{3})[hl]/g)].map((m) => m[1]))];
  ok(modes.includes('1000'), 'button tracking (1000) is on — this is where wheel events arrive', modes.join(','));
  ok(modes.includes('1006'), 'SGR encoding (1006) is on — correct past column 223');
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

  // dimensionsOf wires both dimensions in correctly, and independently.
  const qc = await import(`file://${join(DIST, 'qa/criteria.js')}`);
  const dims1 = qc.dimensionsOf([], false, false, true, true);
  ok(dims1.has('arduino') && dims1.has('arduino-wiring'), 'dimensionsOf includes both arduino dimensions when wiring is likely');
  const dims2 = qc.dimensionsOf([], false, false, true, false);
  ok(dims2.has('arduino') && !dims2.has('arduino-wiring'), 'the wiring dimension is independent — a non-wiring Arduino change gets the naming bar only, not the diagram requirement');
}

// ── wiring diagram trigger: the deterministic detector, before any LLM involvement ──
console.log('\nwiring diagram detection');
{
  const dg = await import(`file://${join(DIST, 'tools/diagram.js')}`);
  ok(dg.isWiringRequest(undefined, 'the wiring between an Arduino and an LED'), 'fires from the subject alone, no kind needed');
  ok(dg.isWiringRequest('wiring', 'anything'), 'fires from an explicit kind');
  ok(dg.isWiringRequest(undefined, 'show me the circuit for this sensor'), 'fires on "circuit"');
  ok(dg.isWiringRequest(undefined, 'draw the pinout for this board'), 'fires on "pinout"');
  ok(!dg.isWiringRequest(undefined, 'how does the chat request flow from the CLI to the model'), 'an ordinary architecture request does not fire it');
  ok(!dg.isWiringRequest('sequence', 'the lifecycle of a fix request'), 'an explicit non-wiring kind does not fire it either');
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

// ── arduino-explain: the deterministic half (pin extraction, sketch discovery, HTML render) ──
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

  // parseConnections: the model's JSON discipline is what's most likely to drift, not the render.
  ok(ae.parseConnections('not json') === null, 'garbage input returns null rather than throwing');
  ok(ae.parseConnections('{"connections": "nope"}') === null, 'a non-array connections field is rejected');
  const wrapped = ae.parseConnections('here you go:\n```json\n{"connections":[{"pin":"13","componentId":"standard-led","leg":"anode","label":"status LED"}]}\n```');
  ok(Array.isArray(wrapped) && wrapped.length === 1 && wrapped[0].componentId === 'standard-led', 'connections wrapped in prose/fences still parse (brace-scan, same shape as diagram.ts/criteria.ts)');

  // renderExplainHtml is PURE — no LLM in this half, so grounding is fabricated here on purpose.
  const fakeConnections = [
    { pin: 'LED_PIN', componentId: 'standard-led', leg: 'anode', label: 'status LED' },
    { pin: '9', componentId: 'sg90-micro-servo', leg: 'signal wire', label: 'door servo' },
    { pin: 'NOPE_UNKNOWN', componentId: 'unknown', leg: '', label: '' }, // pin not in the extracted list — must be ignorable, not fatal
  ];
  const html = ae.renderExplainHtml('BlinkAndBeep', pins, fakeConnections.filter((c) => byRaw[c.pin]));
  ok(html.startsWith('<!doctype html>') && html.trim().endsWith('</html>'), 'produces a complete, well-bounded HTML document');
  const svgOpens = (html.match(/<svg/g) || []).length;
  const svgCloses = (html.match(/<\/svg>/g) || []).length;
  ok(svgOpens === svgCloses && svgOpens > 1, 'svg tags are balanced and there is more than one (canvas + per-card icons)', `${svgOpens} open / ${svgCloses} close`);
  ok((html.match(/<foreignObject/g) || []).length === pins.length, 'exactly one card per touched pin, including the ones with no matched component', String((html.match(/<foreignObject/g) || []).length));
  ok(html.includes('Standard LED'), 'a matched component card carries its real catalog name');
  ok(html.includes('Micro servo motor'), 'a second matched component renders alongside the first');
  ok(html.includes('no catalog component matched'), 'a pin with an unmatched/unknown component still gets an honest card, not a silently dropped one');
  ok(html.includes('stroke-dasharray'), 'wires render as a dashed breadcrumb trail, not a plain solid line');
  ok(!/undefined|NaN/.test(html), 'no undefined/NaN leaked into the rendered geometry or text');

  // Not an Arduino project at all → early return, no files written.
  const outcome = await ae.runArduinoExplain(REPO, { open: false });
  ok(outcome.ok === false && /does not look like an Arduino project/.test(outcome.reason ?? ''), 'runArduinoExplain early-returns with a clear reason on a non-Arduino directory');
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

  const text = pr.formatPresentation('fix the login bug', wrapped, null);
  ok(text.startsWith('> fix the login bug'), 'the formatted text quotes the goal first, as the "what this satisfies" offset');
  ok(text.includes('added the widget'), 'the satisfies sentence is included');
  ok(text.includes('a.ts — added an export'), 'a file bullet reads "path — summary"');
  ok(!/wiring explainer/.test(text), 'no Arduino note when none was passed in');

  const withArduino = pr.formatPresentation('blink an LED', wrapped, 'wiring explainer regenerated (arduino-explain): /tmp/x.wiring.html');
  ok(withArduino.includes('wiring explainer regenerated'), 'an Arduino note, when given, appears as its own bullet');

  const emptyFiles = pr.formatPresentation('do a thing', { presentable: true, satisfies: '', files: [] }, null);
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

console.log(fails === 0 ? '\ngate check: ok' : `\ngate check: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
