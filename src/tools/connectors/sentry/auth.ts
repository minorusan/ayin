/**
 * `/sentry-auth` — turn a pasted blob into a working, VERIFIED Sentry credential.
 *
 * Mirrors the Jira flow deliberately (deterministic parse → LLM only if that fails → verify → write),
 * because the operator's workflow is identical: generate a token, copy what the page shows, come back
 * and paste it. Two things are specific to Sentry:
 *
 * THE ORG SLUG IS REQUIRED AND NOT DISCOVERABLE. Every read endpoint is `/organizations/{org}/…`, and a
 * correctly-scoped token gets 403 from `/organizations/` — so ayin cannot look it up. It is parsed from
 * the paste instead, which usually contains it: a Sentry URL carries the slug either as a subdomain
 * (`org.sentry.io`) or as a path segment (`sentry.io/organizations/org/`).
 *
 * VERIFICATION USES THE REAL ENDPOINT. Checking the token against `/organizations/` would reject exactly
 * the narrowly-scoped credentials this connector is designed for. It is verified with the same
 * issue query the connector runs, so "verified" means "the thing you are about to do works".
 */

import { toolLlm, toolLog, toolReport } from '../../runtime.js';
import { verifyAccess } from './client.js';
import {
  CREDENTIALS_FILE, credentialSummary, readCredentials, writeCredentials, type SentryCredentials,
} from './credentials.js';

interface Extracted { token: string; org: string; project: string; apiBase: string }

const EMPTY: Extracted = { token: '', org: '', project: '', apiBase: '' };

/** `sntryu_` user, `sntrys_` org, `sntryi_` internal-integration, or a legacy 64-char hex token. */
const TOKEN_RE = /\b(?:sntry[usi]_[A-Za-z0-9]{20,}|[0-9a-f]{64})\b/;

/**
 * The ordinary paste, without a model.
 *
 * The org is found from a URL when one is present, then from a `org:`/`organization:` label. Nothing
 * else is guessed: a bare word in a paste is far more likely to be a project, a person or a note.
 */
export function extractDeterministic(text: string): Extracted {
  const out: Extracted = { ...EMPTY };

  out.token = TOKEN_RE.exec(text)?.[0] ?? '';

  // Self-hosted first: if a non-sentry.io host appears with /api/0, that is the base.
  const selfHosted = /https?:\/\/([a-z0-9.-]+)\/api\/0\b/i.exec(text);
  if (selfHosted && !/(^|\.)sentry\.io$/i.test(selfHosted[1])) out.apiBase = `https://${selfHosted[1]}/api/0`;

  const subdomain = /https?:\/\/([a-z0-9-]+)\.sentry\.io/i.exec(text);
  const pathOrg = /sentry\.io\/organizations\/([a-z0-9-]+)/i.exec(text);
  const labelled = /\borgani[sz]ation\b\s*[:=]?\s*([a-z0-9-]+)|\borg\b\s*[:=]?\s*([a-z0-9-]+)/i.exec(text);
  out.org = (pathOrg?.[1] ?? subdomain?.[1] ?? labelled?.[1] ?? labelled?.[2] ?? '').toLowerCase();
  // `us.sentry.io` / `de.sentry.io` are Sentry's regional hosts, not anyone's org slug.
  if (['us', 'de', 'eu', 'www', 'sentry'].includes(out.org)) out.org = '';

  const project = /\bproject\b\s*[:=]?\s*([a-z0-9-]+)/i.exec(text)
    ?? /sentry\.io\/organizations\/[a-z0-9-]+\/(?:issues\/)?\?project=([a-z0-9-]+)/i.exec(text);
  out.project = (project?.[1] ?? '').toLowerCase();

  return out;
}

async function extractWithModel(
  text: string,
  prompt: (id: string, vars: Record<string, string>) => string,
): Promise<Extracted> {
  try {
    const raw = await toolLlm().ask([{ role: 'user', content: prompt('extract', { TEXT: text }) }]);
    const json = /\{[\s\S]*\}/.exec(raw);
    if (!json) return { ...EMPTY };
    const p = JSON.parse(json[0]) as Partial<Extracted>;
    return {
      token: String(p.token ?? '').trim(),
      org: String(p.org ?? '').trim().toLowerCase(),
      project: String(p.project ?? '').trim().toLowerCase(),
      apiBase: String(p.apiBase ?? '').trim().replace(/\/+$/, ''),
    };
  } catch (err) {
    toolLog().warn('sentry_auth_extract_failed', { error: String(err) });
    return { ...EMPTY };
  }
}

/**
 * Parse, merge over what is stored, verify, then write. `prompt` is injected so this file needs no
 * bundle of its own.
 *
 * The merge is what makes `/sentry-auth <org-slug>` alone work: an operator whose token is already
 * stored but whose org was never captured adds only the missing half.
 */
export async function configureSentry(
  text: string,
  prompt: (id: string, vars: Record<string, string>) => string,
): Promise<string> {
  const stored = readCredentials();

  let found = extractDeterministic(text);
  // An LLM round is worth it only when the paste is missing something a regex should have caught.
  if (!found.token && !found.org) {
    toolReport('sentry-auth: reading the paste');
    const viaModel = await extractWithModel(text, prompt);
    found = {
      token: found.token || viaModel.token,
      org: found.org || viaModel.org,
      project: found.project || viaModel.project,
      apiBase: found.apiBase || viaModel.apiBase,
    };
  }

  const merged: SentryCredentials = {
    token: found.token || stored?.token || '',
    org: found.org || stored?.org || '',
    project: found.project || stored?.project || '',
    apiBase: found.apiBase || stored?.apiBase || 'https://sentry.io/api/0',
  };

  if (!merged.token) return 'sentry-auth: no token found in that text. Paste the token itself (Sentry → Settings → Auth Tokens).';
  if (!merged.org) {
    return 'sentry-auth: no organization slug found, and none is stored. Sentry cannot be queried without '
      + 'one, and a scoped token is not allowed to list them. Add it: /sentry-auth <your-org-slug> — it is '
      + 'the name in your Sentry URL.';
  }

  // Verify the CANDIDATE. The client reads env-first, so it is staged there for one call and always
  // restored — on success the file it just wrote is the durable record.
  const had = {
    token: process.env.SENTRY_TOKEN, org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT, api: process.env.SENTRY_API_URL,
  };
  const restore = (): void => {
    for (const [k, v] of [
      ['SENTRY_TOKEN', had.token], ['SENTRY_ORG', had.org],
      ['SENTRY_PROJECT', had.project], ['SENTRY_API_URL', had.api],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  process.env.SENTRY_TOKEN = merged.token;
  process.env.SENTRY_ORG = merged.org;
  if (merged.project) process.env.SENTRY_PROJECT = merged.project;
  else delete process.env.SENTRY_PROJECT;
  process.env.SENTRY_API_URL = merged.apiBase;

  try {
    toolReport(`sentry-auth: verifying against ${merged.org}`);
    await verifyAccess();
  } catch (err) {
    restore();
    toolLog().warn('sentry_auth_rejected', { org: merged.org });
    return `sentry-auth: verification FAILED — nothing was saved.\n${err instanceof Error ? err.message : String(err)}`;
  }

  const path = writeCredentials(merged);
  restore();
  toolLog().info('sentry_auth_saved', { org: merged.org, project: merged.project || '(whole org)' });
  return `sentry-auth: verified ✓\n${credentialSummary(merged)}\nSaved to ${path} (0600).\n`
    + `Ask it something: /sentry what is breaking most for users?`;
}

export { CREDENTIALS_FILE };
