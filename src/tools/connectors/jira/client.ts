/**
 * Jira REST client — the connector's only door to the API.
 *
 * SCOPE IS ENFORCED HERE, NOT IN A PROMPT. Every issue-listing call is `assignee = currentUser() AND
 * sprint in openSprints()`. The connector answers about the operator's current sprint and nothing else,
 * and that is a property of the query, not an instruction a model can be talked out of. It also keeps
 * the payload small enough to hand a local model without eating the context window.
 *
 * CLOUD AND DATA CENTER ARE DETECTED, NOT CONFIGURED. They differ in two ways that matter: the search
 * endpoint (`/rest/api/3/search/jql` vs `/rest/api/2/search`) and the body format of descriptions and
 * comments (ADF, a JSON document tree, vs plain text). Both are discoverable at the first call, so the
 * operator is never asked a question their own server can answer.
 *
 * NO SITE, NO PROJECT KEY, NO DEFAULT HOST APPEARS IN THIS FILE.
 */

import { CREDENTIALS_FILE, apiTarget, credentialSummary, daysUntilExpiry, readCredentials, type JiraCredentials } from './credentials.js';

const TIMEOUT_MS = 20_000;

/** Which REST flavour this site speaks. Learned on the first search, then reused for the session. */
let apiVersion: '3' | '2' | null = null;

/**
 * The flavour that serves `/issue/{key}`, learned separately from the search flavour above.
 *
 * One flag for both was the bug: `issueDetail` read the search one, which is null until a search has
 * run, so a direct by-key fetch — the first call a coding agent makes — guessed Cloud and 404'd on a
 * Data Center site with a message that read as "no such ticket".
 */
let issueApiVersion: '3' | '2' | null = null;

export class JiraError extends Error {}

export interface JiraIssue {
  key: string;
  title: string;
  status: string;
  /**
   * Jira's own three-bucket grouping of `status` — "To Do" / "In Progress" / "Done" — as the site
   * reports it. A board has as many statuses as its workflow invented ("Ready For QA", "In Code
   * Review"), and only the site knows which bucket each falls in. Empty when the field is absent.
   */
  statusCategory: string;
  priority: string;
  issueType: string;
  updated: string;
  /** Who filed it — the one attribution `/explain` needs, and never inferable from a commit message. */
  reporter: string;
  /** Present only on a detail fetch. */
  description?: string;
  comments?: JiraComment[];
}

export interface JiraComment {
  author: string;
  created: string;
  body: string;
}

/** The credential, or a thrown error naming the fix. Callers surface the message verbatim. */
function credentials(): JiraCredentials {
  const c = readCredentials();
  if (!c) {
    throw new JiraError(
      'Jira is not configured. Run `/jira-auth <paste your token, site and email>` — or set JIRA_SITE, '
      + 'JIRA_TOKEN and (Cloud only) JIRA_EMAIL in the environment.',
    );
  }
  return c;
}

async function call(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const target = apiTarget(credentials());
  let res: Response;
  try {
    res = await fetch(`${target.base}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: target.auth,
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new JiraError(`cannot reach Jira (${target.how}): ${msg}`);
  }

  if (res.status === 401 || res.status === 403) {
    /**
     * THE WHOLE PROCEDURE, NOT THE NAME OF THE COMMAND.
     *
     * This said "re-run /jira-auth with a fresh token", which names the last step and leaves the
     * operator to go and find the other three — where Atlassian keeps token creation, what the page
     * is called, whether the old one needs revoking. Reported as the cost it is: *"so the model will
     * reply with that instead of me wasting time lurking"*. A token that expires on a schedule is a
     * refusal this connector will emit over and over, so the fix is to make each one complete.
     *
     * The stored credential is read for the message, never for the retry: `credentialSummary` already
     * knows the site, the auth mode and how far past its expiry date this token is — and "EXPIRED 4d
     * ago" turns a permission mystery into a diary entry. It is the one fact that decides whether to
     * mint a token or go looking for a permissions change, and it costs nothing to include.
     */
    const stored = readCredentials();
    const days = stored ? daysUntilExpiry(stored) : null;
    const verdict = days !== null && days < 0
      ? `The stored token EXPIRED ${-days} day(s) ago — that is almost certainly the whole story.`
      : res.status === 403 && stored
        ? 'The token authenticated but was refused this resource, so it may be a permissions change rather than expiry.'
        : 'The token is wrong, expired, or lacks access.';
    throw new JiraError(
      `Jira rejected the credential (HTTP ${res.status}). ${verdict}\n`
      + (stored ? `Stored: ${credentialSummary(stored)}\n` : '')
      + `To refresh it:\n`
      + `  1. Open https://id.atlassian.com/manage-profile/security/api-tokens\n`
      + `  2. "Create API token", name it (ayin), copy it — Atlassian shows it once.\n`
      + `  3. Run: /jira-auth <token>\n`
      + `     The site is discovered from the token itself; you do not need to pass one.\n`
      + `  4. Revoke the old token on that same page once the new one works.\n`
      + `ayin keeps it at ${CREDENTIALS_FILE} (0600). Nothing is retried until it is replaced.`,
    );
  }
  if (res.status === 404) throw new JiraError(`not found (HTTP 404): ${path.split('?')[0]}`);
  if (!res.ok) throw new JiraError(`Jira returned HTTP ${res.status} for ${path.split('?')[0]}`);
  return res.json().catch(() => {
    throw new JiraError(`Jira returned a non-JSON body for ${path.split('?')[0]}`);
  });
}

