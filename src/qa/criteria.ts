/**
 * QA criteria — WHAT the change is being judged against, decided BEFORE the artifacts are read.
 *
 * Two sources, deliberately separated:
 *
 *   BASELINE (deterministic) — the operator's standing bar, derived from which KINDS of file the
 *   turn touched. These are not negotiable and not invented by a model: UI is never allowed to look
 *   like an MVP, a webview must actually be reachable from another machine, code keeps one
 *   responsibility per module, a project carries a README, markdown uses the format's range.
 *
 *   INTENT (one LLM call) — what THIS user asked for across the session, distilled from their own
 *   prompts. The model that writes these has NOT seen the artifacts, on purpose: a judge shown the
 *   answer first writes criteria the answer happens to satisfy. Same anchoring trap the critic in
 *   `agent.ts` avoids by asking its peer for an unanchored conclusion.
 *
 * Derived ONCE per turn and reused across fix passes — the bar must not move while the agent is
 * trying to clear it (and it halves the GPU cost of a three-pass gate).
 */

import { llmChat } from '../llm/manager.js';
import { log } from '../log.js';
import { getPrompt } from '../prompts.js';
import { prompts as promptsService, packagePath } from '../prompts-service.js';
import { recentPrompts } from '../session-record.js';
import type { ChangedFile } from './probes.js';

/**
 * The `qa` namespace — the baseline bar's text. It is the operator's standing standard, which makes
 * it the single most tunable thing in the gate, so it lives in `prompts/qa/*.txt` and is read on
 * every call. A missing id throws: a silently blank criterion is a bar the change cannot fail.
 */
const qaPrompts = promptsService.register('qa', packagePath('prompts', 'qa')).bundle;

export type Dimension = 'ui' | 'webview' | 'code' | 'docs' | 'api' | 'intent';

export interface Criterion {
  id: string;
  dimension: Dimension;
  text: string;
  source: 'baseline' | 'intent';
}

/** Which bars apply, from what the turn actually touched. */
export function dimensionsOf(files: ChangedFile[], webviewApplies: boolean, apiApplies = false): Set<Dimension> {
  const dims = new Set<Dimension>();
  for (const f of files) {
    if (f.kind === 'ui') { dims.add('ui'); dims.add('code'); }
    else if (f.kind === 'code') dims.add('code');
    else if (f.kind === 'doc') dims.add('docs');
  }
  if (webviewApplies) dims.add('webview');
  if (apiApplies) dims.add('api');
  return dims;
}

/** The standing bar: criterion id → dimension it applies to → the `qa` prompt id holding its text. */
const BASELINE: Array<{ id: string; dimension: Dimension; prompt: string }> = [
  { id: 'ui-not-mvp', dimension: 'ui', prompt: 'baselineUiNotMvp' },
  { id: 'webview-reachable', dimension: 'webview', prompt: 'baselineWebviewReachable' },
  { id: 'code-srp', dimension: 'code', prompt: 'baselineCodeSrp' },
  { id: 'code-readme', dimension: 'code', prompt: 'baselineCodeReadme' },
  { id: 'api-researched', dimension: 'api', prompt: 'baselineApiResearched' },
  { id: 'docs-rich', dimension: 'docs', prompt: 'baselineDocsRich' },
];

function baselineFor(dims: Set<Dimension>): Criterion[] {
  return BASELINE.filter((b) => dims.has(b.dimension))
    .map((b) => ({ id: b.id, dimension: b.dimension, text: qaPrompts.get(b.prompt), source: 'baseline' as const }));
}

/** Pull `{"criteria":[…]}` out of whatever the model wrapped it in. */
function parseIntentCriteria(raw: string): string[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as { criteria?: unknown };
      if (Array.isArray(obj.criteria)) {
        return obj.criteria
          .map((c) => (typeof c === 'string' ? c : typeof (c as { text?: unknown })?.text === 'string' ? String((c as { text: string }).text) : ''))
          .map((s) => s.trim())
          .filter((s) => s.length > 8)
          .slice(0, 6);
      }
    } catch { /* fall through to line scraping */ }
  }
  // Fallback: numbered or bulleted lines. A model that ignores the JSON contract still said something useful.
  return raw
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 12 && !/^[{}[\]"]/.test(l))
    .slice(0, 6);
}

/**
 * Baseline + intent criteria for this turn.
 *
 * Never throws: with the model down, the baseline alone is still a real bar, and a QA gate that
 * crashes the turn it was meant to protect would be worse than no gate.
 */
export async function deriveCriteria(files: ChangedFile[], goal: string, dims: Set<Dimension>): Promise<Criterion[]> {
  const baseline = baselineFor(dims);
  const prompts = recentPrompts(12);
  if (prompts.length === 0) return baseline;

  const fileList = files.slice(0, 25).map((f) => `${f.path} [${f.kind}]`).join('\n');
  const promptList = prompts.map((p, i) => `${i + 1}. ${p.slice(0, 600)}`).join('\n');

  try {
    const raw = await llmChat([{
      role: 'user',
      content: getPrompt('qaCriteria', {
        GOAL: goal || '(none derived)',
        PROMPTS: promptList,
        FILES: fileList || '(none)',
      }),
    }]);
    const intent = parseIntentCriteria(raw).map((text, i) => ({
      id: `intent-${i + 1}`,
      dimension: 'intent' as Dimension,
      text,
      source: 'intent' as const,
    }));
    log('INFO', 'qa_criteria', { baseline: String(baseline.length), intent: String(intent.length) });
    return [...baseline, ...intent];
  } catch (err) {
    log('WARN', 'qa_criteria_failed', { error: err instanceof Error ? err.message : String(err) });
    return baseline;
  }
}

/** The criteria as a numbered block for the review prompt. */
export function renderCriteria(criteria: Criterion[]): string {
  return criteria.map((c) => `[${c.id}] (${c.dimension}) ${c.text}`).join('\n');
}
