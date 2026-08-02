import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSessionId } from './session-store.js';
import { log } from './log.js';

/**
 * FULL TRANSCRIPT — the debugging record, deliberately unabridged.
 *
 * The session record (`session-record.ts`) is the OPERATING log: it clips every field to 4000 chars
 * because it exists to answer "what happened, roughly" cheaply, forever, for every run. That clipping
 * is exactly wrong when the question is "why did it reason that way" — the answer usually lives in the
 * 12 KB of tool output the model actually read, which the operating log has thrown away.
 *
 * So this is a SECOND, opt-in record with the opposite trade-off: **nothing is clipped, ever.** Prompts,
 * every model response verbatim, every tool call with its full parameters AND its full result, the
 * final answer. Files are expected to be large; that is the point, and it is why it is off by default
 * and announced in the UI while it runs.
 *
 * TWO FILES, on purpose:
 *   `<id>.transcript.jsonl`  append-only, flushed per event — the DURABLE spine. A kill -9 mid-run
 *                            cannot cost you more than the event being written.
 *   `<id>.transcript.json`   a formatted (2-space) JSON document rebuilt from that spine — the thing
 *                            a human or another agent actually reads.
 *
 * The formatted file is rebuilt on a short debounce rather than on every event: a re-stringify of a
 * multi-megabyte transcript on each of hundreds of tool results would turn debugging into the thing
 * being debugged. It is always flushed on the final answer and on exit, and because the spine is
 * append-only the JSON can be rebuilt from it at any time (`rebuildFromSpine`) if a crash lands
 * between two debounces.
 *
 * Enable per session with `/transcribe` (interactive) or `AYIN_TRANSCRIBE=1` / `--transcribe`
 * (headless — the mode used when a task is enqueued, which is the case this was built for).
 */

const DIR = join(homedir(), '.ayin-cli', 'transcripts');
const FLUSH_DEBOUNCE_MS = 1500;

export type TranscriptEvent =
  | { kind: 'session'; ts: string; id: string; cwd: string; ayin: string; model: string | null }
  | { kind: 'prompt'; ts: string; text: string }
  | { kind: 'response'; ts: string; round: number; model: string | null; text: string; toolCalls: number }
  | { kind: 'tool'; ts: string; round: number; tool: string; params: Record<string, string>; result: string; ms: number; backgrounded?: boolean; blocked?: string }
  | { kind: 'answer'; ts: string; text: string }
  | { kind: 'note'; ts: string; label: string; text: string };

let active = false;
let events: TranscriptEvent[] = [];
let spinePath = '';
let jsonPath = '';
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

export function isTranscribing(): boolean {
  return active;
}

export function transcriptPath(): string {
  return jsonPath;
}

/** How big the transcript is right now — surfaced in the UI, because "big" is the whole trade. */
export function transcriptSize(): { events: number; bytes: number } {
  return { events: events.length, bytes: Buffer.byteLength(JSON.stringify(events)) };
}

/**
 * Turn it on for this session. Returns the path, or '' when there is no session id yet (a transcript
 * with no session to belong to would be an orphan file nobody can find again).
 */
export function startTranscript(meta: { cwd: string; ayin: string; model: string | null }): string {
  if (active) return jsonPath;
  const id = getSessionId();
  if (!id) return '';
  try {
    mkdirSync(DIR, { recursive: true });
    spinePath = join(DIR, `${id}.transcript.jsonl`);
    jsonPath = join(DIR, `${id}.transcript.json`);
    active = true;
    events = [];
    record({ kind: 'session', ts: new Date().toISOString(), id, cwd: meta.cwd, ayin: meta.ayin, model: meta.model });
    flush(); // the file must EXIST the moment the UI claims it does
    // `process.exit()` does NOT run `finally` blocks, and both headless exit paths call it — so the
    // last debounce window would be lost on exactly the unattended runs this exists for. An exit hook
    // is the only place that catches every path; `flush()` is writeFileSync, so it is safe here.
    process.once('exit', () => flush());
    log('INFO', 'transcript_started', { path: jsonPath });
    return jsonPath;
  } catch (e) {
    active = false;
    log('ERROR', 'transcript_start_failed', { error: e instanceof Error ? e.message : String(e) });
    return '';
  }
}