/**
 * Atlassian Document Format → plain text.
 *
 * Cloud returns descriptions and comments as a nested JSON document. Handed to a model raw it is both
 * unreadable and enormous — the structure outweighs the words. Walk it and keep the text; a hard
 * newline for each block node so paragraphs and list items do not run together.
 */
function adfToText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown };
  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  if (n.type === 'hardBreak') return '\n';
  const inner = n.content ? adfToText(n.content) : '';
  const BLOCK = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'rule', 'tableRow']);
  return n.type && BLOCK.has(n.type) ? `${inner}\n` : inner;
}

/** Cloud sends ADF, Data Center sends a string. Both arrive here. */
function bodyText(raw: unknown): string {
  return (typeof raw === 'string' ? raw : adfToText(raw)).replace(/\n{3,}/g, '\n\n').trim();
}

/** Long free text, head and tail kept. A 400-line description is never worth a local model's window. */
function clip(text: string, maxLines = 40): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, Math.floor(maxLines * 0.7));
  const tail = lines.slice(-Math.floor(maxLines * 0.3));
  return [...head, `… [${lines.length - head.length - tail.length} lines omitted] …`, ...tail].join('\n');
}

interface RawIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { name?: string } };
    priority?: { name?: string };
    issuetype?: { name?: string };
    reporter?: { displayName?: string };
    updated?: string;
    description?: unknown;
    comment?: { comments?: Array<{ author?: { displayName?: string }; created?: string; body?: unknown }> };
  };
}

function toIssue(raw: RawIssue, detail: boolean): JiraIssue {
  const f = raw.fields ?? {};
  const issue: JiraIssue = {
    key: raw.key,
    title: f.summary ?? '(no title)',
    status: f.status?.name ?? '?',
    statusCategory: f.status?.statusCategory?.name ?? '',
    priority: f.priority?.name ?? '?',
    issueType: f.issuetype?.name ?? '?',
    updated: (f.updated ?? '').slice(0, 10),
    reporter: f.reporter?.displayName ?? '',
  };
  if (detail) {
    issue.description = clip(bodyText(f.description)) || '(no description)';
    issue.comments = (f.comment?.comments ?? []).map((c) => ({
      author: c.author?.displayName ?? '?',
      created: (c.created ?? '').slice(0, 10),
      body: clip(bodyText(c.body), 20),
    }));
  }
  return issue;
}

const FIELDS = ['summary', 'status', 'priority', 'issuetype', 'updated', 'reporter'];

/** A cap, because an epic is not bounded by anything but a team's habits. Reported when it bites. */
export const MAX_EPIC_CHILDREN = 200;

/**
 * Run a JQL search, learning the API flavour on the first call.
 *
 * Tries Cloud's endpoint first and falls back to Data Center's on a 404, then remembers. A wrong guess
 * costs one extra request per session; asking the operator costs them a question they cannot answer
 * without reading Atlassian's docs.
 */
async function search(jql: string, fields: string[], maxResults: number): Promise<RawIssue[]> {
  const attempt = async (version: '3' | '2'): Promise<RawIssue[]> => {
    const body = version === '3'
      ? { jql, fields, maxResults }
      : { jql, fields, maxResults, startAt: 0 };
    const path = version === '3' ? '/rest/api/3/search/jql' : '/rest/api/2/search';
    const res = (await call(path, { method: 'POST', body })) as { issues?: RawIssue[] };
    return res.issues ?? [];
  };

  if (apiVersion) return attempt(apiVersion);
  try {
    const issues = await attempt('3');
    apiVersion = '3';
    return issues;
  } catch (err) {
    if (!(err instanceof JiraError) || !err.message.includes('404')) throw err;
    const issues = await attempt('2');
    apiVersion = '2';
    return issues;
  }
}

