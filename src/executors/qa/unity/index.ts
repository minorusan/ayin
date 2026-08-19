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
import { unityBinary } from '../../../testrun/run.js';
import type { ChangedFile } from '../../../qa/probes.js';
import type { ExecutorConfig, PrepareResult, ProbeFact, ProjectContext, QaExecutor } from '../../types.js';

const config: ExecutorConfig = {
  id: 'unity', kind: 'qa', projectTypes: ['unity'], priority: 10, factsOnly: true,
  description: 'Unity QA — one deterministic check: does the C# compile. Nothing else, and no judge.',
};

/** How long a batch-mode compile may take before it is reported as unverified rather than failed. */
const BATCH_TIMEOUT_MS = () => getConfig('unityCompileTimeoutMs', 20 * 60_000);

/** `error CS1002: ; expected` — the only line shape that matters in a Unity log. */
const CS_ERROR = /(\S+\.cs)\((\d+),(\d+)\):\s*error\s+(CS\d+):\s*(.+)/g;

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

    // ── the editor is open: read what it compiled, never take the lock from it ──
    if (unityHasProjectOpen(repo)) {
      return [fromCompiledDlls(repo, cs)];
    }

    // ── the editor is closed: compile for real ──
    const unity = unityBinary(repo);
    if (!unity) {
      const version = unityVersion(repo) ?? 'unknown version';
      return [{
        key: 'unity-compile',
        ok: true,
        hard: false,
        detail: `NOT VERIFIED: no Unity ${version} install found. Point ayin at one with \`/set unity-path <path to the Unity executable>\` — on macOS that is /Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity`,
      }];
    }
    return [batchCompile(repo, unity)];
  },

  /** No criteria: `factsOnly` means the judge is not consulted at all for this project type. */
  criteria(): string[] {
    return [];
  },
};

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
    const errors = [...log.matchAll(CS_ERROR)].map((m) => `${m[1]}(${m[2]},${m[3]}): ${m[4]}: ${m[5]}`);
    const unique = [...new Set(errors)];

    if (unique.length) {
      return { key: 'unity-compile', ok: false, hard: true, detail: formatCompileErrors(unique, unityVersion(repo)) };
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
export function formatCompileErrors(errors: string[], version: string | null): string {
  return [
    `DOES NOT COMPILE: ${errors.length} C# error(s) from Unity ${version ?? ''} batch compile`.replace(/\s+$/, ''),
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
