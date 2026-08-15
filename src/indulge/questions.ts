/**
 * indulge/questions.ts — stage 2: what is worth asking about this code.
 *
 * Questions are **model-generated, not templated**. A fixed list ("what does this class do?") asked
 * of every file in every project produces a corpus of answers nobody needed; projects differ too
 * much for that, and the whole value of the corpus is that tomorrow's first question is already
 * answered. So the model reads the code and proposes the questions.
 *
 * One call per (target, category), where a target is the file itself or one entity inside it. Per
 * category rather than one call asking for all five, because a prompt that asks for five kinds of
 * thing at once returns five shallow examples of the easiest kind — and because each category's
 * focus is then one tunable line in its own prompt file.
 *
 * Two mechanisms stop a generative stage degenerating on a re-run:
 *
 *   - **Stable ids.** `questionId` is derived from the normalised question text plus file and
 *     entity, so a re-run that phrases the same question with different punctuation collides and is
 *     skipped rather than re-answered. The store enforces this; nothing here needs to remember.
 *   - **Caps per entity and per file**, so one verbose generation cannot balloon the night's work.
 *
 * Resume granularity is the (file, entity, category) triple: if the store already holds a question
 * for one, the LLM is not asked again. A triple that legitimately produced nothing is re-asked on a
 * later run, which is the cheap side of the trade.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { languageFor } from '../entangle/index.js';
import { toolLlm, toolPrompts, type ToolPrompts } from '../tools/runtime.js';
import { ensureToolRuntime } from '../tool-wiring.js';
import { CATEGORIES, questionId, type Category, type Entity, type IndulgeStore } from './store.js';

// This module drives the model directly, so it owns the runtime wiring rather than trusting that
// some other import got there first. `indulge` is headless — there is no TUI boot to do it.
ensureToolRuntime();

const indulgePrompts = (): ToolPrompts => toolPrompts('indulge');

const DEFAULT_MAX_PER_TARGET = 4;
const DEFAULT_MAX_PER_FILE = 40;
const DEFAULT_MAX_ENTITIES = 12;

/** How much of a file the model is shown. Clipping is ANNOUNCED — a silently truncated file reads as
 *  the whole thing, and the model then writes questions about code it was never given. */
const MAX_SOURCE_CHARS = 12000;

/** A question shorter than this is not a question. */
const MIN_QUESTION_CHARS = 12;

export interface QuestionOptions {
  store: IndulgeStore;
  repoPath: string;
  categories?: Category[];
  maxPerTarget?: number;
  maxPerFile?: number;
  maxEntities?: number;
  onStatus?: (note: string) => void;
  /** Called before each LLM call with (done, total) so the caller can heartbeat progress.json. */
  onProgress?: (done: number, total: number, current: string) => void;
  /** Cooperative stop — checked between calls so a shutdown lands between records, not inside one. */
  shouldStop?: () => boolean;
  /**
   * The generation call. Defaults to the wired LLM seam; overridden by the gate so stage 2's
   * bookkeeping — resume, caps, dedup — is testable without a GPU. Those are the parts that decide
   * whether a night's work is lost, and they should not need a model to prove.
   */
  ask?: (prompt: string) => Promise<string>;
}

export interface QuestionsReport {
  files: number;
  targets: number;
  /** LLM calls actually made (a resumed run makes fewer). */
  calls: number;
  generated: number;
  /** Questions the model repeated, caught by the stable id. */
  duplicates: number;
  skipped: number;
  stopped: boolean;
}

