/**
 * Telegram MTProto authentication flow.
 * Prompts for API credentials and phone number interactively, then saves the session string to
 * `~/.ayin-cli/telegram.session` — ayin's own state directory, beside its config, sessions and logs,
 * so nothing about this depends on a directory some other program owns.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createInterface } from 'readline';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export const TELEGRAM_SESSION_PATH = join(homedir(), '.ayin-cli', 'telegram.session');

/**
 * The path this file lived at before 1.0.211, when ayin still borrowed another project's state
 * directory. Kept for ONE purpose: moving an existing session across, so nobody has to re-authenticate
 * because a path was tidied up. Delete this once no install can still be on ≤1.0.210.
 */
const LEGACY_SESSION_PATH = join(homedir(), '.egregor', 'telegram.session');

/**
 * Move a pre-1.0.211 session file into ayin's own directory. Called before any read of the session, so
 * a legacy install keeps working with no human in the loop. Best-effort by design: if the move fails
 * (permissions, the old dir is read-only), the flow simply falls through to a fresh interactive auth
 * rather than crashing on housekeeping.
 */
export function migrateLegacySession(): void {
  try {
    if (existsSync(TELEGRAM_SESSION_PATH) || !existsSync(LEGACY_SESSION_PATH)) return;
    mkdirSync(dirname(TELEGRAM_SESSION_PATH), { recursive: true });
    renameSync(LEGACY_SESSION_PATH, TELEGRAM_SESSION_PATH);
  } catch {
    /* fall through to interactive auth */
  }
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

export async function runTgAuth(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  migrateLegacySession(); // adopt a pre-1.0.211 session before deciding anything is missing

  process.stdout.write('\n=== Telegram MTProto Authentication ===\n');
  if (existsSync(TELEGRAM_SESSION_PATH)) {
    process.stdout.write(`A session already exists at ${TELEGRAM_SESSION_PATH} — finishing this will overwrite it.\n`);
  }
  process.stdout.write('Get your API credentials at https://my.telegram.org/apps\n\n');

  const apiIdStr = await ask(rl, 'API ID: ');
  const apiHash = await ask(rl, 'API Hash: ');
  const apiId = parseInt(apiIdStr, 10);

  if (isNaN(apiId) || apiId <= 0 || !apiHash) {
    process.stdout.write('Error: invalid API ID or Hash.\n');
    rl.close();
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(''),
    apiId,
    apiHash,
    { connectionRetries: 3 },
  );

  try {
    await client.start({
      phoneNumber: async () => {
        return ask(rl, 'Phone number (e.g. +79991234567): ');
      },
      password: async () => {
        return ask(rl, '2FA password (press Enter if none): ');
      },
      phoneCode: async () => {
        return ask(rl, 'Verification code from Telegram: ');
      },
      onError: (err) => {
        process.stdout.write(`Auth error: ${err.message}\n`);
      },
    });

    const sessionString = (client.session.save() as unknown) as string;

    mkdirSync(dirname(TELEGRAM_SESSION_PATH), { recursive: true });
    writeFileSync(
      TELEGRAM_SESSION_PATH,
      JSON.stringify({ apiId, apiHash, sessionString }, null, 2),
      'utf-8',
    );

    process.stdout.write(`\nAuthenticated successfully!\nSession saved to: ${TELEGRAM_SESSION_PATH}\n\n`);
    process.stdout.write('You can now use "search in telegram" commands.\n');
  } finally {
    await client.disconnect().catch(() => {});
    rl.close();
  }
}
