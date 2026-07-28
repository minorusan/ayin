/**
 * QA review — one pass of judgement: criteria + probe evidence + the artifacts themselves → verdict.
 *
 * LONG INVESTIGATION, SHORT ANSWER. The judge is handed a lot (every changed file, clipped, plus the
 * deterministic evidence) and is required to answer in a couple of sentences plus a list of concrete
 * issues. Each issue must name a file and a fix, because the next thing that reads it is the agent
 * doing the repair — a verdict like "could be better" produces another aimless round.
 *
 * FAILING IS EXPENSIVE, SO IT MUST BE EARNED. A failed pass costs the user real GPU time on a shared
 * card. The prompt therefore forbids failing on style preference, on anything not visible in the
 * artifacts or the evidence, and on work the user did not ask for — the classic way an automated
 * reviewer turns a finished task into an endless one.
 */

import { readFileSync } from 'node:fs';
import { llmChat } from '../llm/manager.js';
import { log } from '../log.js';
import { getPrompt } from '../prompts.js';
import { renderCriteria, type Criterion } from './criteria.js';
import { renderEvidence, type ChangedFile, type Evidence } from './probes.js';

export interface QaIssue {
  criterion: string;
  file: string;
  problem: string;
  fix: string;
}

export interface QaVerdict {
  verdict: 'pass' | 'fail' | 'unknown';
  summary: string;
  issues: QaIssue[];
}

const PER_FILE_CHARS = 6000;
const TOTAL_CHARS = 30_000;

/** The artifacts, clipped to a budget. Truncation is announced — never silently dropped. */
export function renderArtifacts(files: ChangedFile[]): string {
  const parts: string[] = [];
  let budget = TOTAL_CHARS;
  let skipped = 0;
  for (const f of files) {
    if (!f.exists) { parts.push(`--- ${f.path} — MISSING (deleted or moved)`); continue; }
    if (budget <= 0) { skipped++; continue; }
    let text = '';
    try { text = readFileSync(f.path, 'utf-8'); } catch { parts.push(`--- ${f.path} — unreadable`); continue; }
    const cap = Math.min(PER_FILE_CHARS, budget);
    const body = text.length > cap ? `${text.slice(0, cap)}\n…(+${text.length - cap} chars not shown)` : text;
    budget -= body.length;
    parts.push(`--- ${f.path} [${f.kind}] ---\n${body}`);
  }
  if (skipped > 0) parts.push(`(${skipped} more changed file(s) not shown — review budget exhausted)`);
  return parts.join('\n\n');
}

function parseVerdict(raw: string): QaVerdict {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as {
        verdict?: unknown; summary?: unknown; issues?: unknown;
      };
      const v = String(obj.verdict ?? '').toLowerCase();
      const issues: QaIssue[] = Array.isArray(obj.issues)
        ? obj.issues.slice(0, 10).map((i) => {
          const o = (i ?? {}) as Record<string, unknown>;
          return {
            criterion: String(o.criterion ?? o.id ?? '?'),
            file: String(o.file ?? o.path ?? '?'),
            problem: String(o.problem ?? o.issue ?? '').slice(0, 500),
            fix: String(o.fix ?? o.action ?? '').slice(0, 500),
          };
        }).filter((i) => i.problem.length > 0)
        : [];
      const verdict: QaVerdict['verdict'] = v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : issues.length > 0 ? 'fail' : 'unknown';
      return { verdict, summary: String(obj.summary ?? '').slice(0, 600).trim(), issues };
    } catch { /* fall through */ }
  }
  // No parseable JSON. Read the plain text conservatively: only an explicit FAIL fails.
  const upper = raw.toUpperCase();
  const failed = /\bFAIL\b/.test(upper) && !/\bPASS\b/.test(upper);
  return {
    verdict: failed ? 'fail' : 'unknown',
    summary: raw.trim().split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 400),
    issues: [],
  };
}

/**
 * One review pass. Never throws — an LLM failure yields `unknown`, which the gate treats as "do not
 * block the user", because a broken judge must not hold a finished answer hostage.
 */
export async function reviewArtifacts(
  criteria: Criterion[],
  evidence: Evidence,
  goal: string,
  answer: string,
  pass: number,
): Promise<QaVerdict> {
  try {
    const raw = await llmChat([{
      role: 'user',
      content: getPrompt('qaReview', {
        GOAL: goal || '(none derived)',
        PASS: String(pass),
        CRITERIA: renderCriteria(criteria),
        EVIDENCE: renderEvidence(evidence),
        ARTIFACTS: renderArtifacts(evidence.files),
        ANSWER: answer.slice(0, 4000),
      }),
    }]);
    const v = parseVerdict(raw);
    log('INFO', 'qa_review', { pass: String(pass), verdict: v.verdict, issues: String(v.issues.length), summary: v.summary.slice(0, 200) });
    return v;
  } catch (err) {
    log('WARN', 'qa_review_failed', { pass: String(pass), error: err instanceof Error ? err.message : String(err) });
    return { verdict: 'unknown', summary: 'QA review call failed — verdict unavailable.', issues: [] };
  }
}
