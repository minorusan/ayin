/**
 * Unity QA executor — ONE question: does the C# compile?
 *
 * WHAT THIS REPLACES, AND WHY. Until now a Unity project fell to `qa/base`, whose only contributed fact
 * is `readme-substance` — marked `hard`, so it fails the gate without the judge. Measured on a real
 * Unity repo: a 56-byte root README produced "README.md is only 54 chars — too short to carry a parts
 * list and a pin map", which is Arduino wording (the check was written for the Arduino scaffold stub) and
 * a guaranteed failure on all three passes of every qualifying turn, whatever the work was. On top of
 * that the judge was handed generic code/docs criteria and no compile result at all — so the gate could
 * not tell a Unity turn that BUILDS from one that does not, while reliably failing both.
 *
 * So for Unity the gate is now exactly one deterministic check, and `factsOnly` in the config turns off
 * criteria derivation and the judge entirely (see qa/index.ts). Compilation is the floor: an answer
 * about code that does not compile is not worth reviewing, and everything else the old path asked was
 * either wrong for the project type or unmeasurable without launching the editor.
 *
 * HOW A UNITY PROJECT IS ACTUALLY COMPILED — the two cases, because on a working machine the second is
 * the normal one:
 *
 *   1. THE EDITOR IS CLOSED → run it. `Unity -batchmode -quit -nographics -projectPath …` imports and
 *      compiles, and the log carries `error CS…` lines. This is authoritative and slow. It needs the
 *      project lock, which is why it is only ever attempted when nothing holds it.
 *
 *   2. THE EDITOR IS OPEN → read what it already produced. Unity writes `Library/ScriptAssemblies/
 *      <Assembly>.dll` on a SUCCESSFUL compile and leaves the previous DLL in place on a failed one.
 *      So a DLL newer than every source under its asmdef is proof of a clean compile of that assembly,
 *      and a stale DLL means "not compiled yet, or failed". That distinction is the whole check, and it
 *      costs nothing. Batch mode here would be actively wrong: it cannot take the lock, and killing the
 *      operator's editor to answer a QA question is not something a read-only probe may do.
 *
 * MACOS IS THE TARGET and every piece of it is already correct in `testrun/`: the Hub path
 * `/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity` (`unityBinary`), the version
 * from `ProjectSettings/ProjectVersion.txt` (`unityVersion`), the lock at `Temp/UnityLockfile`, and
 * `/set unity-path` for a non-Hub install. Nothing about the editor's location is written down here.
 *
 * NOT VERIFIED IS NOT A FAILURE. No Unity install, a batch run that timed out, an assembly the editor
 * has not rebuilt yet — each yields a fact that is NOT `hard`, because a gate that blocks a finished
 * answer on "I could not check" is a worse bug than the ones it catches. The detail always says which
 * case it was and what would make it answerable.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { getConfig } from '../../../prompts.js';
import {
  buildAsmdefIndex, compiledState, isUnityProject, owningAsmdef, unityHasProjectOpen, unityVersion,
} from '../../../testrun/asmdef.js';
import { addedFieldNames, inspectFile, typeOwners } from './shape.js';
import { unityBinary } from '../../../testrun/run.js';
import {
  buildSolution, compileWithCsc, generatedProjects, parseCsErrors, projectsCovering, readCsproj, unityCsc,
  type CompileAttempt, type CsProject,
} from './compile.js';
import type { ChangedFile } from '../../../qa/probes.js';
import type { ExecutorConfig, PrepareResult, ProbeFact, ProjectContext, QaExecutor } from '../../types.js';

const config: ExecutorConfig = {
  id: 'unity', kind: 'qa', projectTypes: ['unity'], priority: 10, factsOnly: true,
  description: 'Unity QA — one deterministic check: does the C# compile. Nothing else, and no judge.',
};

/** How long a batch-mode compile may take before it is reported as unverified rather than failed. */
const BATCH_TIMEOUT_MS = () => getConfig('unityCompileTimeoutMs', 20 * 60_000);

