/**
 * Rules — project-specific and flag-provided instructions prepended to every prompt.
 *
 * Sources (in order, combined):
 *   1. AYIN.md in the current working directory (auto-loaded at startup)
 *   2. --rules "..." CLI flag
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';

let rules = '';

export function loadRules(cwd: string): void {
  const parts: string[] = [];

  // 1. AYIN.md in CWD
  const ayinMd = join(cwd, 'AYIN.md');
  if (existsSync(ayinMd)) {
    try {
      const content = readFileSync(ayinMd, 'utf-8').trim();
      if (content) {
        parts.push(content);
        log('INFO', 'rules_loaded', { source: ayinMd, length: String(content.length) });
      }
    } catch {
      log('WARN', 'rules_load_failed', { source: ayinMd });
    }
  }

  // 2. --rules flag
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rules' && args[i + 1]) {
      parts.push(args[i + 1]);
      break;
    }
    if (args[i].startsWith('--rules=')) {
      parts.push(args[i].slice('--rules='.length));
      break;
    }
  }

  rules = parts.join('\n\n').trim();
}

export function getRules(): string {
  return rules;
}