/** Who the token belongs to. Also the cheapest possible proof that a credential works. */
export async function whoAmI(): Promise<{ name: string; email: string }> {
  const me = (await call('/rest/api/latest/myself')) as { displayName?: string; emailAddress?: string; name?: string };
  return { name: me.displayName ?? me.name ?? '(unknown)', email: me.emailAddress ?? '' };
}

/**
 * The id of the `Sprint` field on this site. It is a CUSTOM field, so its id differs per instance
 * (`customfield_10020` here) and must be looked up rather than hardcoded. Cached per session.
 */
let sprintFieldId: string | null = null;

async function findSprintField(): Promise<string | null> {
  if (sprintFieldId !== null) return sprintFieldId || null;
  try {
    const fields = (await call('/rest/api/3/field')) as Array<{ id?: string; name?: string }>;
    sprintFieldId = fields.find((f) => f.name === 'Sprint')?.id ?? '';
  } catch {
    sprintFieldId = '';
  }
  return sprintFieldId || null;
}

interface RawSprint { id?: number; name?: string; state?: string; boardId?: number }

/**
 * THE scope: the operator's issues in the ACTIVE sprint of ONE board.
 *
 * TWO BUGS THIS SHAPE EXISTS FOR, both measured against a real instance:
 *
 * 1. `sprint IN openSprints()` is not "the current sprint". Open means NOT COMPLETED, which includes
 *    FUTURE sprints, and it spans every board the account can see. On a real account it returned issues
 *    from two unrelated projects — one of them from another team's board entirely — and the operator's
 *    reasonable reaction was that the tool was broken.
 * 2. There is no JQL function for "the active sprint". The state of a sprint lives on the issue's Sprint
 *    field, so the filtering has to happen HERE, on data, rather than in the query.
 *
 * So: query openSprints() (which is as narrow as JQL gets), read each issue's Sprint field, and keep only
 * issues carrying an ACTIVE sprint on the chosen board. The board is the operator's `JIRA_BOARD` when set;
 * otherwise the one most of their active-sprint work belongs to, which is reported so it can be pinned.
 */
export async function currentSprintIssues(): Promise<{ issues: JiraIssue[]; scope: string }> {
  const c = credentials();
  const sprintField = await findSprintField();
  const jql = 'assignee = currentUser() AND sprint IN openSprints() ORDER BY status ASC, updated DESC';
  const raw = await search(jql, sprintField ? [...FIELDS, sprintField] : FIELDS, 100);

  // Without the Sprint field there is nothing to filter on; return the wider set rather than nothing, and
  // say so — a silently over-broad list is what caused the original complaint.
  if (!sprintField) {
    return { issues: raw.map((r) => toIssue(r, false)), scope: 'every open sprint (Sprint field not found on this site)' };
  }

  const sprintsOf = (r: RawIssue): RawSprint[] => {
    const v = (r.fields as Record<string, unknown> | undefined)?.[sprintField];
    return (Array.isArray(v) ? v : v ? [v] : []) as RawSprint[];
  };

  const wanted = c.board ? Number(c.board) : 0;
  let board = wanted;
  if (!board) {
    // Majority vote over ACTIVE sprints only: the board the operator is actually working out of.
    const tally = new Map<number, number>();
    for (const r of raw) {
      for (const s of sprintsOf(r)) {
        if (s.state !== 'active' || !s.boardId) continue;
        tally.set(s.boardId, (tally.get(s.boardId) ?? 0) + 1);
      }
    }
    board = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  }

  const kept: JiraIssue[] = [];
  const names = new Set<string>();
  for (const r of raw) {
    const active = sprintsOf(r).find((s) => s.state === 'active' && (!board || s.boardId === board));
    if (!active) continue;
    if (active.name) names.add(active.name);
    kept.push(toIssue(r, false));
  }

  const sprintName = [...names].join(' + ') || 'active sprint';
  // The board is named either way. Pinned and empty is the state that otherwise reads as "the tool is
  // broken": work moved to another board, and nothing on screen says which board was being looked at.
  const pin = wanted
    ? ` · board ${board} (pinned)`
    : ` · board ${board} (auto-detected — pin it with /jira-auth board=${board})`;
  return { issues: kept, scope: `${sprintName}${pin}` };
}

