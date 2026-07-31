/**
 * `ayin jira <token> [email] [site]` — set up or refresh Jira credentials.
 *
 * VALIDATE BEFORE WRITE. The candidate token (plus whatever email/site apply — see below) is tested
 * against the real Jira API FIRST, via `currentSprintTickets`'s `creds` override, which never touches
 * `~/.egregor/config.env`. Only on a confirmed-working response does this command call
 * `writeEgregorEnvKeys` — a bad paste (an expired token, a typo'd site) never overwrites a
 * still-working credential, and the file is never left holding something unverified.
 *
 * The same successful call that confirms auth IS the deliverable: current-sprint tickets, printed as
 * proof the token actually works, not a separate "ok" message you have to trust.
 *
 * email/site ARE OPTIONAL — this command's primary job is refreshing an expiring token, so it reuses
 * whatever's already in the config file for the other two fields. Passing them explicitly is what a
 * first-time setup (no config file yet) needs.
 */

import { currentSprintTickets, loadEgregorEnv, writeEgregorEnvKeys, type JiraTicketSummary } from './jira.js';

function ticketLine(t: JiraTicketSummary): string {
  const assignee = t.assignee ?? 'Unassigned';
  return `  [${t.key}] ${t.summary}  (${t.status} · ${assignee})`;
}

export async function runJiraAuth(argv: string[]): Promise<void> {
  const [token, emailArg, siteArg] = argv;

  if (!token) {
    process.stderr.write(
      'Usage: ayin jira <token> [email] [site]\n' +
      '  <token>  a fresh Jira API token — create one at https://id.atlassian.com/manage-profile/security/api-tokens\n' +
      '  [email]  your Atlassian account email — only needed the first time (or to change accounts)\n' +
      '  [site]   your Jira site, e.g. yourcompany.atlassian.net — only needed the first time (or to change sites)\n' +
      'Existing email/site in ~/.egregor/config.env are reused when not given here.\n',
    );
    process.exit(1);
  }

  const existing = loadEgregorEnv();
  const email = emailArg ?? existing.JIRA_EMAIL;
  const site = siteArg ?? existing.JIRA_SITE;

  const missing = [!email && 'email', !site && 'site'].filter(Boolean);
  if (missing.length) {
    process.stderr.write(
      `Missing ${missing.join(' and ')} — none found in ~/.egregor/config.env and none given on the command line.\n` +
      `Usage: ayin jira <token> <email> <site>  (first-time setup needs all three)\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`Testing the token against ${site} as ${email}...\n`);
  const result = await currentSprintTickets({ email, token, site });

  if (!result.ok) {
    process.stderr.write(`Auth failed — nothing was written to ~/.egregor/config.env.\n${result.reason}\n`);
    process.exit(1);
  }

  // Confirmed working — NOW it's safe to persist.
  writeEgregorEnvKeys({ JIRA_EMAIL: email, JIRA_API_TOKEN: token, JIRA_SITE: site });
  process.stdout.write(`Auth confirmed — token saved to ~/.egregor/config.env.\n\n`);

  if (result.tickets.length === 0) {
    process.stdout.write('No issues in an open sprint right now (auth is working — this account just has none assigned/visible).\n');
  } else {
    process.stdout.write(`Current sprint (${result.tickets.length} issue(s)):\n`);
    for (const t of result.tickets) process.stdout.write(`${ticketLine(t)}\n`);
  }
  // Explicit exit (not just returning): importing ayin's module graph without HEADLESS forcing off
  // constructs a real blessed screen at load time regardless of which CLI subcommand runs — an abrupt
  // process.exit() is what stops its teardown escape codes from leaking into this command's plain
  // stdout, same reason `updater.ts`/`watch.ts`'s own CLI paths all call process.exit() rather than
  // letting the event loop drain naturally.
  process.exit(0);
}
