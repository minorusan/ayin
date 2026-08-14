/**
 * Ticket lookup for `/explain` — now NATIVE.
 *
 * This file used to POST to a host application's `/resource/jira` door, which meant ayin could not
 * validate a ticket key without that application running. `/explain`'s whole claim is that a
 * `PROJECT-123`-shaped string in a commit message is not proof of a ticket, so the one part of it that
 * needs an API was also the part that made a fresh clone unable to do its job.
 *
 * It now goes through ayin's own Jira connector (`tools/connectors/jira/`), which holds the credential
 * and speaks REST directly. Unconfigured is not an error: the lookup reports itself unavailable and
 * `/explain` prints the gap instead of attributing the feature to a ticket nobody verified.
 */

import { issuesByKeys } from './tools/connectors/jira/client.js';
import { readCredentials } from './tools/connectors/jira/credentials.js';
import { log } from './log.js';

export interface JiraTicketDetail {
  key: string;
  title: string;
  status: string;
  priority: string;
  issueType: string;
  reporter: string | null;
  updated: string | null;
}

/**
 * Batch-fetch tickets by key, keeping only the ones that resolve to a real issue — the self-validating
 * shape `/explain` needs for candidates extracted from commit messages.
 */
export async function jiraTickets(
  keys: string[],
): Promise<{ ok: true; tickets: JiraTicketDetail[] } | { ok: false; reason: string }> {
  if (keys.length === 0) return { ok: true, tickets: [] };
  if (!readCredentials()) {
    return { ok: false, reason: 'no Jira credential configured — run /jira-auth' };
  }
  try {
    const issues = await issuesByKeys(keys, false);
    log('INFO', 'jira_key_lookup', { asked: String(keys.length), resolved: String(issues.length) });
    return {
      ok: true,
      tickets: issues.map((i) => ({
        key: i.key,
        title: i.title,
        status: i.status,
        priority: i.priority,
        issueType: i.issueType,
        reporter: i.reporter || null,
        updated: i.updated || null,
      })),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
