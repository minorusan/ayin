#!/usr/bin/env node
/**
 * check-modes — the operator toggles and the round budget.
 *
 * `npm run check:modes` (needs a build first). No LLM, no network. HOME is redirected to a temp dir
 * BEFORE anything is imported, because `prompts.ts` resolves `~/.ayin-cli/prompts.json` at module
 * load: a gate that wrote to the real config would edit the operator's live settings to test them.
 *
 * Three behaviours, each of which is a promise to the operator that a typecheck cannot keep:
 *
 *   1. **Brevity is the DEFAULT.** A build that ships with it off is silently the old ayin.
 *   2. **The round budget is unlimited** unless someone deliberately capped it — and the two
 *      deliberate caps (`AYIN_MAX_ROUNDS`, an explicitly-set `maxToolRounds`) still work. The hound
 *      depends on the first, and a shipped default must never reinstate the cap this build removed.
 *   3. **No `Infinity` reaches the model.** `[Round 3/Infinity]` is what an unguarded denominator
 *      prints, and it is the kind of nonsense a model will happily reason about.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'ayin-modes-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.AYIN_MAX_ROUNDS;
if (!process.argv.includes('-p')) process.argv.push('-p'); // headless: never build blessed widgets

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const CONFIG = join(HOME, '.ayin-cli', 'prompts.json');
const writeConfig = (config) => {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ config }, null, 2));
};

const modes = await import(join(ROOT, 'dist/modes.js'));
const prompts = await import(join(ROOT, 'dist/prompts.js'));
const agent = await import(join(ROOT, 'dist/agent.js'));
const tools = await import(join(ROOT, 'dist/tools.js'));
await tools.loadTools();

const system = () => agent.buildMessages(0, agent.getMaxRounds()).find((m) => m.role === 'system').content;
const volatileText = (round, max) => agent.buildMessages(round, max).filter((m) => m.role === 'user').map((m) => m.content).join('\n');

// ── brevity is the default, /verbose opts out ───────────────────────────────────

ok(modes.isVerbose() === false, 'verbose is OFF on a fresh install — brevity is the default');
ok(modes.isLogCoverage() === false, 'log coverage is OFF on a fresh install');
ok(system().includes('fewest words'), 'the brevity instruction is in the system prompt by default');
ok(!system().includes('cannot be diagnosed'), 'log coverage is not injected when it is off');

modes.setVerbose(true);
ok(modes.isVerbose() === true && !system().includes('fewest words'),
  '/verbose removes the brevity instruction');
modes.setVerbose(false);
ok(system().includes('fewest words'), '/verbose off restores it');

modes.setLogCoverage(true);
ok(system().includes('cannot be diagnosed'), '/logcover injects the log-coverage instruction');
ok(system().includes('fewest words'), 'log coverage and brevity are independent — both can be on');
modes.setLogCoverage(false);

// Brevity governs the ANSWER, not the work. A prompt that told the model to investigate less would
// trade a wall of text for a wrong answer, which is a far worse deal.
const brevity = system();
ok(/never how much you verify/i.test(brevity),
  'the brevity prompt says explicitly that it governs writing, not verification');

// The toggles persist — a mode you must re-enable every session is a mode nobody uses.
const storedConfig = JSON.parse(readFileSync(CONFIG, 'utf-8')).config;
ok(storedConfig.verbose === 0 && storedConfig.logCoverage === 0,
  'both toggles are written to prompts.json and survive a restart', JSON.stringify(storedConfig));

// ── the round budget is unlimited unless deliberately capped ────────────────────

writeConfig({});
ok(agent.getMaxRounds() === Infinity, 'no cap by default — it works until done or cancelled', String(agent.getMaxRounds()));

writeConfig({ maxToolRounds: 7 });
ok(agent.getMaxRounds() === 7, 'a maxToolRounds the OPERATOR set is still honoured');

writeConfig({});
process.env.AYIN_MAX_ROUNDS = '10';
ok(agent.getMaxRounds() === 10, 'AYIN_MAX_ROUNDS still caps — the hound forces a short run with it');
process.env.AYIN_MAX_ROUNDS = 'nonsense';
ok(agent.getMaxRounds() === Infinity, 'an unparseable AYIN_MAX_ROUNDS cannot wedge the loop');
process.env.AYIN_MAX_ROUNDS = '0';
ok(agent.getMaxRounds() === Infinity, 'AYIN_MAX_ROUNDS=0 cannot wedge the loop at zero rounds');
delete process.env.AYIN_MAX_ROUNDS;

// ── no Infinity, and no deadline pressure, reaches the model ────────────────────

const unlimited = volatileText(0, Infinity);
ok(!unlimited.includes('Infinity'), 'the round line never prints Infinity to the model', unlimited.slice(-90));
ok(/\[Round 1\./.test(unlimited), 'an uncapped run still tells the model which round it is on');
ok(!/URGENT|round\(s\) left|converge/i.test(unlimited),
  'no deadline pressure when there is no deadline — that nudge is what bought rushed conclusions');

const capped = volatileText(12, 15);
ok(/URGENT: Round 13\/15/.test(capped), 'an explicitly capped run still warns as it runs out');

// ── /set must not store a dead key that differs only in case ────────────────────
//
// `openai-model` converts mechanically to `openaiModel` while the code reads `openAiModel`, so the
// natural name for a real setting stored a key nobody reads and said so — correct, and useless. A
// hand-map entry would fix that one name and leave the next; snapping to the known list ignoring
// case fixes the class, including keys added later.
{
  const appSrc = readFileSync(join(ROOT, 'src/app.ts'), 'utf-8');
  ok(/KNOWN_CONFIG_KEYS\.find\(\(k\) => k\.toLowerCase\(\) === camel\.toLowerCase\(\)\)/.test(appSrc),
    '/set snaps a converted key to the canonical spelling, case-insensitively');
  const snap = (kebab) => {
    const camel = kebab.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    return prompts.KNOWN_CONFIG_KEYS.find((k) => k.toLowerCase() === camel.toLowerCase()) ?? camel;
  };
  ok(snap('openai-model') === 'openAiModel', 'openai-model reaches openAiModel', snap('openai-model'));
  ok(snap('embed-model') === 'embedModel', 'and the ones that already worked still do');
  ok(snap('nunit-console') === 'nunitConsole', 'as do the newer ones');
  ok(snap('made-up-key') === 'madeUpKey', 'an unknown key still stores, and still warns');
}

// ── choosing OpenAI must OUTLIVE the process that chose it ──────────────────────
//
// `setProviderOverride('openai')` is a module variable, so `/model openai` used to last exactly as
// long as that TUI — and `ayin indulge`, `ayin explain`, `ayin watch` and the next TUI are all
// different processes. The operator picked a provider and then had to keep saying so on every
// command line, which is not a choice, it is a reminder.
{
  const mp = readFileSync(join(ROOT, 'src/model-picker.ts'), 'utf-8');
  ok(/setConfigValue\('llmProvider', 'openai'\)/.test(mp),
    'choosing OpenAI persists llmProvider, so a later process honours it without being told again');
  ok(/setConfigValue\('llmProvider', ''\)/.test(mp),
    'and going back to local persists too — a choice only one direction remembers is worse than neither');

  // select.ts must actually read it, and an empty value must fall through rather than pin a provider.
  const sel = readFileSync(join(ROOT, 'src/llm/select.ts'), 'utf-8');
  ok(/getConfigString\('llmProvider'\)/.test(sel), 'and resolution reads that config key');

  // budget.ts scales the context window off the same fact — it must read config, not only env.
  const bud = readFileSync(join(ROOT, 'src/indulge/budget.ts'), 'utf-8');
  ok(/getConfigString\('llmProvider'\)/.test(bud),
    'the indulge context budget reads the persisted provider too, so a saved choice widens the window');
}

// ── [LONG OPERATION] — finding out WHICH ten minutes ───────────────────────────
//
// A ten-minute turn used to be indistinguishable from a hung one: the status line says "Thinking…"
// for a model call, a tool run and a QA pass alike. Measured live during one such turn: the GPU sat
// at 0% and the gateway queue was EMPTY while ayin had been "generating" for 10m38s. Nothing was
// slow. Nothing was running.
{
  const T = await import(join(ROOT, 'dist/timing.js'));
  T.resetTurnTimings();

  ok(T.longOperationMs() === 120000, 'the threshold is two minutes by default', String(T.longOperationMs()));
  ok(T.human(95000) === '1m 35s' && T.human(45000) === '45s', 'durations read as durations', T.human(95000));

  let announced = [];
  writeConfig({ longOperationMs: 30 });   // so the gate does not have to wait two minutes
  await T.timed('llm', 'round 1', async () => { await new Promise((r) => setTimeout(r, 60)); return 1; },
    (line) => announced.push(line));
  ok(announced.length === 1 && /^\[LONG OPERATION\] llm/.test(announced[0]),
    'a phase past the threshold announces itself, with its name', announced[0]);

  // A phase that THREW is the most interesting measurement in the turn, and the one a naive wrapper loses.
  announced = [];
  let threw = false;
  try {
    await T.timed('tool', 'bash', async () => { await new Promise((r) => setTimeout(r, 60)); throw new Error('boom'); },
      (line) => announced.push(line));
  } catch { threw = true; }
  ok(threw, 'the error still propagates — measuring must not swallow it');
  ok(announced.length === 1 && /FAILED/.test(announced[0]),
    'and a call that hung for minutes and THEN failed is reported as such', announced[0]);

  // Fast phases stay silent: a marker that fires constantly is a marker nobody reads.
  announced = [];
  await T.timed('llm', 'quick', async () => 1, (line) => announced.push(line));
  ok(announced.length === 0, 'a fast phase says nothing');

  const tally = T.formatTurnTimings();
  ok(tally && /where the turn went/.test(tally), 'the turn tally names where the time went');
  ok(/llm ×2/.test(tally), 'grouped by phase — fourteen separate lines is the same data arranged so nobody reads it', tally);

  writeConfig({});
}

rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\nmodes check: ${fails} FAILURE(S)\n` : '\nmodes check: ok\n');
process.exit(fails ? 1 : 0);
