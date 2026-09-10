/**
 * Flutter QA executor — four questions with machine answers, and no opinions at all.
 *
 * WHAT IT REPLACES. A Flutter project fell to `qa/base`, whose one contributed fact is
 * `readme-substance` — `hard`, so it fails the gate without the judge, and worded for the Arduino
 * scaffold ("too short to carry a parts list and a pin map"). On top of that the generic judge was
 * handed code/docs criteria and no analyzer result at all, so the gate could not tell a Flutter turn
 * that COMPILES from one that does not, while reliably failing both. `factsOnly` in the config turns
 * criteria derivation and the judge off entirely.
 *
 * THE FOUR:
 *
 *   1. THE LINTER, WHICH IS ALSO THE COMPILER. `flutter analyze` reports type errors and violations of
 *      the project's own `analysis_options.yaml` from one pass, tagged by severity. Errors and
 *      warnings in the turn's own files are `hard`; `info` (style) is listed and does not block. The
 *      exit code is useless for this — it is 1 for a single `avoid_print` — so severities are parsed.
 *   2. DOES IT STILL WORK. `flutter test`, the project's own suite. For anything ayin scaffolds that
 *      suite pumps the real app and taps through the router, so it is the reachability check too.
 *   3. FILE AND WIDGET SEPARATION, read from the Dart: one public widget per file, the file named
 *      after it, screens where this project keeps screens, and a reusable widget that does not push
 *      routes. `flutter analyze` checks none of these.
 *   4. ROUTING: every `@RoutePage()` screen the turn touched is registered in a router (an annotated
 *      screen no route names is a screen nothing can reach), the generated file is not hand-edited,
 *      and the route list has an entry point.
 *
 * WHOSE CONVENTION, AND WHOSE FILES — the two guards that keep 3 and 4 from becoming the Unity-README
 * failure in a new costume:
 *
 *   · the directories are DISCOVERED from the project (`lib/views` | `lib/pages` | `lib/screens`,
 *     `lib/widgets` | `lib/components`), never imposed, and a project with no such split gets those
 *     checks reported as unchecked;
 *   · a certain finding is `hard` only in a file the TURN CREATED. A pre-existing file ayin edited one
 *     line of is reported, because "you touched this legacy file, now split it into four widgets" is a
 *     gate inventing work nobody asked for. The single exception is a hand-edited generated file: the
 *     turn provably wrote into `.gr.dart`, and the next generator pass will delete that work.
 *
 * ABSENT IS NOT FAILED. No SDK, no resolved dependencies, no test directory, no auto_route router —
 * each is reported as a question that could not be asked. On the turn that CREATES a project, several
 * of those are the normal state.
 */

import { readFileSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { log } from '../../../log.js';
import { checkDeliverables, renderDeliverables } from '../../deliverables.js';
import { flutterPlanExecutor } from '../../plan/flutter/index.js';
import { repoBaselineFact } from '../../plan/git.js';
import type { ChangedFile } from '../../../qa/probes.js';
import type { ExecutorConfig, PrepareResult, ProbeFact, ProjectContext, QaExecutor } from '../../types.js';
import { analyze, depsResolved, generateRoutes, runTests, type Issue } from './analyze.js';
import {
  conventionOf, indexRouters, inspectFile, inspectRouter, isGenerated, newlyAddedFiles, parseDart,
  type Finding,
} from './shape.js';

const config: ExecutorConfig = {
  id: 'flutter', kind: 'qa', projectTypes: ['flutter'], priority: 10, factsOnly: true,
  description: 'Flutter QA — flutter analyze, the project\'s own test suite, widget/file separation and routing. Deterministic, no judge.',
};

/** Repo-relative, `/`-separated — every fact and finding speaks in these. */
function rel(ctx: ProjectContext, path: string): string {
  return relative(ctx.root, path).split('\\').join('/');
}

function dartFiles(files: ChangedFile[]): ChangedFile[] {
  return files.filter((f) => extname(f.path).toLowerCase() === '.dart');
}

/** One line per rule, so the operator's card says what happened without reading the list. */
const HEADLINE: Record<string, string> = {
  'generated-edited': 'GENERATED CODE EDITED BY HAND',
  'route-unregistered': 'A SCREEN NOTHING CAN REACH',
  'route-not-generated': 'routes not regenerated yet',
  'widget-per-file': 'MORE THAN ONE WIDGET IN A FILE',
  'widget-file-name': 'FILE NOT NAMED AFTER ITS WIDGET',
  'widget-is-route': 'A SCREEN IN THE WIDGETS DIRECTORY',
  'widget-navigates': 'A REUSABLE WIDGET THAT NAVIGATES',
  'view-location': 'a screen outside the screens directory',
  'dart-file-name': 'FILE NAME IS NOT lower_snake_case',
  'router-initial': 'the router names no first screen',
};

/**
 * Findings → facts, one fact per rule, and the hard/reported decision made per FILE.
 *
 * Grouping by rule rather than by file is what keeps a rename touching twenty files from producing
 * twenty rows of the same sentence: the headline carries the count, the detail lists the places, and
 * the operator's card shows only the first line.
 */
export function factsFor(findings: Finding[], created: Set<string>): ProbeFact[] {
  const byKind = new Map<string, { hard: boolean; lines: string[] }>();
  for (const f of findings) {
    // Hard only where the turn WROTE the file — except a generated file, which it may not write at all.
    const hard = f.certain && (created.has(f.file) || f.kind === 'generated-edited');
    const slot = byKind.get(f.kind) ?? { hard: false, lines: [] };
    slot.hard = slot.hard || hard;
    slot.lines.push(f.line);
    byKind.set(f.kind, slot);
  }
  return [...byKind.entries()].map(([kind, { hard, lines }]) => ({
    key: `flutter-${kind}`,
    ok: !hard,
    hard,
    detail: [
      `${HEADLINE[kind] ?? kind}: ${lines.length} place(s)${hard ? '' : ' — reported, not enforced (pre-existing file)'}`,
      ...lines.slice(0, 8).map((l) => `  ${l}`),
      ...(lines.length > 8 ? [`  … ${lines.length - 8} more`] : []),
    ].join('\n'),
  }));
}

/** `error`/`warning`/`info` counts, for a headline that says what kind of trouble it is. */
function countBy(issues: Issue[]): Record<Issue['severity'], number> {
  return {
    error: issues.filter((i) => i.severity === 'error').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
  };
}

function issueLine(i: Issue): string {
  return `${i.severity} · ${i.location} · ${i.rule} — ${i.message}`;
}

export const flutterQaExecutor: QaExecutor = {
  config,

  /**
   * REGENERATE THE ROUTES, AND ONLY WHEN THE TURN MADE THEM STALE.
   *
   * A route added without re-running the generator is an undefined name, so `flutter analyze` fails on
   * a command that has no decision in it — a whole fix pass spent arriving where the system was going
   * to arrive anyway. Preparing first makes the analyzer and the routing facts answerable on pass 1.
   *
   * The trigger is narrow on purpose: a changed file that declares `@RoutePage()` or the router itself,
   * and a generated file that does not already contain the route class. Nothing else runs a generator.
   */
  async prepare(ctx: ProjectContext, files: ChangedFile[]): Promise<PrepareResult> {
    const dart = dartFiles(files).filter((f) => f.exists && !isGenerated(f.path));
    if (!dart.length || !depsResolved(ctx.root)) return { produced: [], handled: new Set(), notes: [] };

    const touchesRoutes = dart.some((f) => {
      try {
        const facts = parseDart(readFileSync(f.path, 'utf-8'));
        return facts.routePages.length > 0 || facts.routerConfig;
      } catch { return false; }
    });
    if (!touchesRoutes) return { produced: [], handled: new Set(), notes: [] };

    const routers = indexRouters(ctx.root);
    if (!routers.files.length) return { produced: [], handled: new Set(), notes: [] };

    const stale = dart.some((f) => {
      try {
        for (const view of parseDart(readFileSync(f.path, 'utf-8')).routePages) {
          if (!new RegExp(`class\\s+\\w*${view.replace(/(View|Page|Screen)$/, '')}\\w*Route\\b`).test(routers.generated)
            && !new RegExp(`\\[${view}\\]`).test(routers.generated)) return true;
        }
      } catch { /* unreadable — nothing to regenerate for */ }
      return false;
    });
    if (!stale) return { produced: [], handled: new Set(), notes: [] };

    const result = await generateRoutes(ctx.root);
    log(result.ok ? 'INFO' : 'WARN', 'qa_flutter_codegen', { ok: String(result.ok), detail: result.detail.slice(0, 200) });
    return {
      produced: result.ok ? routers.files.map((f) => f.replace(/\.dart$/, '.gr.dart')) : [],
      handled: new Set(),
      notes: [result.detail],
    };
  },

  async probe(ctx: ProjectContext, files: ChangedFile[]): Promise<ProbeFact[]> {
    const facts: ProbeFact[] = [];
    const dart = dartFiles(files);
    const changed = new Set(dart.filter((f) => f.exists).map((f) => rel(ctx, f.path)));

    // ── 1 · the linter, which is also the compiler ────────────────────────────────
    const analysis = await analyze(ctx.root);
    if (analysis.unverified) {
      facts.push({ key: 'flutter-analyze', ok: true, detail: `analysis not checked: ${analysis.unverified}` });
    } else {
      /**
       * ERRORS ARE WHOLE-PROJECT; LINTS ARE THE TURN'S OWN. Two different questions wearing one
       * command.
       *
       * An `error` is not an opinion: the package does not compile, and `flutter build` fails for all
       * of it — the same stance `tsc --noEmit` and Unity's compile probe take, and it is enforced
       * wherever it is. Measured, which is why this is not "issues in changed files" as it first was:
       * a new screen made the GENERATED router file reference a type it could not see, and the error
       * landed in a file the turn had not touched — reported as "elsewhere", enforced by nothing,
       * while the project did not build.
       *
       * A `warning` or an `info` is the project's own lint set. Those are enforced only in the files
       * this turn wrote: a repo carrying four hundred pre-existing lints must not fail every turn for
       * them, which is the `qa/base`-on-a-Unity-repo failure — a rule nobody can satisfy burning the
       * fix budget that would have fixed something real.
       */
      const mine = analysis.issues.filter((i) => changed.has(i.file));
      const errors = analysis.issues.filter((i) => i.severity === 'error');
      const myWarnings = mine.filter((i) => i.severity === 'warning');
      const style = mine.filter((i) => i.severity === 'info');
      const elsewhere = analysis.issues.filter((i) => i.severity !== 'error' && !changed.has(i.file)).length;
      const context = elsewhere ? ` (${elsewhere} pre-existing lint(s) elsewhere, not this turn's and not enforced)` : '';
      if (errors.length || myWarnings.length) {
        const blocking = [...errors, ...myWarnings];
        facts.push({
          key: 'flutter-analyze', ok: false, hard: true,
          detail: [
            `${analysis.command} FAILED — ${errors.length} error(s) anywhere in the project`
            + ` and ${myWarnings.length} warning(s) in this turn's own files${context}.`
            + ' An error means it does not compile; a warning is the project\'s own analysis_options.yaml:',
            ...blocking.slice(0, 12).map((i) => `  ${issueLine(i)}`),
            ...(blocking.length > 12 ? [`  … ${blocking.length - 12} more`] : []),
            ...(style.length ? [`  plus ${style.length} style lint(s) in the same files — fix those too while you are here`] : []),
          ].join('\n'),
        });
      } else if (style.length) {
        // Style is LISTED, not enforced: `info` is where the analyzer itself stops calling something
        // wrong, and a hard gate on `prefer_const_constructors` burns the budget for a real bug.
        facts.push({
          key: 'flutter-analyze', ok: true,
          detail: [
            `${analysis.command} — no errors or warnings; ${style.length} style lint(s) in this turn's files${context}:`,
            ...style.slice(0, 8).map((i) => `  ${issueLine(i)}`),
          ].join('\n'),
        });
      } else {
        facts.push({
          key: 'flutter-analyze', ok: true, hard: true,
          detail: `${analysis.command} — clean${context}`,
        });
      }
    }

    // ── 2 · the project's own suite ───────────────────────────────────────────────
    const tests = await runTests(ctx.root);
    if (tests.unverified) {
      facts.push({ key: 'flutter-test', ok: true, detail: `tests not checked: ${tests.unverified}` });
    } else if (tests.failed) {
      facts.push({
        key: 'flutter-test', ok: false, hard: true,
        detail: [`flutter test FAILED — ${tests.failed} failing, ${tests.passed} passing. What the app claims does not all work:`,
          ...tests.failures.slice(0, 20).map((l) => `  ${l}`)].join('\n'),
      });
    } else {
      facts.push({ key: 'flutter-test', ok: true, hard: true, detail: `flutter test — ${tests.passed} passing` });
    }

    // ── 3 and 4 · separation and routing, read from the Dart ──────────────────────
    const convention = conventionOf(ctx.root);
    const routers = indexRouters(ctx.root);
    const created = newlyAddedFiles(ctx.root);
    const findings: Finding[] = [];
    for (const f of dart) {
      if (!f.exists) continue;
      let source = '';
      try { source = readFileSync(f.path, 'utf-8'); } catch { continue; }
      findings.push(...inspectFile({ root: ctx.root, file: f.path, source, convention, routers }));
    }
    findings.push(...inspectRouter(ctx.root, routers));
    facts.push(...factsFor(findings, created));

    /**
     * AND SAY SO WHEN A CHECK DID NOT RUN. A gate that silently skips reads exactly like a gate that
     * passed, which is how a check quietly stops existing.
     */
    if (dart.length) {
      const unchecked: string[] = [];
      if (!convention.views && !convention.widgets) {
        unchecked.push('separation by directory: this project has no views/widgets split to check against '
          + '(feature-first layouts are fine — the one-widget-per-file and file-naming rules still ran)');
      }
      if (!routers.files.length) {
        unchecked.push('routing: no @AutoRouterConfig router found — this app does not use auto_route, so nothing was checked');
      }
      if (!findings.length && !unchecked.length) {
        unchecked.push(`separation and routing: ${dart.length} changed Dart file(s), nothing to report`);
      }
      if (unchecked.length) {
        facts.push({ key: 'flutter-shape', ok: true, detail: unchecked.join('\n') });
      }
    }

    // ── the project's shape on disk, and something to diff against ────────────────
    // Hard only on a greenfield turn: `lib/views/*.dart` is the layout ayin's scaffold writes, and
    // demanding it of somebody's existing app is exactly the imposition the checks above avoid.
    const statuses = checkDeliverables(ctx.root, flutterPlanExecutor.deliverables(ctx));
    if (statuses.length) {
      const d = renderDeliverables(ctx.root, statuses);
      facts.push({ key: 'deliverables', ok: d.ok, detail: d.detail, hard: !!ctx.greenfield });
    }
    facts.push(repoBaselineFact(ctx));
    return facts;
  },

  /** factsOnly — nothing is derived, so there is no baseline criterion id to add. */
  criteria(): string[] {
    return [];
  },
};
