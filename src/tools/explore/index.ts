/**
 * explore — deterministic code localization. No model, no loop, no shell.
 *
 * The pipeline, all of it deterministic:
 *
 *     question ─▶ terms ─▶ probes (parallel) ─▶ spans read from disk ─▶ glue ─▶ rank ─▶ format
 *
 * Same signature as the version it replaces (`{question, context?, cwd?} → string`), so the five
 * existing callers — plan, explain, indulge's discover and answer — keep working; what changes is
 * that the string they get back is evidence rather than prose, and it arrives in well under a second
 * instead of minutes.
 *
 * WHY NO MODEL. Measured on this hardware: a full search battery over a 462 MB repository takes
 * ~422 ms; one call to the local 30B takes 15–20 s. A model call costs roughly 100 searches. The
 * previous version spent up to twelve of them per invocation and, across a day of real use, produced
 * an answer once in six tries — while 27 of its 28 shell commands returned real data. The searching
 * was never the problem.
 *
 * WHAT THIS IS FOR. `grep` answers "where does this string appear". This answers "what is connected
 * to what" — the Unity GUID that binds a script to a prefab, the animation clip that calls a method
 * by name, the string key that joins two TypeScript files with no import between them. Those edges
 * are not in the text, and deriving them is the only reason this tool should exist.
 */

import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { toolLog, toolReport } from '../runtime.js';
import { extractTerms } from './terms.js';
import { parseGrepLine, readSpan, runAll } from './search.js';
import { rankAndTrim } from './rank.js';
import { formatResult } from './format.js';
import { unity } from './projects/unity.js';
import { typescript } from './projects/typescript.js';
import { generic } from './projects/generic.js';
import type { Attempt, ExploreResult, Finding, ProjectExplorer } from './types.js';

/** Most specific first; `generic` always matches. */
const EXPLORERS: ProjectExplorer[] = [unity, typescript, generic];

export function pickExplorer(root: string): ProjectExplorer {
  return EXPLORERS.find((e) => e.matches(root)) ?? generic;
}

/**
 * How many identifier candidates to actually search.
 *
 * FOUR, AND RAISING IT WAS TRIED AND REVERTED. The reasoning for more was that searching is nearly
 * free (~0.5s for the whole battery versus 15-20s for one model call), and on the tool's own terms it
 * worked: at seven terms a vague question — "time bonus score multiplier solitaire streak" — returned
 * both ends of the coupling in one call instead of one end.
 *
 * The AGENT then did worse. Same model, same repository, same question: at four terms it answered
 * correctly in 12 tool calls; at seven it named the wrong file and the wrong mechanism, took 25 tool
 * calls, and looped, repeating its conclusion five times without terminating. More findings is more
 * context competing for the same attention, and the extra hits were adjacent code rather than the
 * answer. Breadth is cheap for the TOOL and expensive for the MODEL — the two costs are not the same
 * budget, and only the second one decides whether the turn is right.
 *
 * Re-testing this needs more than n=1 per side; it is written down so the next attempt starts from
 * the measurement rather than from the intuition, which points the wrong way here.
 */
const MAX_TERMS = 4;
/** Context lines quoted around a hit. Enough to read, small enough to stay evidence. */
const CONTEXT_BEFORE = 1;
const CONTEXT_AFTER = 3;

export async function exploreExecute(params: Record<string, string>): Promise<string> {
  const question = (params.question ?? '').trim();
  if (!question) return 'Error: question required';
  const root = params.cwd || process.cwd();
  const started = Date.now();

  const explorer = pickExplorer(root);
  const terms = extractTerms(question);
  // Literals the user quoted are searched exactly; derived identifiers come next.
  const search = [...terms.literals, ...terms.identifiers].slice(0, MAX_TERMS);

  toolReport(`explore · ${explorer.id} · ${search.join(', ') || 'no terms'}`);

  if (search.length === 0) {
    return formatResult({
      question, project: explorer.id, findings: [], attempts: [], terms: [], elapsedMs: Date.now() - started,
    });
  }

  // EVERY PROBE FOR EVERY TERM, AT ONCE. Breadth costs milliseconds here, which is the whole reason
  // the model was removed: there is nothing to decide when trying everything is this cheap.
  const planned = search.flatMap((t) => explorer.plan(t, root).map((p) => ({ ...p, term: t })));
  const results = await runAll(planned.map((p) => ({ strategy: p.strategy, argv: p.argv })), root);

  const attempts: Attempt[] = results.map((r, i) => ({
    strategy: `${planned[i].strategy}(${planned[i].term})`,
    probe: r.result.printable,
    hits: r.result.lines.length,
  }));

  const findings: Finding[] = [];
  for (let i = 0; i < results.length; i++) {
    const { reason, term } = planned[i];
    for (const line of results[i].result.lines) {
      // `find` returns bare paths; grep returns path:line:text.
      const parsed = parseGrepLine(line);
      const relPath = (parsed?.file ?? line).replace(/^\.\//, '');
      const abs = join(root, relPath);
      if (!existsSync(abs)) continue;

      if (!parsed) {
        findings.push({ span: { file: relPath, fromLine: 1, toLine: 1, text: '' }, reason, term, score: 0 });
        continue;
      }
      // READ THE SPAN FROM DISK. A finding that cannot be re-read is dropped rather than reported —
      // this is what makes every quoted line true at answer time.
      const got = readSpan(abs, parsed.line - CONTEXT_BEFORE, parsed.line + CONTEXT_AFTER);
      if (!got) continue;
      findings.push({
        span: {
          file: relPath,
          fromLine: Math.max(1, parsed.line - CONTEXT_BEFORE),
          toLine: Math.max(1, parsed.line - CONTEXT_BEFORE) + got.text.split('\n').length - 1,
          text: got.text,
        },
        reason,
        term,
        symbol: explorer.symbolAt(got.lines, parsed.line),
        score: 0,
      });
    }
  }

  // The non-textual edges — the reason this tool exists rather than being a grep wrapper.
  let glued: Finding[] = [];
  try {
    glued = await explorer.glue(rankAndTrim(findings, 6), root);
  } catch (e) {
    toolLog().warn('explore_glue_failed', { error: e instanceof Error ? e.message : String(e) });
  }

  const result: ExploreResult = {
    question,
    project: explorer.id,
    findings: rankAndTrim([...findings, ...glued], 8),
    attempts,
    terms: search,
    elapsedMs: Date.now() - started,
  };

  toolLog().info('explore_done', {
    project: explorer.id,
    terms: String(search.length),
    probes: String(attempts.length),
    findings: String(result.findings.length),
    ms: String(result.elapsedMs),
  });
  toolReport(`explore → ${result.findings.length} finding(s) in ${result.elapsedMs}ms`);
  return formatResult(result);
}

export { relative, sep };
