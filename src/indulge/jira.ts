/**
 * indulge/jira.ts — `ayin indulge --jira <EPIC>`: an epic's tickets become corpus the same way code does.
 *
 * WHY. Half of what an engineer needs tomorrow is not in the repository. The required value, the unit it
 * is in, the acceptance criterion, the decision someone made in a comment three weeks ago and the reason
 * they gave — all of it lives in Jira, and the agent could only reach it by being told. So the same three
 * stages that turn source into answered questions run over the tickets of one epic, and the result lands
 * in the SAME corpus under the domain `jira`, retrievable beside the code it is about.
 *
 * THE TICKETS BECOME FILES, INSIDE THE CORPUS — never in the repo. A corpus is copied between machines as
 * one directory (`indulge --import`), so the documents an answer cites have to travel with it; and writing
 * twenty files into the operator's working tree to build a corpus would dirty the tree it is about. They
 * are written by IDENTITY (`<corpus>/jira/<KEY>.md`), so a re-run replaces rather than accumulates, and
 * an interrupted run leaves no half-set to clean up.
 *
 * A CITATION NAMES THE TICKET AND THE DATE. `jira/PERF-1234.md:12-18` is a claim about a moving target:
 * ticket text is edited in place by other people, and a reader cannot tell whether it still says that. So
 * every citation carries `ticket` and `at` — the comment's own date when the cited range is inside a
 * comment, the ticket's `updated` when it is in the description or the header. That is what makes a corpus
 * answer about a ticket auditable: WHICH ticket, and WHEN those words were true. `citeLabel` renders it
 * as `PERF-1234 (2026-08-19):12-18` everywhere a citation is shown.
 *
 * RESUME IS THE STORE'S, not this file's. Questions and chunks are appended as they are produced and keyed
 * by stable ids, so a killed run re-reads what it wrote and continues; the ticket files are overwritten by
 * identity. Nothing here holds state that only exists in memory.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { epicChildren, MAX_EPIC_CHILDREN, type JiraIssue } from '../tools/connectors/jira/client.js';
import { ensureToolRuntime } from '../tool-wiring.js';
import { activeModelId } from '../llm/manager.js';
import { toolLlm, toolPrompts } from '../tools/runtime.js';
import { verifyCitations, stripCitations } from './answer.js';
import { blobSha, chunkId, questionId, type Chunk, type Citation, type IndulgeStore } from './store.js';

// Same reason as the answer stage: indulge is headless, so there is no TUI boot to wire the runtime.
ensureToolRuntime();

/** The domain every chunk from here lands under, so `--search` and retrieval can ask for it by name. */
export const JIRA_DOMAIN = 'jira';

/** One category, because the domain already says what these are. Kept free-form like every other. */
export const JIRA_CATEGORY = 'ticket';

/** Questions per ticket. A ticket is one document; past a handful the questions start restating it. */
export const DEFAULT_QUESTIONS_PER_TICKET = 4;

const prompts = () => toolPrompts('indulge');

/** A dated span of the rendered ticket: which lines, and when those words were written. */
export interface DateSpan { from: number; to: number; at: string }

export interface TicketDoc {
  key: string;
  /** Corpus-relative path — what a citation carries and what `citationBase` resolves. */
  path: string;
  title: string;
  text: string;
  sha: string;
  /** Ticket `updated`, the date of everything not inside a comment. */
  updated: string;
  spans: DateSpan[];
  lines: number;
}

const day = (s: string): string => (s || '').slice(0, 10);

/**
 * The ticket as markdown, plus the map from line ranges to dates.
 *
 * DETERMINISTIC AND STABLE: the same ticket renders to the same bytes, so a re-run produces the same line
 * numbers and existing citations keep pointing at the same words. That is the whole reason this is a
 * hand-written renderer and not a JSON dump — a citation into pretty-printed JSON is a citation into
 * whatever the serializer felt like.
 */
export function ticketMarkdown(issue: JiraIssue, epicKey: string): { text: string; spans: DateSpan[] } {
  const updated = day(issue.updated) || day(new Date().toISOString());
  const head = [
    `# ${issue.key} — ${issue.title}`,
    '',
    `status: ${issue.status}`,
    `type: ${issue.issueType}`,
    `priority: ${issue.priority}`,
    `reporter: ${issue.reporter || '(unknown)'}`,
    `updated: ${updated}`,
    `epic: ${epicKey}`,
    '',
    '## Description',
    '',
  ];
  const desc = (issue.description ?? '(no description)').split('\n');
  const lines = [...head, ...desc, ''];
  const spans: DateSpan[] = [{ from: 1, to: lines.length, at: updated }];

  const comments = issue.comments ?? [];
  lines.push('## Comments', '');
  if (!comments.length) {
    lines.push('(no comments)', '');
  }
  for (const c of comments) {
    const at = day(c.created) || updated;
    const from = lines.length + 1;
    lines.push(`### ${c.author} — ${at}`, '', ...c.body.split('\n'), '');
    spans.push({ from, to: lines.length, at });
  }
  return { text: `${lines.join('\n')}\n`, spans };
}

