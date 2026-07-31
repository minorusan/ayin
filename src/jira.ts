/**
 * Jira tool — executes JQL queries against Jira REST API v3.
 *
 * Credentials are loaded from ~/.egregor/config.env:
 *   JIRA_EMAIL, JIRA_API_TOKEN, JIRA_SITE
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const EGREGOR_ENV_PATH = join(homedir(), '.egregor', 'config.env');

// ── Env loader ───────────────────────────────────────────────────────

export function loadEgregorEnv(): Record<string, string> {
  if (!existsSync(EGREGOR_ENV_PATH)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(EGREGOR_ENV_PATH, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Merge `updates` into `~/.egregor/config.env`, preserving every other line (comments, unrelated keys,
 * ordering) — a key that already has a line gets that line's VALUE replaced in place; a new key is
 * appended. Atomic (temp file + rename) so a power cut mid-write can never leave a truncated or
 * half-written credentials file — same discipline `prompts-service.ts` uses for prompt materialization.
 *
 * Callers MUST validate credentials before calling this (see `runJiraAuth` in `jira-auth-cmd.ts`) — this
 * function itself has no opinion about whether `updates` is any good, it only writes what it's given.
 */
export function writeEgregorEnvKeys(updates: Record<string, string>): void {
  mkdirSync(dirname(EGREGOR_ENV_PATH), { recursive: true });
  const existingLines = existsSync(EGREGOR_ENV_PATH) ? readFileSync(EGREGOR_ENV_PATH, 'utf-8').split('\n') : [];
  const remaining = new Map(Object.entries(updates));

  const merged = existingLines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of remaining) merged.push(`${key}=${value}`);
  while (merged.length && merged[merged.length - 1] === '') merged.pop();

  const tmpPath = `${EGREGOR_ENV_PATH}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${merged.join('\n')}\n`);
  renameSync(tmpPath, EGREGOR_ENV_PATH);
}

// ── Types ────────────────────────────────────────────────────────────

interface JiraField {
  summary: string;
  status: { name: string };
  assignee: { displayName: string } | null;
  priority: { name: string } | null;
  issuetype: { name: string };
  created: string;
  updated: string;
  description?: unknown;
  comment?: { total: number };
  labels?: string[];
  fixVersions?: Array<{ name: string }>;
  [key: string]: unknown;
}

interface JiraIssue {
  key: string;
  fields: JiraField;
}

interface JiraSearchResult {
  total: number;
  issues: JiraIssue[];
}

// ── Formatter ────────────────────────────────────────────────────────

function formatIssues(result: JiraSearchResult): string {
  const { total, issues } = result;
  if (issues.length === 0) return 'No issues found.';

  const lines: string[] = [`Found ${total} issue(s) (showing ${issues.length}):\n`];

  for (const issue of issues) {
    const f = issue.fields;
    const assignee = f.assignee?.displayName ?? 'Unassigned';
    const priority = f.priority?.name ?? '-';
    const labels = f.labels?.length ? f.labels.join(', ') : '-';
    const versions = f.fixVersions?.length ? f.fixVersions.map(v => v.name).join(', ') : '-';
    const comments = f.comment?.total ?? 0;
    const updated = f.updated ? new Date(f.updated).toLocaleDateString() : '-';

    lines.push(`[${issue.key}] ${f.summary}`);
    lines.push(`  Type: ${f.issuetype.name} | Status: ${f.status.name} | Priority: ${priority}`);
    lines.push(`  Assignee: ${assignee} | Updated: ${updated} | Comments: ${comments}`);
    if (labels !== '-') lines.push(`  Labels: ${labels}`);
    if (versions !== '-') lines.push(`  Fix Versions: ${versions}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ── Shared search call — both jiraExecute and jiraLookup hit the same endpoint ──

export interface JiraCreds {
  email: string;
  token: string;
  site: string;
}

/**
 * The one place that actually calls the Jira REST API. `jiraExecute` (JQL → formatted text, the tool),
 * `jiraLookup` (candidate keys → structured summaries, for `/explain`), and `currentSprintTickets`
 * (`ayin jira` auth setup) all call this instead of each carrying their own fetch/auth/error-parsing
 * copy — same "one door" reasoning as everywhere else a resource is reached in this codebase, just
 * applied to an HTTP API instead of the GPU.
 *
 * `credsOverride` lets a caller test a CANDIDATE token/email/site before it's ever written to disk —
 * `ayin jira` validates a new token this way, so a bad paste never touches the credentials file.
 */
async function runJiraSearch(jql: string, fields: string[], maxResults: number, credsOverride?: JiraCreds): Promise<JiraSearchResult | { error: string }> {
  const env = credsOverride ?? (() => {
    const e = loadEgregorEnv();
    return { email: e.JIRA_EMAIL, token: e.JIRA_API_TOKEN, site: e.JIRA_SITE };
  })();
  const email = env.email;
  const token = env.token;
  const site = env.site;

  if (!email || !token || !site) {
    return { error: 'Jira credentials not found in ~/.egregor/config.env (need JIRA_EMAIL, JIRA_API_TOKEN, JIRA_SITE)' };
  }

  const url = `https://${site}/rest/api/3/search/jql`;
  const body = JSON.stringify({ jql, maxResults, fields });
  const auth = Buffer.from(`${email}:${token}`).toString('base64');

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body,
    });
  } catch (err) {
    return { error: `network request failed — ${err instanceof Error ? err.message : String(err)}` };
  }

  const text = await resp.text();

  if (!resp.ok) {
    // Try to extract a meaningful Jira error message
    try {
      const errBody = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
      const msgs = [
        ...(errBody.errorMessages ?? []),
        ...Object.values(errBody.errors ?? {}),
      ].join('; ');
      return { error: `Jira error ${resp.status}: ${msgs || text.slice(0, 300)}` };
    } catch {
      return { error: `Jira error ${resp.status}: ${text.slice(0, 300)}` };
    }
  }

  try {
    return JSON.parse(text) as JiraSearchResult;
  } catch {
    return { error: `failed to parse Jira response: ${text.slice(0, 200)}` };
  }
}

