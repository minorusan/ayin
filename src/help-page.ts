/**
 * help-page.ts — `ayin --help`, and the per-topic pages behind it.
 *
 * WHY IT IS NOT A `console.log` OF A TEMPLATE STRING. Help that scrolls off the top of a terminal is
 * help nobody reads: the reader sees the tail of a list whose beginning is gone, and the beginning is
 * where the sections are. So the whole page goes through a pager when there is a terminal to page in,
 * and prints plainly when there is not — a pipe, a CI log, `ayin --help | grep`.
 *
 * WHERE THE WORDS LIVE. The one-line summaries stay in `help.ts`, which is also what feeds the hint
 * panel and `/help` — one list, so a command cannot be documented in one place and missing from the
 * other. The DETAIL — what it really does, when to reach for it, examples — lives one file per topic
 * under `help/`, because prose belongs in files a person can edit and diff, not in string literals
 * wedged between imports. A topic with no file still appears, with its summary; nothing is hidden for
 * want of a page.
 *
 * COLOUR IS OPTIONAL AND NEVER LOAD-BEARING. `NO_COLOR`, a pipe, or a dumb terminal turns it off and
 * the page reads identically — the structure is in the layout, not in the escape codes.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HELP, SECTIONS, type HelpEntry } from './help.js';
import { packagePath } from './prompts-service.js';

/**
 * PLAIN IS THE DEFAULT, and that is a decision about who reads this.
 *
 * ayin is driven by other agents at least as often as by a person, and an agent asking what the
 * commands are gets box drawing, ANSI colour and a pager that never returns. So `ayin --help` prints
 * a flat list with no escape codes and no pager — greppable, diffable, and the same bytes every time.
 * `--ui` asks for the version made for eyes, and `--json` for the version made for parsers.
 */
let dressed = false;
const useColor = (): boolean =>
  dressed && process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  head: '\x1b[38;5;79m', name: '\x1b[38;5;223m', accent: '\x1b[38;5;108m',
};
const paint = (code: string, text: string): string => (useColor() ? `${code}${text}${C.reset}` : text);

