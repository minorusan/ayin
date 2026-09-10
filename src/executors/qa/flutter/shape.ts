/**
 * shape.ts — the two questions Flutter QA answers by READING the Dart: file/widget separation, and
 * routing. No model, no toolchain, no network.
 *
 * WHY A SCANNER AND NOT A JUDGE. Both questions are mechanical. "Does this file hold two public
 * widgets", "is this widget file named after its class", "does a reusable widget in `lib/widgets`
 * push a route", "is this `@RoutePage()` screen registered in any router" — each has one right answer
 * that a program can produce identically every time, and `flutter analyze` checks none of them. A
 * model asked the same questions gives a different answer per run and costs a call per file.
 *
 * WHY IT INFERS THE PROJECT'S CONVENTION INSTEAD OF IMPOSING AYIN'S. `lib/views` + `lib/widgets` is
 * what ayin's scaffold writes; `lib/screens`, `lib/pages` and `lib/components` are equally ordinary
 * Flutter. A gate that demanded ayin's spelling would hard-fail every turn on somebody else's app —
 * which is exactly what `qa/base` did to Unity repos with a README rule written for Arduino. So the
 * directories are DISCOVERED, and where a project has no such split the separation checks report
 * themselves as unchecked rather than inventing a violation.
 *
 * WHY THE PARSER IS REGEX AND WHY THAT IS ENOUGH. There is no Dart AST available in this process, and
 * the alternative — shelling out to the analyzer for a custom rule set — is a plugin, a package and a
 * build step for facts that are visible in the text. Comments are stripped first (a `class` in a doc
 * comment used to count), everything else is read line by line, and anything ambiguous is DROPPED
 * rather than guessed: a missed finding is a check that did not fire, while an invented one is a
 * finished turn held hostage by a bad regex.
 *
 * `certain` DOES NOT MEAN `hard`. It means "this is a mechanical consequence, not a matter of taste".
 * Whether it fails the gate is the caller's decision, and `index.ts` makes it per file: a file the
 * TURN CREATED is held to the pattern, a pre-existing file it merely touched is reported. Editing a
 * legacy three-widget file to fix a typo must not become a demand to split it up.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export interface Finding {
  /** Stable key, one per rule — the caller groups by it so twenty files produce one fact. */
  kind: string;
  /** Repo-relative path, so the caller can decide hard-vs-reported per file. */
  file: string;
  /** One line for the agent: where, and what. */
  line: string;
  /** A mechanical consequence rather than a preference. */
  certain: boolean;
}

export interface DartClass {
  name: string;
  base: string;
  isWidget: boolean;
  isState: boolean;
  isPrivate: boolean;
  routePage: boolean;
}

export interface DartFacts {
  classes: DartClass[];
  /** Class names annotated `@RoutePage()` — the annotation is what makes a route class exist. */
  routePages: string[];
  /** Forward navigation call sites. `pop` is deliberately absent: closing yourself is local. */
  navigations: string[];
  /** True for the file that declares the router. */
  routerConfig: boolean;
  /** `replaceInRouteName`'s value when the router declares one — `'View,Route'`. */
  replaceInRouteName: string;
}

/** Widget base classes, including the common third-party ones. Anything else is not a widget. */
const WIDGET_BASE_RE = /^(StatelessWidget|StatefulWidget|InheritedWidget|InheritedModel|ImplicitlyAnimatedWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget|StatefulHookConsumerWidget)\b/;
/** `State<Foo>`, `ConsumerState<Foo>` — the private half of a StatefulWidget, never a second widget. */
const STATE_BASE_RE = /^(State|ConsumerState|HookState|AnimatedWidgetBaseState)\s*</;
/**
 * FORWARD navigation only. A widget that pops itself is closing its own dialog; a widget that PUSHES
 * names a destination, and a reusable leaf that names a destination cannot be reused anywhere else.
 */
