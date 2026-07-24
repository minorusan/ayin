/**
 * ayin rag — grounded Q&A corpus generator ("rag-e-fire").
 *
 *   ayin rag --repo <path> --questions "q1" "q2" …   (--pathToRepo is an alias for --repo)
 *
 * For each question: run a focused explore investigation against the repo (real commands, real
 * excerpts), then synthesize a detailed GROUNDED markdown answer (file paths, line numbers, code
 * quotes). After every initial question is answered, ask the model for 5 more close-to-domain
 * questions per initial one and answer those the same way.
 *
 * Every answer is saved on the nuk through the backend **logs resource** (`rag.save`), one store
 * per repo (~/.maradel/logs/rag/<repoKey>/<slug>.md + .json) — the corpus we will chunk,
 * vectorize and retrieve later. Saving goes through the resource door, so a run from any machine
 * on the LAN lands in the same store.
 *
 * Survives interruption: docs already in the store are skipped on re-run (resume = re-run the
 * same command), and generated follow-up questions are persisted on the parent doc's meta before
 * they are answered, so a crash mid-followups resumes with the SAME questions, not fresh ones.
 * The LLM is held as the `ayin` authority for the whole run (keepalive-slid), released on exit.
 */

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { llmChat, refreshActiveModel } from './llm/manager.js';
import { connect } from './connection.js';
import { exploreExecute } from './tools/explore.js';
import { resourceOp, acquireLlm, type LlmHold } from './resource-client.js';
import { log } from './log.js';

const FOLLOWUPS_PER_QUESTION = 5;

function out(line: string): void {
  process.stdout.write(line + '\n');
}

function gitToplevel(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let s = '';
    child.stdout.on('data', (c: Buffer) => { s += c.toString(); });
    child.on('close', (code) => resolve(code === 0 ? s.trim() : null));
    child.on('error', () => resolve(null));
  });
}

interface RagDocMeta {
  repoPath: string;
  kind: 'primary' | 'followup';
  parent?: string;              // parent question (for followups)
  followupQuestions?: string[]; // persisted on the parent BEFORE answering them (resume-safe)
  groundingWarnings?: string[]; // fabrication-guard hits (blocks stripped) — treat doc with care
  model?: string;
}

// ── answer one question ──────────────────────────────────────────────

async function answerQuestion(question: string, repoKey: string, repoPath: string): Promise<{ md: string; warnings: string[] }> {
  out(`  exploring: ${question}`);
  let grounded = await exploreExecute({
    question,
    context: 'The answer will seed a knowledge base about this repository. Prefer verbatim code excerpts, file paths and line numbers over prose.',
    thorough: 'true',
  });

  // Gap-fill pass: one more focused explore for the biggest hole in the gathered data.
  const gap = await llmChat([
    { role: 'system', content: 'You reply with a single line: either one focused investigation question, or exactly NONE.' },
    {
      role: 'user',
      content: `Question to answer about a repo: ${question}\n\nData gathered so far:\n${grounded.substring(0, 6000)}\n\nWhat is the SINGLE most important missing piece needed to answer well — e.g. the actual body of a key file/function that is only named so far? Reply with one focused question for a follow-up investigation (mention exact file paths if known), or NONE if the data already suffices.`,
    },
  ]).catch(() => 'NONE');
  const gapQ = gap.trim().split('\n')[0];
  if (gapQ && !/^\s*NONE\b/i.test(gapQ) && gapQ.length > 15) {
    out(`  gap-fill explore: ${gapQ.substring(0, 100)}`);
    const more = await exploreExecute({ question: gapQ, thorough: 'true' });
    grounded += `\n\n--- ADDITIONAL INVESTIGATION (${gapQ}) ---\n${more}`;
  }

  out(`  synthesizing answer (${grounded.length} bytes of grounded data)…`);
  let { md, warnings } = await synthesize(question, grounded, repoKey, repoPath);
  return { md, warnings };
}

/** Every non-trivial line of every code fence must exist in the investigation data (whitespace-
 *  collapsed substring). A fence with <50% matching lines is FABRICATED. One retry, then strip. */
