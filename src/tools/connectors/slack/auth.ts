/**
 * `/slack-auth` — turn a pasted token into a working, VERIFIED Slack credential.
 *
 * Same discipline as `/jira-auth` and `/sentry-auth`: parse, verify against the live API, write only
 * on success. No LLM round: unlike a Sentry org slug, a Slack token's shape is unambiguous (`xoxp-`/
 * `xoxb-`, or a legacy 64-char hex string), so there is nothing here a regex misses that a model would
 * catch — spending a round on it would be pure waste.
 *
 * A BOT TOKEN IS REFUSED BEFORE THE NETWORK CALL, not after a failed verify. `xoxb-` is visible in the
 * token itself, so there is no reason to burn a request finding out what the prefix already says: it
 * cannot search and only sees channels the bot was invited into, which makes it useless for this
 * connector's one job.
 */

import { verifyAccess } from './client.js';
import { CREDENTIALS_FILE, credentialSummary, readCredentials, writeCredentials, type SlackCredentials } from './credentials.js';

/** `xoxp-` (user), `xoxb-` (bot, refused below), or a legacy 64-char hex token. */
const TOKEN_RE = /\bxox[pb]-[A-Za-z0-9-]{10,}\b|\b[0-9a-f]{64}\b/;

/** `team: T0123ABCD` or a bare Enterprise Grid team id sitting in the paste. */
const TEAM_RE = /\bteam\b\s*[:=]?\s*(T[A-Z0-9]{8,})|\b(T[A-Z0-9]{8,})\b/i;

export async function configureSlack(text: string): Promise<string> {
  const found = TOKEN_RE.exec(text)?.[0] ?? '';
  if (!found) return 'slack-auth: no token found in that text. Paste the User OAuth Token (starts with xoxp-).';

  if (found.startsWith('xoxb-')) {
    return 'slack-auth: that is a BOT token (xoxb-) — refused, nothing was saved. It cannot call '
      + 'search.messages and only sees channels the bot was invited into. Reinstall the Slack app and '
      + 'copy the USER OAuth Token (xoxp-…) instead.';
  }

  const stored = readCredentials();
  const teamMatch = TEAM_RE.exec(text);
  const merged: SlackCredentials = {
    token: found,
    teamId: (teamMatch?.[1] ?? teamMatch?.[2] ?? stored?.teamId ?? '').toUpperCase(),
  };

  // Verify the CANDIDATE. The client reads env-first, so it is staged there for one call and restored
  // whatever the outcome — on success the file just written is the durable record.
  const had = { token: process.env.SLACK_USER_TOKEN, team: process.env.SLACK_TEAM_ID };
  const restore = (): void => {
    if (had.token === undefined) delete process.env.SLACK_USER_TOKEN; else process.env.SLACK_USER_TOKEN = had.token;
    if (had.team === undefined) delete process.env.SLACK_TEAM_ID; else process.env.SLACK_TEAM_ID = had.team;
  };
  process.env.SLACK_USER_TOKEN = merged.token;
  if (merged.teamId) process.env.SLACK_TEAM_ID = merged.teamId; else delete process.env.SLACK_TEAM_ID;

  let verified: { who: string; isUserToken: boolean };
  try {
    verified = await verifyAccess();
  } catch (err) {
    restore();
    return `slack-auth: verification FAILED — nothing was saved.\n${err instanceof Error ? err.message : String(err)}`;
  }
  restore();

  if (!verified.isUserToken) {
    // Reachable only if a bot token somehow slipped past the TOKEN_RE branch above (a legacy hex
    // token, say) — the second refusal the hard facts call for, at query/verify time as well as parse time.
    return `slack-auth: Slack authenticated this as ${verified.who}, but it is not a user token — refused, nothing was saved.`;
  }

  const path = writeCredentials(merged);
  return `slack-auth: verified ✓ as ${verified.who}\n${credentialSummary(merged)}\nSaved to ${path} (0600).\n`
    + 'Ask it something: /slack what has anyone said about the outage last week?';
}

export { CREDENTIALS_FILE };