/** Which date the cited range carries. The span containing its FIRST line decides. */
export function dateFor(spans: DateSpan[], startLine: number, fallback: string): string {
  for (const s of spans) if (startLine >= s.from && startLine <= s.to) return s.at;
  return fallback;
}

/** Write one ticket into the corpus, replacing any previous copy of the same key. */
export function writeTicket(store: IndulgeStore, issue: JiraIssue, epicKey: string): TicketDoc {
  const dir = join(store.dir, JIRA_DOMAIN);
  mkdirSync(dir, { recursive: true });
  const { text, spans } = ticketMarkdown(issue, epicKey);
  const path = `${JIRA_DOMAIN}/${issue.key.toUpperCase()}.md`;
  writeFileSync(join(store.dir, path), text, 'utf-8');
  return {
    key: issue.key.toUpperCase(),
    path,
    title: issue.title,
    text,
    sha: blobSha(text),
    updated: day(issue.updated) || day(new Date().toISOString()),
    spans,
    lines: text.split('\n').length,
  };
}

/** The ticket with line numbers, which is what the model must cite against. */
export function numbered(text: string): string {
  return text.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
}

export interface JiraRunOptions {
  store: IndulgeStore;
  epic: string;
  /** The generation seam. The gate passes a fake so the bookkeeping is testable without a GPU. */
  ask?: (prompt: string) => Promise<string>;
  /** Overrides what is stamped on each chunk. Default: whatever model actually answered. */
  model?: string;
  perTicket?: number;
  /** Cap on ANSWERS this run, mirroring `--max-questions`. */
  maxQuestions?: number;
  onStatus?: (note: string) => void;
  onProgress?: (done: number, total: number, current: string) => void;
  shouldStop?: () => boolean;
}

export interface JiraRunReport {
  epic: string;
  via: string;
  tickets: number;
  /** Children Jira reported beyond the cap — stated, never silently dropped. */
  capped: number;
  questions: number;
  duplicates: number;
  answered: number;
  failed: number;
  rejectedCitations: number;
  stopped: boolean;
}

/** `{"questions":["…"]}`, or a bare list. A model that formats badly still asked good questions. */
export function parseTicketQuestions(reply: string, max: number): string[] {
  const out: string[] = [];
  const push = (s: unknown): void => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim().replace(/^[-*\d.)\s]+/, '');
    if (t.length >= 12 && !out.includes(t)) out.push(t);
  };
  const json = reply.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]) as { questions?: unknown };
      if (Array.isArray(parsed.questions)) for (const q of parsed.questions) push(q);
    } catch { /* fall through to the line reader */ }
  }
  if (!out.length) for (const line of reply.split('\n')) if (/\?\s*$/.test(line)) push(line);
  return out.slice(0, max);
}

/**
 * Fetch the epic, write its tickets, ask about each, answer what is pending, and save the chunks.
 *
 * The three stages are interleaved per TICKET rather than run to completion in turn: a run killed after
 * ticket three leaves three tickets fully answered instead of twenty half-asked. Same total work, and the
 * partial state is worth something.
 */
