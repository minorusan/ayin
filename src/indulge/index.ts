/**
 * indulge/index.ts — `ayin indulge`, the overnight corpus builder.
 *
 *     ayin indulge --repoPath <path> --domains "rendering,checkout"
 *     ayin indulge --status          what it is doing right now, for the morning check
 *     ayin indulge --report          write the audit markdown and stop
 *     ayin indulge --dry-run         discover only: the file list and a question estimate
 *
 * It runs unattended for hours, so the shape is dictated by that: no interactive prompt ever, one
 * lock per corpus, `progress.json` written at every step, and every stage resuming from disk. Kill
 * it at any point and the next run continues from the last record written.
 *
 * SIGINT/SIGTERM are cooperative: the flag is set, the stage in flight finishes its current record,
 * and the run closes its manifest honestly. A second signal exits immediately — an operator who
 * presses Ctrl+C twice means it.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquireLlm, type LlmHold } from '../llm/authority.js';
import { answerQuestions } from './answer.js';
import { discoverDomain } from './discover.js';
import { generateQuestions } from './questions.js';
import { writeReport } from './report.js';
import { openStore, StoreLockedError, type Category, type Stage } from './store.js';

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };

export interface IndulgeArgs {
  repoPath: string;
  domains: string[];
  status: boolean;
  report: boolean;
  dryRun: boolean;
  restart: boolean;
  maxDepth?: number;
  maxFiles?: number;
  maxQuestions?: number;
  categories?: Category[];
}

/** `--flag value` and `--flag=value`, both. Unknown flags are reported, never guessed at. */
export function parseArgs(argv: string[]): { args: IndulgeArgs; errors: string[] } {
  const errors: string[] = [];
  const args: IndulgeArgs = {
    repoPath: process.cwd(), domains: [], status: false, report: false, dryRun: false, restart: false,
  };
  const num = (v: string, name: string): number | undefined => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) { errors.push(`--${name} needs a non-negative number, got "${v}"`); return undefined; }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], undefined];
    const value = (): string => inlineValue ?? argv[++i] ?? '';
    switch (flag) {
      case '--repoPath': case '--repo': args.repoPath = value(); break;
      case '--domains': case '--domain':
        args.domains = value().split(',').map((d) => d.trim()).filter(Boolean); break;
      case '--status': args.status = true; break;
      case '--report': args.report = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--restart': args.restart = true; break;
      case '--depth': args.maxDepth = num(value(), 'depth'); break;
      case '--max-files': args.maxFiles = num(value(), 'max-files'); break;
      case '--max-questions': args.maxQuestions = num(value(), 'max-questions'); break;
      case '--categories':
        args.categories = value().split(',').map((c) => c.trim()).filter(Boolean) as Category[]; break;
      default: errors.push(`unknown flag: ${flag}`);
    }
  }
  return { args, errors };
}

const USAGE = [
  'ayin indulge — build a per-repo corpus of answered questions (overnight job)',
  '',
  '  ayin indulge --domains "rendering,checkout" [--repoPath <path>]',
  '  ayin indulge --status        what it is doing now, and how far along',
  '  ayin indulge --report        write the audit markdown and stop',
  '  ayin indulge --dry-run       discover only — file list + question estimate, spends nothing',
  '',
  '  --restart                    discard the corpus and rebuild (default is RESUME)',
  '  --depth N                    reference-walk depth (default 3)',
  '  --max-files N                cap discovered files per domain',
  '  --max-questions N            cap answers this run',
  '  --categories a,b             git,dependencies,connections,functionality,gotchas',
].join('\n');

