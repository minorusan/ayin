/**
 * Session record — a deterministic, append-only log of one ayin run.
 *
 * Everything that happens in a run (the user's prompts, every tool call + its result,
 * and each final answer) is appended as one JSON object per line to
 * `~/.ayin-cli/sessions/<sessionId>.jsonl`. Append-only + flushed per event so a power
 * cut mid-run leaves a truthful partial record on disk — never an in-memory-only trail.
 *
 * This is the CONSOLIDATED per-session artifact. It complements (does not replace)
 * `artifacts.ts`, which stores each tool's FULL output as its own file for the Ctrl+O
 * browser; here we keep a compact, ordered, greppable transcript of the whole run.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSessionId } from './tiferet-session.js';

const SESSIONS_DIR = join(homedir(), '.ayin-cli', 'sessions');
const MAX_FIELD = 4000; // cap large tool results / answers so the log stays browsable
const MAX_READBACK = 2 * 1024 * 1024; // never slurp a whole long session — read the tail

type Event =
  | { kind: 'prompt'; text: string }
  | { kind: 'tool'; tool: string; params: string; result: string; backgrounded?: boolean }
  | { kind: 'answer'; text: string }
  | { kind: 'qa'; verdict: string; pass: number; summary: string; issues: number };

function record(ev: Event): void {
  try {
    const sessionId = getSessionId();
    if (!sessionId) return; // no session established yet — nothing to key on
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), sessionId, cwd: process.cwd(), ...ev }) + '\n';
    appendFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), line);
  } catch {
    /* recording must never break the agent — best-effort only */
  }
}

const clip = (s: string): string => (s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + `…(+${s.length - MAX_FIELD} chars)` : s);

/** A user prompt that kicked off a turn. */
export function recordPrompt(text: string): void {
  record({ kind: 'prompt', text });
}

/** One tool call and (a clip of) its result. write_file/str_replace calls here ARE the change record. */
export function recordTool(tool: string, params: string, result: string, backgrounded = false): void {
  record({ kind: 'tool', tool, params, result: clip(result), backgrounded });
}

/** The assistant's final text for a round. */
export function recordAnswer(text: string): void {
  record({ kind: 'answer', text: clip(text) });
}

/** One QA gate verdict — kept in the same record so a run's quality history is greppable. */
export function recordQa(verdict: string, pass: number, summary: string, issues: number): void {
  record({ kind: 'qa', verdict, pass, summary: clip(summary), issues });
}

/** Path of the current run's record file, or null if no session is established. */
export function sessionRecordPath(): string | null {
  const sessionId = getSessionId();
  return sessionId ? join(SESSIONS_DIR, `${sessionId}.jsonl`) : null;
}

/**
 * The last `limit` user prompts of this session, oldest first.
 *
 * The record on disk is the source — not an in-memory list — so this still answers correctly after
 * a `/resume` or a restart, which is exactly when "what did the user actually ask for?" matters.
 * The module that writes the format reads it; nobody else parses these lines.
 */
export function recentPrompts(limit = 12): string[] {
  const path = sessionRecordPath();
  if (!path) return [];
  try {
    const size = statSync(path).size;
    let text = readFileSync(path, 'utf-8');
    if (size > MAX_READBACK) text = text.slice(-MAX_READBACK); // tail only; a torn first line is dropped below
    const prompts: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('{') || !line.includes('"kind":"prompt"')) continue;
      try {
        const ev = JSON.parse(line) as { kind?: string; text?: string };
        if (ev.kind === 'prompt' && typeof ev.text === 'string' && ev.text.trim()) prompts.push(ev.text.trim());
      } catch { /* torn line — skip it */ }
    }
    return prompts.slice(-limit);
  } catch {
    return [];
  }
}
