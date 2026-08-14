/**
 * Sentry REST client — the connector's only door to the API.
 *
 * NOT an SDK, because there isn't one for this: Sentry's official packages (`@sentry/node` and family)
 * exist to SEND events, not to read the Web API. Nothing to adopt, so plain REST it is.
 *
 * SCOPE IS ENFORCED HERE. Every listing is `is:unresolved` over a bounded recent window in one
 * organization — "what is broken right now", which is both the useful question and a payload small
 * enough for a local model. An operator who has pinned a project gets it narrowed further.
 *
 * THE STACKTRACE IS THE POINT, AND IT IS ALSO THE DANGER. A Sentry event is enormous — a single one can
 * carry hundreds of frames, every request header, and the whole local variable map per frame. Handed to
 * a model raw it would consume the context window and bury the four lines that matter. So an event is
 * reduced here: the culprit, the exception type and value, and the frames nearest the crash, with
 * `in_app` frames preferred over library noise. The reduction is stated in the output, never silent.
 */

import { readCredentials, type SentryCredentials } from './credentials.js';

const TIMEOUT_MS = 20_000;

/** How far back a listing looks. Long enough to include yesterday's regression, short enough to be about now. */
const STATS_PERIOD = '14d';

/** Frames kept per event. The crash is at the top of the stack; the rest is how it got there. */
const MAX_FRAMES = 12;

/** Breadcrumbs kept — the ones NEAREST the failure, which are the last in the list. */
const MAX_BREADCRUMBS = 10;

export class SentryError extends Error {}

export interface SentryIssue {
  /** The human-facing id (`PROJECT-ABC`), which is what an operator reads and types. */
  shortId: string;
  /** The numeric id every other endpoint takes. */
  id: string;
  title: string;
  culprit: string;
  level: string;
  status: string;
  /** Total events seen. */
  count: string;
  /** Distinct users affected — often the difference between "noisy" and "urgent". */
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  project: string;
}

export interface SentryEventDetail {
  /** `TypeError: undefined is not a function`, when the event carries an exception. */
  exception: string;
  /** Trimmed stack, nearest-the-crash first. Empty for an event that is a logged message, not a crash. */
  frames: string[];
  framesOmitted: number;
  /**
   * The last few log lines before the event — Sentry's breadcrumbs.
   *
   * Measured on real data before this existed: an SDK that reports LOGGED errors (a Unity game's logger,
   * for instance) produces events with no exception and no stack at all, so an `open` that only knew how
   * to read stacktraces returned a title and nothing else. For those events the breadcrumb trail is the
   * whole story of what led up to the failure — the analogue of the stack, and the reason `open` is worth
   * a round.
   */
  breadcrumbs: string[];
  breadcrumbsOmitted: number;
  tags: string[];
  message: string;
  timestamp: string;
}

function credentials(): SentryCredentials {
  const c = readCredentials();
  if (!c) {
    throw new SentryError(
      'Sentry is not configured. Run `/sentry-auth <paste your token and org>` — or set SENTRY_TOKEN and '
      + 'SENTRY_ORG in the environment.',
    );
  }
  if (!c.org) {
    throw new SentryError(
      'Sentry has a token but no organization. Every Sentry read endpoint is scoped to one, and a '
      + 'narrowly-scoped token cannot list them. Run `/sentry-auth <your-org-slug>` to add it.',
    );
  }
  return c;
}