export const unityQaExecutor: QaExecutor = {
  config,

  /** Nothing to produce: a compile check needs no artifacts written first. */
  async prepare(): Promise<PrepareResult> {
    return { produced: [], handled: new Set(), notes: [] };
  },

  async probe(ctx: ProjectContext, files: ChangedFile[]): Promise<ProbeFact[]> {
    const repo = ctx.root;
    if (!isUnityProject(repo)) {
      return [{ key: 'unity-compile', ok: true, detail: `${repo} has no ProjectSettings/ProjectVersion.txt — not verified as a Unity project`, hard: false }];
    }
    const cs = files.filter((f) => extname(f.path).toLowerCase() === '.cs');

    /**
     * FIRST CHOICE: COMPILE THE GENERATED PROJECT. No Unity launch, no project lock, seconds instead of
     * minutes, and it works while the editor is open — which is when anyone actually needs it. The editor
     * has already written the source list, the reference paths and the defines into `.sln`/`.csproj`;
     * compiling from those is reading its homework rather than making it do the work again.
     *
     * Only when that is not possible (no generated files, references that do not resolve on this machine,
     * no compiler at all) do the older paths run: batch mode if nothing holds the lock, else the
     * DLL-freshness reading. Each fallback says why it was reached.
     */
    /**
     * THE SHAPE FACTS RUN WHATEVER THE COMPILER SAYS, and before it.
     *
     * They answer a different question. A compiler tells you the code is wrong NOW, on this machine, with
     * this editor's assemblies already built; these say what an edit did to the project's own rules —
     * an asmdef that does not reference the assembly a new field's type lives in, `UnityEditor` in code
     * that ships to the player, a namespace that contradicts the assembly's `rootNamespace`, a
     * `[SerializeField]` Unity will silently ignore, a serialized field added to a script that 40 prefabs
     * already carry. The first three the compiler eventually reports (or the PLAYER build does, which is
     * worse); the last two it never reports at all, because the damage is to data.
     *
     * All of it is decidable from the files, which is why it is a fact and not a criterion for a judge.
     */
    const shape = inspectShape(repo, cs);

    const fromProject = compileGenerated(repo, cs);
    if (fromProject) return [...shape, fromProject];

    // ── the editor is open: read what it compiled, never take the lock from it ──
    if (unityHasProjectOpen(repo)) {
      return [...shape, fromCompiledDlls(repo, cs)];
    }

    // ── the editor is closed: compile for real ──
    const unity = unityBinary(repo);
    if (!unity) {
      const version = unityVersion(repo) ?? 'unknown version';
      return [...shape, {
        key: 'unity-compile',
        ok: true,
        hard: false,
        detail: `NOT VERIFIED: no Unity ${version} install found. Point ayin at one with \`/set unity-path <path to the Unity executable>\` — on macOS that is /Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity`,
      }];
    }
    return [...shape, batchCompile(repo, unity)];
  },

  /** No criteria: `factsOnly` means the judge is not consulted at all for this project type. */
  criteria(): string[] {
    return [];
  },
};

/**
 * The deterministic namespace/asmdef/serialization facts for the changed `.cs` files.
 *
 * ONE fact per KIND rather than one per file, so a rename that touches twenty files does not produce
 * twenty rows of the same sentence — the detail lists the files under a headline that carries the count
 * (which is also what keeps the operator's card to one line while the agent gets every location).
 *
 * `certain` findings become `hard`: they are mechanical consequences, and a model weighing them is how
 * "enforce" quietly becomes "mention". The rest are reported and pass.
 */
function inspectShape(repo: string, cs: ChangedFile[]): ProbeFact[] {
  if (!cs.length) return [];
  const index = buildAsmdefIndex(repo);
  const owners = typeOwners(repo, index);
  const byKind = new Map<string, { certain: boolean; lines: string[] }>();
  for (const f of cs) {
    if (!f.exists) continue;
    let source = '';
    try { source = readFileSync(f.path, 'utf-8'); } catch { continue; }
    const findings = inspectFile({ repo, file: f.path, source, index, owners, addedFields: addedFieldNames(repo, f.path) });
    for (const fi of findings) {
      const slot = byKind.get(fi.kind) ?? { certain: fi.certain, lines: [] };
      slot.certain = slot.certain || fi.certain;
      slot.lines.push(fi.line);
      byKind.set(fi.kind, slot);
    }
  }
  return [...byKind.entries()].map(([kind, { certain, lines }]) => ({
    key: `unity-${kind}`,
    ok: !certain,
    hard: certain,
    detail: [`${HEADLINE[kind] ?? kind}: ${lines.length} place(s)`, ...lines.slice(0, 8).map((l) => `  ${l}`), ...(lines.length > 8 ? [`  … ${lines.length - 8} more`] : [])].join('\n'),
  }));
}

