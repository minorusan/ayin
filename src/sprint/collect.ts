/**
 * sprint/collect.ts — the operator's current sprint as columns.
 *
 * ONE REQUEST, NO DETAIL. The board shows keys, titles, status, type and priority — all of which the
 * sprint search already returns. Descriptions and comments are fetched per card, when one is opened,
 * because 20 detail fetches take a minute and nineteen of them are for cards nobody clicked.
 *
 * COLUMNS COME FROM THE SITE, NOT FROM A LIST IN HERE. A workflow invents its own statuses ("Ready For
 * QA", "In Code Review"), so a hardcoded set of columns silently drops the ones it never heard of — the
 * ticket vanishes from the board while still being in the sprint. Every status present becomes a column,
 * ordered by Jira's own three-bucket `statusCategory` so the board reads left-to-right as work does.
 */

import { currentSprintIssues, whoAmI, type JiraIssue } from '../tools/connectors/jira/client.js';

export interface SprintColumn {
  status: string;
  /** Jira's bucket: "To Do" / "In Progress" / "Done", or empty when the site did not say. */
  category: string;
  issues: JiraIssue[];
}

export interface SprintBoard {
  me: string;
  /** The sprint and board this came from, verbatim from the client — including the pin hint. */
  scope: string;
  generatedAt: string;
  columns: SprintColumn[];
  total: number;
}

/** Left to right is the direction work moves. An unrecognised bucket sorts last rather than first. */
const CATEGORY_ORDER = ['To Do', 'In Progress', 'Done'];
const rank = (category: string): number => {
  const i = CATEGORY_ORDER.indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
};

export function toColumns(issues: JiraIssue[]): SprintColumn[] {
  const by = new Map<string, SprintColumn>();
  for (const i of issues) {
    const col = by.get(i.status) ?? { status: i.status, category: i.statusCategory, issues: [] };
    col.issues.push(i);
    by.set(i.status, col);
  }
  return [...by.values()]
    .map((c) => ({ ...c, issues: c.issues.sort((a, b) => a.key.localeCompare(b.key)) }))
    .sort((a, b) => rank(a.category) - rank(b.category) || a.status.localeCompare(b.status));
}

export async function collectSprint(): Promise<SprintBoard> {
  const me = await whoAmI();
  const { issues, scope } = await currentSprintIssues();
  return {
    me: me.name,
    scope,
    generatedAt: new Date().toISOString(),
    columns: toColumns(issues),
    total: issues.length,
  };
}