const hhmm = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** The morning check: one command that says whether it is alive and how far it got. */
function printStatus(repoPath: string): number {
  const store = openStore(repoPath);
  if (!store.exists()) { out(`No corpus for ${resolve(repoPath)} yet.`); return 0; }
  const t = store.totals();
  const p = store.progress();
  const holder = store.lockHolder();
  const last = store.lastWriteAt();

  out(`corpus  ${store.dir}`);
  out(`files ${t.files} · questions ${t.questions} (${t.answered} answered, ${t.failed} failed, ${t.pending} pending) · chunks ${t.chunks}`);
  if (p) {
    const elapsed = Date.now() - Date.parse(p.startedAt);
    const rate = p.done > 0 ? elapsed / p.done : 0;
    const eta = rate && p.total > p.done ? ` · eta ~${hhmm(rate * (p.total - p.done))}` : '';
    out(`stage   ${p.stage} ${p.done}/${p.total}${eta}`);
    out(`current ${p.current}`);
  }
  if (holder) {
    const beat = Date.parse(holder.heartbeatAt);
    const age = Date.now() - beat;
    out(age < 10 * 60_000
      ? `RUNNING  pid ${holder.pid} on ${holder.host} · last heartbeat ${hhmm(age)} ago`
      : `STALLED  pid ${holder.pid} on ${holder.host} · last heartbeat ${hhmm(age)} ago — the next run will adopt this lock`);
  } else {
    out(`idle${last ? ` · last write ${hhmm(Date.now() - last.getTime())} ago` : ''}`);
  }
  const runs = store.manifest().runs;
  const interrupted = runs.filter((r) => r.status === 'interrupted').length;
  if (interrupted) out(`${interrupted} earlier run(s) were interrupted; their work was kept and resumed.`);
  return 0;
}

