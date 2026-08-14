/**
 * The OpenAI API key — where it lives, and how it is read.
 *
 * OpenAI is the provider a fresh clone can actually use: it needs no GPU, no local runtime, no model
 * download. That makes the key the single thing standing between "cloned" and "working", so it gets a
 * file of its own, a command that sets it, and an error message that names both.
 *
 * PRECEDENCE. Environment first — a CI job or a container passes `OPENAI_API_KEY` and must not have to
 * write a file. Then `~/.ayin-cli/openai.env`, which is what `/openai` writes.
 *
 * This module lives under `tools/` because the TOOL that writes it does, and `tools/` imports nothing
 * outside itself. The provider (core) reads it from here — core may depend on tools, never the reverse.
 */

import { credentialsPath, maskSecret, readEnvFile, writeEnvFile } from './envfile.js';

export const OPENAI_ENV_FILE = credentialsPath('openai.env');

// No default model lives here. The PROVIDER owns that judgement (`providers/openai.ts` DEFAULT_MODEL,
// with its reasoning about the current lineup and what each tier costs); a second copy in the credential
// layer would be a silently-competing default that only shows up on someone else's bill.

export interface OpenAiCredentials {
  key: string;
  /** '' means "use the default" — stored only when the operator asked for a specific model. */
  model: string;
}

/** Env wins, then the file. '' when nothing is configured. */
export function readOpenAiKey(): string {
  const fromEnv = (process.env.OPENAI_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  return (readEnvFile(OPENAI_ENV_FILE).OPENAI_API_KEY ?? '').trim();
}

/** The operator's chosen model, or '' to let the caller apply its default. */
export function readOpenAiModel(): string {
  const fromEnv = (process.env.OPENAI_MODEL ?? '').trim();
  if (fromEnv) return fromEnv;
  return (readEnvFile(OPENAI_ENV_FILE).OPENAI_MODEL ?? '').trim();
}

export function writeOpenAiCredentials(c: OpenAiCredentials): string {
  return writeEnvFile(
    OPENAI_ENV_FILE,
    ['ayin — OpenAI credentials. chmod 0600; never commit this file.', 'Set with /openai <key>. Calls made with this key are billed to its owner.'],
    [['OPENAI_API_KEY', c.key], ['OPENAI_MODEL', c.model]],
  );
}

/**
 * THE message an operator sees when nothing is configured.
 *
 * Exported as one string because it is shown from three places — the provider on a generate, the status
 * line, and `/model openai` — and three drifting versions of "how do I set this up" is how a setup step
 * becomes folklore. Names the command, the env var, and the file: whichever the reader prefers.
 */
export function noKeyMessage(): string {
  return 'No OpenAI key. Set one with:\n'
    + '  /openai sk-…                    (verified against OpenAI, then saved)\n'
    + `Or export OPENAI_API_KEY, or put OPENAI_API_KEY=sk-… in ${OPENAI_ENV_FILE}.\n`
    + 'Get a key at https://platform.openai.com/api-keys — calls are billed to that account.';
}

/** One line for a human: whether a key exists, where it came from, and which model. No key bytes. */
export function openAiSummary(): string {
  const key = readOpenAiKey();
  if (!key) return 'OpenAI: no key configured.';
  const source = (process.env.OPENAI_API_KEY ?? '').trim() ? 'OPENAI_API_KEY (environment)' : OPENAI_ENV_FILE;
  return `OpenAI: ${maskSecret(key)} from ${source} · model ${readOpenAiModel() || '(provider default)'}`;
}
