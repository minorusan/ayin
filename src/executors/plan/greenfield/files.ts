/**
 * What a NEW project of each type actually contains, as bytes — the deterministic half of greenfield.
 *
 * WHY THIS IS A TABLE AND NOT A PROMPT. Everything else in `greenfield/` tells the model what the
 * layout SHOULD be and then hopes; this writes it. A bootstrap is the least creative part of any task
 * and the most annoying to get wrong, so no model call is involved and the result is byte-identical
 * every time. The plan that follows describes the FEATURE, because the project already exists.
 *
 * WHY IT LIVES BESIDE THE DELIVERABLES. `index.ts` declares what QA will demand of a finished project
 * — `package.json`, `tsconfig.json`, `src/index.ts`, `test/*.test.ts`, `.gitignore` for TypeScript.
 * If the scaffold wrote a different set, the validator would reject a plan for the project the
 * scaffold had just built. One file per branch, one list, checked against each other by
 * `check-plan.mjs`.
 *
 * EVERY FILE IS WRITE-IF-MISSING. Scaffolding runs before the plan and may run on a directory that is
 * not as empty as detection thought. Overwriting someone's `package.json` to bootstrap a project they
 * already have is the worst thing in this file's reach, so nothing here can do it.
 *
 * NOTHING HERE NEEDS THE NETWORK. The TypeScript entry point is `node:http`, the test runner is
 * `node:test`, the Python test is `unittest` — all standard library. A scaffold that only works when
 * a registry is reachable is a scaffold that fails in the room where you are demonstrating it.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { log } from '../../../log.js';

export type Branch = 'python' | 'typescript' | 'unity' | 'flutter';

/** A safe project/package name from a directory name. `My Notes!` → `my-notes`. */
export function safeName(root: string, sep = '-'): string {
  const n = (basename(root) || 'app').toLowerCase().replace(/[^a-z0-9._-]+/g, sep).replace(/^[-_]+|[-_]+$/g, '');
  return n || 'app';
}

/** A python-identifier-safe module name: `my-notes` → `my_notes`, never leading with a digit. */
export function pyName(root: string): string {
  const n = safeName(root, '_').replace(/[.-]+/g, '_');
  return /^[0-9]/.test(n) ? `p_${n}` : n;
}

/**
 * A Dart package name: lowercase with underscores, never leading with a digit. `My Notes!` →
 * `my_notes`. Pub REFUSES anything else, and it refuses it at `flutter pub get` — after the
 * scaffold has reported success.
 */
export function dartName(root: string): string {
  const n = safeName(root, '_').replace(/[.-]+/g, '_');
  return /^[0-9]/.test(n) ? `app_${n}` : n;
}

/** Write a file only if absent. Returns the path when it wrote, so the caller can report it. */
export function writeIfMissing(path: string, body: string): string[] {
  if (existsSync(path)) return [];
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    log('INFO', 'scaffold_file', { path });
    return [path];
  } catch (err) {
    // A read-only directory is worth reporting, never worth aborting the plan for.
    log('WARN', 'scaffold_file_failed', { path, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

// ── TypeScript: a web application that serves a page, and a test that proves it ──────────────

const TS_PKG = (name: string): string => `${JSON.stringify({
  name,
  version: '0.1.0',
  private: true,
  type: 'module',
  scripts: {
    // NODEMON, NOT `node --watch`. Both restart on an edit; only one of them is a supervisor the QA
    // boot check can start, wait for and kill as a group, and only one survives the crash an edit
    // introduces — `node --watch` exits on a syntax error and stops watching, so the next save fixes
    // nothing and the operator restarts by hand. `--watch src --ext ts,json` because a restart on
    // every touched file in the tree (dist/, node_modules/) is a server that never finishes starting.
    dev: 'nodemon --watch src --ext ts,json --exec "node --experimental-strip-types src/index.ts"',
    build: 'tsc',
    // `dist/src/index.js`, not `dist/index.js`. `rootDir` is the project root so that `tsc --noEmit`
    // covers the tests too, which means the emitted tree keeps the `src/` segment. A `start` script
    // pointing at a path the build does not produce is the first thing anyone runs.
    start: 'node dist/src/index.js',
    typecheck: 'tsc --noEmit',
    // `node:test` with type stripping — no test framework to install, and therefore a `npm test`
    // that passes on a machine that has never seen a registry.
    //
    // THE PATTERN IS QUOTED AND NODE EXPANDS IT. `test/` alone is read as a FILE and dies with
    // `Cannot find module …/test`; an unquoted `test/*.test.ts` works only because the shell expands
    // it first, which npm does not do the same way on Windows. Node's own glob is the portable form.
    test: 'node --test --experimental-strip-types "test/**/*.test.ts"',
  },
  devDependencies: { typescript: '^5.9.0', '@types/node': '^22.0.0', nodemon: '^3.1.0' },
}, null, 2)}\n`;

/**
 * `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` ARE LOAD-BEARING, not tidiness.
 *
 * Without them the two ways to run this project disagree. TS/ESM convention is to import the COMPILED
 * name — `from './server.js'` — which is right for `npm run build` and which a model correctly writes;
 * but `dev` and `test` execute the .ts directly through Node's type stripping, where `./server.js`
 * resolves literally and there is no such file. Measured: a bootstrapped project with one route added
 * died on `Cannot find module .../src/notes.js`, and neither the scaffold nor the model was wrong —
 * the scripts were. With these two, imports carry `.ts`, Node runs them as written, and tsc rewrites
 * them to `.js` on the way into `dist`.
 */
const TS_TSCONFIG = `${JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    outDir: 'dist',
    rootDir: '.',
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    declaration: false,
    sourceMap: true,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
  },
  include: ['src/**/*.ts', 'test/**/*.ts'],
}, null, 2)}\n`;

/**
 * THE SERVER IS A FUNCTION, AND THAT IS WHAT MAKES IT TESTABLE.
 *
 * `createServer()` here returns the server without listening. `src/index.ts` listens; the test binds
 * it to port 0 and asks it real questions over real HTTP. A bootstrap whose entry point calls
 * `.listen()` at module scope cannot be tested without a port collision, and the first thing anyone
 * does to it is take the logic back out — so it starts out already apart.
 */
const TS_SERVER = `import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * FOUND BY WALKING UP, because this file runs from two different depths.
 *
 * In dev it is \`src/server.ts\` and \`public/\` is one level up. After \`tsc\` it is
 * \`dist/src/server.js\` and \`public/\` is two. A hard-coded \`'..'\` is correct in dev and silently
 * serves 404s for every page in the built artifact — which is the copy you deploy.
 */
function findPublicDir(): string {
  let dir = HERE;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'public');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(HERE, '..', 'public');
}

const PUBLIC_DIR = findPublicDir();

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(urlPath: string, res: ServerResponse): Promise<boolean> {
  // NORMALISE, THEN REFUSE TO LEAVE. Without this, \`GET /../../etc/passwd\` is served happily.
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\\.\\.[/\\\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return false;
  try {
    const body = await readFile(file);
    const ext = (file.match(/\\.[a-z]+$/) ?? ['.html'])[0];
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  if (await serveStatic(url.pathname, res)) return;

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: \`no route \${req.method} \${url.pathname}\` }));
}

/** The server, not listening. The caller decides the port — which is what lets a test use 0. */
export function createServer() {
  return createHttpServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    });
  });
}
`;

