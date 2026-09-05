#!/usr/bin/env node
/**
 * check-help — the command list, and the two things that read it.
 *
 * `npm run check:help` (needs a build first). No LLM, no network, no TUI.
 *
 * `src/help.ts` exists because there were already three lists — the `case '/…'` labels that decide
 * what RUNS, the hint-panel array that decides what is OFFERED, and a hand-written `/help` — and
 * nothing kept them in step. `/diff` shipped with no hint entry; `!` was documented in none of them.
 *
 * So the load-bearing assertion here is the one a typecheck can never make: **every slash command
 * app.ts actually handles has an entry**, and **every entry is actually handled**. Drift in either
 * direction is a lie — a documented command that does nothing, or a working feature nobody can find.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const help = await import(join(ROOT, 'dist/help.js'));
const appSrc = readFileSync(join(ROOT, 'src/app.ts'), 'utf-8');

// ── the drift check, in both directions ──────────────────────────────────────────

const handled = new Set([...appSrc.matchAll(/case '(\/[a-z-]+)'/g)].map((m) => m[1]));
const listed = new Set(help.slashEntries().map((e) => e.name));

// Aliases and tool-owned commands are handled but deliberately not listed on their own line.
const ALIASES = new Set(['/q', '/exit', '/planthis', '/qathis', '/skepticthis', '/presentthis', '/embedthis', '/unlock']);
const missing = [...handled].filter((c) => !listed.has(c) && !ALIASES.has(c));
ok(missing.length === 0,
  'every slash command app.ts handles appears in the help list', missing.join(' '));

// The other direction. A tool-owned command (/jira, /sentry, /openai) has no `case` in app.ts — it
// is resolved through the tool registry — so those are the only legitimate absences.
const TOOL_OWNED = new Set(['/jira', '/jira-auth', '/sentry', '/sentry-auth', '/slack', '/slack-auth', '/openai', '/prefab', '/chore']);
const phantom = [...listed].filter((c) => !handled.has(c) && !TOOL_OWNED.has(c));
ok(phantom.length === 0,
  'every listed slash command is actually handled — a documented no-op is worse than an undocumented feature',
  phantom.join(' '));

// ── the tricks are the whole point ───────────────────────────────────────────────
//
// These are the features with no slash to type, so the help list is the ONLY place they exist.

const names = help.HELP.map((e) => e.name);
ok(names.includes('!<command>'), 'the ! shell passthrough is documented — it is in no other list');
ok(names.some((n) => n.includes('double-Shift')), 'the double-Shift launch hotkey is documented');
ok(help.HELP.some((e) => e.kind === 'key' && e.name === 'Ctrl+O'), 'the key bindings are in the list');
ok(help.HELP.some((e) => e.kind === 'cli'), 'the shell subcommands are in the list');
ok(names.includes('/diff'), '/diff is listed — the command whose absence started this file');

// ── sections cover everything ────────────────────────────────────────────────────

const orphan = help.HELP.filter((e) => !help.SECTIONS.includes(e.section)).map((e) => e.name);
ok(orphan.length === 0, 'every entry sits in a section /help will print', orphan.join(' '));
for (const s of help.SECTIONS) {
  if (help.entriesInSection(s).length === 0) ok(false, `section "${s}" is empty — /help would print a bare heading`);
}
ok(help.SECTIONS[0] === 'Tricks', 'Tricks are printed first — they are what nobody discovers by typing a slash');

// ── the launch tip ───────────────────────────────────────────────────────────────

const tip = help.launchTip();
ok(typeof tip === 'string' && tip.length > 0, 'a tip is chosen at launch', tip ?? '(none)');
ok(help.launchTip() === tip,
  'the tip is STABLE for the process — the goal line repaints constantly, and one that re-rolled mid-read would be unreadable');
const tips = help.HELP.filter((e) => e.tip);
ok(tips.length >= 8, 'there are enough tips that relaunching shows something new', `${tips.length} tips`);
ok(tips.every((e) => e.tip.length <= 110),
  'every tip fits one terminal line', tips.filter((e) => e.tip.length > 110).map((e) => e.name).join(' '));
ok(tips.every((e) => !e.tip.includes('\n')), 'no tip contains a newline — it renders in a single row');

// ── the hint panel reads the same list ───────────────────────────────────────────

const hintsSrc = readFileSync(join(ROOT, 'src/ui/widgets/hints.ts'), 'utf-8');
ok(/slashEntries\(\)/.test(hintsSrc),
  'the hint panel derives from help.ts rather than keeping its own array — that array is what drifted');
ok(help.slashEntries().every((e) => e.name.startsWith('/')), 'slashEntries returns only slash commands');
ok(help.slashEntries().length < help.HELP.length,
  'the hint panel does NOT offer keys and shell commands as if they were typeable');

// ── the chat widget falls back to the tip on the DEFAULT view ────────────────────
//
// The default goal view is `both`, which renders the CARD. The card is empty with no goal, so
// without an explicit fallback the tip would be invisible to everyone who has not set AYIN_GOAL_VIEW.

const chatSrc = readFileSync(join(ROOT, 'src/ui/widgets/chat.ts'), 'utf-8');
ok(/if \(card\.length\) tail\.push\(\.\.\.card\);\s*\n\s*else \{ const l = this\.goalLine\(\)/.test(chatSrc),
  'the card view falls back to the tip line when there is no goal — otherwise the tip never shows');
ok(/launchTip/.test(chatSrc), 'the chat widget reads the tip from help.ts');
ok(!/goalCard\(\)[\s\S]{0,200}launchTip/.test(chatSrc),
  'the tip never enters the OBJECTIVE card — a tip in a bordered panel is shouting, not offering');

console.log(fails ? `\nhelp check: ${fails} FAILURE(S)\n` : '\nhelp check: ok\n');
process.exit(fails ? 1 : 0);
