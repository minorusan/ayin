/**
 * Slack credentials — a user token, and optionally a team id.
 *
 * Same shape as the Jira/Sentry connectors': environment first (for CI), then
 * `~/.ayin-cli/slack.env` written by `/slack-auth`, 0600 and atomic via the shared
 * `credentials/envfile.ts`.
 *
 * A USER TOKEN IS REQUIRED, NOT A CHOICE. `xoxb-` (bot) tokens get `not_allowed_token_type` from
 * `search.messages` and only see channels the bot was invited into — so a bot token cannot answer
 * "what has anyone said about X", which is the whole point of this connector. Refused at auth time
 * (`auth.ts`) before a network call is even made, and again here if one somehow got written anyway.
 *
 * TEAM ID IS OPTIONAL. It is only needed on Enterprise Grid, where a search across an org-level token
 * must say which team to search. Absent, `search.*` calls omit it and Slack applies its own default.
 *
 * NOTHING HERE NAMES A WORKSPACE, A CHANNEL OR A PERSON.
 */

import { credentialsPath, readEnvFile, writeEnvFile } from '../../credentials/envfile.js';

export const CREDENTIALS_FILE = credentialsPath('slack.env');

export interface SlackCredentials {
  /** A user token (`xoxp-…`). Never a bot token — see the note above. */
  token: string;
  /** Enterprise Grid only. '' elsewhere. */
  teamId: string;
}

function pick(src: Record<string, string | undefined>, ...keys: string[]): string {
  for (const k of keys) {
    const v = src[k];
    if (v && v.trim()) return v.trim();
  }
  return '';
}

/** Credentials, or null when no token is configured. Never throws. */
export function readCredentials(): SlackCredentials | null {
  const src: Record<string, string | undefined> = { ...readEnvFile(CREDENTIALS_FILE), ...process.env };
  const token = pick(src, 'SLACK_USER_TOKEN');
  if (!token) return null;
  return { token, teamId: pick(src, 'SLACK_TEAM_ID') };
}

export function writeCredentials(c: SlackCredentials): string {
  return writeEnvFile(
    CREDENTIALS_FILE,
    [
      'ayin — Slack connector credentials. chmod 0600; never commit this file.',
      'A USER token (xoxp-…), from a private Slack app you installed to your own workspace.',
      'A bot token (xoxb-) cannot search and is refused.',
    ],
    [
      ['SLACK_USER_TOKEN', c.token],
      ['SLACK_TEAM_ID', c.teamId],
    ],
  );
}

/** One line for a human. No token bytes. */
export function credentialSummary(c: SlackCredentials): string {
  return c.teamId ? `user token · team ${c.teamId}` : 'user token';
}
