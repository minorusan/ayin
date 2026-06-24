/**
 * Session Summary — rolling context that survives compaction.
 *
 * Updated after every user input + response cycle.
 * The LLM sees previous summary + last exchange and produces an updated one.
 *
 * Structure:
 *   summary: string     — gradually growing narrative
 *   files: string[]     — files created/changed (populated later)
 *   recent: Message[]   — last 5 messages (raw, not summarized)
 */

import { llmCall } from './llm.js';
import { getPrompt, getConfig } from './prompts.js';
import { log } from './log.js';

export interface SessionSummary {
  summary: string;
  files: { created: string[]; changed: string[] };
  recent: Array<{ role: string; content: string }>;
}

function getMaxRecent(): number { return getConfig('summaryRecentMessages', 5); }

let current: SessionSummary = {
  summary: '',
  files: { created: [], changed: [] },
  recent: [],
};

let updating = false;

export function getSummary(): SessionSummary {
  return current;
}

export function getSummaryText(): string {
  const parts: string[] = [];

  if (current.summary) {
    parts.push(current.summary);
  } else {
    parts.push('(no summary yet)');
  }

  if (current.files.created.length > 0) {
    parts.push('');
    parts.push(`Files created: ${current.files.created.join(', ')}`);
  }
  if (current.files.changed.length > 0) {
    parts.push(`Files changed: ${current.files.changed.join(', ')}`);
  }

  if (current.recent.length > 0) {
    parts.push('');
    parts.push('Recent messages:');
    for (const msg of current.recent) {
      const prefix = msg.role === 'user' ? '>' : ' ';
      parts.push(`  ${prefix} ${msg.content}`);
    }
  }

  return parts.join('\n');
}

/**
 * Push a message into the recent buffer and trigger summary update.
 * Call this after every user message AND after every assistant response.
 */
export function pushMessage(role: string, content: string): void {
  current.recent.push({ role, content });
  if (current.recent.length > getMaxRecent()) {
    current.recent.shift();
  }
}

/**
 * Run the summarizer — takes the current summary + last exchange
 * and produces an updated summary. Fire-and-forget, non-blocking.
 */
export async function updateSummary(goal = ''): Promise<void> {
  if (updating) return; // don't stack
  updating = true;

  try {
    // Find the last user+assistant pair in recent
    const recentText = current.recent
      .map(m => `${m.role}: ${m.content.substring(0, 300)}`)
      .join('\n');

    if (!recentText) { updating = false; return; }

    const prompt = getPrompt('summarizer', {
      CURRENT_SUMMARY: current.summary || '(session just started)',
      RECENT_EXCHANGE: recentText,
      MAX_WORDS: String(getConfig('summaryMaxWords', 200)),
      CURRENT_GOAL: goal || '(not set)',
    });
    const newSummary = await llmCall(prompt);

    if (newSummary && newSummary.length > 10) {
      current.summary = newSummary.trim();
      log('DEBUG', 'summary_updated', { length: String(current.summary.length), summary: current.summary });
    }
  } catch {
    // LLM unavailable — summary stays as-is
  }

  updating = false;
}

export function resetSummary(): void {
  current = {
    summary: '',
    files: { created: [], changed: [] },
    recent: [],
  };
}