/** One line per kind, so the operator's card says what happened without the list. */
const HEADLINE: Record<string, string> = {
  'asmdef-reference': 'MISSING ASMDEF REFERENCE',
  'editor-api': 'UnityEditor IN A RUNTIME ASSEMBLY',
  'root-namespace': 'NAMESPACE CONTRADICTS THE ASSEMBLY rootNamespace',
  'serialize-field': 'SERIALIZED FIELD UNITY CANNOT STORE',
  'serialized-layout': 'SERIALIZED LAYOUT CHANGED',
  'namespace-sibling': 'namespace differs from its folder',
};

/**
 * Compile the projects Unity generated — the fast path, and the only one that works with the editor open.
 *
 * Returns null when this route is not available at all, so the caller falls through to batch mode or the
 * DLL reading. Everything else — no compiler, unresolvable references, a csproj whose shape was not
 * understood — comes back as a NON-hard fact that names the reason, because "I could not check" must not
 * read as "your code is broken".
 *
 * WHICH PROJECTS. Only the assemblies that actually contain the changed files, found by matching the
 * `<Compile Include>` lists. Building every generated project in a large Unity repo is dozens of
 * assemblies and minutes; the turn changed two files in one of them.
 */
function compileGenerated(repo: string, cs: ChangedFile[]): ProbeFact | null {
  const { sln, csprojs } = generatedProjects(repo);
  if (!sln && csprojs.length === 0) return null; // never opened in an IDE, or a fresh clone — not this route

  const timeout = BATCH_TIMEOUT_MS();
  const projects = csprojs.map((p) => {
    try { return readCsproj(p); } catch { return null; }
  }).filter((p): p is CsProject => p !== null);

  const targets = cs.length ? projectsCovering(projects, cs.map((f) => f.path)) : projects.slice(0, 1);
  const missing = targets.flatMap((p) => p.missingReferences);
  if (targets.length && missing.length) {
    // The generated files carry ABSOLUTE paths into the editor install and Library/ScriptAssemblies. On a
    // machine that did not generate them — a different Unity version, a clone never opened — they point
    // at nothing, and compiling anyway produces a wall of CS0246 that says nothing about the operator's code.
    return {
      key: 'unity-compile', ok: true, hard: false,
      detail: [
        `NOT VERIFIED: ${missing.length} reference(s) named by the generated project do not exist on this machine —`
        + ' those paths are absolute and belong to whichever machine generated them.',
        ...missing.slice(0, 4).map((m) => `  ${m}`),
        'Open the project in Unity once (it regenerates the .csproj files), then re-run.',
      ].join('\n'),
    };
  }

  // The operator's own toolchain first, if they have one: same build their IDE runs.
  if (sln) {
    const built = buildSolution(sln, timeout);
    if (built && built.errors.length) {
      return { key: 'unity-compile', ok: false, hard: true, detail: formatCompileErrors(built.errors, unityVersion(repo), built.command) };
    }
    if (built && !built.unverified) {
      return { key: 'unity-compile', ok: true, hard: true, detail: `COMPILES: \`${built.command}\` finished with no C# errors` };
    }
    // else: fall through to csc, carrying nothing but the reason
  }

  const unity = unityBinary(repo);
  const csc = unity ? unityCsc(unity) : null;
  if (!csc) {
    return {
      key: 'unity-compile', ok: true, hard: false,
      detail: `NOT VERIFIED: found ${sln ? '1 .sln' : `${csprojs.length} .csproj`} but no compiler — no dotnet/msbuild on PATH, and no Roslyn under the Unity install${unity ? '' : ' (which was not found either; `/set unity-path <path>`)'}`,
    };
  }
  if (!targets.length) {
    return {
      key: 'unity-compile', ok: true, hard: false,
      detail: `NOT VERIFIED: none of the ${projects.length} generated project(s) lists the changed .cs file(s) — the .csproj files are older than this turn's changes. Open the project in Unity once to regenerate them.`,
    };
  }

  const attempts: CompileAttempt[] = targets.map((p) => compileWithCsc(p, csc, timeout));
  const errors = [...new Set(attempts.flatMap((a) => a.errors))];
  if (errors.length) {
    return { key: 'unity-compile', ok: false, hard: true, detail: formatCompileErrors(errors, unityVersion(repo), attempts[0].command) };
  }
  const unverified = attempts.filter((a) => a.unverified);
  if (unverified.length === attempts.length) {
    return {
      key: 'unity-compile', ok: true, hard: false,
      detail: [
        `NOT VERIFIED: ${unverified.length} assembl(y/ies) could not be compiled — ${unverified[0].unverified}`,
        ...(unverified[0].output ? unverified[0].output.split('\n').slice(0, 4).map((l) => `  ${l}`) : []),
      ].join('\n'),
    };
  }
  return {
    key: 'unity-compile', ok: true, hard: true,
    detail: `COMPILES: ${targets.map((t) => t.assembly).join(', ')} built from the generated project(s) with Unity's own Roslyn — no C# errors`,
  };
}

