/**
 * Sentry credentials — token, org, and optionally one project.
 *
 * Same shape as the Jira connector's: environment first (for CI), then `~/.ayin-cli/sentry.env` written
 * by `/sentry-auth`, 0600 and atomic via the shared `credentials/envfile.ts`.
 *
 * THE ORG IS PART OF THE CREDENTIAL, not a setting. Every read endpoint that matters is
 * `/organizations/{org}/…`, and a real Sentry token is frequently scoped so narrowly that it cannot
 * even LIST the orgs it can read from — measured: `GET /api/0/organizations/` returns 403 for a token
 * whose issue queries return 200. So the org cannot be discovered on the operator's behalf; it is
 * stored beside the token, and a token without one is unusable rather than half-configured.
 *
 * NOTHING HERE NAMES AN ORG, A PROJECT OR A HOST. `sentry.io` is the vendor's own API, the same class
 * of literal as `api.openai.com`; the operator's org slug is not, and never appears in source.
 */

import { credentialsPath, readEnvFile, writeEnvFile } from '../../credentials/envfile.js';

export const CREDENTIALS_FILE = credentialsPath('sentry.env');

/** Sentry's own SaaS API. Overridden by `SENTRY_API_URL` for a self-hosted install. */
const DEFAULT_API_BASE = 'https://sentry.io/api/0';

export interface SentryCredentials {
  token: string;
  /** Organization slug — required; every useful endpoint is scoped to it. */
  org: string;
  /** Optional: narrows every query to one project. '' means the whole org. */
  project: string;
  /** API base, no trailing slash. Defaults to Sentry's SaaS. */
  apiBase: string;
}

function pick(src: Record<string, string | undefined>, ...keys: string[]): string {
  for (const k of keys) {
    const v = src[k];
    if (v && v.trim()) return v.trim();
  }
  return '';
}

/** Credentials, or null when no token is configured. Never throws. */
export function readCredentials(): SentryCredentials | null {
  const src: Record<string, string | undefined> = { ...readEnvFile(CREDENTIALS_FILE), ...process.env };
  const token = pick(src, 'SENTRY_TOKEN', 'SENTRY_AUTH_TOKEN');
  if (!token) return null;
  return {
    token,
    org: pick(src, 'SENTRY_ORG', 'SENTRY_ORGANIZATION'),
    project: pick(src, 'SENTRY_PROJECT'),
    apiBase: (pick(src, 'SENTRY_API_URL') || DEFAULT_API_BASE).replace(/\/+$/, ''),
  };
}

export function writeCredentials(c: SentryCredentials): string {
  return writeEnvFile(
    CREDENTIALS_FILE,
    [
      'ayin — Sentry connector credentials. chmod 0600; never commit this file.',
      'Token from Sentry → Settings → Auth Tokens. Read scopes are enough: event:read, project:read.',
    ],
    [
      ['SENTRY_TOKEN', c.token],
      ['SENTRY_ORG', c.org],
      ['SENTRY_PROJECT', c.project],
      // Only when it differs from the default, so the file does not pin a host it never needed to.
      ['SENTRY_API_URL', c.apiBase === DEFAULT_API_BASE ? '' : c.apiBase],
    ],
  );
}

/** One line for a human. No token bytes. */
export function credentialSummary(c: SentryCredentials): string {
  const where = c.apiBase === DEFAULT_API_BASE ? 'sentry.io' : c.apiBase;
  return `${c.org}${c.project ? `/${c.project}` : ''} · ${where}`;
}
