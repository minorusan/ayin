import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { charsPerToken } from './llm/manager.js';
import { log } from './log.js';

const TOKENIZER_DIR = join(homedir(), '.ayin-cli', 'tokenizer');

let tokenizer: Tokenizer | null | undefined;

function load(): Tokenizer | null {
  if (tokenizer !== undefined) return tokenizer;
  const json = join(TOKENIZER_DIR, 'tokenizer.json');
  const config = join(TOKENIZER_DIR, 'tokenizer_config.json');
  if (!existsSync(json)) {
    tokenizer = null;
    log('INFO', 'tokenizer_absent', { dir: TOKENIZER_DIR });
    return null;
  }
  const t0 = performance.now();
  try {
    tokenizer = new Tokenizer(
      JSON.parse(readFileSync(json, 'utf8')),
      existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {},
    );
    log('INFO', 'tokenizer_loaded', { dir: TOKENIZER_DIR, ms: (performance.now() - t0).toFixed(0) });
  } catch (e) {
    tokenizer = null;
    log('WARN', 'tokenizer_failed', { dir: TOKENIZER_DIR, error: e instanceof Error ? e.message : String(e) });
  }
  return tokenizer;
}

export function tokenCount(text: string): number {
  const t = load();
  if (!t) return Math.ceil(text.length / charsPerToken());
  return t.encode(text, { add_special_tokens: false }).ids.length;
}

export function tokenizerLoaded(): boolean {
  return load() !== null;
}
