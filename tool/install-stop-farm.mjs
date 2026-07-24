/**
 * install-stop-farm.mjs — register claude-stop-farm.mjs as a user-level Claude Code Stop hook, so
 * EVERY Claude session (any directory) farms its transcript into the episodic-RAG queue on stop.
 *
 *   node tool/install-stop-farm.mjs          # install (idempotent; backs up settings once)
 *   node tool/install-stop-farm.mjs --remove # uninstall
 *
 * Merges into ~/.claude/settings.json without clobbering existing hooks. Uninstall removes only our
 * entry.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookScript = join(dirname(fileURLToPath(import.meta.url)), 'claude-stop-farm.mjs');
const command = `node "${hookScript}"`;
const settingsPath = join(homedir(), '.claude', 'settings.json');
const remove = process.argv.includes('--remove');

let settings = {};
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); }
  catch (e) { console.error(`~/.claude/settings.json is not valid JSON — fix it first (${e.message})`); process.exit(1); }
} else {
  mkdirSync(dirname(settingsPath), { recursive: true });
}

settings.hooks ??= {};
settings.hooks.Stop ??= [];
const isOurs = (g) => Array.isArray(g.hooks) && g.hooks.some(h => typeof h.command === 'string' && h.command.includes('claude-stop-farm.mjs'));
const already = settings.hooks.Stop.some(isOurs);

if (remove) {
  settings.hooks.Stop = settings.hooks.Stop.filter(g => !isOurs(g));
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
} else if (!already) {
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command, timeout: 20, statusMessage: 'ayin: farming transcript' }] });
} else {
  console.log('already installed — nothing to do.');
  process.exit(0);
}

if (existsSync(settingsPath) && !existsSync(settingsPath + '.bak')) copyFileSync(settingsPath, settingsPath + '.bak');
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? 'Removed' : 'Installed'} the ayin Stop-farm hook in ${settingsPath}`);
if (!remove) console.log(`  command: ${command}\n  → every Claude stop in a git repo now queues its transcript for episode mining.`);
