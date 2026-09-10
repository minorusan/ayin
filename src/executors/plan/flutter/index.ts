/**
 * Flutter planning — and, on a greenfield directory, an app that actually ROUTES.
 *
 * WHY THIS IS ITS OWN EXECUTOR RATHER THAN A GREENFIELD BRANCH. `plan/greenfield` writes file tables
 * and states in its own header that nothing in it needs the network. A Flutter project cannot be
 * finished on those terms: auto_route puts every route class in a GENERATED file, so an app whose
 * generator has never run does not compile — `HomeRoute` is undefined, and `app_router.gr.dart` does
 * not exist for `part` to find. The file table is necessary and not sufficient. This is the same shape
 * as `plan/node`, which owns `node` for the same reason (its `npm install` is what makes the compile
 * check answerable), and the same division: greenfield keeps the layout, the deliverables, the survey
 * and the prompts; the type's owner adds the toolchain.
 *
 * TWO STEPS, AND ONLY ONE OF THEM BLOCKS.
 *
 *   1. THE PLATFORM FOLDERS, SYNCHRONOUSLY. `flutter create` is local — no registry, a few seconds —
 *      and its output is 130-odd files of android/ ios/ web/ boilerplate that must be inside the
 *      scaffold's first commit, or the operator's first `git status` is a wall of untracked noise
 *      with no baseline to diff against. It runs in a TEMPORARY directory and only the platform
 *      folders are copied in, so nothing `flutter create` templates can overwrite a file this
 *      scaffold owns — `pubspec.yaml`, `lib/main.dart`, the README and the test are all files it
 *      would otherwise write its own version of.
 *   2. `flutter pub get` THEN THE GENERATOR, FIRE AND FORGET. `scaffold()` is synchronous and runs
 *      inside the turn, so blocking it on pub.dev plus a cold build_runner (measured: 44s on a warm
 *      machine, and it AOT-compiles the builders first) would freeze a TUI with no spinner and no
 *      way out. `plan/node` made the same call for the same reason. The grounding says the pass was
 *      started and states the two commands verbatim, so a missing route class has an obvious fix
 *      rather than looking like a bug in the router.
 *
 * NO SDK IS ALSO AN ANSWER. Every step is skipped when `flutter` is not on PATH; the file table still
 * lands, and the README's caveat table carries the one command that adds the platform folders later.
 * A scaffold that fails because a toolchain is missing is worse than one that says what to run.
 */

import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../../log.js';
import type { Deliverable, ExecutorConfig, PlanExecutor, ProjectContext } from '../../types.js';
import { dartName } from '../greenfield/files.js';
import { greenfieldPlanExecutor } from '../greenfield/index.js';

const config: ExecutorConfig = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'config.json'), 'utf-8'),
) as ExecutorConfig;

/** Where the files actually go — `root`, or the folder the request named inside it. Mirrors greenfield. */
function targetRoot(ctx: ProjectContext): string {
  return ctx.targetDir ? join(ctx.root, ctx.targetDir) : ctx.root;
}

/**
 * Every platform, because which one gets built is not this scaffold's decision to make — and a
 * missing folder is not a compile error, it is `flutter run -d windows` failing on a machine six
 * months from now. They are cheap: templates on disk, no network.
 *
 * `.metadata` travels with them: it records the Flutter revision and which platforms were generated,
 * and it is what `flutter create` reads to migrate them later.
 */
const PLATFORM_DIRS = ['android', 'ios', 'web', 'macos', 'linux', 'windows'];
const PLATFORMS_ARG = PLATFORM_DIRS.join(',');

/** Local templating, no registry. Generous because a cold SDK builds its own tooling first. */
const CREATE_TIMEOUT_MS = 120_000;
/** pub.dev, and then a build_runner that AOT-compiles its builders before it writes a line. */
const PUB_TIMEOUT_MS = 180_000;
const CODEGEN_TIMEOUT_MS = 300_000;

/**
 * The SDK's own name for itself, or null — and asked with `--version`, which is the only answer that
 * proves the binary runs rather than merely existing.
 *
 * `.bat` is tried because that is what the Flutter SDK ships on Windows, where `execFile` without a
 * shell will not find a bare `flutter`.
 */
