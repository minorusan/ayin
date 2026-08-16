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
import { categoryBatchSize, singleFileBudgetChars } from './budget.js';
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
/** DERIVED from the reading model — see indulge/budget.ts. Was a flat 12000. */
const maxSourceChars = (): number => singleFileBudgetChars();

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
/** Longer than this and it is an essay, not a question — and it costs a full answer call either way. */
const MAX_QUESTION_CHARS = 320;

export function cleanQuestion(raw: string): string {
  const line = raw.trim()
    .replace(/^[-*•]\s+/, '')          // bullet
    .replace(/^\d+[.)]\s+/, '')        // numbering
    .replace(/^["'`]|["'`]$/g, '')     // stray quoting
    .trim();
  if (!line || line.toUpperCase() === 'NONE') return '';
  if (line.length < MIN_QUESTION_CHARS) return '';
  if (/^(here are|questions?:|okay|sure\b)/i.test(line)) return ''; // preamble, not a question
  if (line.length > MAX_QUESTION_CHARS) return '';
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
    // Calls are per (FILE, category) now — targets ride along inside one prompt. Counting slots
    // here would report `up to 336 generation calls` for twelve files that will cost thirty-six,
    // and an inflated cost estimate is exactly the number that made the old per-target shape look
    // like a fact of nature instead of a bug.
    total += categories.length;
  }
  report.files = plan.length;
  onStatus?.(`${plan.length} file(s) × ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} → up to ${total} generation call(s)`);

  let step = 0;
  for (const { file, source, targets, perTarget } of plan) {
    const cap = maxSourceChars();
    const clipped = source.length > cap;
    const shown = clipped
      ? `${source.slice(0, cap)}\n… (file clipped at ${cap} of ${source.length} characters)`
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
    // CATEGORIES RIDE TOGETHER when the window has room. Generation was one call per (file,
    // category) — 1,053 calls on a real run against ~35 for all the answering combined, 30x
    // everything else. The source is identical across categories for one file, so on a big window it
    // is sent once and every angle asked at the same time.
    //
    // Still one-at-a-time on a small window, deliberately: each category carries its own FOCUS
    // prompt, and stacking several framings beside the source in 16k is how you get questions that
    // belong to no category in particular. This is a big-window optimisation, not a better idea.
    const catBatch = categoryBatchSize();
    if (catBatch > 1 && categories.length > 1) {
      for (let ci = 0; ci < categories.length; ci += catBatch) {
        const angles = categories.slice(ci, ci + catBatch);
        step++;
        if (shouldStop?.()) { report.stopped = true; onStatus?.('stop requested — leaving the rest for the next run'); return report; }
        if ((perFile.get(file) ?? 0) >= maxPerFile) { report.skipped++; continue; }

        // Per (target, category) resume, unchanged — an angle already done for a target is dropped
        // from the ask rather than the whole batch being re-run.
        const wantedByCat = new Map<Category, Array<Entity | null>>();
        for (const cat of angles) {
          const w = targets.filter((e) => !done.has(`${file}|${entityKeyOf(e)}|${cat}`));
          if (w.length) wantedByCat.set(cat, w);
        }
        if (!wantedByCat.size) { report.skipped++; continue; }

        const allTargets = [...new Set([...wantedByCat.values()].flat())];
        report.targets += allTargets.length;
        onProgress?.(step, total, `${file} · ${allTargets.length} target(s) × ${wantedByCat.size} angle(s)`);

        const prompt = indulgePrompts().get('questionBatchMulti', {
          FILE: file,
          MAX: String(perTarget),
          ANGLES: [...wantedByCat.keys()].map((c) => `- ${c}: ${categoryFocus(c).replace(/\s+/g, ' ').slice(0, 400)}`).join('\n'),
          TARGETS: allTargets.map((e) => `- ${label(e)}`).join('\n'),
          SOURCE: shown,
        });
        let reply: string;
        try {
          reply = opts.ask ? await opts.ask(prompt) : await toolLlm().ask([{ role: 'user', content: prompt }]);
        } catch (err) {
          onStatus?.(`generation failed on ${file}: ${String(err).slice(0, 120)}`);
          continue;
        }
        report.calls++;

        const parsed = parseQuestionBatchMulti(reply, allTargets, [...wantedByCat.keys()], perTarget);
        for (const [cat, wanted] of wantedByCat) {
          for (const [entity, texts] of parsed.get(cat) ?? []) {
            for (const text of texts) {
              if ((perFile.get(file) ?? 0) >= maxPerFile) break;
              const id = questionId(text, file, entity);
              if (store.addQuestion({ id, file, entity, category: cat, text })) {
                report.generated++;
                perFile.set(file, (perFile.get(file) ?? 0) + 1);
              } else {
                report.duplicates++;
              }
            }
          }
          // Every target in the ask is done, answered or not — "nothing worth asking" is a real
          // answer and must not be re-asked forever at the price of the whole file.
          for (const e of wanted) {
            done.add(`${file}|${entityKeyOf(e)}|${cat}`);
            store.markAsked(file, e, cat);
          }
        }
      }
      onStatus?.(`${file}: ${perFile.get(file) ?? 0} question(s)`);
      continue;
    }

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
        FOCUS: categoryFocus(category),
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
/**
 * Parse a MULTI-ANGLE reply: `angle` (the category) alongside `target`.
 *
 * Same positional pair scan as the single-category parser, for the same two reasons learned from a
 * real corpus — duplicate keys are valid JSON and silently keep only the last, and a truncated reply
 * must yield what it completed rather than nothing.
 *
 * An entry naming an angle that was not asked for is DROPPED rather than reassigned. Filing a
 * question under a category nobody requested puts it in a corpus slice the operator did not choose to
 * build, where it will be retrieved as if they had.
 */
export function parseQuestionBatchMulti(
  reply: string, targets: Array<Entity | null>, categories: Category[], maxPerTarget: number,
): Map<Category, Map<Entity | null, string[]>> {
  const out = new Map<Category, Map<Entity | null, string[]>>();
  const byLabel = new Map(targets.map((t) => [label(t).toLowerCase(), t]));
  const byAngle = new Map(categories.map((c) => [c.toLowerCase(), c]));
  const fileTarget = targets.includes(null) ? null : targets[0] ?? null;

  const re = /"angle"\s*:\s*"([^"]*)"\s*,\s*"target"\s*:\s*"([^"]*)"\s*,\s*"q"\s*:\s*(\[[^\]]*\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply))) {
    const cat = byAngle.get(m[1].toLowerCase().trim());
    if (!cat) continue;
    const entity = byLabel.get(m[2].toLowerCase().trim()) ?? fileTarget;
    let texts: string[];
    try { texts = (JSON.parse(m[3]) as unknown[]).map(String); } catch { continue; }
    const clean = texts.map(cleanQuestion).filter(Boolean).slice(0, maxPerTarget);
    if (!clean.length) continue;
    const perCat = out.get(cat) ?? new Map<Entity | null, string[]>();
    perCat.set(entity, [...(perCat.get(entity) ?? []), ...clean].slice(0, maxPerTarget));
    out.set(cat, perCat);
  }
  return out;
}