/**
 * One issue with its description and comments, BY KEY — a direct GET on the issue itself.
 *
 * Not sprint-scoped and not a search: any key the token can see resolves, open or closed, this sprint or
 * three years ago. That is the whole point — the operator names a ticket by number and it is fetched,
 * rather than being told it is not on their board.
 *
 * IT LEARNS THE API FLAVOUR RATHER THAN GUESSING IT. This used to read `apiVersion ?? '3'`, which is
 * correct only after a search has already run. Called first — which is exactly what a direct-by-key path
 * does — it guessed Cloud, and on a Data Center site the guess is a 404 that reads as "no such ticket".
 * So a 404 on the untried flavour is retried on the other one, once, and the answer is remembered.
 *
 * A 404 from BOTH is the honest not-found, and says both things it can mean: no such key, or a token
 * without permission to see it. Jira does not distinguish them, and pretending otherwise sends the
 * caller looking for the wrong problem.
 */
export async function issueDetail(key: string): Promise<JiraIssue> {
  const path = (v: '3' | '2'): string =>
    `/rest/api/${v}/issue/${encodeURIComponent(key)}?fields=${[...FIELDS, 'description', 'comment'].join(',')}`;
  const isNotFound = (err: unknown): boolean => err instanceof JiraError && err.message.includes('404');

  // THE ORDER, and why it is not simply `apiVersion`. The search flavour is a HINT here, never the
  // answer: the two endpoints are versioned independently, and an install exists where `/api/3/issue`
  // serves while `/api/3/search/jql` does not. So the search-learned flavour only decides which to try
  // FIRST — it is never written back, or a successful issue fetch would pin `search` to a path that
  // 404s with nothing left to fall back to.
  const order: Array<'3' | '2'> = issueApiVersion
    ? [issueApiVersion]
    : apiVersion === '2' ? ['2', '3'] : ['3', '2'];

  for (const v of order) {
    try {
      const raw = (await call(path(v))) as RawIssue;
      issueApiVersion = v;
      return toIssue(raw, true);
    } catch (err) {
      // A 404 on an UNTRIED flavour is ambiguous — wrong path, or no such issue — so the other one is
      // tried once. Anything else (401, 500, a dead network) is the answer and is raised as it is.
      if (!isNotFound(err)) throw err;
    }
  }
  /**
   * A 404 HERE MAY NOT BE ABOUT THE ISSUE AT ALL — so ask something that answers honestly.
   *
   * Atlassian does not return 401 for an issue an unauthorised caller requests; it returns 404,
   * because confirming the key exists would leak it. Measured against the real site with a
   * deliberately invalid token:
   *
   *     rest/api/3/myself            401
   *     rest/api/3/issue/PERF-14116  404
   *
   * So an expired token produced "no issue PERF-14116 — either it does not exist or this token cannot
   * see it", which contains the truth and buries it: the reader checks the key, the project, the
   * permissions, and the credential died last week. `/myself` is the cheapest request that
   * distinguishes them and it is only made once the issue lookup has already failed — on the path
   * that was about to give a misleading answer, never on a working one.
   *
   * Its 401 carries the whole refresh procedure (see `call`), so the throw below is only reached when
   * the credential is PROVEN good, which is what finally makes "it does not exist" worth saying.
   */
  try {
    await call('/rest/api/3/myself');
  } catch (err) {
    if (err instanceof JiraError && !isNotFound(err)) throw err;
  }
  throw new JiraError(
    `no issue ${key} — the credential works (it just authenticated), so this is the issue: either `
    + `the key does not exist or your account cannot see that project.`,
  );
}

/**
 * Post a comment on a ticket. The one WRITE in this connector.
 *
 * THE BODY FORMAT IS THE FLAVOUR, and getting it wrong is a 400, not a degraded comment: Cloud's v3 API
 * takes an ADF document tree and Data Center's v2 takes a plain string. Reading tolerates both because
 * `bodyText` flattens whatever arrives; writing has to choose, so it writes for whichever flavour served
 * the read — the same learned value `issueDetail` uses, since it is the same endpoint family.
 *
 * NOT SILENT ON FAILURE, and never optimistic: the created comment is returned from Jira's own response,
 * so a caller that got a value knows the comment exists on the server. Anything else throws with Jira's
 * status in the message. A page that says "posted" for a comment that was rejected is worse than an error
 * — the operator closes the tab believing their words are on the ticket.
 */
