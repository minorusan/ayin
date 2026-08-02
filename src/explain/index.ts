/**
 * `/explain` — the "tell me the story of this feature" command. Broader than `explore`: `explore`
 * finds and reads code; `/explain` additionally pulls in the feature's real git history and authorship,
 * correlates any Jira tickets referenced in commit messages, and writes the whole thing as a narrative
 * — history and authorship, lifecycle/bugs, composition, and how it's wired up — in plain prose, opened
 * in VS Code. Callable two ways: the interactive `/explain <feature>` command, and the headless
 * `ayin explain "<question>"` CLI subcommand (`index.ts`'s `main()`) — both call `runExplain` directly,
 * so there is exactly one implementation of the pipeline, not one per invocation path.
 *
 * NO DIAGRAM (for now). An earlier version also drew an architecture diagram alongside the report
 * (`tools/diagram.ts`'s validated PlantUML loop). Deliberately dropped per the operator: the report is
 * meant to read like a story a colleague tells you, and a diagram is a separate concern to revisit later
 * — not a bug, not a regression, a scope decision. If diagram support returns, it belongs back here as
 * an explicit opt-in, not bundled unconditionally into every `/explain` call.
 *
 * PIPELINE — deterministic gathering feeds ONE synthesis call, same "evidence before opinion" shape
 * `qa/` and `arduino-explain.ts` already use:
 *
 *   exploreExecute (reused verbatim, `plan/index.ts`'s exact call shape — an agentic loop, real GPU time)
 *   → extractExistingPaths (pure: which of explore's mentioned paths are real files)
 *   → gatherGitHistory + computeBugSignal (pure: git log --follow, deduped, churn/bugfix/authorship counted)
 *   → extractTicketCandidates → jiraTickets (self-validating: a shape match is never trusted alone —
 *     the Maradel backend's `jira` resource is what actually asks the real API, ayin only consumes it)
 *   → ONE llmChat call writes the narrative, in prose, no headings
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { exploreExecute } from '../tools/explore.js';
import { extractExistingPaths } from './paths.js';
import { gatherGitHistory, extractTicketCandidates, computeBugSignal, renderHistoryEvidence } from './git-history.js';
import { jiraTickets } from '../jira.js';
import { llmChat } from '../llm/manager.js';
import { prompts, packagePath } from '../prompts-service.js';
import { openInEditor } from '../editor.js';
import { slugify } from '../tools/diagram.js';
import { projectRoot } from '../qa/probes.js';
import { pushActivity, setActivityDetail } from '../activity.js';
import { log } from '../log.js';

const explainPrompts = prompts.register('explain', packagePath('prompts', 'explain')).bundle;

export interface ExplainOutcome {
  ok: boolean;
  reason?: string;
  reportPath?: string;
  reportOpened?: boolean;
  /** The narrative text itself — a headless caller (`ayin explain "..."`) prints this directly rather
   *  than re-reading the file it was also written to. */
  body?: string;
}

function explainFilename(feature: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `ayin-explain-${slugify(feature) || 'feature'}-${stamp}.md`;
}

function buildJiraBlock(paths: string[], candidates: string[], lookup: Awaited<ReturnType<typeof jiraTickets>> | null): string {
  if (paths.length === 0) return 'JIRA: not checked — no real file could be identified for this feature, so no commit history was gathered to look for ticket references.';
  if (candidates.length === 0) return 'JIRA: no ticket-key-shaped references found in any commit message touching these files.';
  if (!lookup) return 'JIRA: candidates were found but the lookup was skipped.';
  if (!lookup.ok) return `JIRA: unavailable (${lookup.reason}) — do not invent a ticket or reporter to fill this gap.`;
  if (lookup.tickets.length === 0) {
    return `JIRA: ${candidates.length} candidate ticket-key-shaped string(s) found in commit messages (${candidates.join(', ')}), but NONE resolved to a real Jira issue — likely coincidental text (a version string, a part number), not a real ticket. Do not attribute this feature to any of them.`;
  }
  const lines = lookup.tickets.map((t) => `  [${t.key}] ${t.title} — reporter: ${t.reporter ?? 'unknown'}, status: ${t.status}, updated: ${t.updated ?? 'unknown'}`);
  return `JIRA TICKETS LINKED FROM COMMIT MESSAGES (validated against the real API, not just the key shape):\n${lines.join('\n')}`;
}

/**
 * The full pipeline for one feature/path description. Never throws — every stage degrades to an
 * honest gap in the evidence rather than blocking the report; only a totally empty `feature` argument
 * or an exploration that produces nothing usable returns `ok: false`.
 */