/** The file itself, then each declared type, then its public members — capped. */
export function targetsFor(file: string, source: string, maxEntities: number): Array<Entity | null> {
  const out: Array<Entity | null> = [null]; // null = the file as a whole
  const lang = languageFor(file);
  if (!lang) return out;
  let declared;
  try { declared = lang.surfaceOf(source); } catch { return out; }
  // Types first, then their members ranked by KIND rather than by declaration order.
  //
  // The budget is small (2 entities at depth 2), so whatever comes first is all that gets asked
  // about — and source order is alphabetical-by-accident, not importance. Behaviour outranks data:
  // a method is where a bug lives, a field is what it operates on.
  //
  // Public FIELDS are included, where they used to be dropped as "covered by their type's
  // questions". They are not. A `readonly struct` with eight public fields IS its fields, and an
  // enum is nothing else — which is why `RewardType.cs`, whose values decide a live ticket, indulged
  // to zero questions while a test-double file got thirty-six.
  const RANK: Record<string, number> = { method: 0, property: 1, field: 2 };
  for (const t of declared) {
    if (out.length > maxEntities) break;
    out.push({ kind: t.kind === 'interface' ? 'type' : 'class', name: t.name, file });
    const members = (t.members ?? [])
      .filter((m) => m.visibility === 'public')     // a private helper is not what tomorrow asks about
      .filter((m) => m.kind !== 'event')            // an event's contract is its declaring type's
      .sort((a, b) => (RANK[a.kind] ?? 3) - (RANK[b.kind] ?? 3));
    for (const m of members) {
      if (out.length > maxEntities) break;
      const kind = m.kind === 'method' ? 'method' : m.kind === 'property' ? 'property' : 'field';
      out.push({ kind, name: `${t.name}.${m.name}`, file });
    }
  }
  return out.slice(0, maxEntities + 1);
}

/**
 * One question per line, cleaned of the shapes models add anyway.
 *
 * `NONE` is a real answer and must survive as zero questions: a file with nothing worth asking
 * should produce nothing, not four questions invented to fill the quota.
 */