/**
 * The editor-is-open path: is every changed `.cs` covered by an assembly Unity has rebuilt since?
 *
 * Unity writes the DLL only when the compile SUCCEEDS, so `dll.mtime >= source.mtime` is a positive
 * result, not merely an absence of evidence. The inverse is ambiguous on purpose — mid-compile and
 * failed-compile look identical from the filesystem — so it reports NOT VERIFIED and says which
 * assembly, rather than claiming a failure it cannot see.
 */
function fromCompiledDlls(repo: string, cs: ChangedFile[]): ProbeFact {
  const index = buildAsmdefIndex(repo);
  const state = compiledState(repo, index.all);
  const byName = new Map(state.map((s) => [s.asmdef.name, s]));

  if (!cs.length) {
    const anyStale = state.filter((s) => s.stale).map((s) => s.asmdef.name);
    return {
      key: 'unity-compile',
      ok: true,
      hard: false,
      detail: anyStale.length
        ? `no .cs changed this turn; Unity has the project open and ${anyStale.length} assembl(y/ies) are stale (${anyStale.slice(0, 3).join(', ')})`
        : 'no .cs changed this turn; every compiled assembly is newer than its sources',
    };
  }

  const stale: string[] = [];
  const fresh: string[] = [];
  const unowned: string[] = [];
  for (const f of cs) {
    const rel = f.path.startsWith(repo) ? f.path.slice(repo.length + 1) : f.path;
    const owner = owningAsmdef(index, rel);
    // No asmdef means the predefined assembly (Assembly-CSharp), which has no .asmdef to walk to.
    const name = owner?.name ?? 'Assembly-CSharp';
    const s = byName.get(name);
    const dll = join(repo, 'Library', 'ScriptAssemblies', `${name}.dll`);
    const dllMs = s?.dllMs || (existsSync(dll) ? statSync(dll).mtimeMs : 0);
    if (!dllMs) { unowned.push(`${rel} → ${name} (no compiled DLL)`); continue; }
    if (dllMs >= f.mtimeMs) fresh.push(name);
    else stale.push(`${rel} → ${name}`);
  }

  if (stale.length || unowned.length) {
    return {
      key: 'unity-compile',
      ok: true,
      hard: false,
      detail: [
        'NOT VERIFIED: Unity has the project open and has not produced a fresh assembly for '
        + `${[...stale, ...unowned].length} changed file(s) — Unity writes the DLL only on a SUCCESSFUL compile, so this is either mid-compile or a compile error.`,
        ...[...stale, ...unowned].slice(0, 5).map((s) => `  ${s}`),
        'Focus Unity so it compiles (or close it and re-run to compile in batch mode).',
      ].join('\n'),
    };
  }
  return {
    key: 'unity-compile',
    ok: true,
    hard: true,
    detail: `COMPILES: Unity has the project open and every changed .cs is covered by a freshly built assembly (${[...new Set(fresh)].slice(0, 4).join(', ')})`,
  };
}

