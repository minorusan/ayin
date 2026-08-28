/**
 * Slack REST client — the connector's only door to the API.
 *
 * READ-ONLY IS ENFORCED HERE, NOT REQUESTED. `ALLOWED` is an EXACT set of method names — never a
 * prefix match, or `chat.postMessage` would slip in behind `chat.` — and no request body is ever
 * sent. The token itself could post, delete files and leave channels; this allowlist is what stops
 * it, so a prefix match here is not a style choice, it is the whole guarantee.
 *
 * SLACK ANSWERS HTTP 200 WITH `{ok:false, error}` FOR NEARLY EVERY FAILURE, a revoked token
 * included. A caller that checks only the HTTP status reports a dead token as "no results" —
 * indistinguishable from a true negative, the worst failure shape for a search tool. Every failure
 * here is a thrown `SlackError` carrying Slack's own code, never a swallowed `ok:false`.
 *
 * WIRE FORMAT IS DECODED HERE, ONCE. `<@U123>`, `<!here>`, `<#C1|general>`, `<url|label>` and HTML
 * entities are never handed to a model or printed to an operator raw — see `readable()`.
 */

import { readCredentials, type SlackCredentials } from './credentials.js';

const API = 'https://slack.com/api';
const TIMEOUT_MS = 20_000;

/** Read-only allowlist — EXACT method names. No writer exists here to be reached via a prefix. */
export const ALLOWED = new Set([
  'auth.test',
  'search.messages',
  'search.files',
  'conversations.list',
  'conversations.history',
  'conversations.replies',
  'conversations.info',
  'conversations.members',
  'users.conversations',
  'users.info',
  'users.list',
  'users.lookupByEmail',
  'users.profile.get',
  'files.list',
  'files.info',
  'reactions.get',
  'team.info',
]);

export class SlackError extends Error {}

interface SlackResult {
  ok: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  [k: string]: unknown;
}

/** The credential, or a thrown error naming the fix. A bot token is refused HERE too — see auth.ts. */
function credentials(): SlackCredentials {
  const c = readCredentials();
  if (!c) {
    throw new SlackError(
      'Slack is not configured. Run `/slack-auth <paste your user token>` — or set SLACK_USER_TOKEN '
      + '(and, on Enterprise Grid, SLACK_TEAM_ID) in the environment.',
    );
  }
  if (c.token.startsWith('xoxb-')) {
    throw new SlackError(
      'SLACK_USER_TOKEN is a BOT token (xoxb-), which cannot search and only sees channels the bot was '
      + 'invited to. This connector needs a USER token (xoxp-…) — reinstall the Slack app and take the '
      + 'User OAuth Token, then /slack-auth with it.',
    );
  }
  return c;
}

/**
 * One authenticated GET, allowlisted, no body. Every non-2xx-with-`ok:true` outcome throws a
 * `SlackError` carrying Slack's own diagnosis rather than a generic HTTP status.
 */
async function apiGet(method: string, params: Record<string, unknown>): Promise<SlackResult> {
  if (!ALLOWED.has(method)) {
    throw new SlackError(`"${method}" is not available — this connector is READ-ONLY. Allowed: ${[...ALLOWED].join(', ')}`);
  }
  const c = credentials();

  const url = new URL(`${API}/${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  // Enterprise Grid org-level tokens require team_id on search; elsewhere it is accepted and ignored.
  if (c.teamId && method.startsWith('search.') && !url.searchParams.has('team_id')) {
    url.searchParams.set('team_id', c.teamId);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new SlackError(`cannot reach Slack: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 429) {
    throw new SlackError(`rate limited by Slack (retry after ${res.headers.get('retry-after') ?? '?'}s) — ask for less at a time`);
  }
  if (!res.ok) throw new SlackError(`Slack returned HTTP ${res.status} for ${method}`);

  const body = (await res.json().catch(() => {
    throw new SlackError(`Slack returned a non-JSON body for ${method}`);
  })) as SlackResult;
  if (body.ok) return body;

  const code = body.error ?? 'unknown_error';
  if (code === 'missing_scope') {
    throw new SlackError(
      `missing_scope: the token needs "${body.needed ?? '?'}" (it has: ${body.provided ?? '?'}). Add it `
      + "under the Slack app's User Token Scopes and REINSTALL the app — a token never gains a scope on its own.",
    );
  }
  if (code === 'not_allowed_token_type') {
    throw new SlackError(
      `not_allowed_token_type: ${method} requires a USER token (xoxp-). The configured token is a bot `
      + 'token, which cannot search and only sees channels the bot was invited to.',
    );
  }
  if (code === 'invalid_auth' || code === 'token_revoked' || code === 'account_inactive') {
    throw new SlackError(`${code}: the token is dead — reinstall the app and run /slack-auth with a fresh one.`);
  }
  throw new SlackError(code);
}

