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
import { recentPrompts } from '../session-record.js';
import type { ChangedFile } from './probes.js';

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

const BASELINE: Array<{ id: string; dimension: Dimension; text: string }> = [
  {
    id: 'ui-not-mvp',
    dimension: 'ui',
    text: 'The UI is FINISHED, not an MVP. Reading the code alone must show real states (empty, loading, error), '
      + 'consistent spacing and typography, no placeholder/lorem/TODO text, no dead handlers or stub buttons, '
      + 'and no "good enough for now" scaffolding left visible to a user.',
  },
  {
    id: 'webview-reachable',
    dimension: 'webview',
    text: 'If this change involves a webview, it is actually RUNNING and reachable from another machine on the '
      + 'local network — bound to all interfaces, not loopback-only. Evidence, not intention.',
  },
  {
    id: 'code-srp',
    dimension: 'code',
    text: 'Single responsibility is kept: each file/module changed here does ONE job. A module mixing unrelated '
      + 'concerns (transport + rendering + persistence), or a function that grew several jobs, is a failure — '
      + 'name the split that should happen.',
  },
  {
    id: 'code-readme',
    dimension: 'code',
    text: 'The project README.md is maintained: it exists (created if the project had none) and still describes '
      + 'reality after this change — entry points, how to run it, what changed in behaviour.',
  },
  {
    id: 'api-researched',
    dimension: 'api',
    text: 'This change talks to a third-party API, so it must match the CURRENT published API — not an API '
      + 'remembered from training data. Base URL, auth scheme, endpoint paths, parameter and field names, and '
      + 'version must be the ones the vendor documents TODAY, and the code must handle the failures a real '
      + 'service produces (non-2xx, 401/403, 429 with rate limiting, timeouts). If nothing in this change shows '
      + 'the current API was actually looked up — no cited docs, no fresh research, no verified live call — that '
      + 'is a failure: a plausible-looking integration against a renamed field or a deprecated endpoint fails '
      + 'only in production.',
  },
  {
    id: 'docs-rich',
    dimension: 'docs',
    text: 'Markdown uses the range the format affords where it helps comprehension: headings, tables, '
      + 'language-tagged code fences, lists, links, emphasis. A wall of undifferentiated prose is a failure.',
  },
];

function baselineFor(dims: Set<Dimension>): Criterion[] {
  return BASELINE.filter((b) => dims.has(b.dimension)).map((b) => ({ ...b, source: 'baseline' as const }));
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
