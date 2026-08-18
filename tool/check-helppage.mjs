/**
 * check-helppage.mjs — `ayin --help` is the first thing a stranger runs, and the last thing anyone
 * checks. So the contract is asserted rather than eyeballed.
 *
 * The failure this prevents is not a crash. It is a command that exists, works, and appears in no
 * help output — which is how `!<command>` came to be documented nowhere at all. One registry feeds
 * the hint panel, `/help` and this page; the gate holds them to it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const { HELP, SECTIONS } = await import(join(REPO, 'dist/help.js'));
const { fullPage, topicPage, slugFor, detailFor } = await import(join(REPO, 'dist/help-page.js'));

const failures = [];
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };

// ── every command reaches the page ───────────────────────────────────────────────
const page = fullPage();
const missing = HELP.filter((e) => !page.includes(e.name)).map((e) => e.name);
if (missing.length) fail(`not in \`ayin --help\`: ${missing.join(', ')} — a command documented nowhere is a command nobody finds`);
else ok(`all ${HELP.length} registered commands appear in the page`);

const sectionless = HELP.filter((e) => !SECTIONS.includes(e.section)).map((e) => `${e.name} (${e.section})`);
if (sectionless.length) fail(`section not in SECTIONS, so these render nowhere: ${sectionless.join(', ')}`);
else ok('every entry sits in a section the page actually prints');

// ── topics resolve, by name and by slug ──────────────────────────────────────────
for (const e of HELP.slice(0, 8)) {
  const byName = topicPage(e.name);
  if (!byName.includes(e.name)) { fail(`\`ayin --help ${e.name}\` did not resolve to its own entry`); break; }
  const bySlug = topicPage(slugFor(e.name));
  if (!bySlug.includes(e.name)) { fail(`\`ayin --help ${slugFor(e.name)}\` (the slug) did not resolve`); break; }
}
if (!failures.length) ok('topics resolve by the name typed AND by their slug');

const unknown = topicPage('definitely-not-a-command');
if (!/No help topic/.test(unknown)) fail('an unknown topic must say so, not print an empty page');
else ok('an unknown topic says so');

// ── slugs are unique, or two commands fight over one file ────────────────────────
// Uniqueness is PER DIRECTORY, not global: `/diff` and `ayin diff` are two different things an
// operator can type, they deserve two different pages, and they get them — help/commands/diff.md and
// help/cli/diff.md. Checking globally reported four collisions that do not exist.
const seen = new Map();
for (const e of HELP) {
  const dir = e.kind === 'cli' ? 'cli' : 'commands';
  const key = `${dir}/${slugFor(e.name)}`;
  if (seen.has(key)) fail(`slug collision "${key}": ${seen.get(key)} and ${e.name} would share one help file`);
  seen.set(key, e.name);
}
ok(`${seen.size} help pages addressable, no two commands share one`);

// ── a detail page, where one exists, is reachable from its entry ─────────────────
const withPages = HELP.filter((e) => detailFor(e) !== null);
ok(`${withPages.length} of ${HELP.length} entries have a written page`);
for (const e of withPages.slice(0, 5)) {
  if (!topicPage(e.name).includes(detailFor(e).split('\n')[0].slice(0, 40))) {
    fail(`${e.name} has a page under help/ that its topic view does not show`);
    break;
  }
}

// ── the pages themselves must not leak the machine they were written on ──────────
for (const dir of ['commands', 'cli']) {
  const d = join(REPO, 'help', dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((x) => x.endsWith('.md'))) {
    const body = readFileSync(join(d, f), 'utf-8');
    const leak = body.match(/\b(?:192\.168|10\.\d+|172\.(?:1[6-9]|2\d|3[01]))\.\d+|\/home\/[a-z]|\/Users\/[a-z]/i);
    if (leak) fail(`help/${dir}/${f} leaks "${leak[0]}" — this repository is public`);
  }
}
if (!failures.length) ok('no private address or personal path in any written page');

console.log(failures.length ? `\nhelp page check: ${failures.length} FAILED` : '\nhelp page check: ok');
process.exit(failures.length ? 1 : 0);