/* --------------------------------------------------------------- names, wire format, shapes */

type Rec = Record<string, unknown>;
const asArr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** id → display name, process-lifetime. Names change rarely; a stale one is cosmetic. */
const userNames = new Map<string, string>();
const channelNames = new Map<string, string>();

/** Resolve up to `cap` unknown ids. Best-effort: a failed lookup leaves the raw id in the text. */
async function learnUsers(ids: Iterable<string>, cap = 40): Promise<void> {
  const unknown = [...new Set([...ids].filter((id) => id && !userNames.has(id)))].slice(0, cap);
  await Promise.all(
    unknown.map(async (id) => {
      try {
        const r = await apiGet('users.info', { user: id });
        const u = r.user as { name?: string; real_name?: string; profile?: { display_name?: string } } | undefined;
        const name = u?.profile?.display_name || u?.real_name || u?.name;
        if (name) userNames.set(id, name);
      } catch {
        /* leave unresolved */
      }
    }),
  );
}

const MENTION = /<@([UW][A-Z0-9]+)>/g;

/**
 * Every user id a batch of messages refers to: the AUTHORS and the ids MENTIONED inside the text.
 * Authors alone leaves every ping unresolved — a real message is full of `<@U…>` and an unresolved
 * one reads as `@U02P4BE6KA6`, which names nobody.
 */
function idsIn(msgs: Rec[]): string[] {
  const ids: string[] = [];
  for (const m of msgs) {
    if (m.user) ids.push(str(m.user));
    for (const hit of str(m.text).matchAll(MENTION)) ids.push(hit[1]);
  }
  return ids;
}

