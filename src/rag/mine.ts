/**
 * Episodic RAG miner — turn a repo's Claude Code transcripts into git-verified problem→fix
 * EPISODES. Used two ways:
 *   - `ayin rag-mine --repo <path>`  — batch over all of a repo's transcripts (eyeball JSON).
 *   - the watch daemon (kind:"mine")  — incremental, one transcript per Claude Stop (auto-farm).
 *
 * Verify filter is the whole point (transcripts are full of confident-but-wrong turns): keep an
 * episode only if it VERIFIABLY worked. edit → a distinctive line it introduced survived to HEAD;
 * investigation → grounded (substantive conclusion + a file it examined still exists). Our own
 * automated sessions (hound / `-p` reviews) are filtered — indexing them is circular. Pure
 * deterministic git; no model, no GPU.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { appendEpisodes } from './store.js';

export interface Edit { file: string; kind: 'Edit' | 'Write' | 'MultiEdit'; snippet: string }
export interface Episode {
  session: string;
  ts: string;
  kind: 'edit' | 'investigation';
  request: string;
  narration: string;
  edits: Edit[];
  touched: string[];
  verified: boolean;
  verifiedFiles: string[];
}

function out(line: string): void { process.stdout.write(line + '\n'); }

export function git(repo: string, args: string[]): string {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return ''; }
}

/** Git toplevel for a dir, or '' if not a repo. */
export function gitTop(dir: string): string {
  return git(resolve(dir), ['rev-parse', '--show-toplevel']).trim();
}

function findTranscriptDir(repoAbs: string): string | null {
  const projects = resolve(homedir(), '.claude', 'projects');
  if (!existsSync(projects)) return null;
  const direct = resolve(projects, repoAbs.replace(/[/.]/g, '-'));
  if (existsSync(direct)) return direct;
  for (const name of readdirSync(projects)) {
    const dir = resolve(projects, name);
    let files: string[]; try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files.slice(0, 1)) {
      try { const first = readFileSync(resolve(dir, f), 'utf-8').split('\n').find(Boolean); if (first && JSON.parse(first).cwd === repoAbs) return dir; } catch { /* skip */ }
    }
  }
  return null;
}

/** Our own automated sessions (hound skeptic / -p reviews) — not human problem-solving. */
function looksAutomated(request: string): boolean {
  return /^You are a\b|blast-radius skeptic|VERDICT:\s*(CLEAR|ISSUES|RISKY|OK)|Review the following git|senior code reviewer/i.test(request);
}

/** Repo-relative path, symlink-robust: git canonicalizes the repo (e.g. /tmp → /private/tmp) so we
 *  canonicalize the file the same way, else the relative path escapes the repo on symlinked roots. */
function relToRepo(fileAbs: string, repo: string): string {
  if (!isAbsolute(fileAbs)) return fileAbs;
  let abs = fileAbs;
  try { abs = realpathSync(fileAbs); } catch { /* file may be deleted — fall back to the given path */ }
  return relative(repo, abs);
}

function distinctiveLine(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length >= 12);
  return lines.sort((a, b) => b.length - a.length)[0] || text.trim().slice(0, 80);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text').map(b => b.text || '').join('\n');
}

function editsOf(content: unknown, repo: string): Edit[] {
  if (!Array.isArray(content)) return [];
  const edits: Edit[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const blk = b as { type?: string; name?: string; input?: Record<string, unknown> };
    if (blk.type !== 'tool_use' || !blk.input) continue;
    const fileAbs = String(blk.input.file_path || blk.input.path || '');
    if (!fileAbs) continue;
    const file = relToRepo(fileAbs, repo);
    if (blk.name === 'Write') edits.push({ file, kind: 'Write', snippet: distinctiveLine(String(blk.input.content || '')) });
    else if (blk.name === 'Edit') edits.push({ file, kind: 'Edit', snippet: distinctiveLine(String(blk.input.new_string || '')) });
    else if (blk.name === 'MultiEdit' && Array.isArray(blk.input.edits)) edits.push({ file, kind: 'MultiEdit', snippet: distinctiveLine((blk.input.edits as Array<{ new_string?: string }>).map(e => e.new_string || '').join('\n')) });
  }
  return edits;
}

function touchedOf(content: unknown, repo: string): string[] {
  if (!Array.isArray(content)) return [];
  const files: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const blk = b as { type?: string; name?: string; input?: Record<string, unknown> };
    if (blk.type !== 'tool_use' || !blk.input || !['Read', 'Grep', 'Glob'].includes(blk.name || '')) continue;
    const p = String(blk.input.file_path || blk.input.path || '');
    if (p) files.push(relToRepo(p, repo));
  }
  return files;
}