export async function addComment(key: string, text: string): Promise<JiraComment> {
  const body = text.trim();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key.toUpperCase())) throw new JiraError(`${key} is not a ticket key`);
  if (!body) throw new JiraError('refusing to post an empty comment');

  // The flavour is only known after a read. A comment is always posted from a ticket that was just read,
  // so this is the normal case; the fallback is a probe, not a guess, because a wrong ADF body is a 400.
  const order: Array<'3' | '2'> = issueApiVersion
    ? [issueApiVersion]
    : apiVersion === '2' ? ['2', '3'] : ['3', '2'];

  let last: unknown = null;
  for (const v of order) {
    const payload = v === '3'
      ? { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] } }
      : { body };
    try {
      const raw = (await call(`/rest/api/${v}/issue/${encodeURIComponent(key.toUpperCase())}/comment`, {
        method: 'POST',
        body: payload,
      })) as { author?: { displayName?: string }; created?: string; body?: unknown };
      issueApiVersion = v;
      return {
        author: raw.author?.displayName ?? 'you',
        created: (raw.created ?? '').slice(0, 10),
        body: bodyText(raw.body) || body,
      };
    } catch (err) {
      last = err;
      // Only an ambiguous 404 (wrong path vs no such issue) is worth the other flavour. A 400 means the
      // body shape was refused on a path that exists, and retrying the OTHER shape there would post the
      // comment twice on the first success — so it is raised.
      if (!(err instanceof JiraError && err.message.includes('404'))) throw err;
    }
  }
  throw last instanceof Error ? last : new JiraError(`could not comment on ${key}`);
}

/**
 * Specific keys, self-validating: only the ones that resolve to a real issue come back.
 *
 * NOT sprint-scoped, and deliberately so — this serves `/explain`, whose candidate keys come out of
 * commit messages and are usually old. A `PROJECT-123`-shaped string is not proof of a ticket, which is
 * the whole reason this returns fewer rows than it was given rather than erroring.
 *
 * Capped: a repository's history can offer hundreds of candidates, and a JQL `IN` list built from
 * untrusted text is exactly where a request quietly becomes a 4 KB URL.
 */
export async function issuesByKeys(keys: string[], detail = true): Promise<JiraIssue[]> {
  const clean = [...new Set(keys.map((k) => k.trim().toUpperCase()))]
    .filter((k) => /^[A-Z][A-Z0-9_]*-\d+$/.test(k))
    .slice(0, 40);
  if (clean.length === 0) return [];
  const fields = detail ? [...FIELDS, 'description', 'comment'] : FIELDS;
  const raw = await search(`key IN (${clean.join(',')})`, fields, clean.length);
  return raw.map((r) => toIssue(r, detail));
}

/**
 * An epic and everything under it.
 *
 * THERE IS NO ONE WAY TO ASK. How a child points at its epic depends on the site AND on the project:
 * a team-managed project uses the real `parent` field, a company-managed one uses the `Epic Link`
 * custom field, and Server/DC installs answer `childIssuesOf()`. A site can hold both project styles at
 * once, so this cannot be configured per site either. Each form is tried in turn and the first that
 * RETURNS ISSUES wins; `via` names the one that worked, because "0 tickets" and "asked the wrong way"
 * are different answers and only one of them is worth acting on.
 *
 * An unsupported field is a 400 from Jira, not an empty result, so a form that cannot work here is
 * skipped rather than mistaken for an empty epic. If every form fails, the last error is raised.
 */
export async function epicChildren(epicKey: string): Promise<{ epic: JiraIssue; children: JiraIssue[]; via: string }> {
  const key = epicKey.trim().toUpperCase();
  const epic = await issueDetail(key);
  const fields = [...FIELDS, 'description', 'comment'];
  const forms: Array<{ via: string; jql: string }> = [
    { via: 'parent', jql: `parent = ${key} ORDER BY key ASC` },
    { via: '"Epic Link"', jql: `"Epic Link" = ${key} ORDER BY key ASC` },
    { via: 'childIssuesOf', jql: `issue in childIssuesOf("${key}") ORDER BY key ASC` },
  ];

  let last: unknown = null;
  const tried: string[] = [];
  for (const f of forms) {
    try {
      const raw = await search(f.jql, fields, MAX_EPIC_CHILDREN);
      tried.push(f.via);
      if (raw.length) return { epic, children: raw.map((r) => toIssue(r, true)), via: f.via };
    } catch (err) {
      last = err;
    }
  }
  if (tried.length === 0 && last) throw last;
  return { epic, children: [], via: tried.join(', ') };
}

/** Reset the learned API flavour. For tests and for a credential pointing at a different site. */
export function resetApiVersion(): void {
  apiVersion = null;
  issueApiVersion = null;
}
