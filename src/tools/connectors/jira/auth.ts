/**
 * `/jira-auth` — turn a pasted blob into a working, VERIFIED credential file.
 *
 * The operator's real workflow is: generate a token in Atlassian, copy whatever the page shows, come
 * back, paste it. What lands on the clipboard is never a tidy `KEY=value` — it is a token beside a
 * sentence about when it expires, sometimes a site URL, sometimes an email, in any order. Asking them
 * to reformat it by hand is asking them to do the parsing this tool exists to do.
 *
 * DETERMINISTIC FIRST, MODEL SECOND. A regex pass handles the ordinary paste. Only a blob it cannot
 * resolve reaches the LLM, so the common case costs nothing and cannot be hallucinated.
 *
 * ROTATION IS THE COMMON CASE. A token expires every few weeks; the site and email do not change. So a
 * paste containing only a new token MERGES over the stored credential rather than being rejected as
 * incomplete — which is what makes re-authing a two-second act instead of a lookup.
 *
 * NEVER WRITE AN UNVERIFIED CREDENTIAL. The file is written only after the token has actually
 * authenticated against the site. A stored-but-wrong credential fails later, somewhere else, as a 401
 * with no memory of where it came from — the exact bug that makes people distrust the tool.
 *
 * The token is never echoed, logged, or included in any return value.
 */

import { toolLlm, toolLog, toolReport } from '../../runtime.js';
import { whoAmI, resetApiVersion } from './client.js';
import {
  CREDENTIALS_FILE, apiTarget, credentialSummary, normalizeSite, readCredentials, writeCredentials,
  type JiraCredentials,
} from './credentials.js';

interface Extracted { site: string; email: string; token: string; expires: string; board: string }

const EMPTY: Extracted = { site: '', email: '', token: '', expires: '', board: '' };

/** A month name date ("expires 12 September 2026") as well as an ISO one. */
function parseDate(text: string): string {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso) return iso[1];
  const named = /\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b|\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/.exec(text);
  if (!named) return '';
  const t = Date.parse(named[0]);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}

/**
 * The ordinary paste, without a model.
 *
 * The token is the one field with no reliable syntax, so it is found by ELIMINATION: take the longest
 * secret-shaped run that is not the email, not the host, and not a date. Labelled forms
 * (`token: xxx`) win outright when present.
 */