export function parseQuestionBatch(
  reply: string, targets: Array<Entity | null>, maxPerTarget: number,
): Map<Entity | null, string[]> {
  const out = new Map<Entity | null, string[]>();
  const byLabel = new Map(targets.map((t) => [label(t).toLowerCase(), t]));
  const fileTarget = targets.includes(null) ? null : targets[0] ?? null;

  const add = (entity: Entity | null, texts: string[]): void => {
    const clean = texts.map(cleanQuestion).filter(Boolean).slice(0, maxPerTarget);
    if (!clean.length) return;
    out.set(entity, [...(out.get(entity) ?? []), ...clean].slice(0, maxPerTarget));
  };

  // Pull each `"target": … "q": [ … ]` PAIR positionally, rather than JSON.parsing the whole reply.
  //
  // Two failures made whole-document parsing wrong, both seen in a real corpus:
  //
  //   DUPLICATE KEYS. Models emit `{"target":"a","q":[…],"target":"b","q":[…]}` — one object, two
  //   pairs. That is valid JSON and `JSON.parse` keeps only the LAST, so every earlier target's
  //   questions vanished with no error and no way to notice.
  //
  //   TRUNCATION. These questions run long; a reply that hits the output limit mid-array leaves
  //   unbalanced brackets, `JSON.parse` throws, and the whole file's questions were lost — all or
  //   nothing, for a reply that was mostly complete.
  //
  // Scanning pairs is immune to both: it takes every complete pair it finds and stops where the text
  // stops.
  const pair = /"target"\s*:\s*"([^"]*)"\s*,\s*"q"\s*:\s*(\[[^\]]*\])/g;
  let m: RegExpExecArray | null;
  while ((m = pair.exec(reply))) {
    const key = m[1].toLowerCase().trim();
    let texts: string[] = [];
    try { texts = (JSON.parse(m[2]) as unknown[]).map(String); } catch { continue; }
    add(byLabel.get(key) ?? fileTarget, texts);
  }
  if (out.size) return out;

  // No pairs at all. If it LOOKS like JSON, it is a malformed or truncated structured reply, and the
  // line parser would file the raw blob as a question — measured at 2% of one real corpus, each one
  // then costing a full answer call to produce a chunk whose question is unreadable. Storing nothing
  // is strictly better: the triple stays un-asked and the next run retries it.
  if (reply.trim().startsWith('{') || reply.trim().startsWith('[')) return out;

  const lines = parseQuestions(reply, maxPerTarget);
  if (lines.length) out.set(fileTarget, lines);
  return out;
}

/**
 * The FOCUS text for a category.
 *
 * A shipped category has its own tuned prompt file, which is the operator's main surface for
 * changing what a corpus asks about. Anything else — and anything is allowed — gets the generic
 * frame with the angle's name filled in, humanised first so `whyIsDevGae` reads as `why is dev gae`
 * rather than as an identifier the model has to decode before it can use it.
 */
function categoryFocus(category: Category): string {
  const id = `category${category.charAt(0).toUpperCase()}${category.slice(1)}`;
  const bundle = indulgePrompts();
  if (bundle.has(id)) return bundle.get(id);
  return bundle.get('categoryFreeform', { ANGLE: humanise(category) });
}

/** `whyIsDevGae` / `why-is-dev-gae` → `why is dev gae`. */
export function humanise(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
