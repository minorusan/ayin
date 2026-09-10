#!/usr/bin/env node
/**
 * check-qa-flutter — the Flutter QA executor's logic, against synthetic Flutter trees on disk.
 *
 * `npm run check:qa-flutter` (needs a build first). No LLM, no network, and NO FLUTTER SDK: everything
 * asserted here is decidable from the text of a Dart file, the text of an analyzer line, and git.
 *
 * NAMED AS UNVERIFIED HERE, because faking them proves nothing: the `flutter analyze` and
 * `flutter test` invocations themselves, and the `prepare()` codegen pass. Those were exercised on a
 * real project (Flutter 3.44 / Dart 3.12) — analyze clean and 1/1 on a fresh scaffold, both failure
 * paths reproduced with a planted error, and the route-unregistered fact fired on a real new screen.
 *
 * What this pins:
 *   · a Flutter project selects `qa/flutter`, not `qa/base` — the whole point, since base hard-fails
 *     on a README rule written for the Arduino scaffold
 *   · `factsOnly`, so no criteria are derived and no judge is consulted
 *   · the analyzer's line format parses, and SEVERITY is what separates "does not compile" from lint
 *   · one widget per file · the file named after its widget · lower_snake_case · a reusable widget
 *     that does not navigate · a screen not left in the widgets directory
 *   · every @RoutePage screen is registered in a router, and a hand-edited .gr.dart is a finding
 *   · THE FAIRNESS RULE: a certain finding is hard in a file the turn CREATED and reported in one it
 *     merely touched — with the generated-file exception. Without this the gate would demand a
 *     refactor of somebody's legacy widget file for a one-line edit.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('-p')) process.argv.push('-p');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const det = await import(`file://${join(ROOT, 'dist', 'executors', 'detect.js')}`);
const reg = await import(`file://${join(ROOT, 'dist', 'executors', 'registry.js')}`);
const shape = await import(`file://${join(ROOT, 'dist', 'executors', 'qa', 'flutter', 'shape.js')}`);
const analyze = await import(`file://${join(ROOT, 'dist', 'executors', 'qa', 'flutter', 'analyze.js')}`);
const qa = await import(`file://${join(ROOT, 'dist', 'executors', 'qa', 'flutter', 'index.js')}`);

const write = (base, rel, body) => {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
};

/** A Flutter tree with a router, a screen, a reusable widget and a generated file. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'ayin-qa-flutter-'));
  write(dir, 'pubspec.yaml', 'name: demo\nenvironment:\n  sdk: ^3.8.0\ndependencies:\n  flutter:\n    sdk: flutter\n  auto_route: ^11.1.0\n');
  write(dir, 'lib/router/app_router.dart', [
    "import 'package:auto_route/auto_route.dart';",
    "import 'app_router.gr.dart';",
    "export 'app_router.gr.dart';",
    '',
    "@AutoRouterConfig(replaceInRouteName: 'View,Route')",
    'class AppRouter extends RootStackRouter {',
    '  @override',
    '  List<AutoRoute> get routes => [',
    "        AutoRoute(page: HomeRoute.page, path: '/', initial: true),",
    '      ];',
    '}',
  ].join('\n'));
  write(dir, 'lib/router/app_router.gr.dart', [
    '// GENERATED CODE - DO NOT MODIFY BY HAND',
    'class HomeRoute extends PageRouteInfo<void> {',
    "  static const String name = 'HomeRoute';",
    '}',
  ].join('\n'));
  write(dir, 'lib/views/home_view.dart', [
    "import 'package:flutter/material.dart';",
    "import 'package:auto_route/auto_route.dart';",
    '',
    '@RoutePage()',
    'class HomeView extends StatelessWidget {',
    '  const HomeView({super.key});',
    '  @override',
    "  Widget build(BuildContext context) => const Text('home');",
    '}',
  ].join('\n'));
  write(dir, 'lib/widgets/primary_button.dart', [
    "import 'package:flutter/material.dart';",
    '',
    'class PrimaryButton extends StatelessWidget {',
    '  const PrimaryButton({required this.onPressed, super.key});',
    '  final VoidCallback onPressed;',
    '  @override',
    "  Widget build(BuildContext context) => FilledButton(onPressed: onPressed, child: const Text('go'));",
    '}',
  ].join('\n'));
  return dir;
}

const inspect = (dir, rel, source) => shape.inspectFile({
  root: dir,
  file: join(dir, rel),
  source,
  convention: shape.conventionOf(dir),
  routers: shape.indexRouters(dir),
});
const kinds = (findings) => findings.map((f) => f.kind).sort().join(',');

console.log('\n— a Flutter project is judged by the Flutter gate —');
{
  const dir = project();
  const ctx = det.detectProject(dir, '');
  ok(ctx.type === 'flutter', 'a pubspec.yaml is detected as a Flutter project', ctx.type);
  const ex = reg.qaExecutorFor(ctx);
  ok(ex.config.id === 'flutter', '  → and qa/flutter is selected, not qa/base', ex.config.id);
  ok(ex.config.factsOnly === true, '  → factsOnly: no criteria derived, no judge consulted');
  ok(ex.criteria(ctx, [], []).length === 0, '  → and it contributes no criteria for a judge to weigh');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n— the analyzer: severity is the line between "does not compile" and lint —');
{
  // Real `flutter analyze` output, copied verbatim from a run on a scaffolded project.
  const out = [
    'Analyzing demo...',
    '',
    "warning • Unused import: 'package:flutter/material.dart'. Try removing the import directive • lib/router/app_router.dart:2:8 • unused_import",
    "   info • The file name 'Buttons.dart' isn't a lower_case_with_underscores identifier • lib/widgets/Buttons.dart:1:1 • file_names",
    "  error • Undefined name 'labelTypo'. Try correcting the name to one that is defined • lib/widgets/stat_tile.dart:28:17 • undefined_identifier",
    '',
    '3 issues found. (ran in 1.3s)',
  ].join('\n');
  const issues = analyze.parseIssues(out, '/repo');
  ok(issues.length === 3, 'three issues parse out of a real analyzer run', String(issues.length));
  ok(issues.map((i) => i.severity).join(',') === 'warning,info,error', '  → each with its severity', issues.map((i) => i.severity).join(','));
  ok(issues[2].rule === 'undefined_identifier' && issues[2].location === 'lib/widgets/stat_tile.dart:28:17',
    '  → and its rule and file:line:col, which is what a fix pass acts on', `${issues[2].rule} @ ${issues[2].location}`);
  ok(analyze.parseIssues('Analyzing demo...\nNo issues found! (ran in 2.1s)', '/repo').length === 0,
    'a clean run parses to no issues — "No issues found!" is not mistaken for one');
  ok(!analyze.depsResolved('/definitely/not/a/project'),
    'a project with no .dart_tool/package_config.json is "dependencies not resolved", which is UNCHECKED not failed');
}

console.log('\n— file and widget separation —');
{
  const dir = project();
  ok(kinds(inspect(dir, 'lib/widgets/primary_button.dart', [
    "import 'package:flutter/material.dart';",
    'class PrimaryButton extends StatelessWidget {',
    '  const PrimaryButton({super.key});',
    '}',
  ].join('\n'))) === '', 'one widget, in its own class, in a file named after it — nothing to report');

  ok(kinds(inspect(dir, 'lib/widgets/buttons.dart', [
    "import 'package:flutter/material.dart';",
    'class DangerButton extends StatelessWidget {}',
    'class QuietButton extends StatelessWidget {}',
  ].join('\n'))).includes('widget-per-file'), 'two public widgets in one file is a finding');

  ok(kinds(inspect(dir, 'lib/widgets/Buttons.dart', 'class Foo {}')).includes('dart-file-name'),
    'a file name that is not lower_snake_case is a finding');

  ok(kinds(inspect(dir, 'lib/widgets/thing.dart', [
    "import 'package:flutter/material.dart';",
    'class PrimaryButton extends StatelessWidget {}',
  ].join('\n'))).includes('widget-file-name'), 'a widget file not named after its widget is a finding');

  const stateful = inspect(dir, 'lib/widgets/counter_box.dart', [
    "import 'package:flutter/material.dart';",
    'class CounterBox extends StatefulWidget {',
    '  @override',
    '  State<CounterBox> createState() => _CounterBoxState();',
    '}',
    'class _CounterBoxState extends State<CounterBox> {}',
  ].join('\n'));
  ok(kinds(stateful) === '', 'a StatefulWidget plus its private State class is ONE widget, not two');

  const navigating = inspect(dir, 'lib/widgets/danger_button.dart', [
    "import 'package:flutter/material.dart';",
    "import '../router/app_router.dart';",
    'class DangerButton extends StatelessWidget {',
    '  @override',
    '  Widget build(BuildContext context) => FilledButton(',
    '        onPressed: () => context.router.push(const HomeRoute()),',
    '        child: const Text("go"),',
    '      );',
    '}',
  ].join('\n'));
  ok(kinds(navigating).includes('widget-navigates'), 'a reusable widget that PUSHES a route is a finding');

  const popping = inspect(dir, 'lib/widgets/close_button.dart', [
    "import 'package:flutter/material.dart';",
    'class CloseButton extends StatelessWidget {',
    '  @override',
    '  Widget build(BuildContext context) => IconButton(',
    '        onPressed: () => Navigator.of(context).pop(),',
    '        icon: const Icon(Icons.close),',
    '      );',
    '}',
  ].join('\n'));
  ok(!kinds(popping).includes('widget-navigates'),
    '  → but popping is not navigating: closing yourself is local, and a dialog button must stay legal');

  const screenInWidgets = inspect(dir, 'lib/widgets/settings_view.dart', [
    "import 'package:auto_route/auto_route.dart';",
    "import 'package:flutter/material.dart';",
    '@RoutePage()',
    'class SettingsView extends StatelessWidget {}',
  ].join('\n'));
  ok(kinds(screenInWidgets).includes('widget-is-route'), 'a @RoutePage() screen left in the widgets directory is a finding');

  ok(kinds(inspect(dir, 'lib/views/home_view.dart', [
    '// class NotAWidget extends StatelessWidget {}',
    '/* class NeitherIsThis extends StatelessWidget {} */',
    "import 'package:flutter/material.dart';",
    'class HomeView extends StatelessWidget {}',
  ].join('\n'))) === '', 'a class inside a comment is not a class — comments are stripped before parsing');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n— routing —');
{
  const dir = project();
  ok(kinds(inspect(dir, 'lib/views/home_view.dart', [
    "import 'package:auto_route/auto_route.dart';",
    "import 'package:flutter/material.dart';",
    '@RoutePage()',
    'class HomeView extends StatelessWidget {}',
  ].join('\n'))) === '', 'a screen the router registers is reachable — nothing to report');

  const orphan = inspect(dir, 'lib/views/settings_view.dart', [
    "import 'package:auto_route/auto_route.dart';",
    "import 'package:flutter/material.dart';",
    '@RoutePage()',
    'class SettingsView extends StatelessWidget {}',
  ].join('\n'));
  ok(orphan.some((f) => f.kind === 'route-unregistered'), 'a @RoutePage() screen NO router registers is a finding — a screen nothing can reach');
  ok(/AutoRoute\(page: SettingsRoute\.page/.test(orphan.find((f) => f.kind === 'route-unregistered').line),
    '  → and the finding names the line to add, not just the problem');

  ok(shape.routeNameCandidates('HomeView', 'View,Route').includes('HomeRoute'),
    "replaceInRouteName: 'View,Route' maps HomeView → HomeRoute");
  ok(shape.routeNameCandidates('HomeView', '').includes('HomeViewRoute'),
    '  → and with no such option, auto_route\'s default HomeViewRoute is accepted too');

  const edited = inspect(dir, 'lib/router/app_router.gr.dart', 'class HomeRoute {}');
  ok(edited.length === 1 && edited[0].kind === 'generated-edited' && edited[0].certain,
    'a hand-edited .gr.dart is a finding on its own, whatever is in it', kinds(edited));

  ok(shape.inspectRouter(dir, shape.indexRouters(dir)).length === 0,
    'a router with `initial: true` names a first screen');
  rmSync(dir, { recursive: true, force: true });
}
{
  // A project with no auto_route router at all — go_router, or plain Navigator. Nothing to check, and
  // inventing a violation for it is exactly what this gate must never do.
  const dir = mkdtempSync(join(tmpdir(), 'ayin-qa-flutter-plain-'));
  write(dir, 'pubspec.yaml', 'name: plain\n');
  write(dir, 'lib/main.dart', "import 'package:flutter/material.dart';\nvoid main() {}\n");
  const routers = shape.indexRouters(dir);
  ok(routers.files.length === 0, 'a project with no @AutoRouterConfig has no router to check against');
  ok(shape.inspectRouter(dir, routers).length === 0, '  → and the router checks stay silent rather than inventing one');
  const conv = shape.conventionOf(dir);
  ok(conv.views === null && conv.widgets === null, '  → a feature-first project has no views/widgets split, and that is a legal answer');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n— the project\'s own convention, discovered rather than imposed —');
{
  const dir = mkdtempSync(join(tmpdir(), 'ayin-qa-flutter-screens-'));
  write(dir, 'pubspec.yaml', 'name: screens\n');
  write(dir, 'lib/screens/home_screen.dart', 'class HomeScreen {}');
  write(dir, 'lib/components/tile.dart', 'class Tile {}');
  const conv = shape.conventionOf(dir);
  ok(conv.views === 'lib/screens', 'lib/screens is where this project keeps screens', String(conv.views));
  ok(conv.widgets === 'lib/components', 'and lib/components is its widgets directory', String(conv.widgets));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n— the fairness rule: hard for what the turn WROTE, reported for what it touched —');
{
  const findings = [
    { kind: 'widget-per-file', file: 'lib/widgets/legacy.dart', line: 'lib/widgets/legacy.dart — 3 widgets', certain: true },
    { kind: 'widget-file-name', file: 'lib/widgets/new_thing.dart', line: 'lib/widgets/new_thing.dart — named wrong', certain: true },
    { kind: 'generated-edited', file: 'lib/router/app_router.gr.dart', line: 'lib/router/app_router.gr.dart — edited', certain: true },
    { kind: 'router-initial', file: 'lib/router/app_router.dart', line: 'lib/router/app_router.dart — no first screen', certain: false },
  ];
  const facts = qa.factsFor(findings, new Set(['lib/widgets/new_thing.dart']));
  const by = Object.fromEntries(facts.map((f) => [f.key, f]));
  ok(by['flutter-widget-file-name'].hard === true && by['flutter-widget-file-name'].ok === false,
    'a violation in a file the turn CREATED fails the gate');
  ok(by['flutter-widget-per-file'].hard !== true && by['flutter-widget-per-file'].ok === true,
    'the same violation in a PRE-EXISTING file is reported and does not — a one-line edit is not a refactor request');
  ok(/reported, not enforced/.test(by['flutter-widget-per-file'].detail),
    '  → and the detail says which it is, so "passed" is never confused with "not checked"');
  ok(by['flutter-generated-edited'].hard === true,
    'a hand-edited generated file is hard WHEREVER it is: the turn wrote into it, and the generator will delete that work');
  ok(by['flutter-router-initial'].hard !== true,
    'an uncertain finding is never hard — a redirect can legitimately supply the first screen');
}

console.log('\n— what the turn created is answered by git, and outside git nothing is enforced —');
{
  const dir = mkdtempSync(join(tmpdir(), 'ayin-qa-flutter-git-'));
  write(dir, 'lib/widgets/old.dart', 'class Old {}');
  ok(shape.newlyAddedFiles(dir).size === 0, 'outside a git repository nothing counts as new — everything is merely reported');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'base'], { cwd: dir });
  write(dir, 'lib/widgets/new.dart', 'class New {}');
  write(dir, 'lib/widgets/old.dart', 'class Old { int x = 1; }');
  const added = shape.newlyAddedFiles(dir);
  ok(added.has('lib/widgets/new.dart'), 'an untracked file is one the turn created');
  ok(!added.has('lib/widgets/old.dart'), 'and a committed file it modified is not');
  execFileSync('git', ['add', 'lib/widgets/new.dart'], { cwd: dir });
  ok(shape.newlyAddedFiles(dir).has('lib/widgets/new.dart'),
    'still true once it is staged — ayin\'s own watch daemon stages as it goes');
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails ? `\nqa flutter check: ${fails} FAILED` : '\nqa flutter check: all passed');
process.exit(fails ? 1 : 0);