const NAV_RE = /\b(?:context\.router\.(?:push|replace|navigate)(?:Path|All|Named)?\s*\(|AutoRouter\.of\s*\(|context\.(?:pushRoute|navigateTo|replaceRoute)\s*\(|Navigator\.(?:of\s*\([^)]*\)\s*\.)?(?:push|pushNamed|pushReplacement|pushReplacementNamed|pushAndRemoveUntil)\s*\()/;

/** Line and block comments out, so a `class` inside documentation stops counting as a declaration. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

/** `PrimaryButton` → `primary_button`, and `HTTPClient` → `http_client` rather than `h_t_t_p_client`. */
export function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** What one Dart file declares. Never throws: an unparseable file yields empty facts, not a finding. */
export function parseDart(source: string): DartFacts {
  const clean = stripComments(source);
  const classes: DartClass[] = [];
  const routePages: string[] = [];
  const lines = clean.split('\n');
  let pendingRoutePage = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/@RoutePage\s*\(/.test(line)) { pendingRoutePage = true; continue; }
    const m = /^(?:abstract\s+|final\s+|base\s+|sealed\s+|mixin\s+)*class\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:extends\s+([A-Za-z_$][\w$.]*(?:<[^>]*>)?))?/.exec(line);
    if (!m) {
      // An annotation belongs to the next DECLARATION; anything else between them means it was not a
      // class annotation at all (a field, a parameter) and the flag must not leak onto a later class.
      if (line && !line.startsWith('@')) pendingRoutePage = pendingRoutePage && !/[;{}]/.test(line);
      continue;
    }
    const name = m[1];
    const base = m[2] ?? '';
    const cls: DartClass = {
      name,
      base,
      isWidget: WIDGET_BASE_RE.test(base),
      isState: STATE_BASE_RE.test(base),
      isPrivate: name.startsWith('_'),
      routePage: pendingRoutePage,
    };
    if (pendingRoutePage) routePages.push(name);
    pendingRoutePage = false;
    classes.push(cls);
  }
  const replace = /@AutoRouterConfig\s*\(\s*replaceInRouteName:\s*'([^']*)'/.exec(clean);
  return {
    classes,
    routePages,
    navigations: lines.filter((l) => NAV_RE.test(l)).map((l) => l.trim().slice(0, 160)),
    routerConfig: /@AutoRouterConfig\b/.test(clean),
    replaceInRouteName: replace?.[1] ?? '',
  };
}

/** Generated Dart. Never linted, never counted as a hand-written widget, never edited by hand. */
export function isGenerated(path: string): boolean {
  return /\.(g|gr|freezed|config|mocks|pb|pbenum|pbjson|pbserver)\.dart$/.test(path);
}

export interface Convention {
  /** Where this project keeps its screens — `lib/views`, `lib/pages`, `lib/screens`, or null. */
  views: string | null;
  /** Where it keeps reusable widgets — `lib/widgets`, `lib/components`, or null. */
  widgets: string | null;
}

const VIEW_DIRS = ['lib/views', 'lib/pages', 'lib/screens'];
const WIDGET_DIRS = ['lib/widgets', 'lib/components'];

/**
 * The project's OWN layout, discovered. Both halves may be null, and that is a legitimate answer for a
 * feature-first app (`lib/features/<name>/…`) — the caller then reports the location checks as
 * unchecked instead of demanding a layout the project never chose.
 */
export function conventionOf(root: string): Convention {
  const pick = (candidates: string[]): string | null => candidates.find((d) => {
    try { return statSync(join(root, d)).isDirectory(); } catch { return false; }
  }) ?? null;
  return { views: pick(VIEW_DIRS), widgets: pick(WIDGET_DIRS) };
}

/** Every `.dart` under `lib/`, bounded — the routers and the generated files have to be found. */
export function libDartFiles(root: string, limit = 800): string[] {
  const out: string[] = [];
  const stack = [join(root, 'lib')];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let entries: Array<{ name: string; dir: boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
    } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.dir) stack.push(p);
      else if (e.name.endsWith('.dart')) out.push(p);
    }
  }
  return out.sort();
}

export interface RouterIndex {
  /** Paths of the files declaring `@AutoRouterConfig`. Empty when this app does not use auto_route. */
  files: string[];
  /** Their source, concatenated — every route registration in the project, as text. */
  text: string;
  /** Every `.gr.dart` body, concatenated: what the generator has actually produced so far. */
  generated: string;
  replaceInRouteName: string;
}

