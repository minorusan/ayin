/**
 * Fixme tool — rewrites ayin's prompts to match a requested personality style.
 *
 * Calls the same local LLM (Keli/Qwen3) used by the agent.
 * Validates and deserializes the returned JSON before writing.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { llmChat } from './llm/manager.js';
import { log } from './log.js';

const PROMPTS_FILE = join(homedir(), '.ayin-cli', 'prompts.json');

export async function fixmeExecute(style: string): Promise<string> {
  style = style.trim();
  if (!style) return 'Error: style description required';

  if (!existsSync(PROMPTS_FILE)) return 'Error: prompts.json not found';
  const current = readFileSync(PROMPTS_FILE, 'utf-8');

  log('INFO', 'fixme_start', { style: style.slice(0, 80) });

  let raw: string;
  try {
    raw = await llmChat([
      {
        role: 'user',
        content: `You are editing the personality of an AI coding agent by rewriting its system prompts.

Style request: "${style}"

Current prompts.json:
${current}

Instructions:
- Rewrite the "content" fields of "system" and "summarizer" so the agent speaks and behaves in the requested style
- Keep ALL {{VARIABLE}} placeholders exactly as-is (e.g. {{WORKING_DIR}}, {{TOOLS}}, {{CURRENT_SUMMARY}}, {{RECENT_EXCHANGE}}, {{MAX_WORDS}})
- Keep all functional rules, tool descriptions, and behavioral instructions — only change the tone, voice, and personality
- Preserve the "config" section and all "description" fields exactly as-is
- Commit fully to the style — be creative and consistent

Return ONLY the raw JSON object. No markdown fences, no explanation, no preamble. Just the JSON.`,
      },
    ]);
  } catch (err) {
    return `Error: LLM call failed — ${err instanceof Error ? err.message : String(err)}`;
  }

  // Strip accidental markdown fences
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return `Error: LLM returned invalid JSON — ${e instanceof Error ? e.message : String(e)}\n\nRaw:\n${cleaned.slice(0, 400)}`;
  }

  writeFileSync(PROMPTS_FILE, JSON.stringify(parsed, null, 2), 'utf-8');
  log('INFO', 'fixme_applied', { style: style.slice(0, 80) });
  return `Done. Agent personality updated to: "${style}" ✓\n\nUse /reset to restore defaults.`;
}
