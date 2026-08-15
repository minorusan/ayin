/**
 * `ayin launch` — open a NEW terminal window at the front file-manager directory, running ayin.
 *
 * This is not a mode and not something to type. Running `ayin` in a terminal already uses that
 * terminal's cwd; there is nothing to add. What this exists for is the case where **there is no
 * terminal**: a global hotkey fires while Finder/Explorer is focused, with no cwd, no window, and no
 * shell to inherit from. Two things have to happen before ayin can start at all — find the directory
 * the operator is looking at, and open a window. That is the whole job.
 *
 * ayin deliberately does NOT listen for the hotkey. A global modifier-tap listener is an OS-level
 * input tap (CGEventTap / WH_KEYBOARD_LL / evdev) that sees every keystroke on the machine and needs
 * Accessibility permission to do it. That is keylogger-shaped code, and the machine already has a
 * daemon with those permissions — Hammerspoon, Karabiner, AutoHotkey. The trigger is theirs; the
 * action is ours. See docs/LAUNCH.md for the binding.
 *
 * The window and the shell are separable, and only one of them is portable:
 *   - the SHELL is bash everywhere, because the launch script has a bash shebang. Windows resolves it
 *     through Git Bash, exactly as `shell.ts` already does for the bash tool.
 *   - the WINDOW is not portable at all. `open -a` is macOS, `git-bash.exe` is Windows, and Linux has
 *     no answer — so the opener is a config template, not a literal, and every platform default can
 *     be replaced with one line by an operator whose terminal is not the one we guessed.
 *
 * A temp script carries the command rather than interpolating it into the opener, because otherwise a
 * directory name with a quote or a space in it has to survive shell → AppleScript → shell, and that
 * is three chances to get quoting wrong on a path we did not choose. The script is written once, run
 * once, and pruned on a later launch (never by a handler at exit — a killed process runs no handler,
 * and a stale script must not be able to outlive the machine that made it).
 */

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfigString } from './prompts.js';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const SCRIPT_DIR = join(tmpdir(), 'ayin-launch');
const SCRIPT_TTL_MS = 60 * 60 * 1000;

// ── where the operator is looking ────────────────────────────────────────────────

/**
 * The directory of the frontmost file-manager window, or null when there is not one.
 *
 * Null is a real answer, not a failure: the operator may have fired the hotkey with no Finder window
 * open at all. The caller falls back rather than erroring, because a launcher that refuses to open
 * is worse than one that opens somewhere defensible.
 */
