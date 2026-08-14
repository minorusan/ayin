/**
 * `KEY=value` credential files under the operator's config dir — one shape, one set of guarantees.
 *
 * Every secret ayin stores gets the same three properties, and they are here rather than in each
 * caller because a guarantee re-implemented per credential is a guarantee that diverges: one file ends
 * up 0644, or written non-atomically, and nobody notices until it matters.
 *
 *   0600            the operator's own file, never group- or world-readable
 *   ATOMIC          temp + rename, so an interrupted write cannot leave a truncated secret — which
 *                   fails later as an authentication error nobody attributes to the writer
 *   QUOTE-TOLERANT  a value pasted from a password manager often arrives wrapped in quotes, and a
 *                   token with a stray quote in it fails as a 401 that explains nothing
 *
 * Not a dotenv library: no interpolation, no export statements, no multiline values. A credential file
 * that supports a syntax has a syntax to get wrong.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Where ayin keeps operator credentials. One directory, so `ls` answers "what does it know about me". */
export function credentialsPath(name: string): string {
  return join(homedir(), '.ayin-cli', name);
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Parsed file, or `{}` when absent or unreadable. Never throws: a missing credential is not an error. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseEnv(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write `KEY=value` lines, 0600, atomically. `comments` go at the top, each prefixed with `# `.
 * Entries with an empty value are omitted — an empty `KEY=` reads as configured-but-blank.
 */
export function writeEnvFile(path: string, comments: string[], entries: Array<[string, string]>): string {
  mkdirSync(dirname(path), { recursive: true });
  const body = [
    ...comments.map((c) => `# ${c}`),
    ...entries.filter(([, v]) => v).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(tmp, 0o600); // explicit: writeFileSync's mode is subject to umask on some platforms
  renameSync(tmp, path);
  return path;
}

/** `sk-abc…wxyz` — enough to tell two keys apart, never enough to use one. */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return '…';
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}
