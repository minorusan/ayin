/**
 * indulge/report.ts — the audit deliverable.
 *
 * Phase 1 is judged on whether the chunks are any good, and nobody judges that by reading 400 JSON
 * files. This writes one markdown document grouping every chunk by file and category, with its
 * citations rendered as `path:start-end` so a reader can jump straight to the code and check it.
 *
 * It also **re-verifies every citation as it writes**, rather than trusting the flag set when the
 * chunk was stored. Those are different claims: the first says the proof resolved when the answer
 * was written, the second says it resolves *now*. A file edited since the corpus was built makes a
 * chunk stale, and a report that quietly presented stale chunks as current would defeat its own
 * purpose. Anything that no longer resolves is listed in its own section.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../prompts-service.js';
import { blobSha, citationBase, citeLabel, type Chunk, type IndulgeStore } from './store.js';

export interface ReportOptions {
  store: IndulgeStore;
  repoPath: string;
  /** Where to write. Defaults to `<corpus>/report.md`. */
  outPath?: string;
}

export interface ReportResult {
  path: string;
  chunks: number;
  files: number;
  /** Chunks whose citations no longer resolve — the file changed under the corpus. */
  stale: number;
  failedQuestions: number;
}

/** True when every citation still resolves against the bytes on disk right now. */
export function chunkStillResolves(repoPath: string, chunk: Chunk): boolean {
  for (const c of chunk.citations) {
    let body: Buffer;
    try { body = readFileSync(join(citationBase(repoPath, c), c.path)); } catch { return false; }
    if (blobSha(body) !== c.sha) return false;
    const lineCount = body.toString('utf-8').split('\n').length;
    if (c.startLine < 1 || c.endLine > lineCount || c.endLine < c.startLine) return false;
  }
  return chunk.citations.length > 0;
}

const esc = (s: string): string => s.replace(/\r/g, '').trim();

export function renderReport(store: IndulgeStore, repoPath: string): { markdown: string; result: Omit<ReportResult, 'path'> } {
  const chunks = store.chunks();
  const questions = store.questions();
  const manifest = store.manifest();
  const totals = store.totals();

  const byFile = new Map<string, Chunk[]>();
  for (const c of chunks) {
    const key = c.entity?.file || c.files[0] || '(unattributed)';
    const list = byFile.get(key);
    if (list) list.push(c); else byFile.set(key, [c]);
  }

  let stale = 0;
  const staleRows: string[] = [];
  const out: string[] = [];

  out.push(`# indulge corpus — ${manifest.repoPath}`);
  out.push('');
  out.push(`\`${store.key}\` · ${chunks.length} chunk(s) across ${byFile.size} file(s)`);
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| questions | ${totals.questions} |`);
  out.push(`| answered | ${totals.answered} |`);
  out.push(`| failed (no resolvable proof) | ${totals.failed} |`);
  out.push(`| still pending | ${totals.pending} |`);
  out.push(`| files discovered | ${totals.files} |`);
  out.push('');
  out.push('Runs:');
  out.push('');
  for (const r of manifest.runs.slice(-8)) {
    out.push(`- \`${r.runId}\` ${r.started.slice(0, 16)} · ${r.status} · domains: ${r.domains.join(', ') || '(none)'} · ${r.chunks} chunk(s)`);
  }
  out.push('');

  for (const [file, list] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`## ${file}`);
    out.push('');
    const byCategory = new Map<string, Chunk[]>();
    for (const c of list) {
      const l = byCategory.get(c.category);
      if (l) l.push(c); else byCategory.set(c.category, [c]);
    }
    for (const [category, cs] of [...byCategory].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`### ${category}`);
      out.push('');
      for (const c of cs) {
        const fresh = chunkStillResolves(repoPath, c);
        if (!fresh) { stale++; staleRows.push(`- \`${c.chunkId.slice(0, 10)}\` ${file} · ${category} — ${esc(c.question).slice(0, 120)}`); }
        out.push(`**Q. ${esc(c.question)}**${fresh ? '' : '  \n> ⚠ STALE — the cited code has changed since this was answered.'}`);
        out.push('');
        if (c.entity) out.push(`*${c.entity.kind} \`${c.entity.name}\`*`);
        out.push('');
        out.push(esc(c.answer));
        out.push('');
        out.push(`<sub>${c.citations.map((x) => `\`${citeLabel(x)}\``).join(' · ')} — ${c.model}, ${c.createdAt.slice(0, 16)}</sub>`);
        out.push('');
      }
    }
  }

  const failed = questions.filter((q) => q.status === 'failed');
  if (failed.length) {
    out.push('## Unanswered');
    out.push('');
    out.push('Questions whose answer could not be proved. They are recorded, not stored as chunks —');
    out.push('an answer without a resolvable citation is exactly what this corpus refuses to contain.');
    out.push('');
    for (const q of failed.slice(0, 200)) {
      out.push(`- \`${q.file}\` · ${q.category} — ${esc(q.text).slice(0, 140)} *(${q.note || 'no note'})*`);
    }
    out.push('');
  }

  if (staleRows.length) {
    out.push('## Stale');
    out.push('');
    out.push('The cited bytes have changed since these were answered. Re-run indulge to refresh them.');
    out.push('');
    out.push(...staleRows);
    out.push('');
  }

  return {
    markdown: out.join('\n'),
    result: { chunks: chunks.length, files: byFile.size, stale, failedQuestions: failed.length },
  };
}

export function writeReport(opts: ReportOptions): ReportResult {
  const { markdown, result } = renderReport(opts.store, opts.repoPath);
  const path = opts.outPath || join(opts.store.dir, 'report.md');
  // Atomic, like every other whole-file document in the corpus: a half-written report read by a
  // human at 08:00 is worse than none, because it looks complete.
  writeAtomic(path, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  return { path, ...result };
}