/** `/indulge-model` → `indulge-model`, `!<command>` → `bang`, `Ctrl+O` → `ctrl-o`. */
export function slugFor(name: string): string {
  const bare = name.replace(/^ayin\s+/, '').replace(/^\//, '');
  if (bare.startsWith('!')) return 'bang';
  // `-p` is the headless mode, and a page called `p.md` tells a reader nothing. Named, like `bang`.
  if (bare === '-p' || bare.startsWith('-p ')) return 'headless';
  // `--debug` is the FLAG form applied to a normal launch; `ayin debug` is the subcommand that writes a
  // bundle and exits. Both would slug to `debug.md`, and one page cannot honestly describe two
  // behaviours — check:helppage rejects the collision rather than letting the second entry open a page
  // about the first.
  if (bare === '--debug') return 'debug-flag';
  const slug = bare.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'ayin';
}

function helpRoot(): string {
  return packagePath('help');
}

/** The detail page for a topic, or null when nobody has written one yet. */
export function detailFor(entry: HelpEntry): string | null {
  const dir = entry.kind === 'cli' ? 'cli' : 'commands';
  const path = join(helpRoot(), dir, `${slugFor(entry.name)}.md`);
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf-8').trim(); } catch { return null; }
}

function findEntry(topic: string): HelpEntry | null {
  const want = topic.trim().toLowerCase().replace(/^\//, '').replace(/^ayin\s+/, '');
  const norm = (s: string): string => s.toLowerCase().replace(/^\//, '').replace(/^ayin\s+/, '');
  return HELP.find((e) => norm(e.name) === want)
    ?? HELP.find((e) => slugFor(e.name) === slugFor(want))
    ?? null;
}

/** Indent a detail page and dim its example blocks so the commands stand out from the prose. */
function renderDetail(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) { out.push('', paint(C.accent, `  ${line.slice(3)}`)); continue; }
    if (line.startsWith('    ')) { out.push(paint(C.name, `  ${line}`)); continue; }
    out.push(line.trim() ? `  ${line}` : '');
  }
  return out;
}

/** One topic in full: name, summary, and the page written for it. */
export function topicPage(topic: string): string {
  const entry = findEntry(topic);
  if (!entry) {
    const near = HELP.map((e) => e.name).filter((n) => n.toLowerCase().includes(topic.toLowerCase().replace(/^\//, '')));
    return [
      `No help topic "${topic}".`,
      near.length ? `Did you mean: ${near.slice(0, 6).join(', ')}` : 'Run `ayin --help` for the full list.',
      '',
    ].join('\n');
  }
  const lines = [
    '',
    `  ${paint(C.bold + C.name, entry.name)}  ${paint(C.dim, `· ${entry.section}`)}`,
    '',
    `  ${entry.short}`,
  ];
  const detail = detailFor(entry);
  if (detail) lines.push('', ...renderDetail(detail));
  else lines.push('', paint(C.dim, '  (no detailed page for this one yet)'));
  lines.push('');
  return lines.join('\n');
}

/** The whole thing: every section, every entry, with the detail pages folded in. */
export function fullPage(opts: { brief?: boolean } = {}): string {
  const lines: string[] = [
    '',
    `  ${paint(C.bold + C.head, 'ayin')} ${paint(C.dim, '— a terminal coding agent that runs on a model you host')}`,
    '',
    `  ${paint(C.dim, 'ayin')}                     start the agent in this directory`,
    `  ${paint(C.dim, 'ayin -p "<prompt>"')}       one task, no TUI, answer on stdout`,
    `  ${paint(C.dim, 'ayin --help <topic>')}      one command in full — ${paint(C.name, 'ayin --help /diff')}`,
    '',
  ];

  for (const section of SECTIONS) {
    const entries = HELP.filter((e) => e.section === section);
    if (!entries.length) continue;
    lines.push(paint(C.head, `  ── ${section} ${'─'.repeat(Math.max(2, 60 - section.length))}`), '');
    const width = Math.max(...entries.map((e) => e.name.length));
    for (const e of entries) {
      lines.push(`  ${paint(C.name, e.name.padEnd(width))}  ${e.short}`);
      if (opts.brief) continue;
      const detail = detailFor(e);
      if (!detail) continue;
      // The FIRST line of a page is written to stand alone, so it is the one worth folding in here;
      // the rest is what `--help <topic>` is for. A wall of every page is a wall nobody scrolls.
      const [, ...rest] = detail.split('\n');
      const examples = rest.join('\n').split('\n').filter((l) => l.startsWith('    ')).slice(0, 2);
      for (const ex of examples) lines.push(paint(C.dim, `  ${' '.repeat(width)}  ${ex.trim()}`));
    }
    lines.push('');
  }

  const pages = countPages();
  lines.push(paint(C.dim, `  ${HELP.length} commands · ${pages} with a detailed page · ayin --help <topic> for one`), '');
  return lines.join('\n');
}

function countPages(): number {
  let n = 0;
  for (const dir of ['commands', 'cli']) {
    try { n += readdirSync(join(helpRoot(), dir)).filter((f) => f.endsWith('.md')).length; } catch { /* none written */ }
  }
  return n;
}

/**
 * Print through a pager when there is a terminal and the page will not fit in it.
 *
 * `less -R` keeps the colours. `$PAGER` wins if the operator set one. Anything that fails — no pager
 * installed, a pipe, a CI log — falls back to writing the text, because help that cannot be displayed
 * must still be displayed.
 */
export function printPaged(text: string): void {
  const rows = process.stdout.rows ?? 0;
  const fits = rows === 0 || text.split('\n').length <= rows - 2;
  if (!process.stdout.isTTY || fits) { process.stdout.write(text); return; }

  const pager = process.env.PAGER || 'less';
  const args = pager === 'less' ? ['-R', '-F', '-X'] : [];
  try {
    const r = spawnSync(pager, args, { input: text, stdio: ['pipe', 'inherit', 'inherit'] });
    if (r.error || r.status === null) process.stdout.write(text);
  } catch { process.stdout.write(text); }
}

/**
 * The flat list: one command per line, no colour, no pager, no box drawing.
 *
 * Aligned rather than tab-separated because it has two readers and alignment costs the parser
 * nothing — a machine splits on the first run of two spaces, a person reads the columns. The header
 * names the two other forms, because an agent that wants structure should not have to guess that
 * `--json` exists.
 */
export function plainPage(): string {
  const lines = [
    'ayin — a terminal coding agent that runs on a model you host',
    '',
    'ayin                      start the agent in this directory',
    'ayin -p "<prompt>"        one task, no TUI, answer on stdout',
    'ayin --help <topic>       one command in full',
    'ayin --help --ui          the same list, formatted for a terminal',
    'ayin --help --json        the same list, as JSON',
    '',
  ];
  const width = Math.max(...HELP.map((e) => e.name.length));
  for (const section of SECTIONS) {
    const entries = HELP.filter((e) => e.section === section);
    if (!entries.length) continue;
    lines.push(`${section}:`);
    for (const e of entries) lines.push(`  ${e.name.padEnd(width)}  ${e.short}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Everything a parser needs, including whether a topic has a page worth fetching. */
export function jsonPage(): string {
  return `${JSON.stringify({
    commands: HELP.map((e) => ({
      name: e.name,
      kind: e.kind,
      section: e.section,
      summary: e.short,
      topic: slugFor(e.name),
      hasDetail: detailFor(e) !== null,
    })),
  }, null, 2)}\n`;
}

/** `ayin --help [topic] [--ui|--json]`. Returns the process exit code. */
export function runHelp(argv: string[]): number {
  const topic = argv.find((a) => !a.startsWith('-'));
  if (argv.includes('--json')) { process.stdout.write(jsonPage()); return 0; }

  dressed = argv.includes('--ui');
  if (topic) {
    const page = topicPage(topic);
    if (dressed) printPaged(page); else process.stdout.write(page);
    return 0;
  }
  if (dressed) { printPaged(fullPage()); return 0; }
  process.stdout.write(plainPage());
  return 0;
}