export function parseQuestions(reply: string, max: number): string[] {
  const out: string[] = [];
  for (const raw of reply.split('\n')) {
    const line = raw.trim()
      .replace(/^[-*•]\s+/, '')          // bullet
      .replace(/^\d+[.)]\s+/, '')        // numbering
      .replace(/^["'`]|["'`]$/g, '')     // stray quoting
      .trim();
    if (!line || line.toUpperCase() === 'NONE') continue;
    if (line.length < MIN_QUESTION_CHARS) continue;
    if (/^(here are|questions?:|okay|sure\b)/i.test(line)) continue; // preamble, not a question
    if (!out.includes(line)) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

const label = (e: Entity | null): string => (e ? `${e.kind} ${e.name}` : 'the file as a whole');

/**
 * Generate and store questions for every file discovered in stage 1.
 *
 * Each question is appended the moment it is parsed, so an interrupted stage leaves a partial but
 * usable question set that the next run continues from instead of regenerating.
 */
export async function generateQuestions(opts: QuestionOptions): Promise<QuestionsReport> {
  const { store, onStatus, onProgress, shouldStop } = opts;
  const repoPath = resolve(opts.repoPath);
  const categories = opts.categories?.length ? opts.categories : CATEGORIES;
  const maxPerTarget = opts.maxPerTarget ?? DEFAULT_MAX_PER_TARGET;
  const maxPerFile = opts.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  const maxEntities = opts.maxEntities ?? DEFAULT_MAX_ENTITIES;

  const report: QuestionsReport = {
    files: 0, targets: 0, calls: 0, generated: 0, duplicates: 0, skipped: 0, stopped: false,
  };

  // One entry per path — a file discovered under two domains is one file to ask about.
  const paths = [...new Set(store.files().map((f) => f.path))].sort();
  // A seed IS the feature; a neighbour is context. Measured on a real repo: peripheral interfaces
  // reached at depth 1 produced 40 questions each (many members x 4 each) while the seed produced
  // 12, so the corpus described the surroundings better than the thing asked about.
  const depthOf = new Map<string, number>();
  for (const f of store.files()) {
    const prev = depthOf.get(f.path);
    if (prev === undefined || f.depth < prev) depthOf.set(f.path, f.depth);
  }
  const budgetFor = (file: string): { perTarget: number; entities: number } => {
    const d = depthOf.get(file) ?? 0;
    if (d === 0) return { perTarget: maxPerTarget, entities: maxEntities };
    if (d === 1) return { perTarget: Math.max(2, Math.floor(maxPerTarget / 2)), entities: Math.min(maxEntities, 5) };
    return { perTarget: 1, entities: 2 };
  };
  const existing = store.questions();
  // (file, entity, category) triples already carrying a question — the resume key.
  const done = new Set(existing.map((q) => `${q.file}|${q.entity ? `${q.entity.kind}:${q.entity.name}` : ''}|${q.category}`));
  const perFile = new Map<string, number>();
  for (const q of existing) perFile.set(q.file, (perFile.get(q.file) ?? 0) + 1);

  // Total is an upper bound: resumed triples are skipped without a call, and it is reported as such.
  let total = 0;
  const plan: Array<{ file: string; source: string; targets: Array<Entity | null>; perTarget: number }> = [];
  for (const path of paths) {
    let source: string;
    try { source = readFileSync(join(repoPath, path), 'utf-8'); } catch { report.skipped++; continue; }
    const budget = budgetFor(path);
    const targets = targetsFor(path, source, budget.entities);
    plan.push({ file: path, source, targets, perTarget: budget.perTarget });
    total += targets.length * categories.length;
  }
  report.files = plan.length;
  onStatus?.(`${plan.length} file(s) → up to ${total} generation calls`);

  let step = 0;
  for (const { file, source, targets, perTarget } of plan) {
    const clipped = source.length > MAX_SOURCE_CHARS;
    const shown = clipped
      ? `${source.slice(0, MAX_SOURCE_CHARS)}\n… (file clipped at ${MAX_SOURCE_CHARS} of ${source.length} characters)`
      : source;

    for (const entity of targets) {
      report.targets++;
      for (const category of categories) {
        step++;
        if (shouldStop?.()) { report.stopped = true; onStatus?.('stop requested — leaving the rest for the next run'); return report; }
        if ((perFile.get(file) ?? 0) >= maxPerFile) { report.skipped++; continue; }
        const key = `${file}|${entity ? `${entity.kind}:${entity.name}` : ''}|${category}`;
        if (done.has(key)) { report.skipped++; continue; }

        onProgress?.(step, total, `${file} · ${label(entity)} · ${category}`);
        const prompt = indulgePrompts().get('questionFrame', {
          FILE: file,
          TARGET: entity ? `ABOUT: ${label(entity)}` : 'ABOUT: this file as a whole',
          FOCUS: indulgePrompts().get(categoryPrompt(category)),
          MAX: String(maxPerTarget),
          SOURCE: shown,
        });
        let reply: string;
        try {
          reply = opts.ask
            ? await opts.ask(prompt)
            : await toolLlm().ask([{ role: 'user', content: prompt }]);
        } catch (err) {
          // A model that is down must not lose the questions already written. The triple stays
          // un-done, so the next run asks it again.
          onStatus?.(`generation failed on ${file} · ${category}: ${String(err).slice(0, 120)}`);
          continue;
        }
        report.calls++;

        for (const text of parseQuestions(reply, perTarget)) {
          if ((perFile.get(file) ?? 0) >= maxPerFile) break;
          const id = questionId(text, file, entity);
          if (store.addQuestion({ id, file, entity, category, text })) {
            report.generated++;
            perFile.set(file, (perFile.get(file) ?? 0) + 1);
          } else {
            report.duplicates++;
          }
        }
        done.add(key);
      }
    }
    onStatus?.(`${file}: ${perFile.get(file) ?? 0} question(s)`);
  }

  return report;
}

/** The prompt id carrying a category's focus. One short, tunable file each. */
function categoryPrompt(category: Category): string {
  return `category${category.charAt(0).toUpperCase()}${category.slice(1)}`;
}
