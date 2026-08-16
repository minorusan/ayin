/**
 * debug-bundle.ts — `/debug <dir>` and `ayin debug <dir>`.
 *
 * Everything needed to work out what a session actually did, in one directory someone else can read.
 *
 * WHY THIS EXISTS. Diagnosing a run has meant the operator pasting fragments of terminal into a chat
 * and the reader guessing from them — which, over one long day, produced three wrong diagnoses in a
 * row before the real cause turned up in a number nobody had pasted. The evidence exists; it is just
 * scattered across four files with unguessable names, in a home directory nothing else can reach.
 *
 * SECRETS ARE STRIPPED, and that is not a nicety. This bundle is written to a directory chosen so
 * that something ELSE can read it — a beacon, a shared folder, an attachment. A stored OpenAI key
 * lives one JSON key away from the settings this dumps, and a debug bundle that leaks one is worse
 * than no debug bundle: it does harm the operator cannot see, in a file they were told was for help.
 * Anything key-shaped is redacted by NAME, not by pattern, so a new secret setting is redacted the
 * day it is added rather than the day someone notices.
 *
 * BOUNDED. A session record reaches megabytes and a log grows all day; both are tailed. A bundle
 * nobody can open is a bundle nobody reads.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentLogFile } from './log.js';
import { getPromptsFile } from './prompts.js';
import { sessionRecordPath } from './session-record.js';
import { longOperations, turnTimings } from './timing.js';

/** Tail size for anything that grows without bound. */
const TAIL_BYTES = 512 * 1024;

/**
 * Config keys whose VALUE must never leave the machine, by name.
 *
 * By name rather than by pattern: a regex for "looks like a key" fails open on the one that does not
 * look like one, and this is the failure that costs the operator something real.
 */
const SECRET_KEYS = new Set(['openaikey', 'apikey', 'token', 'password', 'secret', 'jiratoken', 'sentrytoken']);

function redactConfig(raw: string): string {
  try {
    const data = JSON.parse(raw) as { config?: Record<string, unknown> };
    const cfg = data.config ?? {};
    for (const k of Object.keys(cfg)) {
      if (SECRET_KEYS.has(k.toLowerCase()) || /key|token|secret|password/i.test(k)) {
        cfg[k] = `[redacted — ${String(cfg[k]).length} chars]`;
      }
    }
    return JSON.stringify({ config: cfg }, null, 2);
  } catch {
    return '{"error":"config unreadable — nothing copied rather than copying it blind"}';
  }
}

/** The last `TAIL_BYTES` of a file, or '' when there is nothing to read. */
function tail(path: string | null): string {
  if (!path || !existsSync(path)) return '';
  try {
    const size = statSync(path).size;
    const text = readFileSync(path, 'utf-8');
    return size > TAIL_BYTES ? `…(${size - TAIL_BYTES} earlier bytes omitted)\n${text.slice(-TAIL_BYTES)}` : text;
  } catch {
    return '';
  }
}

export interface BundleFacts {
  version: string;
  provider: string;
  model: string;
  dialect: string;
  contextTokens: number;
  cwd: string;
  sessionId: string | null;
}

export interface BundleResult {
  dir: string;
  files: string[];
  bytes: number;
  omitted: string[];
}

/**
 * Write the bundle. `dir` is the operator's choice — the whole point is putting it somewhere another
 * machine can read, and this module must not guess where that is on their setup.
 */
export function writeDebugBundle(dir: string, facts: BundleFacts): BundleResult {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const out = join(dir, `ayin-debug-${stamp}`);
  mkdirSync(out, { recursive: true });
  const files: string[] = [];
  const omitted: string[] = [];

  const put = (name: string, body: string): void => {
    if (!body) { omitted.push(name); return; }
    writeFileSync(join(out, name), body, 'utf-8');
    files.push(name);
  };

  put('manifest.json', JSON.stringify({
    ...facts,
    collectedAt: new Date().toISOString(),
    platform: `${platform()} ${release()}`,
    node: process.version,
    argv: process.argv.slice(1),
    // The environment ayin actually resolved from, names only — a value here could be an endpoint,
    // a path or a key, and which is which depends on the operator's shell.
    ayinEnvNames: Object.keys(process.env).filter((k) => k.startsWith('AYIN_') || k === 'OPENAI_API_KEY'),
  }, null, 2) + '\n');

  put('timings.json', JSON.stringify({
    thisTurn: turnTimings(),
    longOperations: longOperations(),
  }, null, 2) + '\n');

  put('session.jsonl', tail(sessionRecordPath()));
  put('log.txt', tail(currentLogFile()));

  const promptsFile = getPromptsFile();
  if (existsSync(promptsFile)) put('config.json', redactConfig(readFileSync(promptsFile, 'utf-8')));
  else omitted.push('config.json');

  put('README.md', [
    `# ayin debug bundle`,
    ``,
    `Collected ${new Date().toISOString()} from ayin ${facts.version}.`,
    ``,
    `| file | what it is |`,
    `|---|---|`,
    `| manifest.json | version, provider, model, dialect, context size, platform |`,
    `| timings.json | this turn's phases, and every [LONG OPERATION] this process saw |`,
    `| session.jsonl | prompts, tool calls and answers, newest last (tailed) |`,
    `| log.txt | the process log (tailed) |`,
    `| config.json | settings, **with every key-shaped value redacted** |`,
    ``,
    `## What is deliberately NOT here`,
    ``,
    `- **Secrets.** Any setting whose name looks like a key, token, secret or password is replaced`,
    `  with its length. This bundle is written to be READ BY SOMETHING ELSE, so a leaked key here`,
    `  would do harm the operator cannot see, in a file they were told was for help.`,
    `- **Full tool output.** Artifacts are per-run files of their own; the session record carries a`,
    `  clipped preview of each, which is what a diagnosis needs.`,
    `- **Earlier bytes** of anything long. Both the record and the log are tailed at ${Math.round(TAIL_BYTES / 1024)} KB;`,
    `  a bundle nobody can open is a bundle nobody reads.`,
    ``,
    omitted.length ? `Not written this time (nothing to write): ${omitted.join(', ')}.` : '',
  ].join('\n'));

  const bytes = files.reduce((n, f) => {
    try { return n + statSync(join(out, f)).size; } catch { return n; }
  }, 0);
  return { dir: out, files, bytes, omitted };
}

/**
 * A default destination when the operator names none.
 *
 * The system temp directory, because it is the one place readable by a helper process without the
 * operator widening anything: a beacon ships with `/tmp` in its read roots and a home directory very
 * deliberately not. Naming a path is still better — this is the fallback, not the intent.
 */
export function defaultBundleDir(): string {
  // `/tmp` on POSIX, NOT `os.tmpdir()`.
  //
  // On macOS `os.tmpdir()` is a per-user `/var/folders/xx/…/T/` path, which is exactly the kind of
  // place a helper process cannot reach — a beacon ships with `/private/tmp` in its read roots and
  // nothing under `/var/folders`. The default therefore defeated the one thing this bundle is for:
  // being read by something else. `/tmp` is `/private/tmp` on macOS and readable on Linux.
  if (process.platform !== 'win32' && existsSync('/tmp')) return join('/tmp', 'ayin-debug');
  return join(tmpdir(), 'ayin-debug');
}

export function homeHint(): string {
  return homedir();
}
