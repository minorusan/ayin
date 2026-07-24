/**
 * ayin rag-mine — Phase 0 of episodic RAG: mine this repo's Claude Code transcripts into
 * problem→fix EPISODES, and keep only the ones whose edits VERIFIABLY SURVIVED to HEAD.
 *
 *   ayin rag-mine --repo <path> [--out <file>] [--limit N]
 *
 * Why the verify filter is the whole point: transcripts are full of confident-but-wrong turns
 * (dead-ends, backtracks, fixes-of-fixes). Indexing those unfiltered builds a RAG that repeats
 * our past mistakes. So an episode is kept ONLY if a distinctive line it introduced is present in
 * the current committed file (git show HEAD:<file>) — i.e. the change stuck. Pure deterministic
 * git; no model, no GPU, no risk. Output is JSON to eyeball before we invest in embeddings.
 *
 * Transcript source: ~/.claude/projects/<cwd-with-slashes-as-dashes>/*.jsonl. An episode = one
 * user request → the assistant narration + Edit/Write/MultiEdit calls until the next user request.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';

function out(line: string): void { process.stdout.write(line + '\n'); }

function git(repo: string, args: string[]): string {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return ''; }
}

/** Locate the Claude Code project dir for a repo: try the slash→dash encoding, else scan project
 *  dirs and match the `cwd` recorded in each transcript's first line. */
function findTranscriptDir(repoAbs: string): string | null {
  const projects = resolve(homedir(), '.claude', 'projects');
  if (!existsSync(projects)) return null;
  const encoded = repoAbs.replace(/[/.]/g, '-');
  const direct = resolve(projects, encoded);
  if (existsSync(direct)) return direct;
  // fallback: match by the cwd field inside the transcripts
  for (const name of readdirSync(projects)) {
    const dir = resolve(projects, name);
    let files: string[]; try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files.slice(0, 1)) {
      try {
        const first = readFileSync(resolve(dir, f), 'utf-8').split('\n').find(Boolean);
        if (first && JSON.parse(first).cwd === repoAbs) return dir;
      } catch { /* skip */ }
    }
  }
  return null;
}

interface Edit { file: string; kind: 'Edit' | 'Write' | 'MultiEdit'; snippet: string }
interface Episode {
  session: string;
  ts: string;
  kind: 'edit' | 'investigation'; // did Claude change files, or only read/grep/analyse?
  request: string;         // the user ask that opened the episode
  narration: string;       // assistant's visible text (stated reasoning / conclusion) in the episode
  edits: Edit[];
  touched: string[];       // files Read/Grep/Glob'd — the investigation surface
  verified: boolean;       // edit: a change survived to HEAD · investigation: grounded + still-present
  verifiedFiles: string[];
}

/** A distinctive line from introduced content — the longest trimmed line ≥ 12 chars, used to test
 *  whether the change survived to HEAD (cheap, robust against reformatting of the rest). */
function distinctiveLine(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length >= 12);
  return lines.sort((a, b) => b.length - a.length)[0] || text.trim().slice(0, 80);
}

/** Is this "user" turn actually one of our own automated agents (the premortem-hound skeptic, an
 *  ayin/claude -p review, a habit) rather than a human problem-solving session? Indexing those is
 *  circular — a RAG feeding on its own review passes. Filter them out. */
function looksAutomated(request: string): boolean {
  return /^You are a\b|blast-radius skeptic|VERDICT:\s*(CLEAR|ISSUES|RISKY|OK)|Review the following git|senior code reviewer/i.test(request);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map(b => b.text || '').join('\n');
}

function editsOf(content: unknown, repo: string): Edit[] {
  if (!Array.isArray(content)) return [];
  const edits: Edit[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const blk = b as { type?: string; name?: string; input?: Record<string, unknown> };
    if (blk.type !== 'tool_use' || !blk.input) continue;
    const inp = blk.input;
    const fileAbs = String(inp.file_path || inp.path || '');
    if (!fileAbs) continue;
    const file = isAbsolute(fileAbs) ? relative(repo, fileAbs) : fileAbs;
    if (blk.name === 'Write') edits.push({ file, kind: 'Write', snippet: distinctiveLine(String(inp.content || '')) });
    else if (blk.name === 'Edit') edits.push({ file, kind: 'Edit', snippet: distinctiveLine(String(inp.new_string || '')) });
    else if (blk.name === 'MultiEdit' && Array.isArray(inp.edits)) {
      const joined = (inp.edits as Array<{ new_string?: string }>).map(e => e.new_string || '').join('\n');
      edits.push({ file, kind: 'MultiEdit', snippet: distinctiveLine(joined) });
    }
  }
  return edits;
}

