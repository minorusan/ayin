/**
 * jira — a thin CONSUMER of a backend's `jira` resource. ayin no longer calls the Jira REST
 * API itself, no longer reads any Jira credential, and no longer has a `/set`-style auth command —
 * setup/refresh of the actual API token lives on the backend side now (the backend's own credential setup), because
 * the resource is what actually holds the credential and does the arbitrated call. This mirrors the
 * exact shape `llm/providers/resource.ts` already uses for the `llm` resource: one door
 * (`POST {backend}/resource/jira {op, params}`), never a raw JQL string the calling model has to
 * guess at — the resource returns already-filtered, structured JSON for the common asks (current
 * sprint, a specific ticket + comments, a batch of tickets by key, a project's epics) and turns free
 * text into JQL itself (an agentic loop on the backend) for anything else.
 *
 * Structured ops: currentSprint · ticket · tickets (batch, self-validating — only keys that resolve
 * to a real issue come back) · comments · epics · search (free text). See
 * `backend/src/resources/jira.ts` for the authoritative op list and return shapes.
 */

import { llmBaseUrl } from './connection.js';
import { log } from './log.js';

interface ResourceResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** The one door: POST {backend}/resource/jira {op, params}. Never throws. */
async function resourceOp(op: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<ResourceResponse> {
  try {
    const res = await fetch(`${llmBaseUrl()}/resource/jira`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as ResourceResponse | null;
    if (!body) return { ok: false, error: `HTTP ${res.status} (no JSON body)` };
    return body;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── structured shapes — mirror backend/src/resources/jira.ts's return types verbatim ──

export interface JiraTruncatedText {
  head: string[];
  tail: string[];
  truncated: boolean;
  totalLines: number;
}

export interface JiraTicket {
  key: string;
  title: string;
  status: string;
  priority: string;
  issueType: string;
  assignee: string | null;
  reporter: string | null;
  updated: string | null;
  due: string | null;
}

export interface JiraComment {
  author: string;
  created: string | null;
  body: JiraTruncatedText;
}

export interface JiraTicketDetail extends JiraTicket {
  description: JiraTruncatedText;
  comments: JiraComment[];
}

function flatten(t: JiraTruncatedText): string {
  return [...t.head, ...(t.truncated ? ['…'] : []), ...t.tail].join('\n');
}

function fmtTicket(t: JiraTicket): string {
  const due = t.due ? ` (due ${t.due})` : '';
  return `[${t.key}] ${t.title}  (${t.issueType} · ${t.priority} · ${t.status}${t.assignee ? ` · ${t.assignee}` : ''})${due}`;
}

function fmtDetail(d: JiraTicketDetail): string {
  const head = fmtTicket(d);
  const desc = flatten(d.description) || '(no description)';
  const comments = d.comments.length
    ? d.comments.map((c) => `- ${c.author} (${(c.created ?? '').slice(0, 10)}): ${flatten(c.body)}`).join('\n')
    : '(no comments)';
  return `${head}\n\nDescription:\n${desc}\n\nComments (${d.comments.length}):\n${comments}`;
}

/**
 * Batch-fetch tickets by key, keeping only the ones that resolve to a real issue — the self-
 * validating shape `/explain` needs for ticket-key candidates extracted from commit messages (a
 * `PROJECT-123`-shaped string is not proof of a real ticket; asking the resource is).
 */
export async function jiraTickets(keys: string[]): Promise<{ ok: true; tickets: JiraTicketDetail[] } | { ok: false; reason: string }> {
  if (keys.length === 0) return { ok: true, tickets: [] };
  const r = await resourceOp('tickets', { keys });
  if (!r.ok) return { ok: false, reason: r.error ?? 'unknown error' };
  return { ok: true, tickets: (r.data as { tickets: JiraTicketDetail[] }).tickets };
}

/** Tool entry point: `jira(op=…, query=…, key=…, project=…)`. Structured op, not raw JQL — the
 *  resource is what knows how to turn free text into a query; this tool never guesses one itself. */
export async function jiraExecute(params: Record<string, string>): Promise<string> {
  const op = (params.op ?? '').trim();
  const valid = new Set(['currentSprint', 'ticket', 'comments', 'epics', 'search']);
  if (!valid.has(op)) {
    return `Error: op required, one of: currentSprint | ticket | comments | epics | search. ` +
      `currentSprint/epics take no required params (epics: project= optional); ticket/comments take key=<ISSUE-123>; search takes query=<free text>.`;
  }

  if (op === 'ticket' || op === 'comments') {
    const key = (params.key ?? '').trim();
    if (!key) return 'Error: key=<ISSUE-123> required for this op';
    const r = await resourceOp(op, { key });
    if (!r.ok) return `Error: ${r.error}`;
    if (op === 'comments') {
      const { comments } = r.data as { key: string; comments: JiraComment[] };
      return comments.length
        ? comments.map((c) => `- ${c.author} (${(c.created ?? '').slice(0, 10)}): ${flatten(c.body)}`).join('\n')
        : '(no comments)';
    }
    return fmtDetail(r.data as JiraTicketDetail);
  }

  if (op === 'search') {
    const query = (params.query ?? '').trim();
    if (!query) return 'Error: query=<free text> required for search';
    log('INFO', 'jira_search', { query: query.slice(0, 100) });
    const r = await resourceOp('search', { prompt: query }, 60_000); // an agentic loop on the backend — give it real runway
    if (!r.ok) return `Error: ${r.error}`;
    const { jqlUsed, tickets } = r.data as { jqlUsed: string; tickets: JiraTicketDetail[] };
    if (tickets.length === 0) return `No results (query used: ${jqlUsed})`;
    return `${tickets.length} result(s) — query used: ${jqlUsed}\n\n${tickets.map(fmtDetail).join('\n\n---\n\n')}`;
  }

  if (op === 'epics') {
    const r = await resourceOp('epics', params.project ? { project: params.project } : {});
    if (!r.ok) return `Error: ${r.error}`;
    const { scope, epics } = r.data as { scope: string; epics: JiraTicket[] };
    return epics.length ? `Epics — ${scope} (${epics.length}):\n${epics.map(fmtTicket).join('\n')}` : `No epics found (${scope}).`;
  }

  // currentSprint
  const r = await resourceOp('currentSprint', params.project ? { project: params.project } : {});
  if (!r.ok) return `Error: ${r.error}`;
  const { scope, tickets } = r.data as { scope: string; tickets: JiraTicket[] };
  return tickets.length ? `${scope} (${tickets.length}):\n${tickets.map(fmtTicket).join('\n')}` : `No issues in ${scope}.`;
}