/** Parse ONE transcript file into episodes (user request → narration + tool activity). */
export function segmentTranscript(file: string, repo: string): Episode[] {
  const episodes: Episode[] = [];
  let cur: Episode | null = null;
  const push = () => {
    if (cur) {
      cur.kind = cur.edits.length ? 'edit' : 'investigation';
      if (cur.edits.length || (cur.narration.length >= 200 && cur.touched.length > 0)) { cur.touched = [...new Set(cur.touched)]; episodes.push(cur); }
    }
    cur = null;
  };
  let text: string;
  try { text = readFileSync(file, 'utf-8'); } catch { return []; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: { message?: { role?: string; content?: unknown }; timestamp?: string; sessionId?: string };
    try { o = JSON.parse(line); } catch { continue; }
    const m = o.message; if (!m || !m.role) continue;
    if (m.role === 'user') {
      const t = textOf(m.content).trim();
      if (t && !t.startsWith('<') && !looksAutomated(t)) {
        push();
        cur = { session: o.sessionId || basename(file, '.jsonl'), ts: o.timestamp || '', kind: 'investigation', request: t.slice(0, 600), narration: '', edits: [], touched: [], verified: false, verifiedFiles: [] };
      }
    } else if (m.role === 'assistant' && cur) {
      const t = textOf(m.content).trim();
      if (t) cur.narration = (cur.narration ? cur.narration + '\n' : '') + t;
      cur.edits.push(...editsOf(m.content, repo));
      cur.touched.push(...touchedOf(m.content, repo));
    }
  }
  push();
  return episodes;
}

function survives(repo: string, edit: Edit): boolean {
  if (edit.file.startsWith('..')) return false;
  const head = git(repo, ['show', `HEAD:${edit.file}`]);
  return !!head && edit.snippet.length >= 12 && head.includes(edit.snippet);
}

/** Mark each episode verified: edit → change survived to HEAD; investigation → grounded + present.
 *  Caps narration for storage. Returns only the verified ones. */
export function verifyEpisodes(repo: string, eps: Episode[]): Episode[] {
  for (const ep of eps) {
    const vfiles = new Set<string>();
    if (ep.kind === 'edit') { for (const e of ep.edits) if (survives(repo, e)) vfiles.add(e.file); }
    else { for (const f of ep.touched) if (!f.startsWith('..') && existsSync(resolve(repo, f))) vfiles.add(f); }
    ep.verifiedFiles = [...vfiles];
    ep.verified = vfiles.size > 0;
    ep.narration = ep.narration.slice(0, 1500);
  }
  return eps.filter(e => e.verified);
}

export async function runRagMine(args: string[]): Promise<void> {
  const repoArg = args[args.indexOf('--repo') + 1];
  if (!args.includes('--repo') || !repoArg) { process.stderr.write('usage: ayin rag-mine --repo <path> [--limit N]\n'); process.exit(1); }
  const repo = gitTop(repoArg);
  if (!repo) { process.stderr.write(`not a git repo: ${repoArg}\n`); process.exit(1); }
  const dir = findTranscriptDir(repo);
  if (!dir) { process.stderr.write(`no Claude transcripts found for ${repo} under ~/.claude/projects\n`); process.exit(1); }

  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => resolve(dir, f));
  out(`mining ${files.length} transcript(s) for ${repo}`);
  const all = files.flatMap(f => segmentTranscript(f, repo));
  const kept = verifyEpisodes(repo, all);
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 0;
  const r = await appendEpisodes(repo, limit > 0 ? kept.slice(0, limit) : kept);

  const nEdit = kept.filter(e => e.kind === 'edit').length;
  out(`episodes: ${all.length} found · ${kept.length} verified (${nEdit} edit, ${kept.length - nEdit} investigation) · ${all.length - kept.length} dropped`);
  out(`→ +${r.added} new (${r.total} total) on the ${r.where === 'backend' ? 'backend (maradel, central)' : 'LOCAL fallback — backend unreachable'}`);
  for (const ep of kept.slice(0, 4)) { out(`\n  • [${ep.kind}] ${ep.request.split('\n')[0].slice(0, 90)}`); out(`    files: ${ep.verifiedFiles.slice(0, 4).join(', ') || '(none)'}`); }
}