/** Files Claude Read/Grep/Glob'd in this content block — the investigation surface (relative). */
function touchedOf(content: unknown, repo: string): string[] {
  if (!Array.isArray(content)) return [];
  const files: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const blk = b as { type?: string; name?: string; input?: Record<string, unknown> };
    if (blk.type !== 'tool_use' || !blk.input) continue;
    if (!['Read', 'Grep', 'Glob'].includes(blk.name || '')) continue;
    const p = String(blk.input.file_path || blk.input.path || '');
    if (p) files.push(isAbsolute(p) ? relative(repo, p) : p);
  }
  return files;
}

/** Did the introduced snippet survive to the current committed file? (change stuck, not reverted) */
function survives(repo: string, edit: Edit): boolean {
  if (edit.file.startsWith('..')) return false;         // outside the repo
  const head = git(repo, ['show', `HEAD:${edit.file}`]); // '' if file absent in HEAD
  if (!head) return false;
  return edit.snippet.length >= 12 && head.includes(edit.snippet);
}

export async function runRagMine(args: string[]): Promise<void> {
  const repoArg = args[args.indexOf('--repo') + 1];
  if (!args.includes('--repo') || !repoArg) { process.stderr.write('usage: ayin rag-mine --repo <path> [--out <file>] [--limit N]\n'); process.exit(1); }
  const top = git(resolve(repoArg), ['rev-parse', '--show-toplevel']).trim();
  if (!top) { process.stderr.write(`not a git repo: ${repoArg}\n`); process.exit(1); }
  const repo = top;

  const dir = findTranscriptDir(repo);
  if (!dir) { process.stderr.write(`no Claude transcripts found for ${repo} under ~/.claude/projects\n`); process.exit(1); }
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => resolve(dir, f));
  out(`mining ${files.length} transcript(s) for ${repo}`);

  const episodes: Episode[] = [];
  for (const file of files) {
    let cur: Episode | null = null;
    const push = () => {
      if (cur) {
        cur.kind = cur.edits.length ? 'edit' : 'investigation';
        // Keep edit episodes, or investigations with a substantive conclusion + real files touched.
        if (cur.edits.length || (cur.narration.length >= 200 && cur.touched.length > 0)) {
          cur.touched = [...new Set(cur.touched)];
          episodes.push(cur);
        }
      }
      cur = null;
    };
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let o: { message?: { role?: string; content?: unknown }; timestamp?: string; sessionId?: string };
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message; if (!m || !m.role) continue;
      if (m.role === 'user') {
        const t = textOf(m.content).trim();
        // A real user request (has text) starts a new episode; a tool_result-only user msg doesn't.
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
  }

  // Verify. edit episodes: a change survived to HEAD (the fix stuck). investigation episodes:
  // grounded + still-relevant — ≥1 file it read/analysed still exists in the tree (not stale).
  for (const ep of episodes) {
    const vfiles = new Set<string>();
    if (ep.kind === 'edit') {
      for (const e of ep.edits) if (survives(repo, e)) vfiles.add(e.file);
    } else {
      for (const f of ep.touched) if (!f.startsWith('..') && existsSync(resolve(repo, f))) vfiles.add(f);
    }
    ep.verifiedFiles = [...vfiles];
    ep.verified = vfiles.size > 0;
    ep.narration = ep.narration.slice(0, 1500); // cap for eyeballing / later chunking
  }

  const kept = episodes.filter(e => e.verified);
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 0;
  const outEpisodes = limit > 0 ? kept.slice(0, limit) : kept;

  const outFile = args.includes('--out')
    ? resolve(args[args.indexOf('--out') + 1])
    : resolve(homedir(), '.ayin-cli', 'rag', basename(repo), 'episodes.json');
  mkdirSync(resolve(outFile, '..'), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ repo, minedAt: new Date().toISOString(), total: episodes.length, verified: kept.length, episodes: outEpisodes }, null, 2));

  const nEdit = kept.filter(e => e.kind === 'edit').length;
  out(`episodes: ${episodes.length} found · ${kept.length} verified (${nEdit} edit, ${kept.length - nEdit} investigation) · ${episodes.length - kept.length} dropped`);
  out(`→ ${outFile}`);
  // A quick eyeball sample.
  for (const ep of outEpisodes.slice(0, 4)) {
    out(`\n  • [${ep.kind}] ${ep.request.split('\n')[0].slice(0, 90)}`);
    out(`    files: ${ep.verifiedFiles.slice(0, 4).join(', ') || '(none)'}`);
  }
}