/** Stop recording and write the final formatted file. */
export function stopTranscript(): string {
  if (!active) return '';
  const path = jsonPath;
  flush();
  active = false;
  log('INFO', 'transcript_stopped', { path, events: String(events.length) });
  return path;
}

/**
 * Append one event. Never throws and never clips — a transcript that quietly drops the 200 KB tool
 * result is worse than no transcript, because you would trust it.
 */
function record(ev: TranscriptEvent): void {
  if (!active && ev.kind !== 'session') return;
  events.push(ev);
  dirty = true;
  try {
    appendFileSync(spinePath, `${JSON.stringify(ev)}\n`);
  } catch (e) {
    log('ERROR', 'transcript_append_failed', { error: e instanceof Error ? e.message : String(e) });
  }
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flush();
  }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref?.();
}

/** Rebuild the formatted document, atomically (temp + rename — never a half-written transcript). */
export function flush(): void {
  if (!dirty || !jsonPath) return;
  dirty = false;
  const doc = {
    ayin: events.find((e) => e.kind === 'session')?.kind === 'session' ? (events[0] as Extract<TranscriptEvent, { kind: 'session' }>).ayin : undefined,
    session: (events[0] as Extract<TranscriptEvent, { kind: 'session' }>)?.id,
    cwd: (events[0] as Extract<TranscriptEvent, { kind: 'session' }>)?.cwd,
    startedAt: events[0]?.ts,
    updatedAt: new Date().toISOString(),
    counts: {
      prompts: events.filter((e) => e.kind === 'prompt').length,
      responses: events.filter((e) => e.kind === 'response').length,
      tools: events.filter((e) => e.kind === 'tool').length,
      answers: events.filter((e) => e.kind === 'answer').length,
    },
    events,
  };
  try {
    const tmp = `${jsonPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    renameSync(tmp, jsonPath);
  } catch (e) {
    log('ERROR', 'transcript_flush_failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Rebuild the formatted document from the append-only spine — the crash path. The spine survives what
 * the debounce does not, so a transcript is never lost, only occasionally a rebuild behind.
 */
export function rebuildFromSpine(sessionId: string): string {
  const spine = join(DIR, `${sessionId}.transcript.jsonl`);
  const lines = readFileSync(spine, 'utf8').split('\n').filter((l) => l.trim());
  events = [];
  for (const l of lines) {
    try {
      events.push(JSON.parse(l) as TranscriptEvent);
    } catch {
      /* torn last line — a power cut mid-append; everything before it is intact */
    }
  }
  jsonPath = join(DIR, `${sessionId}.transcript.json`);
  dirty = true;
  flush();
  return jsonPath;
}

// ── the recording surface the agent loop calls ────────────────────────────────

export function transcribePrompt(text: string): void {
  record({ kind: 'prompt', ts: new Date().toISOString(), text });
}

export function transcribeResponse(round: number, model: string | null, text: string, toolCalls: number): void {
  record({ kind: 'response', ts: new Date().toISOString(), round, model, text, toolCalls });
}

export function transcribeTool(e: { round: number; tool: string; params: Record<string, string>; result: string; ms: number; backgrounded?: boolean; blocked?: string }): void {
  record({ kind: 'tool', ts: new Date().toISOString(), ...e });
}

export function transcribeAnswer(text: string): void {
  record({ kind: 'answer', ts: new Date().toISOString(), text });
  flush(); // an answer ends a turn — the file on disk should be complete at every natural pause
}

export function transcribeNote(label: string, text: string): void {
  record({ kind: 'note', ts: new Date().toISOString(), label, text });
}