export async function runIndulge(argv: string[]): Promise<number> {
  // Help first: asking for help must never be answered with "unknown flag: --help".
  if (argv.includes('--help') || argv.includes('-h')) { out(USAGE); return 0; }
  const { args, errors } = parseArgs(argv);
  if (errors.length) { out(errors.join('\n')); out(); out(USAGE); return 2; }

  const repoPath = resolve(args.repoPath);
  if (!existsSync(repoPath)) { out(`No such directory: ${repoPath}`); return 2; }

  if (args.status) return printStatus(repoPath);

  const store = openStore(repoPath);

  if (args.report) {
    if (!store.exists()) { out(`No corpus for ${repoPath} yet — run indulge first.`); return 2; }
    const r = writeReport({ store, repoPath });
    out(`${r.path}`);
    out(`${r.chunks} chunk(s) across ${r.files} file(s)${r.stale ? ` · ${r.stale} STALE` : ''}${r.failedQuestions ? ` · ${r.failedQuestions} unproven` : ''}`);
    return 0;
  }

  if (args.domains.length === 0) { out('--domains is required (comma-separated).'); out(); out(USAGE); return 2; }

  // Cooperative stop. The stages check this between records, so a signal costs at most the one
  // question in flight; a second signal is an operator who means it.
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) { out('\nsecond signal — exiting now.'); process.exit(130); }
    stopping = true;
    out('\nstopping after the current step… (again to force)');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const shouldStop = (): boolean => stopping;

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const headSha = '';
  try {
    store.beginRun({ runId, domains: args.domains, headSha, restart: args.restart });
  } catch (err) {
    if (err instanceof StoreLockedError) {
      out(String(err.message));
      out(`If that process is gone, its lock is adopted automatically once its heartbeat stops.`);
      return 3;
    }
    throw err;
  }

  const startedAt = new Date().toISOString();
  const progress = (stage: Stage, done: number, total: number, current: string): void =>
    store.setProgress({ runId, stage, done, total, current, startedAt });
  const status = (note: string): void => out(`  ${note}`);

  // ONE DOOR: generation goes through the resource layer as a background consumer, so a human at the
  // keyboard is never starved by an overnight sweep. A refusal is not fatal — indulge is a guest.
  let hold: LlmHold | null = null;
  try {
    hold = await acquireLlm('ayin indulge: overnight corpus build');
    if (hold === 'busy') out('note: the model is held by someone else; queuing behind them.');
  } catch { /* no resource layer here — the provider is reached directly */ }

  try {
    out(`indulge ${repoPath}`);
    out(`corpus  ${store.dir}`);
    out(`domains ${args.domains.join(', ')}`);
    out();

    // ── stage 1 ────────────────────────────────────────────────────────────────
    progress('discover', 0, args.domains.length, '');
    let matched = 0;
    for (const [i, domain] of args.domains.entries()) {
      if (shouldStop()) break;
      out(`[discover] ${domain}`);
      const r = await discoverDomain({
        store, repoPath, domain, maxDepth: args.maxDepth, maxFiles: args.maxFiles, onStatus: status,
      });
      matched += r.added;
      progress('discover', i + 1, args.domains.length, domain);
      if (r.seeds === 0) out(`  "${domain}" matched nothing in this repo — no files written.`);
      else out(`  ${r.added} file(s)${r.truncated ? ' (capped — the walk stopped early)' : ''}` +
        `${r.hallucinated.length ? ` · ${r.hallucinated.length} named path(s) did not exist and were dropped` : ''}`);
    }

    if (matched === 0) {
      out();
      out('Nothing matched. No questions, no chunks — a corpus is not invented to have one.');
      store.endRun(runId, 'finished');
      return 0;
    }

    if (args.dryRun) {
      const files = store.files().length;
      out();
      out(`dry run: ${files} file(s) discovered. A full run would ask roughly ${files * 5 * 2}–${files * 5 * 5} question(s).`);
      out('Nothing was spent and no questions were written.');
      store.endRun(runId, 'finished');
      return 0;
    }

    // ── stage 2 ────────────────────────────────────────────────────────────────
    out();
    out('[questions]');
    const q = await generateQuestions({
      store, repoPath, categories: args.categories, onStatus: status, shouldStop,
      onProgress: (done, total, current) => progress('questions', done, total, current),
    });
    out(`  ${q.generated} new question(s)` +
      `${q.duplicates ? `, ${q.duplicates} already known` : ''}${q.skipped ? `, ${q.skipped} skipped (already generated)` : ''}`);

    // ── stage 3 ────────────────────────────────────────────────────────────────
    out();
    out('[answers]');
    const a = await answerQuestions({
      store, repoPath, limit: args.maxQuestions, onStatus: status, shouldStop,
      onProgress: (done, total, current) => progress('answer', done, total, current),
    });
    out(`  ${a.answered} answered · ${a.failed} unproven (not stored) · ${a.rejectedCitations} citation(s) rejected`);

    // ── the deliverable ────────────────────────────────────────────────────────
    // Close the run BEFORE writing the report: `endRun` stamps the run's totals from disk, and the
    // report renders the manifest. Writing it first published a run row reading `running · 0 chunks`
    // in a document whose whole job is to be an accurate account of the night.
    progress('report', 0, 1, 'writing');
    store.endRun(runId, stopping ? 'interrupted' : 'finished');
    const r = writeReport({ store, repoPath });
    const totals = store.totals();
    out();
    out(`report  ${r.path}`);
    out(`corpus  ${totals.chunks} chunk(s) · ${totals.answered} answered · ${totals.failed} unproven · ${totals.pending} still pending`);
    if (stopping) out('Stopped early — re-run to continue where this left off.');
    return 0;
  } catch (err) {
    // The run stays `running` in the manifest only until the next run adopts it, which is what makes
    // a crash indistinguishable from a kill: both resume.
    store.endRun(runId, 'interrupted');
    out(`indulge failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    // Same shape as the watch daemon: only a real grant has a release, and letting it go matters —
    // an overnight job that dies holding the authority starves every other consumer until the TTL.
    if (typeof hold === 'object' && hold) {
      try { await hold.release(); } catch { /* best effort — the TTL frees it anyway */ }
    }
  }
}