export function frontWindowDir(): string | null {
  try {
    if (IS_MAC) {
      // `target of front window` throws for a window with no folder behind it — a search result, the
      // Trash, a saved-search — so the failure is caught rather than prevented.
      const out = execFileSync('osascript', [
        '-e', 'tell application "Finder" to POSIX path of (target of front window as alias)',
      ], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return validDir(out.trim());
    }
    if (IS_WIN) {
      // Match Explorer windows against the FOREGROUND window handle. Taking "the last Explorer
      // window" instead is the tempting one-liner and it is wrong whenever more than one is open —
      // it launches in a folder the operator is not looking at, which is indistinguishable from a
      // bug they will report as "it opened in the wrong place".
      const ps = [
        'Add-Type -Namespace W -Name U -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();\';',
        '$fg = [W.U]::GetForegroundWindow();',
        '$sh = New-Object -ComObject Shell.Application;',
        '$w = $sh.Windows() | Where-Object { $_.HWND -eq $fg } | Select-Object -First 1;',
        'if ($w -eq $null) { $w = $sh.Windows() | Where-Object { $_.Document.Folder } | Select-Object -Last 1 };',
        'if ($w -ne $null) { $w.Document.Folder.Self.Path }',
      ].join(' ');
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      return validDir(out.trim());
    }
  } catch { /* no window, no file manager, no osascript — all the same answer */ }
  // Linux has no cross-desktop way to ask "what is the front file manager showing", and Wayland
  // forbids the question by design. Saying so beats guessing wrong.
  return null;
}

function validDir(path: string): string | null {
  if (!path) return null;
  try { return statSync(path).isDirectory() ? path : null; } catch { return null; }
}

// ── the window ───────────────────────────────────────────────────────────────────

/**
 * Locate `git-bash.exe` — the Git for Windows launcher that OPENS A WINDOW.
 *
 * Deliberately not the `Git\bin\bash.exe` that `shell.ts` finds: that one is a console program which
 * inherits its parent's console and shows nothing when spawned detached. Same install, different
 * binary, and picking the familiar one produces a launcher that silently does nothing.
 */
function gitBashWindow(): string | null {
  const roots = [
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git`,
    process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Git`,
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Programs\\Git`,
  ].filter(Boolean) as string[];
  for (const root of roots) {
    const candidate = `${root}\\git-bash.exe`;
    try { if (existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The command that opens a window and runs {{SCRIPT}} in it.
 *
 * `terminalCommand` in config wins outright. The platform defaults are guesses about someone else's
 * machine — an operator on Ghostty, WezTerm or Alacritty replaces one line rather than filing a bug.
 */
export function openerCommand(script: string): string | null {
  const configured = getConfigString('terminalCommand');
  if (configured) return configured.replaceAll('{{SCRIPT}}', script);
  if (IS_MAC) return `open -a Terminal ${shq(script)}`;
  if (IS_WIN) {
    const bash = gitBashWindow();
    return bash ? `"${bash}" ${shq(script)}` : null;
  }
  // One of these is usually installed; x-terminal-emulator is the Debian alternatives symlink.
  const linux = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
  const found = linux.find((t) => existsSync(`/usr/bin/${t}`));
  return found ? `${found} -e ${shq(script)}` : null;
}

/** POSIX single-quote escaping — the one place a path we did not choose meets a shell. */
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// ── the script ───────────────────────────────────────────────────────────────────

/**
 * Write the one-shot launch script and return its path.
 *
 * `exec` so the terminal's shell becomes ayin rather than hosting it: closing ayin then closes the
 * window, which is what an operator who opened it with a hotkey expects.
 */
export function writeLaunchScript(dir: string, argv: string[]): string {
  mkdirSync(SCRIPT_DIR, { recursive: true });
  pruneOldScripts();
  const path = join(SCRIPT_DIR, `launch-${process.pid}-${hash(dir)}.sh`);
  writeFileSync(path, [
    '#!/bin/bash',
    `cd ${shq(dir)} || exit 1`,
    `exec ${argv.map(shq).join(' ')}`,
    '',
  ].join('\n'), 'utf-8');
  chmodSync(path, 0o700);
  return path;
}

/**
 * Delete launch scripts older than an hour, on the way IN rather than on the way out.
 *
 * A cleanup that runs at exit does not run when the process is killed, and these files name
 * directories the operator was looking at. Pruning at the start of the next launch is the version
 * that survives a power cut.
 */
function pruneOldScripts(): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(SCRIPT_DIR)) {
      const p = join(SCRIPT_DIR, name);
      try { if (now - statSync(p).mtimeMs > SCRIPT_TTL_MS) rmSync(p, { force: true }); }
      catch { /* someone else's, or already gone */ }
    }
  } catch { /* directory not there yet */ }
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ── the command ──────────────────────────────────────────────────────────────────

const USAGE = `ayin launch — open a new terminal window running ayin, at the front Finder/Explorer directory.

For a global hotkey to call. Running \`ayin\` in a terminal already uses that terminal's directory;
this exists for when a hotkey fires and there is no terminal at all.

  --dir <path>   launch here instead of asking the file manager
  --print        print the directory that would be used, and exit
  --help

Config — inside ayin: /set terminal-command <cmd>   (stored as terminalCommand)
  the command that opens a window running {{SCRIPT}}
  default: macOS    open -a Terminal {{SCRIPT}}
           Windows  "<Git>\\git-bash.exe" {{SCRIPT}}
           Linux    x-terminal-emulator -e {{SCRIPT}}

Binding it to a hotkey: docs/LAUNCH.md
`;

export async function runLaunch(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const dirFlag = argv.indexOf('--dir');
  const explicit = dirFlag >= 0 ? argv[dirFlag + 1] : undefined;
  if (dirFlag >= 0 && !explicit) {
    process.stderr.write('ayin launch: --dir needs a path\n');
    return 2;
  }

  // Order is deliberate: an explicit path is an instruction, the front window is an inference, and
  // cwd is the fallback that is never wrong so much as uninteresting.
  const dir = (explicit && validDir(explicit)) || frontWindowDir() || process.cwd() || homedir();
  if (explicit && !validDir(explicit)) {
    process.stderr.write(`ayin launch: ${explicit} is not a directory\n`);
    return 2;
  }

  if (argv.includes('--print')) {
    process.stdout.write(`${dir}\n`);
    return 0;
  }

  // ABSOLUTE node + absolute entry script, never a bare `ayin`. A hotkey daemon spawns with a
  // login-less PATH that usually lacks the npm prefix, and the new window inherits it — so a bare
  // name opens a terminal for the sole purpose of printing `command not found`, which reads as the
  // hotkey being broken. Neither of these two paths can be missing: they are how THIS process runs.
  const script = writeLaunchScript(dir, [process.execPath, process.argv[1] || 'ayin']);
  const opener = openerCommand(script);
  if (!opener) {
    process.stderr.write(
      'ayin launch: no terminal found to open.\n'
      + '  Set one, inside ayin:  /set terminal-command <your terminal> -e {{SCRIPT}}\n'
      + `  Directory resolved: ${dir}\n`,
    );
    return 1;
  }

  // Detached and unref'd: the launcher must exit immediately and leave the window running. A hotkey
  // that keeps a process alive for the life of the session leaks one per press.
  const child = spawn(opener, { shell: true, detached: true, stdio: 'ignore' });
  child.unref();
  process.stdout.write(`${dir}\n`);
  return 0;
}
