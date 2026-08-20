/**
 * The GitHub personal access token — where it lives, and how it is read.
 *
 * ayin needs a PAT for one job: reaching GitHub as the operator (pull requests, repo reads) without a
 * browser and without `gh auth login`, which is interactive and therefore useless in a headless run.
 *
 * PRECEDENCE, and why this order. Environment first — a CI job or a container passes `GITHUB_TOKEN`
 * and must not have to write a file. Then `~/.ayin-cli/github.env`, written by `writeGithubToken`.
 * Then, LAST, `gh auth token` if the CLI happens to be logged in: a convenience for a workstation that
 * already works, never a dependency, because it is a subprocess that can hang and its answer belongs
 * to whatever account someone logged in as — which is not necessarily the one this run wants.
 *
 * ONE TOKEN, not two. A tool that answers questions across several accounts needs to pick one per
 * call; ayin operates on the repo in front of it, so a second stored identity would only be a second
 * thing to pick wrong. If a run needs a different account, point `GITHUB_TOKEN` at it.
 *
 * This module lives under `tools/` because the TOOL that writes it does, and `tools/` imports nothing
 * outside itself — core may depend on tools, never the reverse.
 */

import { execFileSync } from 'node:child_process';
import { credentialsPath, maskSecret, readEnvFile, writeEnvFile } from './envfile.js';

export const GITHUB_ENV_FILE = credentialsPath('github.env');

/** Where a token came from — reported to the operator, never guessed at in a message. */
export type GithubTokenSource = 'environment' | 'file' | 'gh-cli' | 'none';

let cliProbed = false;
let cliToken = '';

/**
 * `gh auth token`, at most once per process. Bounded and swallowed: the CLI may be absent, logged out,
 * or (on a wedged keyring) slow, and none of those are this function's problem to report.
 */
function ghCliToken(): string {
  if (cliProbed) return cliToken;
  cliProbed = true;
  try {
    cliToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    cliToken = '';
  }
  return cliToken;
}

/** Env → file → `gh auth token`. '' when nothing is configured. */
export function readGithubToken(): string {
  const fromEnv = (process.env.GITHUB_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  const fromFile = (readEnvFile(GITHUB_ENV_FILE).GITHUB_TOKEN ?? '').trim();
  if (fromFile) return fromFile;
  return ghCliToken();
}

/** Which of the three sources answered. Cheap — mirrors `readGithubToken`'s order exactly. */
export function githubTokenSource(): GithubTokenSource {
  if ((process.env.GITHUB_TOKEN ?? '').trim()) return 'environment';
  if ((readEnvFile(GITHUB_ENV_FILE).GITHUB_TOKEN ?? '').trim()) return 'file';
  if (ghCliToken()) return 'gh-cli';
  return 'none';
}

export function writeGithubToken(token: string): string {
  return writeEnvFile(
    GITHUB_ENV_FILE,
    [
      'ayin — GitHub personal access token. chmod 0600; never commit this file.',
      'Fine-grained PAT needs: Contents read, Pull requests read+write, Metadata read.',
    ],
    [['GITHUB_TOKEN', token]],
  );
}

/**
 * Verify a token against GitHub and report who it belongs to.
 *
 * A PAT that is merely PRESENT is worth nothing — the failure mode this exists to prevent is a stored
 * token that 401s later, in the middle of something, with an error the operator attributes to the code
 * rather than to the credential. So: one call, and the login it names is the confirmation.
 */
export async function verifyGithubToken(token: string): Promise<{ ok: boolean; login: string; error: string; scopes: string }> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ayin',
      },
      signal: AbortSignal.timeout(15_000),
    });
    const scopes = res.headers.get('x-oauth-scopes') ?? '';
    if (!res.ok) {
      const body = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        msg = (JSON.parse(body) as { message?: string }).message ?? msg;
      } catch { /* raw */ }
      return { ok: false, login: '', error: msg, scopes };
    }
    const me = (await res.json()) as { login?: string };
    return { ok: true, login: String(me.login ?? ''), error: '', scopes };
  } catch (e) {
    return { ok: false, login: '', error: e instanceof Error ? e.message : String(e), scopes: '' };
  }
}

/**
 * THE message an operator sees when nothing is configured. One string, because it is shown from more
 * than one place and drifting copies are how a setup step becomes folklore. Names both the env var and
 * the file — whichever the reader prefers — and warns about the CLI fallback's ambiguous ownership.
 */
export function noTokenMessage(): string {
  return 'No GitHub token. Set one by either:\n'
    + `  · writing GITHUB_TOKEN=ghp_… into ${GITHUB_ENV_FILE}\n`
    + '  · exporting GITHUB_TOKEN in the environment\n'
    + 'Create one at https://github.com/settings/tokens — a fine-grained PAT needs\n'
    + 'Contents: read, Pull requests: read+write, Metadata: read.\n'
    + 'A logged-in `gh` CLI is used as a last resort, but its token belongs to whichever\n'
    + 'account someone logged in as — set one of the two above to be sure which it is.';
}

/** One line for a human: whether a token exists and where it came from. Never any token bytes. */
export function githubSummary(): string {
  const token = readGithubToken();
  if (!token) return 'GitHub: no token configured.';
  const source = githubTokenSource();
  const where = source === 'environment' ? 'GITHUB_TOKEN (environment)' : source === 'file' ? GITHUB_ENV_FILE : '`gh auth token`';
  return `GitHub: ${maskSecret(token)} from ${where}`;
}
