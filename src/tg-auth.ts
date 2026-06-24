/**
 * Telegram MTProto authentication flow.
 * Prompts for API credentials and phone number interactively,
 * then saves the session string to ~/.egregor/telegram.session
 * so TelegramTipharetTool (in Hesed/Tiferet) can reuse it.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createInterface } from 'readline';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export const TELEGRAM_SESSION_PATH = join(homedir(), '.egregor', 'telegram.session');

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

export async function runTgAuth(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  process.stdout.write('\n=== Telegram MTProto Authentication ===\n');
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
    process.stdout.write('You can now use "search in telegram" commands via Egregor.\n');
  } finally {
    await client.disconnect().catch(() => {});
    rl.close();
  }
}
