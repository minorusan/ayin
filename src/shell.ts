/**
 * Cross-platform shell — the one place that knows how to run a shell command and kill its tree on
 * POSIX vs Windows, so the rest of ayin (the bash tool, explore) stays platform-agnostic.
 *
 * Shell choice:
 *   - $AYIN_SHELL set → use it verbatim (a bash-like shell, invoked `-lc`). Escape hatch.
 *   - POSIX → /bin/bash -lc "<cmd>"  (login shell so PATH/aliases resolve, as before).
 *   - Windows → **Git Bash if present** (so the POSIX-ish commands models emit — ls/grep/cat/…
 *     — actually work), else cmd.exe /d /s /c. Git Bash is auto-detected at the standard install
 *     locations; set AYIN_SHELL to override.
 *
 * Kill: POSIX kills the process GROUP (detached child) so pipelines die whole; Windows uses
 * `taskkill /t /f` to take down the child tree (no POSIX process groups there).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

const IS_WIN = process.platform === 'win32';

let cached: { file: string; posix: boolean } | null = null;
function resolveShell(): { file: string; posix: boolean } {
  if (cached) return cached;
  const override = process.env.AYIN_SHELL;
  if (override) return (cached = { file: override, posix: true });
  if (!IS_WIN) return (cached = { file: '/bin/bash', posix: true });
  // Windows: prefer Git Bash so model-emitted POSIX commands run; fall back to cmd.exe.
  const candidates = [
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`,
    process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`,
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`,
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try { if (existsSync(c)) return (cached = { file: c, posix: true }); } catch { /* keep looking */ }
  }
  return (cached = { file: process.env.ComSpec || 'cmd.exe', posix: false });
}

/** Human-readable name of the shell ayin will use (for diagnostics / the status/version line). */
export function shellName(): string {
  const s = resolveShell();
  return s.posix ? s.file : `${s.file} (cmd)`;
}

/** Spawn `command` through the platform shell. On POSIX the child is detached (its own process
 *  group) so killTree can signal the whole pipeline; on Windows the console is hidden. */
export function spawnShell(command: string, opts: { cwd?: string } = {}): ChildProcess {
  const sh = resolveShell();
  const args = sh.posix ? ['-lc', command] : ['/d', '/s', '/c', command];
  return spawn(sh.file, args, {
    cwd: opts.cwd,
    env: process.env,
    detached: !IS_WIN,        // POSIX: own process group for group-kill. Windows: n/a.
    windowsHide: true,        // no flashing console window on Windows
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Kill a spawned child and its descendants, portably. POSIX: signal the process group; Windows:
 *  taskkill /t (tree) /f (force). Best-effort — never throws. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  if (!pid) return;
  if (IS_WIN) {
    try { spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }); }
    catch { try { child.kill(); } catch { /* gone */ } }
    return;
  }
  try { process.kill(-pid, signal); }          // whole process group
  catch { try { process.kill(pid, signal); } catch { /* gone */ } }
}
