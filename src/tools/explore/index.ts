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

import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
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

/** How far up to look for a project marker before giving up. */
const MAX_WALK_UP = 8;

/**
 * Find the PROJECT root, not merely the directory we happen to be standing in.
 *
 * `matches()` tests one directory, so testing only the cwd means a session started anywhere below the
 * project root — `…/solitairesmash/Assets/Games/Foo`, or a monorepo package — silently degrades to the
 * generic explorer. Observed in real use on a Unity project: `explore · generic`, 0 findings in 51 ms,
 * because `Assets/` and `ProjectSettings/` were one level up and nothing looked there. The generic
 * explorer greps every file type in the tree, so on a Unity repo it is both slower and blind to the
 * only edges worth having — GUID references, animation events, asmdef boundaries.
 *
 * Walking up is cheap (a few `existsSync` calls) and turns a silent downgrade into a correct answer.
 */
export function resolveProject(start: string): { root: string; explorer: ProjectExplorer } {
  let dir = start;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const hit = EXPLORERS.find((e) => e !== generic && e.matches(dir));
    if (hit) return { root: dir, explorer: hit };
    const up = dirname(dir);
    if (up === dir) break; // filesystem root
    dir = up;
  }
  return { root: start, explorer: generic };
}

/**
 * Absolute paths the caller mentioned, best first.
 *
 * `context` is where the model puts the file it is actually asking about — a stack frame, the path it
 * just read. It was DECLARED by the tool and never read, so a model helpfully passing
 * `…/solitairesmash/Assets/Games/…` had it discarded and got a generic search of the wrong tree. A
 * path in the context is the strongest hint available about which project the question is about.
 */
export function pathsIn(text: string): string[] {
  if (!text) return [];
  return [...new Set(text.match(/(?:[A-Za-z]:)?[\\/][\w.\-+/\\]{3,}/g) ?? [])]
    .map((p) => p.replace(/[),.;]+$/, ''))
    .filter((p) => existsSync(p));
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
  const started = Date.now();

  // WHERE to search, decided from everything the caller gave us rather than from the cwd alone:
  // an explicit cwd, then any real path in `context`, then the process cwd — each walked UP to the
  // nearest project marker. A question about a Unity project must reach the Unity explorer even when
  // the session was started three directories inside it.
  const contextPaths = pathsIn(params.context ?? '');
  const starts = [
    params.cwd,
    ...contextPaths.map((p) => (statSync(p, { throwIfNoEntry: false })?.isDirectory() ? p : dirname(p))),
    process.cwd(),
  ].filter((d): d is string => Boolean(d) && existsSync(d));

  let resolved = { root: starts[0] ?? process.cwd(), explorer: generic as ProjectExplorer };
  for (const s of starts) {
    const r = resolveProject(s);
    if (r.explorer !== generic) { resolved = r; break; }
  }
  const { root, explorer } = resolved;
  const terms = extractTerms(question);
  // Literals the user quoted are searched exactly; derived identifiers come next.
  const search = [...terms.literals, ...terms.identifiers].slice(0, MAX_TERMS);

  const rootNote = root === process.cwd() ? '' : ` · in ${relative(process.cwd(), root) || root}`;
  toolReport(`explore · ${explorer.id}${rootNote} · ${search.join(', ') || 'no terms'}`);

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

  // WIDEN WHEN THE JOINED FORMS FIND NOTHING.
  //
  // A question about a CONCEPT rather than a symbol — "bingo gameplay", the kind indulge asks to find
  // a domain's files — yields `bingoGameplay`/`BingoGameplay`, and nothing is called that. The code
  // lives at `Assets/Games/Bingo/Gameplay/…`, where the two words are PATH SEGMENTS. Measured on a
  // real corpus build: 0 seed files for "bingo gameplay" while "resource management" found 7, purely
  // because a `ResourceManagement` class happened to exist. That is luck, not localization.
  //
  // So when the joined forms come back empty, search the individual words. It costs one extra battery
  // only on the searches that already failed, and it is what makes a concept findable at all.
  if (findings.length === 0 && terms.words.length) {
    const wordTerms = terms.words.filter((w) => w.length >= 3).slice(0, MAX_TERMS);
    if (wordTerms.length) {
      toolReport(`explore · nothing for the joined forms — widening to ${wordTerms.join(', ')}`);
      const wide = wordTerms.flatMap((w) => explorer.plan(w, root).map((pl) => ({ ...pl, term: w })));
      const wideResults = await runAll(wide.map((pl) => ({ strategy: pl.strategy, argv: pl.argv })), root);
      for (let i = 0; i < wideResults.length; i++) {
        const { reason, term } = wide[i];
        for (const line of wideResults[i].result.lines) {
          const parsed = parseGrepLine(line);
          const relPath = (parsed?.file ?? line).replace(/^\.\//, '');
          if (!existsSync(join(root, relPath))) continue;
          if (!parsed) {
            findings.push({ span: { file: relPath, fromLine: 1, toLine: 1, text: '' }, reason, term, score: 0 });
            continue;
          }
          const got = readSpan(join(root, relPath), parsed.line - CONTEXT_BEFORE, parsed.line + CONTEXT_AFTER);
          if (!got) continue;
          findings.push({
            span: {
              file: relPath,
              fromLine: Math.max(1, parsed.line - CONTEXT_BEFORE),
              toLine: Math.max(1, parsed.line - CONTEXT_BEFORE) + got.text.split('\n').length - 1,
              text: got.text,
            },
            reason, term, symbol: explorer.symbolAt(got.lines, parsed.line), score: 0,
          });
        }
      }
      attempts.push(...wideResults.map((r, i) => ({
        strategy: `widened:${wide[i].strategy}(${wide[i].term})`,
        probe: r.result.printable,
        hits: r.result.lines.length,
      })));
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
