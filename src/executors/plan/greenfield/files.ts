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

export type Branch = 'python' | 'typescript' | 'unity';

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
    dev: 'node --watch --experimental-strip-types src/index.ts',
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
  devDependencies: { typescript: '^5.9.0', '@types/node': '^22.0.0' },
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
npm run dev        # watch mode on http://localhost:3000
npm test           # node:test, no framework to install
npm run build      # tsc → dist/
npm run typecheck  # fails until npm install has run
\`\`\`

## Layout

- \`src/server.ts\` — the routes. \`createServer()\` returns the server **without** listening, which is
  what lets the test bind it to port 0.
- \`src/index.ts\` — the entry point. Reads \`PORT\`, listens.
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