/** Slack's wire format → readable text: mentions, broadcasts, channel refs, links, entities. */
export function readable(text: string): string {
  return text
    .replace(MENTION, (_m, id: string) => `@${userNames.get(id) ?? id}`)
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, (_m, kind: string) => `@${kind}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label: string | undefined) => label || '@group')
    // Private channels are G… on older workspaces and C… on newer ones, DMs are D…. A C-only pattern
    // left every private-channel reference as raw wire format.
    .replace(/<#([CGD][A-Z0-9]+)\|([^>]*)>/g, (_m, id: string, name: string) => `#${name || channelNames.get(id) || id}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => `${label} (${url})`)
    .replace(/<(https?:\/\/[^|>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s*\n\s*/g, ' ⏎ ')
    .trim();
}

/** "1756108980.123456" → "2026-08-25 11:03" UTC. The raw ts travels alongside — it IS the message id. */
export function when(ts: unknown): string {
  const secs = Number.parseFloat(String(ts ?? ''));
  if (!Number.isFinite(secs) || secs <= 0) return '?';
  return new Date(secs * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export interface SlackMessage {
  ts: string;
  at: string;
  author: string;
  text: string;
  threadTs?: string;
  replyCount?: number;
  channelId?: string;
  channel?: string;
  permalink?: string;
}

function author(m: Rec): string {
  const id = str(m.user) || str(m.bot_id);
  return (str(m.username) || userNames.get(id) || id || '?').replace(/^@/, '');
}

export function message(m: Rec): SlackMessage {
  const out: SlackMessage = { ts: str(m.ts), at: when(m.ts), author: author(m), text: readable(str(m.text)) };
  if (m.thread_ts && m.thread_ts !== m.ts) out.threadTs = str(m.thread_ts);
  if (typeof m.reply_count === 'number' && m.reply_count > 0) out.replyCount = m.reply_count;
  if (m.permalink) out.permalink = str(m.permalink);
  return out;
}

/**
 * Oldest-first, by numeric `ts`, whatever order Slack used. `conversations.history` returns
 * newest-first and `conversations.replies` returns oldest-first — a blind `.reverse()` fixes one and
 * presents the other backwards. Sorting by the id itself is correct regardless of which endpoint sent it.
 */
export function chronological(msgs: Rec[]): Rec[] {
  return [...msgs].sort((a, b) => Number.parseFloat(str(a.ts) || '0') - Number.parseFloat(str(b.ts) || '0'));
}

/** One line for a message — the primitive the loop assembles blocks from. */
export function msgLine(m: SlackMessage, withChannel = false): string {
  const where = withChannel && m.channel ? `${m.channel} ` : '';
  const chan = withChannel && m.channelId ? ` chan=${m.channelId}` : '';
  const thread = m.threadTs ? ' ↳thread' : '';
  const replies = m.replyCount ? ` (${m.replyCount} replies, ts=${m.ts})` : '';
  const MAX_TEXT = 600;
  const text = m.text.length > MAX_TEXT ? `${m.text.slice(0, MAX_TEXT)}…[+${m.text.length - MAX_TEXT} chars]` : m.text;
  const link = m.permalink ? `\n    ${m.permalink}` : '';
  return `${where}${m.at} ts=${m.ts}${chan} @${m.author}${thread}${replies}: ${text}${link}`;
}

function channelLabel(c: Rec): string {
  const id = str(c.id);
  if (c.is_im) return `DM:@${userNames.get(str(c.user)) ?? str(c.user)}`;
  const name = str(c.name);
  if (name) channelNames.set(id, name);
  return `${c.is_private ? '🔒#' : '#'}${name || id}`;
}

const cursorOf = (r: SlackResult): string => str((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor);

/* -------------------------------------------------------------------------------- the ops */

export interface SlackSearchResult { total: number; page: number; pageCount: number; matches: SlackMessage[] }

/** Every message the operator can see that matches `query` — channels they are in, and their DMs. */
export async function search(query: string, opts: { count?: number; page?: number } = {}): Promise<SlackSearchResult> {
  const r = await apiGet('search.messages', {
    query,
    count: Math.min(opts.count ?? 20, 100),
    page: opts.page,
  });
  const box = (r.messages ?? {}) as Rec;
  const matches = asArr(box.matches);
  await learnUsers(idsIn(matches));
  const pag = (box.pagination ?? {}) as Rec;
  return {
    total: Number(box.total ?? 0),
    page: Number(pag.page ?? 1),
    pageCount: Number(pag.page_count ?? 1),
    matches: matches.map((m) => {
      const ch = (m.channel ?? {}) as Rec;
      return { ...message(m), channel: channelLabel(ch), channelId: str(ch.id) };
    }),
  };
}

export interface SlackHistoryResult { messages: SlackMessage[]; hasMore: boolean; cursor: string }

/** A channel's or DM's messages, oldest first. `latest` narrows to just before a given ts — how a hit from `search` is read in context. */
export async function history(
  channel: string, opts: { latest?: string; cursor?: string; limit?: number } = {},
): Promise<SlackHistoryResult> {
  const r = await apiGet('conversations.history', {
    channel,
    limit: Math.min(opts.limit ?? 50, 100),
    latest: opts.latest,
    inclusive: opts.latest ? 'true' : undefined,
    cursor: opts.cursor,
  });
  const msgs = asArr(r.messages);
  await learnUsers(idsIn(msgs));
  return { messages: chronological(msgs).map(message), hasMore: !!r.has_more, cursor: cursorOf(r) };
}

/** The whole thread under a message: the parent plus every reply, oldest first. */
export async function replies(
  channel: string, ts: string, opts: { cursor?: string; limit?: number } = {},
): Promise<SlackHistoryResult> {
  const r = await apiGet('conversations.replies', { channel, ts, limit: Math.min(opts.limit ?? 50, 100), cursor: opts.cursor });
  const msgs = asArr(r.messages);
  await learnUsers(idsIn(msgs));
  return { messages: chronological(msgs).map(message), hasMore: !!r.has_more, cursor: cursorOf(r) };
}

export interface SlackChannelInfo {
  id: string; label: string; isPrivate: boolean; isIm: boolean; isArchived: boolean;
  members?: number; topic: string;
}
export interface SlackChannelListResult { scope: string; conversations: SlackChannelInfo[]; cursor: string }

/** The operator's own channels/DMs by default; every workspace channel (joined or not) when `workspace` is set. */
export async function channelList(opts: { workspace?: boolean; cursor?: string; limit?: number } = {}): Promise<SlackChannelListResult> {
  const method = opts.workspace ? 'conversations.list' : 'users.conversations';
  const r = await apiGet(method, {
    types: 'public_channel,private_channel,mpim,im',
    limit: Math.min(opts.limit ?? 200, 200),
    exclude_archived: 'true',
    cursor: opts.cursor,
  });
  const chans = asArr(r.channels);
  await learnUsers(chans.filter((c) => c.is_im).map((c) => str(c.user)));
  return {
    scope: opts.workspace ? 'workspace' : 'mine',
    conversations: chans.map((c) => ({
      id: str(c.id),
      label: channelLabel(c),
      isPrivate: !!c.is_private,
      isIm: !!c.is_im,
      isArchived: !!c.is_archived,
      members: typeof c.num_members === 'number' ? c.num_members : undefined,
      topic: readable(str((c.topic as Rec | undefined)?.value ?? '')).slice(0, 140),
    })),
    cursor: cursorOf(r),
  };
}

export interface SlackUserInfo {
  id: string; name: string; handle: string; realName: string; title: string; isBot: boolean; deleted: boolean;
}

/** A person by Slack id or by email. */
export async function lookupUser(idOrEmail: string): Promise<SlackUserInfo> {
  const isEmail = idOrEmail.includes('@');
  const r = isEmail ? await apiGet('users.lookupByEmail', { email: idOrEmail }) : await apiGet('users.info', { user: idOrEmail });
  const u = (r.user ?? {}) as Rec;
  const profile = (u.profile ?? {}) as Rec;
  const name = str(profile.display_name) || str(u.real_name) || str(u.name);
  if (u.id) userNames.set(str(u.id), name);
  return {
    id: str(u.id), name, handle: str(u.name), realName: str(u.real_name),
    title: str(profile.title), isBot: !!u.is_bot, deleted: !!u.deleted,
  };
}

/**
 * The escape hatch, for a read method nobody wrapped (`reactions.get`, `team.info`,
 * `conversations.info`, `search.files`, …). Still allowlisted and body-less by `apiGet` — an
 * unwrapped method is not an unchecked one.
 */
export async function rawCall(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const { ok: _ok, ...rest } = await apiGet(method, params);
  return rest;
}

/** Identity check — the one thing that proves the token is alive, and the right kind. */
export async function whoAmI(): Promise<{ user: string; team: string; teamId: string; isUserToken: boolean }> {
  const r = await apiGet('auth.test', {});
  return {
    user: str(r.user), team: str(r.team), teamId: str(r.team_id),
    isUserToken: readCredentials()?.token.startsWith('xoxp-') ?? false,
  };
}

/** Prove the credential works, for `/slack-auth`'s pre-write check and the connector's own status line. */
export async function verifyAccess(): Promise<{ who: string; isUserToken: boolean }> {
  const me = await whoAmI();
  return { who: `${me.user} @ ${me.team}`, isUserToken: me.isUserToken };
}

/** Exported for the offline harness — not part of the connector's public surface. */
export const _internals = { ALLOWED, apiGet, readable, when, message, chronological, channelLabel, idsIn, userNames, channelNames };
