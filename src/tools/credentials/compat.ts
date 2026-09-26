/**
 * credentials/compat.ts — one key store for every OpenAI-COMPATIBLE vendor.
 *
 * `openai.ts` beside this file is the same thing written once for one vendor, and it stays as it is:
 * it has a command, a setup message and a gate that all name OpenAI specifically. This is its shape
 * generalised, for the vendors added since — DeepSeek and whatever follows.
 *
 * WHY NOT ONE FILE FOR ALL OF THEM. A credential file per vendor means a leaked or rotated key is one
 * file, `chmod 0600` is per vendor, and deleting one does not disturb another. `~/.ayin-cli/` holds
 * `openai.env` and `deepseek.env` side by side, which is also what an operator expects to find.
 *
 * THE VENDOR TABLE IS NOT IMPORTED HERE. `tools/` imports nothing outside `tools/`, and the table is
 * core (`llm/vendors.ts`). So this module takes the names it needs as arguments and core supplies
 * them — the same bargain every other seam in `tools/` makes.
 */

import { credentialsPath, readEnvFile, writeEnvFile } from './envfile.js';

/** `~/.ayin-cli/deepseek.env`. One file per vendor — see the header. */
export function vendorEnvFile(vendorId: string): string {
  return credentialsPath(`${vendorId}.env`);
}

/** Env wins, then the file. '' when nothing is configured. */
export function readVendorKey(vendorId: string, envKey: string): string {
  const fromEnv = (process.env[envKey] ?? '').trim();
  if (fromEnv) return fromEnv;
  return (readEnvFile(vendorEnvFile(vendorId))[envKey] ?? '').trim();
}

/** The operator's chosen model, or '' to let the caller apply its default. */
export function readVendorModel(vendorId: string, envModel: string): string {
  const fromEnv = (process.env[envModel] ?? '').trim();
  if (fromEnv) return fromEnv;
  return (readEnvFile(vendorEnvFile(vendorId))[envModel] ?? '').trim();
}

export function writeVendorCredentials(
  vendorId: string, label: string, envKey: string, envModel: string,
  c: { key: string; model: string },
): string {
  return writeEnvFile(
    vendorEnvFile(vendorId),
    [
      `ayin — ${label} credentials. chmod 0600; never commit this file.`,
      `Set with /${vendorId} <key>. Calls made with this key are billed to its owner.`,
    ],
    [[envKey, c.key], [envModel, c.model]],
  );
}

/**
 * Persist ONLY the model, leaving the stored key exactly as it was.
 *
 * THE KEY IS READ FROM THE FILE, NOT FROM `readVendorKey`, and the difference is a secret leak: that
 * function prefers the ENVIRONMENT, and a key deliberately supplied by a CI job or a shell export
 * belongs to someone who chose not to put it on disk. Round-tripping it through here would write it
 * out the first time anybody changed model, and nothing would say so. Carried over verbatim from
 * `writeOpenAiModel`, which learned it first.
 */
export function writeVendorModel(
  vendorId: string, label: string, envKey: string, envModel: string, model: string,
): string {
  const stored = (readEnvFile(vendorEnvFile(vendorId))[envKey] ?? '').trim();
  return writeVendorCredentials(vendorId, label, envKey, envModel, { key: stored, model: model.trim() });
}
