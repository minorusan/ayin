/**
 * Jira credentials — read from the environment, else from the operator's own file.
 *
 * WHY A FILE OF ITS OWN, not `prompts.json` where the OpenAI key lives: this one expires. An operator
 * who rotates a token every 30 days edits it by hand, and a secret sitting in a JSON blob beside
 * prompt-tuning numbers is a secret that gets pasted into an issue report by accident. `jira.env` is
 * one obvious file, `KEY=value`, chmod 0600, and nothing else lives in it.
 *
 * ENV WINS. A CI job or a container passes `JIRA_*` and must not have to write a file first.
 *
 * AUTH MODE IS INFERRED, NOT CONFIGURED. Jira Cloud authenticates as `email:api-token` over Basic;
 * Server/Data Center uses a Personal Access Token as a Bearer and has no email at all. That is one
 * question the operator should never be asked, because their credential already answers it: an email
 * present means Basic, absent means Bearer.
 *
 * NOTHING IN THIS FILE NAMES A SITE. No default host, no project key, no fallback URL — unconfigured
 * is empty, and every caller reports that as "not configured" rather than dialling somewhere.
 */

import { credentialsPath, readEnvFile, writeEnvFile } from '../../credentials/envfile.js';

export const CREDENTIALS_FILE = credentialsPath('jira.env');

export interface JiraCredentials {
  token: string;
  /**
   * The cloud id of the site this token is used against, discovered from the token itself via
   * `/oauth/token/accessible-resources`. Present means: talk to the Atlassian **gateway** as Bearer.
   *
   * This is what makes `/jira-auth <token>` — token and nothing else — the normal case. The site is not
   * something the operator should have to tell ayin: the token already knows which sites it is valid
   * for, so asking for it is asking a person to look up what a GET request answers.
   */
  cloudId: string;
  /** The site's URL, for display only when a cloudId is in use. Bare host when it is the API target. */
  site: string;
  /** Only for the direct-to-site Basic fallback. Empty for gateway/Bearer. */
  email: string;
  /**
   * The board whose ACTIVE sprint defines "my sprint". '' means auto-detect per query.
   *
   * Needed because an account can see many boards — 18 on the instance this was built against — and
   * `openSprints()` spans all of them. Pinning it makes the answer stable instead of a majority vote that
   * can flip when work moves.
   */
  board: string;
  /** ISO date the token stops working, or '' if the operator did not record one. */
  expires: string;
}

/** Where requests go, and how they authenticate. Derived, never configured. */
export function apiTarget(c: JiraCredentials): { base: string; auth: string; how: string } {
  if (c.cloudId) {
    return {
      base: `https://api.atlassian.com/ex/jira/${c.cloudId}`,
      auth: `Bearer ${c.token}`,
      how: 'gateway (Bearer)',
    };
  }
  return {
    base: `https://${c.site}`,
    auth: authHeader(c),
    how: c.email ? `direct to site (Basic as ${c.email})` : 'direct to site (Bearer)',
  };
}

/** `https://x.example.net/` · `x.example.net` → `x.example.net`. */
export function normalizeSite(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').trim();
}

/** Both spellings: the older ayin used `JIRA_API_TOKEN`, and an operator's shell profile may still. */
function pick(src: Record<string, string | undefined>, ...keys: string[]): string {
  for (const k of keys) {
    const v = src[k];
    if (v && v.trim()) return v.trim();
  }
  return '';
}

/** Credentials, or null when no token is configured anywhere. Never throws. */
export function readCredentials(): JiraCredentials | null {
  const src: Record<string, string | undefined> = { ...readEnvFile(CREDENTIALS_FILE), ...process.env };

  const token = pick(src, 'JIRA_TOKEN', 'JIRA_API_TOKEN');
  if (!token) return null;
  const cloudId = pick(src, 'JIRA_CLOUD_ID');
  const site = normalizeSite(pick(src, 'JIRA_SITE', 'JIRA_URL', 'JIRA_HOST'));
  // A token with neither a discovered cloud id nor a site has nowhere to go.
  if (!cloudId && !site) return null;
  return {
    token,
    cloudId,
    site,
    email: pick(src, 'JIRA_EMAIL', 'JIRA_USER'),
    board: pick(src, 'JIRA_BOARD'),
    expires: pick(src, 'JIRA_TOKEN_EXPIRES', 'JIRA_EXPIRES'),
  };
}

/** Basic for Cloud (email present), Bearer for a Server/DC personal access token. */
export function authHeader(c: JiraCredentials): string {
  return c.email
    ? `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}`
    : `Bearer ${c.token}`;
}

/**
 * Days until the recorded expiry — negative once past, null when unrecorded or unparseable.
 * Advisory only: the token is whatever the server says it is, and this is the operator's own note.
 */
export function daysUntilExpiry(c: JiraCredentials): number | null {
  if (!c.expires) return null;
  const t = Date.parse(c.expires);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

/**
 * Write the file, 0600, atomically.
 *
 * Atomic because a half-written credential file is indistinguishable from a wrong token: the failure
 * surfaces as a 401 an hour later, and nobody suspects the writer. 0600 before the rename, so the
 * secret is never briefly world-readable.
 */
export function writeCredentials(c: JiraCredentials): string {
  return writeEnvFile(
    CREDENTIALS_FILE,
    [
      'ayin — Jira connector credentials. chmod 0600; never commit this file.',
      'Cloud: JIRA_EMAIL + an API token. Server/Data Center: a personal access token, no email.',
    ],
    [
      ['JIRA_TOKEN', c.token],
      ['JIRA_CLOUD_ID', c.cloudId],
      ['JIRA_SITE', c.site],
      ['JIRA_EMAIL', c.email],
      ['JIRA_BOARD', c.board],
      ['JIRA_TOKEN_EXPIRES', c.expires],
    ],
  );
}

/** One line for a human: where the credential came from and how long it has left. No token bytes. */
export function credentialSummary(c: JiraCredentials): string {
  const mode = apiTarget(c).how;
  const days = daysUntilExpiry(c);
  const exp = days === null
    ? c.expires ? ` · expires ${c.expires}` : ''
    : days < 0 ? ` · EXPIRED ${-days}d ago (${c.expires})` : ` · expires in ${days}d (${c.expires})`;
  return `${c.site} · ${mode}${exp}`;
}