export function extractDeterministic(text: string): Extracted {
  const out: Extracted = { ...EMPTY };

  const email = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/.exec(text);
  if (email) out.email = email[0];

  const site = /\b(?:https?:\/\/)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)(?:\/[^\s]*)?/i.exec(
    // The email's domain is not the site; remove it before looking for a host.
    out.email ? text.replace(out.email, ' ') : text,
  );
  if (site) out.site = normalizeSite(site[1]);

  out.expires = parseDate(text);
  // `board=1` / `board 1` — the board whose active sprint counts as "my sprint".
  out.board = /\bboard\s*[:=]?\s*(\d+)\b/i.exec(text)?.[1] ?? '';

  const labelled = /\b(?:token|key|pat|secret)\b\s*[:=]?\s*["']?([A-Za-z0-9_\-=+./]{16,})["']?/i.exec(text);
  if (labelled) {
    out.token = labelled[1];
    return out;
  }
  const candidates = text
    .split(/\s+/)
    .map((w) => w.replace(/^["'(<]+|[."'),>]+$/g, ''))
    .filter((w) => w.length >= 16 && /^[A-Za-z0-9_\-=+./]+$/.test(w))
    .filter((w) => w !== out.email && !w.includes('@'))
    .filter((w) => !out.site || !w.includes(out.site))
    .filter((w) => !/^\d{4}-\d{2}-\d{2}$/.test(w));
  if (candidates.length) out.token = candidates.sort((a, b) => b.length - a.length)[0];

  return out;
}

/** Ask the model, for a blob the regexes could not resolve. Returns EMPTY on any failure. */
/**
 * THE SITE CANNOT BE DISCOVERED FROM AN API TOKEN. Recorded because it cost a rebuild.
 *
 * `GET https://api.atlassian.com/oauth/token/accessible-resources` does return every site a credential
 * can reach — but only for an OAuth 2.0 (3LO) access token obtained through the authorization-code flow.
 * A personal API token is not one, classic or scoped: the endpoint answers **403** for both. Measured
 * against a real, freshly-created token before this comment was written.
 *
 * So Basic `email:token` against the operator's own site is the whole story for a Cloud API token, and
 * the email is required by the protocol rather than by ayin — there is no endpoint that turns a token
 * into the account it belongs to, because every such endpoint needs to be authenticated first.
 *
 * Consequence, accepted: the FIRST `/jira-auth` needs token + email + site. Every later one needs only
 * the token, because the rest merges from the stored file — which is the case that actually recurs, since
 * tokens expire and sites do not.
 */

async function extractWithModel(text: string, prompt: (id: string, vars: Record<string, string>) => string): Promise<Extracted> {
  try {
    const raw = await toolLlm().ask([{ role: 'user', content: prompt('extract', { TEXT: text }) }]);
    const json = /\{[\s\S]*\}/.exec(raw);
    if (!json) return { ...EMPTY };
    const parsed = JSON.parse(json[0]) as Partial<Extracted>;
    return {
      site: normalizeSite(String(parsed.site ?? '')),
      email: String(parsed.email ?? '').trim(),
      token: String(parsed.token ?? '').trim(),
      expires: String(parsed.expires ?? '').trim(),
      board: '',
    };
  } catch (err) {
    toolLog().warn('jira_auth_extract_failed', { error: String(err) });
    return { ...EMPTY };
  }
}

/**
 * Parse, merge over what is stored, verify against the server, then write.
 * `prompt` is injected so this file needs no prompt bundle of its own.
 */
export async function configureJira(
  text: string,
  prompt: (id: string, vars: Record<string, string>) => string,
): Promise<string> {
  const stored = readCredentials();

  let found = extractDeterministic(text);
  // Only a paste that still lacks the one irreducible field is worth an LLM round.
  if (!found.token) {
    toolReport('jira-auth: reading the paste');
    const viaModel = await extractWithModel(text, prompt);
    found = {
      site: found.site || viaModel.site,
      email: found.email || viaModel.email,
      token: found.token || viaModel.token,
      expires: found.expires || viaModel.expires,
      board: found.board || viaModel.board,
    };
  }

  const token = found.token || stored?.token || '';
  if (!token) return 'jira-auth: no token found in that text. Paste the token itself.';

  const merged: JiraCredentials = {
    token,
    // Reserved for a future OAuth path; never set from an API token (see the note above).
    cloudId: stored?.cloudId ?? '',
    site: normalizeSite(found.site || stored?.site || ''),
    email: found.email || stored?.email || '',
    board: found.board || stored?.board || '',
    expires: found.expires || (found.token ? '' : stored?.expires ?? ''),
  };

  if (!merged.site) {
    return 'jira-auth: no site stored yet, so there is nowhere to send requests. The first time, include '
      + 'your site and the account email alongside the token:\n'
      + '  /jira-auth <token> you@company.com yourcompany.atlassian.net\n'
      + 'After that, rotating is just `/jira-auth <new-token>` — the site and email are remembered. '
      + '(An API token cannot reveal its own site: that endpoint is OAuth-only and answers 403 here.)';
  }
  // No email is NOT refused here: a Server/Data Center personal access token authenticates as a Bearer
  // and has no email at all. Which kind this is cannot be known from the string, so it is tried — and the
  // failure path below names the missing email, which is the likely cause for a Cloud token.

  // Verify BEFORE writing, against the CANDIDATE rather than whatever is stored. The client reads its
  // credential through the environment-first path, so the candidate is staged there for the length of one
  // call and then always put back — including on success, where the newly written file becomes the
  // durable record. Leaving it staged would silently outrank a later hand-edit of that file for the rest
  // of the session, which is the kind of "I changed it and nothing happened" that costs an afternoon.
  const had = {
    site: process.env.JIRA_SITE, token: process.env.JIRA_TOKEN,
    email: process.env.JIRA_EMAIL, cloud: process.env.JIRA_CLOUD_ID,
  };
  const restore = (): void => {
    for (const [k, v] of [
      ['JIRA_SITE', had.site], ['JIRA_TOKEN', had.token],
      ['JIRA_EMAIL', had.email], ['JIRA_CLOUD_ID', had.cloud],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetApiVersion();
  };
  const stage = (k: string, v: string): void => { if (v) process.env[k] = v; else delete process.env[k]; };
  stage('JIRA_TOKEN', merged.token);
  stage('JIRA_CLOUD_ID', merged.cloudId);
  stage('JIRA_SITE', merged.site);
  stage('JIRA_EMAIL', merged.email);
  resetApiVersion();

  const how = apiTarget(merged).how;
  let who: { name: string; email: string };
  try {
    toolReport(`jira-auth: verifying — ${how}`);
    who = await whoAmI();
  } catch (err) {
    restore(); // a failed attempt must not break a session that was already working
    toolLog().warn('jira_auth_rejected', { how, site: merged.site });
    return `jira-auth: verification FAILED via ${how} — nothing was saved.\n`
      + `${err instanceof Error ? err.message : String(err)}`
      + `${merged.cloudId ? '' : '\nJira Cloud tokens also need your account email for direct site access: `/jira-auth <token> <email>`.'}`;
  }

  const path = writeCredentials(merged);
  restore();
  toolLog().info('jira_auth_saved', { how, site: merged.site, expires: merged.expires || 'unrecorded' });
  return `jira-auth: authenticated as ${who.name}${who.email ? ` <${who.email}>` : ''} ✓\n`
    + `${credentialSummary(merged)}\nSaved to ${CREDENTIALS_FILE} (0600).`
    + `${merged.expires ? '' : '\nNo expiry recorded — include the date next time and ayin will warn you before it lapses.'}`;
}

export { CREDENTIALS_FILE };