/** Find the routers once per pass. Reading a few hundred small files costs milliseconds. */
export function indexRouters(root: string): RouterIndex {
  const files: string[] = [];
  let text = '';
  let generated = '';
  let replaceInRouteName = '';
  for (const p of libDartFiles(root)) {
    let source = '';
    try { source = readFileSync(p, 'utf-8'); } catch { continue; }
    if (isGenerated(p)) { generated += `\n${source}`; continue; }
    if (!/@AutoRouterConfig\b/.test(source)) continue;
    files.push(p);
    text += `\n${source}`;
    const facts = parseDart(source);
    if (facts.replaceInRouteName) replaceInRouteName = facts.replaceInRouteName;
  }
  return { files, text, generated, replaceInRouteName };
}

/**
 * The names a `@RoutePage()` class could plausibly be registered under.
 *
 * auto_route's generated class name depends on the router's own `replaceInRouteName` — `'View,Route'`
 * turns `HomeView` into `HomeRoute`, and with no such option it is `HomeViewRoute`. Rather than
 * modelling every spelling of that option, this returns EVERY candidate and the caller accepts any
 * one of them: over-accepting means a route we could not name is treated as registered, which is the
 * safe direction for a check that can otherwise invent a dead screen.
 */
export function routeNameCandidates(viewClass: string, replaceInRouteName: string): string[] {
  const names = new Set<string>([`${viewClass}Route`, viewClass]);
  const [from, to] = replaceInRouteName.split(',').map((s) => s.trim());
  if (from && to) {
    for (const token of from.split('|').map((s) => s.trim()).filter(Boolean)) {
      if (viewClass.endsWith(token)) names.add(`${viewClass.slice(0, -token.length)}${to}`);
    }
  }
  // The conventional suffixes, so a project that never declared the option is still read correctly.
  for (const suffix of ['View', 'Page', 'Screen']) {
    if (viewClass.endsWith(suffix)) names.add(`${viewClass.slice(0, -suffix.length)}Route`);
  }
  return [...names];
}

/** Is `rel` inside `dir` (both repo-relative, `/`-separated)? */
function inside(rel: string, dir: string | null): boolean {
  return !!dir && (rel === dir || rel.startsWith(`${dir}/`));
}

/** Files whose name is theirs by definition — an entry point is not a widget file. */
const NAME_EXEMPT = new Set(['main.dart']);

export interface InspectInput {
  root: string;
  file: string;
  source: string;
  convention: Convention;
  routers: RouterIndex;
}

/**
 * Every finding for ONE file. Ordered by how mechanical they are, and each one names the fix in the
 * same line — the agent reads this string and acts on it, so "what is wrong" without "what to do"
 * costs a whole extra pass.
 */