const TS_INDEX = `import { createServer } from './server.ts';

const PORT = Number(process.env.PORT ?? 3000);

createServer().listen(PORT, () => {
  console.log(\`listening on http://localhost:\${PORT}\`);
});
`;

const TS_PAGE = (name: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; display: grid; place-items: center; min-height: 100vh;
           font: 16px/1.5 system-ui, sans-serif; }
    main { text-align: center; }
    code { padding: .15em .4em; border-radius: 4px; background: color-mix(in srgb, currentColor 12%, transparent); }
  </style>
</head>
<body>
  <main>
    <h1>${name}</h1>
    <p>The server is up. <span id="health">checking…</span></p>
    <p><code>src/server.ts</code> is where routes go.</p>
  </main>
  <script type="module">
    const el = document.getElementById('health');
    try {
      const r = await fetch('/api/health');
      el.textContent = r.ok ? '/api/health is OK' : \`/api/health returned \${r.status}\`;
    } catch {
      el.textContent = '/api/health is unreachable';
    }
  </script>
</body>
</html>
`;

/**
 * A TEST THAT PASSES ON A FRESH SCAFFOLD, over real HTTP.
 *
 * `npm test` on a project with a declared test script and no tests exits 1 — and QA has passed such a
 * project while calling its pipeline valid. Port 0 lets the OS pick, so this never collides with a dev
 * server or with a second copy of itself running in CI.
 */
const TS_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';

/** Start on port 0, run one request, always close — even when the assertion throws. */
async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    return await fn(\`http://127.0.0.1:\${port}\`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /api/health reports ok', async () => {
  await withServer(async (base) => {
    const res = await fetch(\`\${base}/api/health\`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});

test('GET / serves the page', async () => {
  await withServer(async (base) => {
    const res = await fetch(\`\${base}/\`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\\/html/);
    assert.match(await res.text(), /<h1>/);
  });
});

test('an unknown route is a 404, not a crash', async () => {
  await withServer(async (base) => {
    const res = await fetch(\`\${base}/nope\`);
    assert.equal(res.status, 404);
  });
});

test('a traversal attempt does not escape public/', async () => {
  await withServer(async (base) => {
    const res = await fetch(\`\${base}/../package.json\`);
    assert.notEqual(res.status, 200);
  });
});
`;

const TS_GITIGNORE = `node_modules/
dist/
*.tsbuildinfo
*.log
.env
`;

const TS_README = (name: string): string => `# ${name}

## Run it

\`\`\`bash
npm install        # required first — the type definitions come from here
npm run dev        # nodemon on http://localhost:3000 — restarts on every edit under src/
npm test           # node:test, no framework to install
npm run build      # tsc → dist/
npm run typecheck  # fails until npm install has run
\`\`\`

## Layout

- \`src/server.ts\` — the routes. \`createServer()\` returns the server **without** listening, which is
  what lets the test bind it to port 0.
- \`src/index.ts\` — the entry point. Reads \`PORT\`, listens. \`PORT=4000 npm run dev\` to move it.
- \`public/index.html\` — the page. Anything in \`public/\` is served as-is.
- \`test/server.test.ts\` — real HTTP against a real server.

Import local files with the \`.ts\` extension (\`./server.ts\`) — this tsconfig rewrites it to \`.js\` on
build, and Node runs it as written in dev and test.

## Notes

This project was bootstrapped deterministically — the manifest, the TypeScript configuration, the
server, the page and the test were written without a model, so they are the same every time.
`;

// ── Python: a package that imports and a test that runs, with nothing installed ───────────────

const PY_PYPROJECT = (name: string, mod: string): string => `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "${name}"
version = "0.1.0"
description = "${name}"
requires-python = ">=3.10"
dependencies = []

[project.scripts]
${name} = "${mod}.__main__:main"

[tool.hatch.build.targets.wheel]
packages = ["src/${mod}"]
`;

const PY_INIT = (mod: string): string => `"""${mod} — the package root."""

__all__ = ["greet"]


def greet(who: str = "world") -> str:
    """The one function the smoke test proves is importable."""
    return f"hello, {who}"
`;

const PY_MAIN = (mod: string): string => `"""Entry point: \`python -m ${mod}\`."""

import sys

from . import greet


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    print(greet(args[0] if args else "world"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

/**
 * `unittest.TestCase`, NOT a bare `def test_…`, and the path insert is deliberate.
 *
 * pytest collects both; `python -m unittest` collects only the class. Writing the class means the
 * suite runs under either, including on a machine with nothing installed and no virtualenv — which is
 * the state a freshly scaffolded project is in. The `sys.path` insert is what makes `src/` importable
 * before an editable install has happened, for the same reason.
 */
const PY_TEST = (mod: string): string => `import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ${mod} import greet  # noqa: E402


class TestGreet(unittest.TestCase):
    def test_default(self) -> None:
        self.assertEqual(greet(), "hello, world")

    def test_named(self) -> None:
        self.assertEqual(greet("ayin"), "hello, ayin")


if __name__ == "__main__":
    unittest.main()
`;

const PY_GITIGNORE = `__pycache__/
*.py[cod]
.venv/
venv/
dist/
build/
*.egg-info/
.pytest_cache/
.mypy_cache/
.env
`;

const PY_README = (name: string, mod: string): string => `# ${name}

## Run it

\`\`\`bash
python -m unittest discover -s tests        # passes with nothing installed
PYTHONPATH=src python -m ${mod}   # prints: hello, world
\`\`\`

\`PYTHONPATH=src\` is needed until the package is installed — this is a src layout, so \`src/\` is not
on the path by default. The test file inserts it itself, which is why the suite needs no such prefix.

Once you want an environment:

\`\`\`bash
python -m venv .venv && . .venv/bin/activate
pip install -e .        # then \`${name}\` is on PATH
\`\`\`

## Layout

- \`src/${mod}/__init__.py\` — the package. \`greet()\` is what the smoke test imports.
- \`src/${mod}/__main__.py\` — \`python -m ${mod}\`.
- \`tests/test_smoke.py\` — \`unittest.TestCase\`, so pytest and \`python -m unittest\` both collect it.

## Notes

Bootstrapped deterministically — src layout, manifest and smoke test written without a model.
`;

// ── Unity: the three files that make a folder a project Unity will open ───────────────────────

const UNITY_MANIFEST = `{
  "dependencies": {
    "com.unity.ugui": "1.0.0",
    "com.unity.modules.ui": "1.0.0",
    "com.unity.modules.uielements": "1.0.0"
  }
}
`;

/**
 * `ProjectVersion.txt` IS WHAT MAKES THE FOLDER A PROJECT. Without it the Hub does not list the
 * directory at all, and the operator's first experience of the scaffold is Unity not seeing it. The
 * version is a recent LTS and is meant to be edited to whatever is installed — which the README says.
 */
const UNITY_VERSION = `m_EditorVersion: 2022.3.62f1
m_EditorVersionWithRevision: 2022.3.62f1 (4a4e2f7b0b6a)
`;

const UNITY_SCRIPT = (cls: string): string => `using UnityEngine;

/// <summary>
/// The one behaviour the scaffold ships: proof the assembly compiles and the scene runs.
/// Attach it to an empty GameObject, press Play, and the message is in the Console.
/// </summary>
public class ${cls} : MonoBehaviour
{
    [SerializeField] private string message = "${cls} is running";

    private void Awake()
    {
        Debug.Log(message);
    }
}
`;

const UNITY_GITIGNORE = `[Ll]ibrary/
[Tt]emp/
[Oo]bj/
[Bb]uild/
[Bb]uilds/
[Ll]ogs/
[Uu]ser[Ss]ettings/
*.csproj
*.sln
*.userprefs
.vscode/
.idea/
`;

const UNITY_README = (name: string, cls: string): string => `# ${name}

## Open it

Unity Hub → Add → this folder. \`ProjectSettings/ProjectVersion.txt\` says **2022.3.62f1**; change that
line to the version you actually have installed before opening, or the Hub will offer to upgrade.

## Layout

- \`Assets/Scripts/${cls}.cs\` — a MonoBehaviour that logs on \`Awake\`. Attach it to an empty
  GameObject to confirm the project builds and runs.
- \`Packages/manifest.json\` — UGUI and the UI modules; add packages here, not through the filesystem.
- \`ProjectSettings/ProjectVersion.txt\` — what the Hub reads to decide the editor version.

Scenes and \`.meta\` files are the EDITOR's to create. Nothing here writes them: a hand-written
\`.meta\` with an invented GUID is how a project ends up with broken references that only appear on
another machine.

## Notes

Bootstrapped deterministically — written without a model, so it is the same every time.
`;

// ── Flutter: a routed app that analyzes clean, tests green and builds ─────────────────────────

/**
 * EVERY BYTE BELOW WAS RUN BEFORE IT WAS WRITTEN DOWN — Flutter 3.44 / Dart 3.12, `flutter analyze`
 * clean, `flutter test` green, `flutter build web --release` through. Four of these files are the way
 * they are because the first version of them did not compile, and the four errors are in the README's
 * caveat table for the operator who hits them next:
 *
 *   · `AppRouter extends RootStackRouter`, never `_$AppRouter`. auto_route ≥ 9 generates the route
 *     classes and NOT a router base class, so the `_$` form fails with `extends_non_class` and then
 *     every member of the router — `config()` included — reads as undefined.
 *   · the generated routes are IMPORTED and re-exported, never a `part`. In part mode the generated
 *     file inherits this file's imports and can add none of its own, so a `Key?` in a generated args
 *     class needs `material.dart` here — and, worse, a view that is annotated but not yet registered
 *     generates a route class naming a type this file never imported, which breaks the build inside
 *     generated code. The default mode imports every view itself.
 *   · a route with arguments generates a NON-const constructor, so `const DetailRoute(id: …)` is
 *     `const_with_non_const`.
 *   · the widget test imports only `flutter_test` and the app — an unused `material.dart` import is a
 *     lint, and `flutter analyze` is a deliverable here.
 *
 * THE ONE THING THIS SCAFFOLD CANNOT DO ALONE is generate `app_router.gr.dart`: auto_route's routes
 * come out of build_runner, so the project needs `flutter pub get` and one generator pass before it
 * compiles. `plan/flutter` starts both; the README states them for every case where it could not.
 */

const FLUTTER_PUBSPEC = (name: string): string => `name: ${name}
description: "${name} — a Flutter app routed with auto_route."
publish_to: 'none'
version: 0.1.0+1

environment:
  # ^3.8.0 IS THE FLOOR THE DEPENDENCIES SET, not a preference: build_runner 2.15 and flutter_lints 6
  # both declare it. An older SDK cannot resolve this file at all — run \`flutter upgrade\`.
  sdk: ^3.8.0

dependencies:
  flutter:
    sdk: flutter
  auto_route: ^11.1.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^6.0.0
  # The generator's major trails auto_route's on purpose — this is the pair pub actually resolves.
  auto_route_generator: ^10.6.0
  build_runner: ^2.15.1

flutter:
  uses-material-design: true
`;

/**
 * The generated `.gr.dart` is deliberately NOT excluded from the analyzer. It carries its own
 * `ignore_for_file: type=lint`, so lints are already quiet in it — but a real error there is almost
 * always a missing import in the file it is a `part` of, and that is the one diagnostic worth seeing.
 */
const FLUTTER_ANALYSIS = `include: package:flutter_lints/flutter.yaml
`;

const FLUTTER_MAIN = `import 'package:flutter/material.dart';

import 'app.dart';

void main() {
  runApp(const App());
}
`;

const FLUTTER_APP = (name: string): string => `import 'package:flutter/material.dart';

import 'router/app_router.dart';

/// The root widget. The router is built ONCE, as a field — a router constructed inside \`build()\`
/// is a new router on every rebuild, which drops the navigation stack.
class App extends StatefulWidget {
  const App({super.key});

  @override
  State<App> createState() => _AppState();
}

class _AppState extends State<App> {
  final AppRouter _router = AppRouter();

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: '${name}',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF4F46E5), useMaterial3: true),
      darkTheme: ThemeData(
        colorSchemeSeed: const Color(0xFF4F46E5),
        brightness: Brightness.dark,
        useMaterial3: true,
      ),
      routerConfig: _router.config(),
    );
  }
}
`;

/**
 * IMPORTED AND RE-EXPORTED, NEVER A `part` — and that is a measured decision, not a style.
 *
 * auto_route's part-file mode cannot add imports (a `part` may not have any), so the generated route
 * classes borrow this file's. Measured on a real turn: a view annotated `@RoutePage()` and not yet
 * registered still gets a route class generated, that class names the view, this file did not import
 * it — and a project that analyzed clean stopped compiling *inside a generated file*, which is the
 * most confusing state an agent can be handed. In the default mode the generated library imports
 * every view itself, so an unregistered view is harmless and the router file needs no view imports at
 * all. `export` is what keeps `import '../router/app_router.dart'` enough for a view to name a route.
 */
const FLUTTER_ROUTER = `import 'package:auto_route/auto_route.dart';

import 'app_router.gr.dart';

export 'app_router.gr.dart';

/// Every route in the app, in one list.
///
/// \`replaceInRouteName: 'View,Route'\` is what turns \`HomeView\` into the \`HomeRoute\` you navigate
/// with. To add a screen: one \`@RoutePage()\` view file, one \`AutoRoute\` line here, then
///
///     dart run build_runner build
///
/// \`RootStackRouter\` is the base class — auto_route generates the route classes, not the router.
@AutoRouterConfig(replaceInRouteName: 'View,Route')
class AppRouter extends RootStackRouter {
  @override
  List<AutoRoute> get routes => [
        AutoRoute(page: HomeRoute.page, path: '/', initial: true),
        AutoRoute(page: CounterRoute.page, path: '/counter'),
        AutoRoute(page: DetailRoute.page, path: '/detail/:id'),
      ];
}
`;

/** One view per file, one class per file — the convention the whole `lib/views` tree follows. */
const FLUTTER_HOME_VIEW = `import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';

import '../router/app_router.dart';
import '../widgets/primary_button.dart';
import '../widgets/section_card.dart';

/// \`@RoutePage()\` is what makes \`HomeRoute\` exist. A view without it cannot be routed to.
@RoutePage()
class HomeView extends StatelessWidget {
  const HomeView({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionCard(
            title: 'Counter',
            body: 'State kept in a StatefulWidget.',
            action: PrimaryButton(
              label: 'Open counter',
              onPressed: () => context.router.push(const CounterRoute()),
            ),
          ),
          const SizedBox(height: 12),
          SectionCard(
            title: 'Detail',
            body: 'A route that takes a path parameter.',
            action: PrimaryButton(
              label: 'Open detail',
              // NOT const: a route with arguments generates a non-const constructor.
              onPressed: () => context.router.push(DetailRoute(id: 'ayin')),
            ),
          ),
        ],
      ),
    );
  }
}
`;

const FLUTTER_COUNTER_VIEW = `import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';

import '../widgets/primary_button.dart';
import '../widgets/stat_tile.dart';

@RoutePage()
class CounterView extends StatefulWidget {
  const CounterView({super.key});

  @override
  State<CounterView> createState() => _CounterViewState();
}

class _CounterViewState extends State<CounterView> {
  int _count = 0;

  void _increment() => setState(() => _count++);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Counter')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            StatTile(label: 'Taps', value: '\$_count'),
            const SizedBox(height: 16),
            PrimaryButton(label: 'Add one', onPressed: _increment),
          ],
        ),
      ),
    );
  }
}
`;

const FLUTTER_DETAIL_VIEW = `import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';

import '../widgets/section_card.dart';

/// \`@PathParam\` binds \`/detail/:id\` to the constructor argument, so the deep link
/// \`/detail/ayin\` and \`DetailRoute(id: 'ayin')\` reach this widget with the same value.
@RoutePage()
class DetailView extends StatelessWidget {
  const DetailView({@PathParam('id') required this.id, super.key});

  final String id;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Detail: \$id')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: SectionCard(title: id, body: 'Opened with id "\$id".'),
      ),
    );
  }
}
`;

/** One widget per file, in its own class, taking what it shows and doing nothing else. */
const FLUTTER_PRIMARY_BUTTON = `import 'package:flutter/material.dart';

class PrimaryButton extends StatelessWidget {
  const PrimaryButton({required this.label, required this.onPressed, super.key});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return FilledButton(onPressed: onPressed, child: Text(label));
  }
}
`;

const FLUTTER_SECTION_CARD = `import 'package:flutter/material.dart';

class SectionCard extends StatelessWidget {
  const SectionCard({required this.title, required this.body, this.action, super.key});

  final String title;
  final String body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: text.titleMedium),
            const SizedBox(height: 4),
            Text(body, style: text.bodyMedium),
            if (action != null) ...[const SizedBox(height: 12), action!],
          ],
        ),
      ),
    );
  }
}
`;

const FLUTTER_STAT_TILE = `import 'package:flutter/material.dart';

class StatTile extends StatelessWidget {
  const StatTile({required this.label, required this.value, super.key});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Column(
      children: [
        Text(value, style: theme.textTheme.displaySmall),
        Text(label, style: theme.textTheme.labelLarge),
      ],
    );
  }
}
`;

/**
 * A TEST THAT DRIVES THE ROUTER, not one that pumps a widget in isolation.
 *
 * It pumps the real `App`, taps through to a second route and asserts the state change there — so it
 * fails if the router is misconfigured, which is the thing most likely to be wrong in a routed app
 * and the thing a per-widget test cannot see. `pumpAndSettle` is required after a push: a route
 * transition is an animation, and `pump` alone lands mid-flight.
 */
const FLUTTER_TEST = (name: string): string => `import 'package:flutter_test/flutter_test.dart';
import 'package:${name}/app.dart';

void main() {
  testWidgets('home routes to the counter, and it counts', (WidgetTester tester) async {
    await tester.pumpWidget(const App());
    await tester.pumpAndSettle();

    expect(find.text('Home'), findsOneWidget);

    await tester.tap(find.text('Open counter'));
    await tester.pumpAndSettle();

    expect(find.text('Counter'), findsOneWidget);
    expect(find.text('0'), findsOneWidget);

    await tester.tap(find.text('Add one'));
    await tester.pump();

    expect(find.text('1'), findsOneWidget);
  });
}
`;

/**
 * Flutter's own template, plus one deliberate omission: `*.gr.dart` is NOT ignored.
 *
 * The generated routes are committed, so a fresh clone builds after `flutter pub get` alone and a
 * reviewer can see a new route arrive in the diff. Ignoring them makes "clone and run" fail on a
 * missing file that no error message tells you to generate.
 */
const FLUTTER_GITIGNORE = `# Miscellaneous
*.class
*.log
*.swp
.DS_Store
.atom/
.build/
.buildlog/
.history
.svn/
.swiftpm/
migrate_working_dir/

# IntelliJ related
*.iml
*.ipr
*.iws
.idea/

# Flutter/Dart/Pub related
**/doc/api/
**/ios/Flutter/.last_build_id
.dart_tool/
.flutter-plugins-dependencies
.pub-cache/
.pub/
/build/
/coverage/

# Symbolication and obfuscation
app.*.symbols
app.*.map.json

# Android Studio build artifacts
/android/app/debug
/android/app/profile
/android/app/release
`;

const FLUTTER_README = (name: string): string => `# ${name}

A Flutter app routed with [auto_route](https://pub.dev/packages/auto_route). Bootstrapped
deterministically by ayin: the layout below is the pattern to extend, not a suggestion.

## Launch it

\`\`\`bash
flutter pub get                 # 1. resolve dependencies
dart run build_runner build     # 2. generate lib/router/app_router.gr.dart
flutter run -d chrome           # 3. run — or -d macos, or -d <id> from \`flutter devices\`
\`\`\`

**Steps 1 and 2 are not optional, and they are in that order.** \`HomeRoute\`, \`CounterRoute\` and
\`DetailRoute\` do not exist in any file you can read — the generator writes them into
\`lib/router/app_router.gr.dart\`, and nothing compiles until it has.

Then, in any order:

\`\`\`bash
flutter analyze     # must print "No issues found!"
flutter test        # one widget test: home → counter → tap → 1
flutter build web   # or: apk · appbundle · ios · macos · linux · windows
\`\`\`

## Layout

| Path | What it is |
|---|---|
| \`lib/main.dart\` | \`runApp\`. Three lines; leave it alone. |
| \`lib/app.dart\` | \`MaterialApp.router\`, theme, and the ONE \`AppRouter\` instance. |
| \`lib/router/app_router.dart\` | every route, in one list. |
| \`lib/router/app_router.gr.dart\` | **generated**, and re-exported by \`app_router.dart\`. Never edit it. |
| \`lib/views/*_view.dart\` | one screen per file, one class per file, each \`@RoutePage()\`. |
| \`lib/widgets/*.dart\` | one widget per file, one class per file, no routing knowledge. |
| \`test/navigation_test.dart\` | pumps the real app and taps through the router. |

## Adding a screen — the whole pattern

1. \`lib/views/settings_view.dart\`: one class, \`@RoutePage()\`, \`class SettingsView extends StatelessWidget\`.
2. \`lib/router/app_router.dart\`: \`AutoRoute(page: SettingsRoute.page, path: '/settings')\`.
3. \`dart run build_runner build\` — \`SettingsRoute\` does not exist until this runs.
4. Navigate: \`context.router.push(const SettingsRoute())\`.

\`replaceInRouteName: 'View,Route'\` is what maps \`SettingsView\` → \`SettingsRoute\`. Path parameters
are declared on the constructor (\`@PathParam('id') required this.id\`) and passed as arguments
(\`DetailRoute(id: 'x')\`) — see \`lib/views/detail_view.dart\`. Keep \`dart run build_runner watch\`
running while you work and step 3 happens by itself.

The router file imports no views: the generated library imports them itself, which is why a
\`@RoutePage()\` view you have not registered yet is harmless rather than a broken build.

## Why it will not launch

| What you see | Why | Fix |
|---|---|---|
| \`Target of URI hasn't been generated: 'app_router.gr.dart'\`, or \`Undefined name 'HomeRoute'\` | the generator has not run since the last route change | \`dart run build_runner build\` |
| \`Undefined name 'HomeRoute'\` **although app_router.gr.dart exists** | the route classes live in \`app_router.gr.dart\`; the router file re-exports them | keep \`export 'app_router.gr.dart';\` in \`app_router.dart\` |
| \`extends_non_class\` on \`_$AppRouter\`, then \`config()\` undefined | auto_route ≥ 9 generates routes, NOT a router base class | \`class AppRouter extends RootStackRouter\` |
| \`const_with_non_const\` on a route you navigate to | a route WITH arguments generates a non-const constructor | drop the \`const\` |
| \`These options have been removed and were ignored: --delete-conflicting-outputs\` | build_runner ≥ 2.15 dropped the flag | harmless; drop the flag |
| \`Because ${name} requires SDK version ^3.8.0\` | the Dart SDK is older than the dependencies | \`flutter upgrade\` (or lower the constraint in \`pubspec.yaml\` and re-resolve at your own risk) |
| \`No supported devices connected\` | nothing to run on | \`flutter devices\`. \`-d chrome\` needs Chrome; \`-d macos\` needs Xcode; a phone needs USB debugging |
| \`android/\`, \`ios/\` or \`web/\` is missing | Flutter was not on PATH when the project was scaffolded, so the platform folders were never generated | \`flutter create --platforms=android,ios,web,macos .\` in this directory |
| CocoaPods errors on an iOS/macOS build | pods not installed for the platform folder | \`sudo gem install cocoapods\`, then \`cd macos && pod install\` |
| Android build stops on licences | the SDK licences were never accepted | \`flutter doctor --android-licenses\` |
| \`pub get\` hangs or fails | no route to pub.dev, or a proxy | \`flutter pub get -v\`; set \`PUB_HOSTED_URL\` / \`FLUTTER_STORAGE_BASE_URL\` for a mirror |
| something else entirely | | \`flutter doctor -v\` first — it names the broken piece, and it is usually not this project |

## Dependencies

- [Flutter SDK — install](https://docs.flutter.dev/get-started/install) · [flutter doctor](https://docs.flutter.dev/reference/flutter-cli)
- [auto_route](https://pub.dev/packages/auto_route) · [API docs](https://pub.dev/documentation/auto_route/latest/)
- [auto_route_generator](https://pub.dev/packages/auto_route_generator) · [build_runner](https://pub.dev/packages/build_runner)
- [flutter_lints](https://pub.dev/packages/flutter_lints) · [Flutter cookbook](https://docs.flutter.dev/cookbook)

## Notes

The manifest, the router, the views, the widgets and the test were written without a model, so they
are identical every time. The generated route file is deliberately **not** gitignored — commit it, and
a fresh clone builds after \`flutter pub get\` alone while a new route still shows up in review as a diff.
`;

// ── the design directory, in every branch ─────────────────────────────────────────────────────

/**
 * `.naamah/` EXISTS FROM THE START, because a convention nobody can see is a convention that gets
 * skipped.
 *
 * The system prompt tells the agent to make `.naamah/<task-slug>/` itself and the naamah tool creates
 * it on first sketch — so the directory did appear, eventually, on a turn that remembered. Shipping it
 * with the scaffold makes the design step part of what a project IS rather than something the model has
 * to recall: the folder is there, the README says what goes in it, and `naamah show` has somewhere to
 * point before any sketch exists.
 *
 * IT MUST NOT REACH THE BUILD. A design file is `declare class X { … }` — signatures with no bodies,
 * one global scope, deliberately not a module. Compiled as part of the project it is a duplicate-symbol
 * error at best. The TypeScript scaffold's `include` names only the `src` and `test` trees, so
 * `.naamah/` is outside it; Python packages only `src/<mod>`; Unity compiles only under `Assets/`, and
 * a dot-directory is invisible to the editor anyway. Asserted by `check-plan.mjs`, which drops a real
 * design file in and compiles.
 *
 * (The glob is described rather than quoted: a `*` followed by a `/` inside a block comment ends the
 * comment, and the rest of this file becomes syntax errors. It did.)
 *
 * NOT GITIGNORED, ON PURPOSE. The design is the most reviewable artefact the project has — it is the
 * thing `/naamah` puts on a page and comments on — and a reviewer who cannot see it in the diff cannot
 * review it.
 */
const NAAMAH_README = (kind: 'TypeScript' | 'Python' | 'C#'): string => {
  const ext = kind === 'C#' ? 'cs' : kind === 'Python' ? 'ts' : 'ts';
  const decl = kind === 'C#'
    ? 'public class NoteService { public Note Get(string id); }'
    : 'declare class NoteService { get(id: string): Note; }';
  return `# .naamah — the design, before the code

One directory per task: \`.naamah/<task-slug>/\`. Inside it, one file per type, written as
declarations with no bodies:

\`\`\`${ext === 'cs' ? 'csharp' : 'typescript'}
${decl}
\`\`\`

Then \`naamah build .naamah/<task-slug>/\` compiles the whole design with a real compiler and
**enforces** it: from that point every write is checked against the sketch and you are handed one type
at a time to implement.

Three rules, because the compiler cannot warn you kindly about any of them:

- **These files are documents, not modules.** Never import from \`.naamah/\` in real source — nothing
  here exports anything, so the import cannot resolve. Declare the type again where you implement it;
  the sketch is what you transcribe FROM.
- **No \`import\`/\`export\`** in a ${kind} design file${kind === 'C#' ? ' and no `namespace`' : ''}. They share one
  global scope, which is what lets one file refer to a type another file declares.
- **Every name is copied**, from the request or from code that already exists. From \`build\` onward a
  mistyped name is not a typo, it is the contract.

Nothing here is compiled into the project — it is outside the build's \`include\` — and it is **not**
gitignored, because the design is the part most worth reviewing.
`;
};

// ── the table ─────────────────────────────────────────────────────────────────────────────────

/**
 * The scaffold's OWN design, and it must BUILD — not a placeholder.
 *
 * `.naamah/README.md` described the format and shipped nothing in it, so the first `naamah build` an
 * agent ran was against an empty directory: the design gate's first contact with a new project was a
 * failure, on the one turn where nothing is wrong yet. This is one real annotated declaration of the
 * server the scaffold just wrote, which means `naamah build .naamah/scaffold` typechecks and renders
 * from the moment the project exists, and the next design is written by copying a file that works
 * rather than by reading a description of one.
 *
 * IT DESCRIBES `src/server.ts`, the file it sits beside — a design of something else would be a lie
 * that compiles. `createServer` returns Server from node:http; the design says `unknown` because a
 * design directory has no `@types/node` on its own compile line and a name it cannot resolve is the
 * one thing that fails this build.
 */
const TS_DESIGN = `@Domain('HTTP')
@Remark('The server the scaffold wrote. Replace this file with the design of YOUR feature.')
declare class HttpServer {
  // MUST return the server WITHOUT listening — that is what lets a test bind port 0.
  createServer(): unknown;

  // MUST read process.env.PORT and listen on it. The QA gate boots the project and checks that port.
  listen(port: number): void;
}
`;

/** One branch's files, as `relative path → contents`, given the project directory. */
export function branchFiles(branch: Branch, dir: string): Record<string, string> {
  if (branch === 'typescript') {
    const name = safeName(dir);
    return {
      'package.json': TS_PKG(name),
      'tsconfig.json': TS_TSCONFIG,
      '.gitignore': TS_GITIGNORE,
      'README.md': TS_README(name),
      'src/server.ts': TS_SERVER,
      'src/index.ts': TS_INDEX,
      'public/index.html': TS_PAGE(name),
      'test/server.test.ts': TS_TEST,
      '.naamah/README.md': NAAMAH_README('TypeScript'),
      '.naamah/scaffold/HttpServer.ts': TS_DESIGN,
    };
  }
  if (branch === 'python') {
    const name = safeName(dir);
    const mod = pyName(dir);
    return {
      'pyproject.toml': PY_PYPROJECT(name, mod),
      '.gitignore': PY_GITIGNORE,
      'README.md': PY_README(name, mod),
      [`src/${mod}/__init__.py`]: PY_INIT(mod),
      [`src/${mod}/__main__.py`]: PY_MAIN(mod),
      'tests/test_smoke.py': PY_TEST(mod),
      '.naamah/README.md': NAAMAH_README('Python'),
    };
  }
  if (branch === 'flutter') {
    const name = dartName(dir);
    return {
      'pubspec.yaml': FLUTTER_PUBSPEC(name),
      'analysis_options.yaml': FLUTTER_ANALYSIS,
      '.gitignore': FLUTTER_GITIGNORE,
      'README.md': FLUTTER_README(name),
      'lib/main.dart': FLUTTER_MAIN,
      'lib/app.dart': FLUTTER_APP(name),
      'lib/router/app_router.dart': FLUTTER_ROUTER,
      'lib/views/home_view.dart': FLUTTER_HOME_VIEW,
      'lib/views/counter_view.dart': FLUTTER_COUNTER_VIEW,
      'lib/views/detail_view.dart': FLUTTER_DETAIL_VIEW,
      'lib/widgets/primary_button.dart': FLUTTER_PRIMARY_BUTTON,
      'lib/widgets/section_card.dart': FLUTTER_SECTION_CARD,
      'lib/widgets/stat_tile.dart': FLUTTER_STAT_TILE,
      'test/navigation_test.dart': FLUTTER_TEST(name),
      // Naamah compiles TypeScript or C# sketches, so a Dart project's design is written in
      // TypeScript — the same choice the python branch makes, for the same reason.
      '.naamah/README.md': NAAMAH_README('TypeScript'),
    };
  }
  // unity
  const name = safeName(dir);
  const cls = `${name.replace(/(^|[-_.])(\w)/g, (_m, _s, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '') || 'Bootstrap'}Bootstrap`;
  return {
    'Packages/manifest.json': UNITY_MANIFEST,
    'ProjectSettings/ProjectVersion.txt': UNITY_VERSION,
    '.gitignore': UNITY_GITIGNORE,
    'README.md': UNITY_README(name, cls),
    [`Assets/Scripts/${cls}.cs`]: UNITY_SCRIPT(cls),
    '.naamah/README.md': NAAMAH_README('C#'),
  };
}

/**
 * Which of a branch's files are already on disk — what the survey must report as DONE.
 *
 * Answered from the same table that writes them, so the survey cannot describe a project the scaffold
 * did not produce, and cannot miss one it did.
 */
export function existingBranchFiles(branch: Branch, dir: string): string[] {
  return Object.keys(branchFiles(branch, dir)).filter((rel) => existsSync(join(dir, rel)));
}

/** Write a branch's whole file set into `dir`, skipping anything already there. */
export function writeBranchFiles(branch: Branch, dir: string): string[] {
  const made: string[] = [];
  for (const [rel, body] of Object.entries(branchFiles(branch, dir))) {
    made.push(...writeIfMissing(join(dir, rel), body));
  }
  if (made.length) log('INFO', 'scaffold_branch', { branch, dir, files: String(made.length) });
  return made;
}
