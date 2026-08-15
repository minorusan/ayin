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
  /** Only these files. The interleaved runner uses it to generate one batch at a time. */
  only?: string[];
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
/**
 * One question, stripped of the shapes models add anyway — or '' when the line is not a question.
 *
 * Shared by both parsers: JSON output arrives cleaner but still carries stray numbering and quoting,
 * and having one cleaner means a rule added for one shape protects the other.
 */
export function cleanQuestion(raw: string): string {
  const line = raw.trim()
    .replace(/^[-*•]\s+/, '')          // bullet
    .replace(/^\d+[.)]\s+/, '')        // numbering
    .replace(/^["'`]|["'`]$/g, '')     // stray quoting
    .trim();
  if (!line || line.toUpperCase() === 'NONE') return '';
  if (line.length < MIN_QUESTION_CHARS) return '';
  if (/^(here are|questions?:|okay|sure\b)/i.test(line)) return ''; // preamble, not a question
  return line;
}

export function parseQuestions(reply: string, max: number): string[] {
  const out: string[] = [];
  for (const raw of reply.split('\n')) {
    const line = cleanQuestion(raw);
    if (!line) continue;
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
  const paths = (opts.only
    ? opts.only.filter((p) => store.files().some((f) => f.path === p))
    : [...new Set(store.files().map((f) => f.path))]).sort();
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
  // Resume is the union of two facts: a triple that PRODUCED questions, and a triple that was ASKED
  // and produced none. The second used to be unrecorded, so every legitimately empty target was
  // re-asked on every run — at the price of the whole source file in the prompt each time.
  const done = new Set([
    ...existing.map((q) => `${q.file}|${q.entity ? `${q.entity.kind}:${q.entity.name}` : ''}|${q.category}`),
    ...store.askedKeys(),
  ]);
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

    // ONE CALL PER (FILE, CATEGORY) — not per (entity, category).
    //
    // The previous shape asked once per target per category, and every one of those calls carried
    // the WHOLE SOURCE FILE again. A real run reported `1139 file(s) → up to 5802 generation calls`,
    // which is the same file re-sent up to twenty-six times to collect twenty-six short questions.
    //
    // It also scaled the wrong way. Call count was proportional to TARGETS, and fixing the C# surface
    // extractor took a seed file from 2 targets to 13 — so the old shape would have multiplied an
    // already ten-hour stage rather than shortening it. Per (file, category) is proportional to
    // FILES, which is the number the operator actually controls.
    //
    // Category stays a separate call rather than being folded in too: each one carries its own FOCUS
    // prompt, those prompts are the operator's main tuning surface, and merging them would put
    // several conflicting framings in one context for a model that has to hold the source as well.
    for (const category of categories) {
      report.targets += targets.length;
      step++;
      if (shouldStop?.()) { report.stopped = true; onStatus?.('stop requested — leaving the rest for the next run'); return report; }
      if ((perFile.get(file) ?? 0) >= maxPerFile) { report.skipped++; continue; }

      // Resume is still per (file, entity, category): a batch that already ran for some targets asks
      // only about the rest, so an interrupted run never re-pays for work already on disk.
      const wanted = targets.filter((e) => !done.has(`${file}|${entityKeyOf(e)}|${category}`));
      if (!wanted.length) { report.skipped++; continue; }

      onProgress?.(step, total, `${file} · ${wanted.length} target(s) · ${category}`);
      const prompt = indulgePrompts().get('questionBatch', {
        FILE: file,
        FOCUS: indulgePrompts().get(categoryPrompt(category)),
        MAX: String(perTarget),
        TARGETS: wanted.map((e) => `- ${label(e)}`).join('\n'),
        SOURCE: shown,
      });
      let reply: string;
      try {
        reply = opts.ask
          ? await opts.ask(prompt)
          : await toolLlm().ask([{ role: 'user', content: prompt }]);
      } catch (err) {
        // A model that is down must not lose the questions already written. Nothing is marked done,
        // so the next run asks again.
        onStatus?.(`generation failed on ${file} · ${category}: ${String(err).slice(0, 120)}`);
        continue;
      }
      report.calls++;

      const byTarget = parseQuestionBatch(reply, wanted, perTarget);
      for (const [entity, texts] of byTarget) {
        for (const text of texts) {
          if ((perFile.get(file) ?? 0) >= maxPerFile) break;
          const id = questionId(text, file, entity);
          if (store.addQuestion({ id, file, entity, category, text })) {
            report.generated++;
            perFile.set(file, (perFile.get(file) ?? 0) + 1);
          } else {
            report.duplicates++;
          }
        }
      }
      // EVERY target in the call is done, not only the ones that came back with questions. "Nothing
      // worth asking here" is a real answer — the prompt says so explicitly — and marking only the
      // productive targets means a genuinely empty one is re-asked on every future run, forever, at
      // full file cost. The resume key stays (file, entity, category), unchanged from before the
      // batching, so questions already on disk from an earlier run still skip.
      for (const e of wanted) {
        done.add(`${file}|${entityKeyOf(e)}|${category}`);
        store.markAsked(file, e, category);
      }
    }
    onStatus?.(`${file}: ${perFile.get(file) ?? 0} question(s)`);
  }

  return report;
}

const entityKeyOf = (e: Entity | null): string => (e ? `${e.kind}:${e.name}` : '');

/**
 * Parse the batch reply into questions per target.
 *
 * Tolerant on purpose, and it MUST be: a JSON contract with a local model is a strong hint, not a
 * guarantee, and a strict parser turns one stray code fence into a whole file's questions lost with
 * no way to tell it apart from "nothing worth asking".
 *
 * Falls back to the old line-per-question shape when there is no usable JSON, attributing everything
 * to the file as a whole — a question filed against the wrong target is still a true question about
 * this file, whereas discarding it is a hole in the corpus.
 */
export function parseQuestionBatch(
  reply: string, targets: Array<Entity | null>, maxPerTarget: number,
): Map<Entity | null, string[]> {
  const out = new Map<Entity | null, string[]>();
  const byLabel = new Map(targets.map((t) => [label(t).toLowerCase(), t]));

  // A fence is the single most common deviation; strip it before anything else.
  const body = reply.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1)) as { questions?: Array<{ target?: string; q?: unknown }> };
      for (const row of parsed.questions ?? []) {
        const key = String(row.target ?? '').toLowerCase().trim();
        // An unrecognised label is attributed to the file rather than dropped: the model answered
        // about this file either way, and `null` is a legitimate target.
        const entity = byLabel.get(key) ?? (byLabel.has(key) ? null : (targets.includes(null) ? null : targets[0] ?? null));
        const texts = (Array.isArray(row.q) ? row.q : [])
          .map((x) => cleanQuestion(String(x)))
          .filter(Boolean)
          .slice(0, maxPerTarget);
        if (!texts.length) continue;
        out.set(entity, [...(out.get(entity) ?? []), ...texts].slice(0, maxPerTarget));
      }
      if (out.size) return out;
    } catch { /* fall through to the line parser */ }
  }

  const lines = parseQuestions(reply, maxPerTarget);
  if (lines.length) out.set(targets.includes(null) ? null : targets[0] ?? null, lines);
  return out;
}

/** The prompt id carrying a category's focus. One short, tunable file each. */
function categoryPrompt(category: Category): string {
  return `category${category.charAt(0).toUpperCase()}${category.slice(1)}`;
}