export async function runJiraIndulge(opts: JiraRunOptions): Promise<JiraRunReport> {
  const { store } = opts;
  const ask = opts.ask ?? ((prompt: string): Promise<string> => toolLlm().ask([{ role: 'user', content: prompt }]));
  const perTicket = Math.max(1, opts.perTicket ?? DEFAULT_QUESTIONS_PER_TICKET);
  const say = opts.onStatus ?? ((): void => {});
  const stop = opts.shouldStop ?? ((): boolean => false);
  const budget = opts.maxQuestions ?? Infinity;

  const epicKey = opts.epic.trim().toUpperCase();
  say(`jira: reading ${epicKey} and its children`);
  const { epic, children, via } = await epicChildren(epicKey);
  const issues = [epic, ...children.filter((c) => c.key.toUpperCase() !== epicKey)];
  say(`jira: ${epic.key} "${epic.title}" · ${children.length} child ticket(s) via ${via}`);

  const report: JiraRunReport = {
    epic: epicKey, via, tickets: 0, capped: children.length >= MAX_EPIC_CHILDREN ? 1 : 0,
    questions: 0, duplicates: 0, answered: 0, failed: 0, rejectedCitations: 0, stopped: false,
  };

  let answeredThisRun = 0;
  const total = issues.length;
  for (const [index, issue] of issues.entries()) {
    if (stop()) { report.stopped = true; break; }
    const doc = writeTicket(store, issue, epicKey);
    report.tickets++;
    opts.onProgress?.(index, total, `${doc.key} · ${doc.lines} lines`);

    // ── questions ────────────────────────────────────────────────────────────────
    const existing = store.questions().filter((q) => q.file === doc.path);
    let asked = existing;
    if (!existing.length) {
      let reply: string;
      try {
        reply = await ask(prompts().get('jiraQuestions', {
          KEY: doc.key,
          TITLE: doc.title,
          STATUS: issue.status,
          TYPE: issue.issueType,
          PRIORITY: issue.priority,
          UPDATED: doc.updated,
          EPIC: epicKey,
          MAX: String(perTicket),
          TICKET: numbered(doc.text),
        }));
      } catch (err) {
        say(`jira: ${doc.key} — question generation failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const text of parseTicketQuestions(reply, perTicket)) {
        const id = questionId(text, doc.path, null);
        const added = store.addQuestion({ id, file: doc.path, entity: null, category: JIRA_CATEGORY, text });
        if (added) report.questions++; else report.duplicates++;
      }
      asked = store.questions().filter((q) => q.file === doc.path);
    } else {
      say(`jira: ${doc.key} — ${existing.length} question(s) already on disk`);
    }

    // ── answers ─────────────────────────────────────────────────────────────────
    for (const q of asked) {
      if (stop()) { report.stopped = true; break; }
      if (answeredThisRun >= budget) { report.stopped = true; break; }
      const id = chunkId(store.key, doc.path, null, JIRA_CATEGORY, q.id);
      if (q.status === 'answered' && store.hasChunk(id)) continue;

      let reply: string;
      try {
        reply = await ask(prompts().get('jiraAnswer', {
          KEY: doc.key,
          FILE: doc.path,
          QUESTION: q.text,
          TICKET: numbered(doc.text),
        }));
      } catch (err) {
        store.setQuestionStatus(q.id, 'failed', err instanceof Error ? err.message : String(err));
        report.failed++;
        continue;
      }
      answeredThisRun++;

      const { citations, rejected } = verifyCitations(store.dir, reply);
      report.rejectedCitations += rejected;
      // TICKET AND DATE, stamped here rather than asked of the model: it cannot know a comment's date
      // reliably from prose, and a citation whose date the model chose is not evidence.
      const stamped: Citation[] = citations
        .filter((c) => c.path === doc.path)
        .map((c) => ({ ...c, ticket: doc.key, at: dateFor(doc.spans, c.startLine, doc.updated) }));
      if (!stamped.length) {
        store.setQuestionStatus(q.id, 'failed', 'answer carried no citation into the ticket');
        report.failed++;
        continue;
      }

      const chunk: Chunk = {
        chunkId: id,
        questionId: q.id,
        repoKey: store.key,
        domains: [JIRA_DOMAIN],
        question: q.text,
        answer: stripCitations(reply),
        files: [doc.path],
        citations: stamped,
        entity: null,
        category: JIRA_CATEGORY,
        // Read AFTER the call: the manager only knows the served model id once something has been asked.
        model: opts.model ?? activeModelId() ?? 'unknown',
        createdAt: new Date().toISOString(),
        sourceSha: doc.sha,
        ext: {
          jira: {
            key: doc.key,
            epic: epicKey,
            status: issue.status,
            issueType: issue.issueType,
            priority: issue.priority,
            updated: doc.updated,
            isEpic: doc.key === epicKey,
          },
        },
      };
      store.saveChunk(chunk);
      store.setQuestionStatus(q.id, 'answered');
      report.answered++;
    }
    if (report.stopped) break;
  }

  return report;
}

/** Read a ticket back out of the corpus — for `--search` output and for the gate. */
export function readTicket(store: IndulgeStore, key: string): string | null {
  try { return readFileSync(join(store.dir, JIRA_DOMAIN, `${key.toUpperCase()}.md`), 'utf-8'); }
  catch { return null; }
}
