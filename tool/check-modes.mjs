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

rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\nmodes check: ${fails} FAILURE(S)\n` : '\nmodes check: ok\n');
process.exit(fails ? 1 : 0);
