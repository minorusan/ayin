/**
 * How a ticket is rendered for a model. Shared by the connector's loop and by the direct `jira_ticket`
 * tool, so an agent that reads a ticket in one round sees the same bytes the operator's `/jira` does —
 * two renderings of the same ticket is two shapes for the model to learn, and the drift is invisible.
 */

import type { JiraIssue } from './client.js';

/** One line, for a list. */
export function fmtLine(i: JiraIssue): string {
  return `${i.key} · ${i.status} · ${i.issueType}/${i.priority} · ${i.title}`;
}

/** The ticket in full: what it says, and who said what on it. Already clipped by the client. */
export function fmtDetail(i: JiraIssue): string {
  const comments = i.comments?.length
    ? i.comments.map((c) => `  - ${c.author} (${c.created}): ${c.body}`).join('\n')
    : '  (no comments)';
  return `${fmtLine(i)}\nDescription:\n${i.description}\nComments (${i.comments?.length ?? 0}):\n${comments}`;
}
