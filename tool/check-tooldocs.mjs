/**
 * check-tooldocs.mjs — every tool describes itself in a FILE, and that file stays worth its tokens.
 *
 * A tool's description is the single highest-leverage text in the system per character: it is what the
 * model reads to decide whether to call the thing at all, and it is loaded on every turn the operator
 * waits through. It used to be a string literal wedged into a TypeScript file — invisible to anyone
 * tuning behaviour, and unchangeable without a rebuild.
 *
 * Now it lives in `prompts/tools/<name>.txt`. The inline string stays as a FALLBACK, because a broken
 * install with no prompts directory must still have tools the model can choose between — but a
 * fallback that quietly becomes the real text is how the file stops being maintained. So: a file for
 * every tool, and the budget enforced, since nothing else in this repo will notice a description that
 * grew into a paragraph.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const DEFS = join(REPO, 'src/tools/defs');
const DOCS = join(REPO, 'prompts/tools');

const failures = [];
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };

/**
 * The budget is on PROSE, not on the file.
 *
 * A format spec is the one earned exception in CLAUDE.md §3a — a model cannot emit a grammar it was
 * never shown, and `naama`'s line grammar is 300 characters that replace an entire failed call. So
 * indented block lines are excluded from the prose count and only the whole file has a hard ceiling.
 * Measured against the four longest descriptions in the repo: all four are dense rather than padded.
 */
const MAX_PROSE = 700;
const MAX_TOTAL = 1400;

/** More than three shouted markers and the priority signal is gone — see CLAUDE.md §3a. */
const MAX_EMPHASIS = 3;

/**
 * An ACRONYM IS NOT SHOUTING. Counting every capitalised run flagged GUID, HTML and JSON as emphasis
 * and would have had the writer remove the words that carry the meaning.
 */
const ACRONYMS = new Set([
  'GUID', 'HTML', 'JSON', 'YAML', 'HTTP', 'HTTPS', 'API', 'URL', 'URI', 'CLI', 'TUI', 'CI', 'TTY',
  'GPU', 'CPU', 'PDF', 'PNG', 'JPG', 'SVG', 'VCS', 'SQL', 'CSV', 'XML', 'UML', 'ID', 'IDE', 'OS',
  'NUNIT', 'ASCII', 'UTF', 'REST', 'SSH', 'DOM', 'MCP', 'RAM', 'VRAM',
]);

const names = [];
for (const f of readdirSync(DEFS).filter((x) => x.endsWith('.ts'))) {
  const src = readFileSync(join(DEFS, f), 'utf-8');
  // TWO DEF SHAPES, AND THE CLASS ONE MUST BE READ FIRST.
  //
  // An object literal says `name: 'grep'`; a `BaseTool` subclass says `readonly name = 'grep'`. This
  // gate only knew the literal, so for a class def the first `name: '…'` it found was a PARAMETER —
  // `perform_edit` was reported as a missing doc for a tool called "file", and `find_relevant_files`
  // as one called "task". Two tools named after their own arguments, and the real gap (`subagent`)
  // sitting underneath, unexplained.
  const m = src.match(/readonly\s+name\s*=\s*'([a-z][a-z0-9_]*)'/)
    ?? src.match(/^\s*name:\s*'([a-z][a-z0-9_]*)'/m);
  if (!m) { fail(`${f} declares no tool name this gate can read`); continue; }
  names.push(m[1]);
}
ok(`${names.length} tools found in src/tools/defs`);

for (const name of names) {
  const path = join(DOCS, `${name}.txt`);
  if (!existsSync(path)) {
    fail(`${name} has no prompts/tools/${name}.txt — its description is trapped in TypeScript`);
    continue;
  }
  const body = readFileSync(path, 'utf-8').trim();
  if (!body) { fail(`prompts/tools/${name}.txt is empty — the model would be told nothing about it`); continue; }
  const prose = body.split('\n').filter((l) => !/^\s{2,}\S/.test(l)).join('\n');
  if (prose.length > MAX_PROSE) {
    fail(`prompts/tools/${name}.txt has ${prose.length} chars of prose (max ${MAX_PROSE}) — every character is taken from the attention available to every other token`);
  }
  if (body.length > MAX_TOTAL) {
    fail(`prompts/tools/${name}.txt is ${body.length} chars in total (max ${MAX_TOTAL})`);
  }
  const shouted = (body.match(/\b[A-Z]{2,}\b/g) ?? []).filter((w) => !ACRONYMS.has(w)).length;
  if (shouted > MAX_EMPHASIS) {
    fail(`prompts/tools/${name}.txt shouts ${shouted} times (max ${MAX_EMPHASIS}) — when everything shouts, nothing does`);
  }
  if (/\{\{[A-Z_]+\}\}/.test(body)) {
    fail(`prompts/tools/${name}.txt contains a {{VAR}} — a description is rendered with no variables, so it would reach the model literally`);
  }
}
if (!failures.length) ok(`every tool has a description file, within ${MAX_PROSE} chars of prose and ${MAX_EMPHASIS} emphasis markers`);

// A file with no tool is a description nothing reads — usually a rename that left its old page behind.
for (const f of (existsSync(DOCS) ? readdirSync(DOCS) : []).filter((x) => x.endsWith('.txt'))) {
  const name = f.replace(/\.txt$/, '');
  if (!names.includes(name)) fail(`prompts/tools/${f} describes "${name}", which is not a tool — a stale file nothing loads`);
}
if (!failures.length) ok('no orphaned description file');

console.log(failures.length ? `\ntool docs check: ${failures.length} FAILED` : '\ntool docs check: ok');
process.exit(failures.length ? 1 : 0);
