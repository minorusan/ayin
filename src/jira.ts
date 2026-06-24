/**
 * Jira tool — executes JQL queries against Jira REST API v3.
 *
 * Credentials are loaded from ~/.egregor/config.env:
 *   JIRA_EMAIL, JIRA_API_TOKEN, JIRA_SITE
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

// ── Env loader ───────────────────────────────────────────────────────

function loadEgregorEnv(): Record<string, string> {
  const envPath = `${homedir()}/.egregor/config.env`;
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
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

// ── Main execute ─────────────────────────────────────────────────────

export async function jiraExecute(params: Record<string, string>): Promise<string> {
  const env = loadEgregorEnv();
  const email = env.JIRA_EMAIL;
  const token = env.JIRA_API_TOKEN;
  const site = env.JIRA_SITE;

  if (!email || !token || !site) {
    return 'Error: Jira credentials not found in ~/.egregor/config.env (need JIRA_EMAIL, JIRA_API_TOKEN, JIRA_SITE)';
  }

  const jql = params.jql?.trim();
  if (!jql) return 'Error: jql parameter required';

  const maxResults = Math.min(parseInt(params.maxResults || '20', 10), 50);
  const fields = params.fields
    ? params.fields.split(',').map(f => f.trim())
    : ['summary', 'status', 'assignee', 'priority', 'issuetype', 'created', 'updated', 'comment', 'labels', 'fixVersions'];

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
    return `Error: network request failed — ${err instanceof Error ? err.message : String(err)}`;
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
      return `Jira error ${resp.status}: ${msgs || text.slice(0, 300)}`;
    } catch {
      return `Jira error ${resp.status}: ${text.slice(0, 300)}`;
    }
  }

  let result: JiraSearchResult;
  try {
    result = JSON.parse(text) as JiraSearchResult;
  } catch {
    return `Error: failed to parse Jira response: ${text.slice(0, 200)}`;
  }

  return formatIssues(result);
}