function ungroundedFences(answer: string, grounded: string): string[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const hay = norm(grounded);
  const bad: string[] = [];
  const fences = answer.match(/```[a-z]*\n[\s\S]*?```/g) || [];
  for (const fence of fences) {
    const lines = fence.split('\n').slice(1, -1).map(norm).filter(l => l.length > 15);
    if (lines.length === 0) continue;
    const found = lines.filter(l => hay.includes(l)).length;
    if (found / lines.length < 0.5) bad.push(fence);
  }
  return bad;
}

async function synthesize(question: string, grounded: string, repoKey: string, repoPath: string): Promise<{ md: string; warnings: string[] }> {
  const warnings: string[] = [];
  let answer = await llmChat([
    {
      role: 'system',
      content: 'You are a senior engineer writing knowledge-base articles about a codebase. You write in clean markdown. You are rigorous about grounding: every claim cites a file path (and line numbers where known), and code is quoted verbatim from the provided investigation data. You never invent code or paths.',
    },
    {
      role: 'user',
      content: `Write a detailed, self-contained knowledge-base answer to this question about the repository "${repoKey}".

**Question:** ${question}

**Investigation data (verbatim command output from the repo — your ONLY source of truth):**
${grounded}

Rules:
- Ground EVERYTHING in the investigation data: quote the actual code, name the actual files (with line numbers when the data shows them). If the data doesn't cover part of the question, say exactly what is missing — do NOT fill gaps from general knowledge.
- Structure: start with a direct 2-3 sentence answer, then the details (code excerpts + explanation), then a "Sources" list of the files/locations referenced.
- Self-contained: a reader sees ONLY your answer, never the investigation data.
- Markdown only, no preamble.`,
    },
  ]);

  // Fabrication guard — code the model "quotes" MUST exist in the investigation data.
  let bad = ungroundedFences(answer, grounded);
  if (bad.length > 0) {
    out(`  ⚠ ${bad.length} fabricated code block(s) — re-synthesizing`);
    log('WARN', 'rag_fabrication_retry', { question: question.substring(0, 80), fences: String(bad.length) });
    answer = await llmChat([
      { role: 'system', content: 'You are a rigorous fact-checker rewriting a knowledge-base article. Markdown only, no preamble.' },
      {
        role: 'user',
        content: `The draft below QUOTES CODE THAT DOES NOT EXIST in the investigation data — that is fabrication and it poisons a knowledge base. Rewrite the draft so that EVERY code block is copied verbatim from the investigation data (or removed). Where the data has no code for a claim, state plainly what the data does and does not show instead of inventing.\n\n**Question:** ${question}\n\n**Investigation data (the ONLY permitted source of quotes):**\n${grounded}\n\n**Draft to fix:**\n${answer}`,
      },
    ]);
    bad = ungroundedFences(answer, grounded);
    if (bad.length > 0) {
      // Still fabricating → strip the blocks and say so, loudly, in doc + meta.
      for (const fence of bad) {
        answer = answer.replace(fence, '> _(removed: a code block here was not present in the investigation data — fabricated by the model)_');
      }
      warnings.push(`${bad.length} fabricated code block(s) stripped after retry`);
      log('WARN', 'rag_fabrication_stripped', { question: question.substring(0, 80), fences: String(bad.length) });
    }
  }

  const banner = warnings.length > 0 ? `\n> ⚠ **grounding warnings:** ${warnings.join('; ')}\n` : '';
  const md = `# ${question}

> repo: **${repoKey}** (\`${repoPath}\`) · generated by \`ayin rag\` · ${new Date().toISOString()}
${banner}
${answer.trim()}
`;
  return { md, warnings };
}

async function saveDoc(repoKey: string, question: string, markdown: string, meta: RagDocMeta): Promise<string | null> {
  const saved = await resourceOp('logs', 'rag.save', { repo: repoKey, question, markdown, meta }, 15_000);
  if (!saved || !saved.slug) return null;
  return String(saved.slug);
}