export async function runExplain(argText: string, cwd: string = process.cwd()): Promise<ExplainOutcome> {
  const feature = argText.trim();
  if (!feature) return { ok: false, reason: 'Usage: /explain <feature or path to explain> — e.g. /explain the llm resource' };

  const root = projectRoot(cwd);
  const endPhase = pushActivity('Explain', `investigating ${feature}`);
  try {
    // 1. explore — reused verbatim (same call shape plan/index.ts uses), a real agentic loop.
    let exploreFindings = '';
    try {
      exploreFindings = await exploreExecute({
        question: `Explain how this works and exactly where it lives in the codebase (name real files/functions) — including how it's initialized or registered (a DI installer, a startup hook, an entry point), what it depends on, and any config it reads: ${feature}`,
        thorough: 'true',
      });
    } catch (err) {
      log('WARN', 'explain_explore_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    if (!exploreFindings || exploreFindings.length < 20) {
      return { ok: false, reason: `Exploration found nothing usable for "${feature}" — try a more specific area or a real path.` };
    }

    // 2. real file paths — either the argument itself, or extracted from explore's prose. Converted to
    // paths RELATIVE TO THE REPO ROOT before git-log gathering: `cwd` is wherever ayin was launched
    // (e.g. a `backend/` subdirectory), but `git log` below runs with `cwd: root` — a path resolved
    // against `cwd` alone (`src/resources/llm.ts`) would silently mean the wrong file once `root` and
    // `cwd` differ, and `git log` would just report no history instead of erroring, which is the kind
    // of wrong-but-quiet bug this codebase's own "evidence, not assumption" discipline exists to catch.
    setActivityDetail('gathering git history');
    const literalPath = existsSync(resolve(root, feature)) ? feature : (existsSync(resolve(cwd, feature)) ? feature : null);
    const rawPaths = literalPath ? [literalPath] : extractExistingPaths(exploreFindings, cwd);
    const paths = rawPaths
      .map((p) => relative(root, resolve(cwd, p)))
      .filter((p) => p && !p.startsWith('..'));

    const history = paths.length ? gatherGitHistory(paths, root) : { commits: [], byPath: {} };
    const signal = computeBugSignal(history);
    const historyEvidence = paths.length
      ? renderHistoryEvidence(history, signal)
      : 'COMMIT HISTORY: could not identify a real file from the exploration — no git history gathered. Say so; do not invent a timeline.';

    // 3. Jira — self-validating: a key-shaped candidate is proven real by asking Jira, never trusted alone.
    setActivityDetail('checking Jira for linked tickets');
    const candidates = paths.length ? extractTicketCandidates(history.commits) : [];
    const lookup = candidates.length ? await jiraTickets(candidates) : null;
    const jiraBlock = buildJiraBlock(paths, candidates, lookup);

    // 4. synthesis — one call, the whole story in prose, grounded in everything gathered above.
    setActivityDetail('writing the story');
    const body = (await llmChat([{
      role: 'user',
      content: explainPrompts.get('synthesize', {
        FEATURE: feature,
        EXPLORE_FINDINGS: exploreFindings.slice(0, 8000),
        HISTORY_EVIDENCE: historyEvidence,
        JIRA_BLOCK: jiraBlock,
      }),
    }])).trim();

    const reportPath = join(cwd, explainFilename(feature));
    const header = [
      '<!-- Written by ayin /explain. -->',
      `<!-- Asked about: ${feature} -->`,
      `<!-- Files this drew history from: ${paths.length ? paths.join(', ') : '(none identified)'} -->`,
      '',
      `# ${feature}`,
      '',
    ].join('\n');
    writeFileSync(reportPath, `${header}${body}\n`);
    const reportOpened = await openInEditor(reportPath);
    log('INFO', 'explain_report_written', { feature, path: reportPath, paths: String(paths.length), commits: String(history.commits.length), tickets: String(lookup?.ok ? lookup.tickets.length : 0) });

    return { ok: true, reportPath, reportOpened, body };
  } finally {
    endPhase();
  }
}

/** Used by the interactive `/explain` command, which shows this short line in chat — the file (opened
 *  in VS Code) is where the actual story lives. The headless `ayin explain` CLI prints `o.body` itself
 *  instead of calling this — see `runExplainCli` in `index.ts`. */
export function formatExplainOutcome(o: ExplainOutcome): string {
  if (!o.ok) return o.reason ?? 'Nothing to report.';
  return `Report: ${o.reportPath}${o.reportOpened ? ' (opened in editor)' : ' (no editor found on PATH — open it manually)'}`;
}