export function inspectFile({ root, file, source, convention, routers }: InspectInput): Finding[] {
  const rel = relative(root, file).split('\\').join('/');
  const base = basename(rel);
  const out: Finding[] = [];
  const add = (kind: string, line: string, certain = true): void => {
    out.push({ kind, file: rel, line: `${rel} — ${line}`, certain });
  };

  if (isGenerated(rel)) {
    // The one finding that does not depend on the file's content: it is generated, and the turn wrote it.
    add('generated-edited', 'generated code was edited by hand. Change the SOURCE and re-run `dart run build_runner build`; the next generator pass overwrites this file');
    return out;
  }
  if (!rel.startsWith('lib/')) return out;

  const facts = parseDart(source);
  if (!/^[a-z0-9_]+\.dart$/.test(base)) {
    add('dart-file-name', `file names are lower_snake_case in Dart (effective_dart, \`file_names\`) — rename it to ${snake(base.replace(/\.dart$/, ''))}.dart`);
  }

  const publicWidgets = facts.classes.filter((c) => c.isWidget && !c.isPrivate);
  if (publicWidgets.length > 1) {
    add('widget-per-file', `${publicWidgets.length} public widgets in one file (${publicWidgets.map((c) => c.name).join(', ')}). One widget per file, each in its own class — split them, and keep the file named after the one that stays`);
  }
  const primary = publicWidgets[0];
  if (primary && publicWidgets.length === 1 && !NAME_EXEMPT.has(base) && base !== `${snake(primary.name)}.dart`) {
    add('widget-file-name', `holds \`${primary.name}\` but is named \`${base}\` — the file is named after its widget: ${snake(primary.name)}.dart`);
  }

  if (inside(rel, convention.widgets)) {
    if (facts.routePages.length) {
      add('widget-is-route', `a @RoutePage() screen (${facts.routePages.join(', ')}) under ${convention.widgets}/. Screens live in ${convention.views ?? 'lib/views'}/; ${convention.widgets}/ is for reusable widgets`);
    }
    if (facts.navigations.length && publicWidgets.length) {
      add('widget-navigates', `a reusable widget that NAVIGATES (${facts.navigations[0]}). Take a callback (\`onPressed\`) and let the screen decide where it goes — a leaf that names a destination cannot be reused anywhere else`);
    }
  }
  if (facts.routePages.length && convention.views && !inside(rel, convention.views) && !facts.routerConfig) {
    add('view-location', `declares @RoutePage() (${facts.routePages.join(', ')}) outside ${convention.views}/, where this project keeps its screens`);
  }

  // ── routing: is every screen this file declares actually reachable? ──
  if (facts.routePages.length && routers.files.length) {
    for (const view of facts.routePages) {
      const candidates = routeNameCandidates(view, routers.replaceInRouteName);
      const registered = candidates.some((n) => new RegExp(`\\b${n}\\b`).test(routers.text));
      if (!registered) {
        add('route-unregistered', `@RoutePage() \`${view}\` is registered in no router — it is a screen nothing can reach. Add \`AutoRoute(page: ${candidates[candidates.length - 1]}.page, path: '/…')\` to ${relative(root, routers.files[0])}, then re-run the generator`);
        continue;
      }
      const generatedNow = candidates.some((n) => new RegExp(`class\\s+${n}\\b`).test(routers.generated));
      if (!generatedNow) {
        add('route-not-generated', `\`${view}\` is annotated and registered, but its route class is in no .gr.dart yet — run \`dart run build_runner build\``, false);
      }
    }
  }
  return out;
}

/**
 * The router-level finding: an app whose route list names no entry point opens on nothing.
 *
 * Reported rather than certain: `initial: true` is the usual spelling, `path: '/'` is another, and a
 * redirect or a guard can legitimately supply the first screen instead.
 */
export function inspectRouter(root: string, routers: RouterIndex): Finding[] {
  if (!routers.files.length) return [];
  if (/initial:\s*true/.test(routers.text) || /path:\s*['"]\/['"]/.test(routers.text)) return [];
  const rel = relative(root, routers.files[0]);
  return [{
    kind: 'router-initial',
    file: rel,
    line: `${rel} — no route is marked \`initial: true\` and none has \`path: '/'\`. auto_route has no first screen to open`,
    certain: false,
  }];
}

/**
 * Which paths the TURN CREATED, as repo-relative strings — untracked, or staged as an addition.
 *
 * This is what keeps the separation rules fair. A file ayin just wrote is held to the pattern; a
 * pre-existing file it edited one line of is reported and not enforced, because "you touched this
 * legacy file, now split it into four" is a gate demanding work nobody asked for. Outside a git
 * repository the answer is "nothing is new", so everything is reported — the conservative direction.
 */
export function newlyAddedFiles(root: string): Set<string> {
  const added = new Set<string>();
  let out = '';
  try {
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: root, encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return added;
  }
  for (const raw of out.split('\n')) {
    if (!raw.trim()) continue;
    const status = raw.slice(0, 2);
    const path = raw.slice(3).trim().replace(/^"|"$/g, '');
    // `A` in either column is an addition; `??` is untracked. A rename (`R`) carries " -> " and is
    // deliberately not counted: the file existed, under another name.
    if (status.includes('A') || status.startsWith('??')) added.add(path);
  }
  return added;
}