// ── follow-up question generation ────────────────────────────────────

function parseQuestionList(raw: string): string[] {
  const found: string[] = [];
  const push = (s: unknown) => {
    const t = String(s).trim();
    if (t.length > 10 && !found.includes(t)) found.push(t);
  };

  // 1. One JSON array spanning the whole response.
  const aStart = raw.indexOf('[');
  const aEnd = raw.lastIndexOf(']');
  if (aStart !== -1 && aEnd > aStart) {
    try {
      const arr = JSON.parse(raw.substring(aStart, aEnd + 1));
      if (Array.isArray(arr)) arr.forEach(push);
    } catch { /* fall through */ }
  }

  // 2. Per-line JSON — qwen often emits ONE single-element array PER LINE: ["q1"]\n["q2"]…
  if (found.length === 0) {
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const v = JSON.parse(t);
        if (Array.isArray(v)) v.forEach(push);
        else if (typeof v === 'string') push(v);
      } catch { /* not a JSON line */ }
    }
  }

  // 3. Loose: numbered / bulleted / quoted lines that end in a question mark.
  if (found.length === 0) {
    for (const line of raw.split('\n')) {
      const cleaned = line
        .replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '')
        .replace(/^[\["'`]+/, '')
        .replace(/[\]"'`,]+\s*$/, '')
        .trim();
      if (cleaned.length > 10 && /\?$/.test(cleaned)) push(cleaned);
    }
  }

  return found.slice(0, FOLLOWUPS_PER_QUESTION);
}

async function generateFollowups(question: string, answerMd: string): Promise<string[]> {
  const prompt = {
    role: 'user',
    content: `A knowledge base about a code repository just answered this question:

**Question:** ${question}

**Answer:**
${answerMd.substring(0, 6000)}

Propose exactly ${FOLLOWUPS_PER_QUESTION} MORE questions, close to this domain, that a developer working with this code would naturally ask next. Each must be answerable by reading this repository (not general programming trivia), specific, and non-overlapping with the original question and with each other. Refer to files/classes by the EXACT names used in the answer.

Respond with ONLY a JSON array of ${FOLLOWUPS_PER_QUESTION} strings.`,
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await llmChat([
      { role: 'system', content: 'You respond with a raw JSON array of strings. No prose, no markdown fences.' },
      prompt,
    ]);
    const qs = parseQuestionList(raw);
    if (qs.length > 0) return qs;
    log('WARN', 'rag_followups_unparseable', { attempt: String(attempt), preview: raw.substring(0, 300) });
  }
  return [];
}

// ── main ─────────────────────────────────────────────────────────────

export async function runRag(args: string[]): Promise<void> {
  // --repo/--pathToRepo <path>; --questions consumes every following non-flag arg.
  let repoArg: string | null = null;
  const questions: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' || args[i] === '--pathToRepo') { repoArg = args[++i] ?? null; continue; }
    if (args[i] === '--questions') {
      for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) { questions.push(args[j]); i = j; }
      continue;
    }
  }
  if (!repoArg || questions.length === 0) {
    process.stderr.write('usage: ayin rag --repo <path> --questions "q1" ["q2" …]\n');
    process.exit(1);
  }

  const repoPath = (await gitToplevel(repoArg)) ?? repoArg;
  const repoKey = basename(repoPath).toLowerCase();
  process.chdir(repoPath); // explore runs its commands in cwd

  await connect();

  // Existing docs → skip set (resume-on-rerun) + persisted follow-up questions.
  const listing = await resourceOp('logs', 'rag.list', { repo: repoKey }, 15_000);
  if (listing === null) {
    process.stderr.write(`ayin rag: backend logs resource unreachable — the store lives on the nuk, refusing to run without it.\n`);
    process.exit(1);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = new Map<string, any>((listing.docs ?? []).map((d: any) => [String(d.question), d]));

  // One door: hold the llm as `ayin` for the whole run.
  const hold: LlmHold = await acquireLlm('ayin rag: corpus generation');
  if (hold === 'busy') {
    process.stderr.write('ayin rag: llm resource busy — try again when it frees (reviews defer, rag runs are interactive enough to just retry).\n');
    process.exit(2);
  }
  if (typeof hold === 'object') out('llm acquired (ayin) — backend swapping to the coder model');
  await refreshActiveModel().catch(() => {});

  const release = async () => { if (typeof hold === 'object') await hold.release(); };
  process.on('SIGINT', () => { void release().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void release().then(() => process.exit(0)); });

  const results: Array<{ question: string; slug: string | null; kind: string; parent?: string }> = [];

  try {
    // Phase 1 — answer the initial questions (domain exploration).
    const primaryAnswers = new Map<string, string>(); // question → answer md
    for (const q of questions) {
      out(`[primary] ${q}`);
      if (existing.has(q)) {
        out('  already in store — skipping (delete the doc to re-answer)');
        const got = await resourceOp('logs', 'rag.get', { repo: repoKey, slug: existing.get(q).slug }, 15_000);
        if (got?.markdown) primaryAnswers.set(q, String(got.markdown));
        results.push({ question: q, slug: String(existing.get(q).slug), kind: 'primary' });
        continue;
      }
      const { md, warnings } = await answerQuestion(q, repoKey, repoPath);
      const slug = await saveDoc(repoKey, q, md, {
        repoPath, kind: 'primary', ...(warnings.length ? { groundingWarnings: warnings } : {}),
      });
      if (!slug) throw new Error('rag.save failed — backend down mid-run?');
      primaryAnswers.set(q, md);
      results.push({ question: q, slug, kind: 'primary' });
      out(`  saved: ${slug}`);
      log('INFO', 'rag_primary_saved', { repo: repoKey, slug });
    }

    // Phase 2 — per initial question: 5 close-to-domain follow-ups, answered the same way.
    for (const q of questions) {
      const answerMd = primaryAnswers.get(q);
      if (!answerMd) continue;

      // Reuse persisted follow-ups if this parent already generated them (resume-safe).
      const parentDoc = existing.get(q)
        ?? (await resourceOp('logs', 'rag.list', { repo: repoKey }, 15_000))?.docs?.find((d: { question: string }) => d.question === q);
      let followups: string[] = parentDoc?.meta?.followupQuestions ?? [];

      if (followups.length === 0) {
        out(`[followups] generating ${FOLLOWUPS_PER_QUESTION} for: ${q}`);
        followups = await generateFollowups(q, answerMd);
        if (followups.length === 0) { out('  follow-up generation returned nothing usable — skipping'); continue; }
        // Persist the list on the parent BEFORE answering, so a crash resumes with the same set.
        await saveDoc(repoKey, q, answerMd, { repoPath, kind: 'primary', followupQuestions: followups });
      } else {
        out(`[followups] reusing ${followups.length} persisted follow-ups for: ${q}`);
      }

      const freshListing = await resourceOp('logs', 'rag.list', { repo: repoKey }, 15_000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const done = new Set<string>((freshListing?.docs ?? []).map((d: any) => String(d.question)));

      for (const fq of followups) {
        out(`[followup] ${fq}`);
        if (done.has(fq)) { out('  already in store — skipping'); continue; }
        const { md, warnings } = await answerQuestion(fq, repoKey, repoPath);
        const slug = await saveDoc(repoKey, fq, md, {
          repoPath, kind: 'followup', parent: q, ...(warnings.length ? { groundingWarnings: warnings } : {}),
        });
        if (!slug) throw new Error('rag.save failed — backend down mid-run?');
        results.push({ question: fq, slug, kind: 'followup', parent: q });
        out(`  saved: ${slug}`);
        log('INFO', 'rag_followup_saved', { repo: repoKey, slug, parent: q.substring(0, 60) });
      }
    }
  } finally {
    await release();
  }

  // Machine-readable run summary (the per-question .json lives in the store next to each .md).
  out(JSON.stringify({ repo: repoKey, repoPath, store: `~/.maradel/logs/rag/${repoKey}/`, docs: results }, null, 2));
  process.exit(0);
}