function sdkBin(name: 'flutter' | 'dart'): string | null {
  for (const bin of [name, `${name}.bat`]) {
    try {
      execFileSync(bin, ['--version'], { timeout: 60_000, stdio: 'ignore' });
      return bin;
    } catch { /* not this one */ }
  }
  return null;
}

/**
 * The platform folders, generated in a temp directory and copied in.
 *
 * Copied and never generated in place, because `flutter create` also templates `pubspec.yaml`,
 * `lib/main.dart`, `analysis_options.yaml`, `README.md`, `.gitignore` and `test/` — every one of
 * which this scaffold has its own, deliberately different version of. Copying only the platform
 * folders means there is no ordering, no overwrite and nothing to undo.
 *
 * `--project-name` is passed explicitly so the generated Gradle/Xcode identifiers match the package
 * name in the pubspec, whatever the operator called the directory.
 */
function generatePlatforms(dir: string, bin: string): string[] {
  const name = dartName(dir);
  const staging = mkdtempSync(join(tmpdir(), 'ayin-flutter-'));
  const from = join(staging, name);
  const made: string[] = [];
  try {
    execFileSync(bin, ['create', '--no-pub', '--project-name', name, '--platforms', PLATFORMS_ARG, from], {
      timeout: CREATE_TIMEOUT_MS, stdio: 'ignore',
    });
    for (const entry of [...PLATFORM_DIRS, '.metadata']) {
      const src = join(from, entry);
      const dst = join(dir, entry);
      // Write-if-missing, like every other writer in the scaffold: a platform folder that is already
      // there is the operator's.
      if (!existsSync(src) || existsSync(dst)) continue;
      cpSync(src, dst, { recursive: true });
      made.push(dst);
    }
    log('INFO', 'scaffold_flutter_platforms', { dir, folders: String(made.length) });
  } catch (err) {
    // A project without platform folders still analyzes, still tests and still builds for the web
    // once they are added — so this is reported and the scaffold continues.
    log('WARN', 'scaffold_flutter_create_failed', { dir, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return made;
}

/**
 * `flutter pub get`, then the generator that writes the routes. Chained in the callback because the
 * second cannot start before the first: build_runner resolves auto_route_generator through the
 * package config `pub get` produces.
 *
 * Never held onto — `unref` so a finished plan is not waiting on pub.dev — and every outcome is
 * logged, because from here on the only evidence is the log.
 */
function startCodegen(dir: string, flutter: string, dart: string | null): void {
  log('INFO', 'scaffold_flutter_pub_get_start', { dir });
  const pub = execFile(flutter, ['pub', 'get'], { cwd: dir, timeout: PUB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err) => {
    if (err) {
      log('WARN', 'scaffold_flutter_pub_get_failed', { dir, error: err.message.slice(0, 200) });
      return;
    }
    log('INFO', 'scaffold_flutter_pub_get_done', { dir });
    if (!dart) {
      log('WARN', 'scaffold_flutter_codegen_skipped', { dir, reason: 'no dart binary on PATH' });
      return;
    }
    const gen = execFile(dart, ['run', 'build_runner', 'build'], { cwd: dir, timeout: CODEGEN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (genErr) => {
      if (genErr) log('WARN', 'scaffold_flutter_codegen_failed', { dir, error: genErr.message.slice(0, 200) });
      else log('INFO', 'scaffold_flutter_codegen_done', { dir });
    });
    gen.unref?.();
  });
  pub.unref?.();
}

export const flutterPlanExecutor: PlanExecutor = {
  config,

  survey(ctx: ProjectContext): string { return greenfieldPlanExecutor.survey(ctx); },
  observability(ctx: ProjectContext): string { return greenfieldPlanExecutor.observability(ctx); },

  /**
   * GREENFIELD'S LIST, NOT A SECOND ONE — the manifest, the entry point, the router, the views, the
   * widgets, the test, the lint config and the ignore file are declared there, prefixed for
   * `targetDir` there, and checked against the file table by `check-plan.mjs`. Two lists of what a
   * Flutter project must contain is one list too many.
   */
  deliverables(ctx: ProjectContext): Deliverable[] { return greenfieldPlanExecutor.deliverables(ctx); },

  /**
   * WHAT THE BOOTSTRAP ALREADY DECIDED. The layout prompt says what a Flutter project SHOULD look
   * like and an operator can edit it; this says what is already on disk, which they cannot.
   *
   * The generated-routes rule is here and not only in the README because the model does not read the
   * README, and the failure it prevents — hand-writing `app_router.gr.dart`, or a route class, when
   * the generator has simply not run yet — produces a file the next generator pass overwrites.
   */
  grounding(ctx: ProjectContext, request?: string): string {
    const base = greenfieldPlanExecutor.grounding(ctx, request);
    if (!ctx.greenfield || ctx.type !== 'flutter') return base;
    const lines = [
      'THIS PROJECT WAS JUST BOOTSTRAPPED. It already routes, already analyzes clean and already has a',
      'passing widget test — do not recreate any of it.',
      '',
      '  pubspec.yaml                auto_route, plus flutter_lints / auto_route_generator / build_runner',
      '  lib/main.dart               runApp(const App()). Three lines; leave it alone.',
      '  lib/app.dart                MaterialApp.router, the theme, and the ONE AppRouter instance.',
      '  lib/router/app_router.dart  THE ROUTE LIST. Every screen needs a line in it.',
      '  lib/views/*_view.dart       home, counter, detail — one @RoutePage() class per file.',
      '  lib/widgets/*.dart          primary_button, section_card, stat_tile — one class per file.',
      '  test/navigation_test.dart   pumps the real app and taps through the router.',
      '',
      'ADD A SCREEN IN FOUR STEPS: lib/views/<name>_view.dart with one @RoutePage() class; one AutoRoute',
      'line in lib/router/app_router.dart; `dart run build_runner build`; then',
      'context.router.push(const <Name>Route()).',
      '',
      'ROUTES ARE GENERATED. <Name>Route does not exist until build_runner has run, so a step that adds',
      'or renames a route is followed by a step that runs it. NEVER write or edit',
      'lib/router/app_router.gr.dart by hand — it is a `part` of app_router.dart, it takes its imports',
      'from there, and the next generator pass overwrites whatever you put in it.',
      '',
      '`flutter pub get` and the first generator pass are STARTED IN THE BACKGROUND by the scaffold when',
      'the SDK is on PATH. If a route class or app_router.gr.dart is missing, that pass has not finished',
      'or never ran:',
      '  flutter pub get && dart run build_runner build',
      '',
      'ONLY auto_route IS INSTALLED. Importing any other package fails to compile — add it to',
      'pubspec.yaml in the same change and say that `flutter pub get` must run.',
      '',
      'VERIFY WITH `flutter analyze` AND `flutter test`. Both are fast, neither needs a device, and',
      'analyze must be clean — this project starts clean.',
    ];
    return [base, lines.join('\n')].filter((x) => x.trim()).join('\n\n');
  },

  /**
   * PLATFORMS FIRST, THEN GREENFIELD, THEN THE GENERATOR — and the order is the whole design.
   *
   * The platform folders have to be on disk before greenfield's `commitScaffold` runs, or the first
   * commit does not contain them. Greenfield then makes the directory (when the request named one),
   * runs `git init`, writes the file table over nothing that collides, and commits. Only after that
   * does anything touch the network.
   */
  scaffold(ctx: ProjectContext): string[] {
    if (!ctx.greenfield || ctx.type !== 'flutter') return greenfieldPlanExecutor.scaffold(ctx);
    const dir = targetRoot(ctx);
    const flutter = sdkBin('flutter');
    const made: string[] = [];
    if (flutter) {
      // greenfield makes this itself, but the platform folders have to land inside it first.
      if (!existsSync(dir)) {
        try {
          mkdirSync(dir, { recursive: true });
          made.push(dir);
        } catch (err) {
          log('WARN', 'scaffold_project_dir_failed', { dir, error: err instanceof Error ? err.message : String(err) });
          return greenfieldPlanExecutor.scaffold(ctx);
        }
      }
      made.push(...generatePlatforms(dir, flutter));
    } else {
      log('WARN', 'scaffold_flutter_sdk_missing', { dir, effect: 'no platform folders and no codegen — the README says what to run' });
    }
    made.push(...greenfieldPlanExecutor.scaffold(ctx));
    if (flutter) startCodegen(dir, flutter, sdkBin('dart'));
    return made;
  },
};