// ── Main execute ─────────────────────────────────────────────────────

export async function jiraExecute(params: Record<string, string>): Promise<string> {
  const jql = params.jql?.trim();
  if (!jql) return 'Error: jql parameter required';

  const maxResults = Math.min(parseInt(params.maxResults || '20', 10), 50);
  const fields = params.fields
    ? params.fields.split(',').map(f => f.trim())
    : ['summary', 'status', 'assignee', 'priority', 'issuetype', 'created', 'updated', 'comment', 'labels', 'fixVersions'];

  const result = await runJiraSearch(jql, fields, maxResults);
  if ('error' in result) return `Error: ${result.error}`;
  return formatIssues(result);
}

// ── Structured lookup for /explain — self-validating ticket-key correlation ──

export interface JiraTicketSummary {
  key: string;
  summary: string;
  status: string;
  reporter: string | null;
  assignee: string | null;
  created: string | null;
}

export type JiraLookupResult =
  | { ok: true; tickets: JiraTicketSummary[] }
  | { ok: false; reason: string };

/** Shared issue→summary mapping — both `jiraLookup` and `currentSprintTickets` return the same shape. */
function toTicketSummaries(result: JiraSearchResult): JiraTicketSummary[] {
  return result.issues.map((issue) => {
    const f = issue.fields as JiraField & { reporter?: { displayName: string } | null };
    return {
      key: issue.key,
      summary: f.summary,
      status: f.status?.name ?? 'unknown',
      reporter: f.reporter?.displayName ?? null,
      assignee: f.assignee?.displayName ?? null,
      created: f.created ?? null,
    };
  });
}

/**
 * Batch-validate candidate ticket keys and return structured summaries for the ones that resolve to a
 * REAL issue. Exists because a generic ticket-key shape (`PROJ-123`) is structurally identical to
 * plenty of non-ticket text a commit message might contain (hardware part numbers like `KY-040` are
 * the exact same shape) — so candidates pulled from commit subjects by regex are never trusted on
 * their own. Asking Jira is the validation: a candidate that isn't a real issue just doesn't come back.
 *
 * Never throws. Missing credentials or a network/API failure both come back as `{ ok: false, reason }`
 * — the caller (`/explain`) degrades to "no Jira context available" rather than blocking the report.
 */
export async function jiraLookup(candidateKeys: string[]): Promise<JiraLookupResult> {
  const keys = [...new Set(candidateKeys.map((k) => k.trim()).filter(Boolean))].slice(0, 40);
  if (keys.length === 0) return { ok: true, tickets: [] };

  const jql = `key in (${keys.map((k) => `"${k.replace(/"/g, '')}"`).join(',')})`;
  const result = await runJiraSearch(jql, ['summary', 'status', 'reporter', 'assignee', 'created'], keys.length);
  if ('error' in result) return { ok: false, reason: result.error };
  return { ok: true, tickets: toTicketSummaries(result) };
}

// ── current-sprint lookup — used both by the `jira` tool's auth setup and available generally ──

/**
 * Issues in any open sprint the credentials' account can see (`sprint in openSprints()` — the JQL
 * function that needs no board/project id, since a fresh setup doesn't know one yet). `creds`, when
 * given, tests a CANDIDATE credential set without touching `~/.egregor/config.env` — this is what
 * `ayin jira <token>` uses to confirm a new token actually works before writing it down.
 */
export async function currentSprintTickets(creds?: JiraCreds, maxResults = 20): Promise<JiraLookupResult> {
  const result = await runJiraSearch('sprint in openSprints() ORDER BY updated DESC', ['summary', 'status', 'assignee', 'created'], maxResults, creds);
  if ('error' in result) return { ok: false, reason: result.error };
  return { ok: true, tickets: toTicketSummaries(result) };
}