async function call(path: string): Promise<unknown> {
  const c = credentials();
  let res: Response;
  try {
    res = await fetch(`${c.apiBase}${path}`, {
      headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new SentryError(`cannot reach Sentry: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 401) {
    throw new SentryError('Sentry rejected the token (HTTP 401) — it is wrong or revoked. Re-run /sentry-auth.');
  }
  if (res.status === 403) {
    // The single most confusing Sentry failure, and it is almost never "wrong token": tokens are scoped,
    // and a token that reads issues perfectly well still cannot list organizations or projects.
    throw new SentryError(
      `Sentry refused this request (HTTP 403) — the token is valid but lacks the scope for it, or the `
      + `organization slug is wrong. Issue reads need event:read; check the token's scopes in Sentry → `
      + `Settings → Auth Tokens.`,
    );
  }
  if (res.status === 404) throw new SentryError(`not found (HTTP 404): ${path.split('?')[0]}`);
  if (!res.ok) throw new SentryError(`Sentry returned HTTP ${res.status} for ${path.split('?')[0]}`);
  return res.json().catch(() => {
    throw new SentryError(`Sentry returned a non-JSON body for ${path.split('?')[0]}`);
  });
}

interface RawIssue {
  id?: string;
  shortId?: string;
  title?: string;
  culprit?: string;
  level?: string;
  status?: string;
  count?: string | number;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  project?: { slug?: string };
}

function toIssue(r: RawIssue): SentryIssue {
  return {
    shortId: r.shortId ?? r.id ?? '?',
    id: r.id ?? '',
    title: (r.title ?? '(no title)').replace(/\s+/g, ' ').trim(),
    culprit: r.culprit ?? '',
    level: r.level ?? '',
    status: r.status ?? '',
    count: String(r.count ?? '0'),
    userCount: r.userCount ?? 0,
    firstSeen: (r.firstSeen ?? '').slice(0, 10),
    lastSeen: (r.lastSeen ?? '').slice(0, 16).replace('T', ' '),
    project: r.project?.slug ?? '',
  };
}

/** THE scope: unresolved issues in the operator's org (and project, if pinned), most recent first. */
export async function unresolvedIssues(limit = 25): Promise<SentryIssue[]> {
  const c = credentials();
  const params = new URLSearchParams({
    query: 'is:unresolved',
    statsPeriod: STATS_PERIOD,
    limit: String(limit),
    sort: 'freq',
  });
  if (c.project) params.set('project', c.project);
  const raw = (await call(`/organizations/${encodeURIComponent(c.org)}/issues/?${params}`)) as RawIssue[];
  return (Array.isArray(raw) ? raw : []).map(toIssue);
}

interface RawFrame {
  filename?: string;
  module?: string;
  function?: string;
  lineno?: number;
  in_app?: boolean;
}

interface RawEvent {
  message?: string;
  dateCreated?: string;
  tags?: Array<{ key?: string; value?: string }>;
  entries?: Array<{ type?: string; data?: unknown }>;
}

interface RawCrumb {
  timestamp?: string;
  level?: string;
  category?: string;
  message?: string;
}

/** `02:26:47 info unity.logger: version hasn't changed` — time, severity, source, text. */
function crumbLine(c: RawCrumb): string {
  const at = (c.timestamp ?? '').slice(11, 19);
  const level = c.level && c.level !== 'info' ? ` ${c.level.toUpperCase()}` : '';
  const cat = c.category ? ` ${c.category}` : '';
  return `${at}${level}${cat}: ${(c.message ?? '').replace(/\s+/g, ' ').slice(0, 200)}`;
}

function frameLine(f: RawFrame): string {
  const where = f.filename || f.module || '?';
  const fn = f.function ? ` in ${f.function}` : '';
  const line = f.lineno ? `:${f.lineno}` : '';
  return `${where}${line}${fn}${f.in_app ? '' : '  (library)'}`;
}

/**
 * The latest event for an issue, reduced to what a person debugging would read first.
 *
 * `in_app` frames are kept ahead of library frames when the stack must be cut: a hundred frames of
 * framework internals push the one line of the operator's own code out of the window, and that line is
 * the entire reason for looking.
 */
export async function latestEvent(issueId: string): Promise<SentryEventDetail> {
  const ev = (await call(`/issues/${encodeURIComponent(issueId)}/events/latest/`)) as RawEvent;

  let exception = '';
  let frames: RawFrame[] = [];
  let crumbs: RawCrumb[] = [];
  let formatted = '';
  for (const entry of ev.entries ?? []) {
    if (entry.type === 'exception') {
      const values = (entry.data as { values?: Array<{ type?: string; value?: string; stacktrace?: { frames?: RawFrame[] } }> })?.values ?? [];
      const v = values[0];
      if (!v) continue;
      exception = [v.type, v.value].filter(Boolean).join(': ').replace(/\s+/g, ' ').trim();
      // Sentry orders frames oldest-first; the crash is the LAST one.
      frames = (v.stacktrace?.frames ?? []).slice().reverse();
    } else if (entry.type === 'breadcrumbs') {
      crumbs = (entry.data as { values?: RawCrumb[] })?.values ?? [];
    } else if (entry.type === 'message') {
      formatted = String((entry.data as { formatted?: string })?.formatted ?? '');
    }
  }

  const inApp = frames.filter((f) => f.in_app);
  const chosen = (inApp.length >= MAX_FRAMES ? inApp : [...inApp, ...frames.filter((f) => !f.in_app)]).slice(0, MAX_FRAMES);
  // The TAIL, not the head: the crumbs adjacent to the failure are the ones that explain it.
  const keptCrumbs = crumbs.slice(-MAX_BREADCRUMBS);

  return {
    exception,
    frames: chosen.map(frameLine),
    framesOmitted: Math.max(0, frames.length - chosen.length),
    breadcrumbs: keptCrumbs.map(crumbLine),
    breadcrumbsOmitted: Math.max(0, crumbs.length - keptCrumbs.length),
    tags: (ev.tags ?? [])
      .filter((t) => t.key && !['sentry:user', 'sentry:release', 'url'].includes(t.key))
      .slice(0, 10)
      .map((t) => `${t.key}=${t.value}`),
    // `message` is the top-level summary; the `message` ENTRY's formatted text is the same thing when
    // both exist, so it is only a fallback for an event that carries one and not the other.
    message: (ev.message || formatted || '').replace(/\s+/g, ' ').slice(0, 400).trim(),
    timestamp: (ev.dateCreated ?? '').slice(0, 16).replace('T', ' '),
  };
}

/**
 * Prove a token+org pair works, using the SAME endpoint the connector depends on.
 *
 * Not `/organizations/`: a scoped token returns 403 there while reading issues perfectly well, so
 * verifying against it would reject exactly the correctly-scoped credentials it is meant to accept.
 * Measured against a real token before this was written.
 */
export async function verifyAccess(): Promise<number> {
  const c = credentials();
  const params = new URLSearchParams({ query: 'is:unresolved', statsPeriod: '1d', limit: '1' });
  if (c.project) params.set('project', c.project);
  const raw = (await call(`/organizations/${encodeURIComponent(c.org)}/issues/?${params}`)) as RawIssue[];
  return Array.isArray(raw) ? raw.length : 0;
}
