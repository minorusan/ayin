/**
 * claude-stop-farm.mjs — a Claude Code **Stop hook** (user-level) that farms transcripts for the
 * episodic RAG. On every stop it drops ONE marker into the ayin-watch queue:
 *   {kind:"mine", transcript:<path>, cwd:<dir>, session:<id>, ts:<epoch>}
 * The always-on `ayin watch` daemon drains it and mines that session into git-verified episodes.
 *
 * Like the post-commit hook: never blocks, never does the work here — just enqueues. Skips its own
 * recursion (the hound's `-p` runs set PREMORTEM_HOUND / AYIN_READONLY), stop-hook continuations,
 * and non-git-repo cwds (nothing to verify there). Reads the hook JSON on stdin (fd 0).
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

try {
  // Recursion / automation guards — don't farm our own agent runs.
  if (process.env.PREMORTEM_HOUND || process.env.AYIN_READONLY) process.exit(0);

  let raw = '';
  try { raw = readFileSync(0, 'utf-8'); } catch { /* no stdin */ }
  const o = JSON.parse(raw || '{}');
  if (o.stop_hook_active) process.exit(0);           // already in a stop-triggered continuation
  const cwd = o.cwd || process.cwd();
  const transcript = o.transcript_path || '';
  const session = o.session_id || '';
  if (!transcript) process.exit(0);

  // Only farm git repos — episodes are verified against git; a non-repo has nothing to verify.
  try { execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); }
  catch { process.exit(0); }

  const dir = join(homedir(), '.ayin-cli', 'watch');
  mkdirSync(dir, { recursive: true });
  const marker = { kind: 'mine', transcript, cwd, session, ts: Date.now(), repo: cwd, commit: '' };
  appendFileSync(join(dir, 'queue.jsonl'), JSON.stringify(marker) + '\n');
} catch {
  /* never break the user's stop */
}
process.exit(0);