/**
 * The authoritative path: `-batchmode -quit`, then read the log.
 *
 * THE LOG DECIDES, NOT THE EXIT CODE. Unity exits non-zero for a licence problem, a missing module and a
 * hundred other things that are not a compile error, and there are versions that compile-error their way
 * to a zero exit. `error CS…` lines are unambiguous; anything else is reported as unverified WITH the
 * exit code and the tail of the log, so the operator sees the real reason instead of "QA failed".
 */
function batchCompile(repo: string, unity: string): ProbeFact {
  const dir = mkdtempSync(join(tmpdir(), 'ayin-unity-compile-'));
  const logFile = join(dir, 'unity.log');
  let status: number | null = 0;
  let threw = '';
  try {
    try {
      execFileSync(unity, [
        '-batchmode', '-quit', '-nographics',
        '-projectPath', repo,
        '-logFile', logFile,
      ], { encoding: 'utf-8', timeout: BATCH_TIMEOUT_MS(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { status?: number | null; signal?: string; message?: string };
      status = err.status ?? null;
      threw = err.signal === 'SIGTERM' ? 'timed out' : (err.message ?? 'failed').split('\n')[0];
    }
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '';
    const unique = parseCsErrors(log);

    if (unique.length) {
      return { key: 'unity-compile', ok: false, hard: true, detail: formatCompileErrors(unique, unityVersion(repo), 'Unity batch compile') };
    }
    if (threw === 'timed out') {
      return {
        key: 'unity-compile', ok: true, hard: false,
        detail: `NOT VERIFIED: the batch compile hit the ${Math.round(BATCH_TIMEOUT_MS() / 60000)}-minute timeout (a first import of a large project can exceed it). Raise it with \`/set unity-compile-timeout-ms <ms>\`.`,
      };
    }
    if (status !== 0) {
      return {
        key: 'unity-compile', ok: true, hard: false,
        detail: [
          `NOT VERIFIED: Unity exited ${status ?? '(signal)'} with no C# errors in the log — that is a licence, module or project problem, not a compile failure.`,
          ...logTail(log, 6).map((l) => `  ${l}`),
        ].join('\n'),
      };
    }
    if (!log.trim()) {
      return { key: 'unity-compile', ok: true, hard: false, detail: 'NOT VERIFIED: Unity produced no log — nothing to read a compile result from' };
    }
    return {
      key: 'unity-compile', ok: true, hard: true,
      detail: `COMPILES: Unity ${unityVersion(repo) ?? ''} batch compile finished with no C# errors (${countAssemblies(repo)} assembl(y/ies) in Library/ScriptAssemblies)`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * HEADLINE FIRST, ERRORS BELOW — and that layout is a contract, not formatting.
 *
 * The gate puts a fact's FIRST LINE on the operator's card and the WHOLE detail into the agent's fix
 * feedback (`qa/index.ts`). So a compiler's output has to be shaped for both readers at once: the human
 * asked for a working build and does not want a build log scrolling past, while the agent is about to act
 * on every file, line and column in the same second. First line = what happened and how much of it; the
 * rest = the errors, indented, verbatim.
 *
 * Capped at ten because a fix pass acts on the first few and a hundred errors are usually one cause.
 */
export function formatCompileErrors(errors: string[], version: string | null, how = 'Unity batch compile'): string {
  return [
    `DOES NOT COMPILE: ${errors.length} C# error(s) · Unity ${version ?? ''} · ${how}`.replace(/\s{2,}/g, ' '),
    ...errors.slice(0, 10).map((e) => `  ${e}`),
    ...(errors.length > 10 ? [`  … ${errors.length - 10} more`] : []),
  ].join('\n');
}

/** The last non-empty lines, for a failure whose cause is in the log rather than in the code. */
function logTail(log: string, n: number): string[] {
  return log.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n);
}

function countAssemblies(repo: string): number {
  try {
    return readdirSync(join(repo, 'Library', 'ScriptAssemblies')).filter((f) => f.endsWith('.dll')).length;
  } catch {
    return 0;
  }
}
