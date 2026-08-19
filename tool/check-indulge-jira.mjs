#!/usr/bin/env node
/**
 * check-indulge-jira — an epic becomes corpus, and every chunk can say WHICH ticket at WHAT DATE.
 *
 * `npm run check:jira-indulge` (needs a build). Hermetic: `fetch` is stubbed, the credential comes from the
 * environment, the model is a fake, and the corpus goes to a throwaway `AYIN_RAG_DIR`. No network, no GPU.
 *
 * WHAT IT PINS:
 *   · the epic's children are found however this site expresses them — `parent`, `"Epic Link"`, or
 *     `childIssuesOf()`. A site holds both project styles at once, so this cannot be configured.
 *   · the rendered ticket is STABLE. Citations are line ranges into it; a renderer whose output moves
 *     invalidates every citation already stored.
 *   · a citation carries `ticket` + `at`, and `at` is the COMMENT's date when the range is inside a
 *     comment. `jira/PERF-1.md:40-44` is a claim about a moving target — ticket text is edited in place.
 *   · the tickets live in the CORPUS, never in the repo, and so does citation re-verification: without
 *     that, every ticket citation reads as a source file someone deleted.
 *   · resume: a second run re-reads what the first wrote and asks nothing again.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

// A throwaway corpus root and a throwaway repo, so nothing here touches the operator's own.
const rag = mkdtempSync(join(tmpdir(), 'ayin-jira-rag-'));
const repo = mkdtempSync(join(tmpdir(), 'ayin-jira-repo-'));
process.env.AYIN_RAG_DIR = rag;
execFileSync('git', ['-C', repo, 'init', '-q']);

process.env.JIRA_SITE = 'jira.example.net';
process.env.JIRA_TOKEN = 'not-a-real-token';
process.env.JIRA_EMAIL = 'someone@example.net';

const jql = [];
let childForm = 'parent';
const raw = (key, title, comments) => ({
  key,
  fields: {
    summary: title,
    status: { name: 'Open', statusCategory: { name: 'To Do' } },
    priority: { name: 'High' },
    issuetype: { name: 'Bug' },
    updated: '2026-08-01T10:00:00.000+0000',
    reporter: { displayName: 'A Reporter' },
    description: 'The booster must use XRayBoosterDurationSec from config.\nDefault is 5 seconds.',
    comment: { comments },
  },
});
const EPIC = raw('PROJ-1', 'X-Ray booster', []);
const CHILD = raw('PROJ-2', 'Use the config value', [
  { author: { displayName: 'A Dev' }, created: '2026-08-14T09:00:00.000+0000', body: 'Decided: read it once at boot.' },
]);

globalThis.fetch = async (url, init) => {
  const u = String(url);
  const body = init?.body ? JSON.parse(init.body) : null;
  if (body?.jql) jql.push(body.jql);
  const reply = (status, b) => ({ status, ok: status >= 200 && status < 300, json: async () => b });
  if (u.includes('/issue/PROJ-1?')) return reply(200, EPIC);
  if (u.includes('/search')) {
    // Only ONE of the three child queries works on this "site" — the others are a 400, exactly as an
    // unsupported field or function answers.
    const q = body?.jql ?? '';
    const wanted = { parent: 'parent = ', epiclink: 'Epic Link', childissuesof: 'childIssuesOf' }[childForm];
    // `none` = a site where every form is refused, which is how "no children" must NOT be reported.
    if (!wanted || !q.includes(wanted)) return reply(400, { errorMessages: ['Field not found'] });
    return reply(200, { issues: [CHILD] });
  }
  return reply(404, {});
};

const { openStore } = await import(`file://${join(ROOT, 'dist', 'indulge', 'store.js')}`);
const { citeLabel, citationBase } = await import(`file://${join(ROOT, 'dist', 'indulge', 'store.js')}`);
const { runJiraIndulge, ticketMarkdown, dateFor, parseTicketQuestions } =
  await import(`file://${join(ROOT, 'dist', 'indulge', 'jira.js')}`);
const { chunkStillResolves } = await import(`file://${join(ROOT, 'dist', 'indulge', 'report.js')}`);
const { assessChunk } = await import(`file://${join(ROOT, 'dist', 'indulge', 'staleness.js')}`);

// ── the rendered ticket ──────────────────────────────────────────────────────────

console.log('\nthe ticket as a document');
const md = ticketMarkdown({
  key: 'PROJ-2', title: 'Use the config value', status: 'Open', statusCategory: 'To Do', priority: 'High',
  issueType: 'Bug', updated: '2026-08-01', reporter: 'A Reporter',
  description: 'line one\nline two',
  comments: [{ author: 'A Dev', created: '2026-08-14', body: 'Decided: read it once at boot.' }],
}, 'PROJ-1');
ok(md.text === ticketMarkdown({
  key: 'PROJ-2', title: 'Use the config value', status: 'Open', statusCategory: 'To Do', priority: 'High',
  issueType: 'Bug', updated: '2026-08-01', reporter: 'A Reporter',
  description: 'line one\nline two',
  comments: [{ author: 'A Dev', created: '2026-08-14', body: 'Decided: read it once at boot.' }],
}, 'PROJ-1').text, 'the same ticket renders to the same bytes — line citations depend on it');
const descLine = md.text.split('\n').findIndex((l) => l === 'line one') + 1;
const cmtLine = md.text.split('\n').findIndex((l) => /Decided:/.test(l)) + 1;
ok(dateFor(md.spans, descLine, 'fallback') === '2026-08-01', 'a range in the description carries the TICKET date',
  dateFor(md.spans, descLine, 'fallback'));
ok(dateFor(md.spans, cmtLine, 'fallback') === '2026-08-14', 'a range inside a comment carries the COMMENT date',
  dateFor(md.spans, cmtLine, 'fallback'));
ok(dateFor([], 9, '2026-01-01') === '2026-01-01', 'and an unmapped line falls back rather than inventing one');

console.log('\nquestion parsing');
ok(parseTicketQuestions('{"questions":["What unit is the duration in?","Who decided the default?"]}', 4).length === 2,
  'JSON is read');
ok(parseTicketQuestions('1. What unit is the duration in?\n2. Who decided the default value?', 4).length === 2,
  'and a model that formats badly still had good questions');
ok(parseTicketQuestions('{"questions":["ok?","What unit is the duration in?"]}', 4).length === 1,
  'a three-character "question" is not one');

// ── the run ─────────────────────────────────────────────────────────────────────

let calls = 0;
const ask = async (prompt) => {
  calls++;
  if (/Reply with JSON only/.test(prompt)) return '{"questions":["What value must the booster read, and in what unit?"]}';
  const file = /CITE: (\S+):START-END/.exec(prompt)?.[1];
  // Find the line the comment sits on IN THE PROMPT (it is numbered), and cite exactly that.
  const line = (prompt.split('\n').find((l) => /Decided: read it once at boot/.test(l)) ?? '').match(/^(\d+):/)?.[1];
  const cite = line ? `CITE: ${file}:${line}-${line}` : `CITE: ${file}:1-3`;
  return `It reads XRayBoosterDurationSec, in seconds, once at boot.\n\n${cite}\n`;
};

console.log('\nthe run (parent form)');
const store = openStore(repo);
const r = await runJiraIndulge({ store, epic: 'PROJ-1', ask, model: 'fake-model' });
ok(r.tickets === 2, 'the epic and its child both became documents', `${r.tickets} ticket(s)`);
ok(r.via === 'parent', 'via names the query that worked', r.via);
ok(existsSync(join(store.dir, 'jira', 'PROJ-2.md')), 'the ticket file lives in the CORPUS');
ok(!existsSync(join(repo, 'jira')), 'and never in the repo — building a corpus must not dirty the tree');
ok(r.answered === 2 && r.failed === 0, 'every question was answered and cited', `${r.answered} answered, ${r.failed} unproven`);

const chunks = store.chunks();
ok(chunks.length === 2, 'a chunk per question', String(chunks.length));
ok(chunks.every((c) => c.domains.includes('jira')), 'under the jira domain — retrievable beside the code');
const child = chunks.find((c) => c.ext?.jira?.key === 'PROJ-2');
ok(child?.ext?.jira?.epic === 'PROJ-1', 'each chunk records its ticket and its epic', JSON.stringify(child?.ext?.jira ?? {}));
const cite = child?.citations?.[0];
ok(cite?.ticket === 'PROJ-2', 'the citation names the TICKET, not just a path', JSON.stringify(cite));
ok(cite?.at === '2026-08-14', 'and the DATE of the cited words — the comment\'s own, not the ticket\'s',
  `at=${cite?.at}`);
ok(citeLabel(cite) === `PROJ-2 (2026-08-14):${cite.startLine}-${cite.endLine}`,
  'rendered as "TICKET (date):lines" everywhere a citation is shown', citeLabel(cite));
ok(citationBase(repo, cite) === store.dir, 'a ticket citation resolves against the corpus, a code one against the repo');
ok(chunkStillResolves(repo, child), 'so the report can still verify it — it is not a missing source file');
const assessed = assessChunk(repo, child);
ok(assessed.state === 'fresh' && /PROJ-2 as of 2026-08-14/.test(assessed.label),
  'and staleness says which ticket, as of when, instead of "STALE"', assessed.label);

console.log('\nresume');
const callsAfterFirst = calls;
const again = await runJiraIndulge({ store, epic: 'PROJ-1', ask, model: 'fake-model' });
ok(calls === callsAfterFirst, 'a second run asks the model NOTHING — every question and chunk was on disk',
  `${calls - callsAfterFirst} extra call(s)`);
ok(again.answered === 0 && again.questions === 0, 'and reports it as nothing new', JSON.stringify({ q: again.questions, a: again.answered }));

console.log('\nthe other two child forms');
for (const [form, label] of [['epiclink', '"Epic Link"'], ['childissuesof', 'childIssuesOf']]) {
  childForm = form;
  const dir = mkdtempSync(join(tmpdir(), 'ayin-jira-repo-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  const s2 = openStore(dir);
  const r2 = await runJiraIndulge({ store: s2, epic: 'PROJ-1', ask, model: 'fake-model' });
  ok(r2.tickets === 2 && r2.via === label, `a site that only answers ${label} still yields the children`, `via=${r2.via}`);
  rmSync(dir, { recursive: true, force: true });
}

// TWO DIFFERENT ANSWERS, and only one of them is worth acting on: an epic with no children, and a site
// where no child query could be asked. Reporting the second as the first sends the operator looking for
// tickets that are there.
console.log('\nno child query worked (every form refused)');
childForm = 'none';
const dead = mkdtempSync(join(tmpdir(), 'ayin-jira-repo-'));
execFileSync('git', ['-C', dead, 'init', '-q']);
let threw = null;
try { await runJiraIndulge({ store: openStore(dead), epic: 'PROJ-1', ask, model: 'fake-model' }); }
catch (e) { threw = e; }
ok(threw !== null, 'it FAILS rather than reporting an epic with no children', threw ? String(threw.message).slice(0, 60) : '(no throw)');
ok(/400/.test(String(threw?.message ?? '')), 'and the message carries what Jira said', String(threw?.message ?? '').slice(0, 70));
rmSync(dead, { recursive: true, force: true });

console.log('\na genuinely empty epic');
// The query WORKS here and returns nothing — that is an answer, and it is not an error.
globalThis.fetch = async (url) => {
  const u = String(url);
  const reply = (status, b) => ({ status, ok: status >= 200 && status < 300, json: async () => b });
  if (u.includes('/issue/PROJ-1?')) return reply(200, EPIC);
  if (u.includes('/search')) return reply(200, { issues: [] });
  return reply(404, {});
};
const lone = mkdtempSync(join(tmpdir(), 'ayin-jira-repo-'));
execFileSync('git', ['-C', lone, 'init', '-q']);
const r3 = await runJiraIndulge({ store: openStore(lone), epic: 'PROJ-1', ask, model: 'fake-model' });
ok(r3.tickets === 1, 'the epic itself is still read and asked about', `${r3.tickets} ticket(s)`);
// Every form is tried when one answers with nothing, and `via` lists all three: "asked three ways, no
// children" is a stronger statement than "asked the way that happened to work first".
ok(/parent/.test(r3.via) && /childIssuesOf/.test(r3.via),
  'and via lists every query that was asked — the epic is simply empty', `via="${r3.via}"`);
rmSync(lone, { recursive: true, force: true });

rmSync(rag, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });
console.log(fails ? `\nindulge --jira check: ${fails} FAILURE(S)\n` : '\nindulge --jira check: ok\n');
process.exit(fails ? 1 : 0);
