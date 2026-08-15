# `ayin launch` — starting ayin without a terminal

`ayin` run in a terminal already uses that terminal's directory. There is nothing to add, and nothing
to type. This command exists for the one case where **there is no terminal at all**: a global hotkey
fires while a file manager is focused, and something has to find the directory the operator is
looking at *and* open a window before ayin can start.

That is the whole job. Once the window exists, plain `ayin` is already correct.

```
ayin launch [--dir <path>] [--print]
```

| | |
|---|---|
| `--dir <path>` | launch here instead of asking the file manager |
| `--print` | print the directory that would be used, open nothing |
| `--help` | usage |

Resolution order: `--dir` → the front file-manager window → the current directory. An explicit
`--dir` that does not exist is **refused** rather than silently swapped for the cwd — a launcher that
quietly opens somewhere else is worse than one that says no.

---

## ayin does not listen for the hotkey, on purpose

Capturing a global modifier double-tap means an OS-level input tap — `CGEventTap` on `flagsChanged`,
`WH_KEYBOARD_LL`, evdev — which sees **every keystroke on the machine** and needs Accessibility or
Input Monitoring permission to do it. That is keylogger-shaped code, and shipping it inside a coding
agent would mean asking every user to grant a coding agent permission to read their keyboard.

The machine already has a daemon with exactly those permissions and a UI for managing them.
**The trigger is theirs; the action is ours.**

The same reasoning keeps this out of the `watch` daemon: that one is per-repo, poll-only, and its
lifetime is tied to a checkout. A hotkey listener is machine-scoped. Folding them together would mean
every repo's watcher wanting Accessibility — wrong lifetime, wrong blast radius.

---

## Binding it

### macOS — Hammerspoon

Double-tap Shift. The `dirty` flag is load-bearing, not decoration: naive double-Shift fires during
ordinary typing, on any two capitals in quick succession. Invalidating on an intervening keypress is
how the editors that ship this shortcut make it usable.

```lua
local last, GAP, dirty = 0, 0.4, false

hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function()
  dirty = true; return false
end):start()

hs.eventtap.new({ hs.eventtap.event.types.flagsChanged }, function(e)
  local f = e:getFlags()
  if f.shift and not (f.cmd or f.alt or f.ctrl) then
    local now = hs.timer.secondsSinceEpoch()
    if not dirty and now - last < GAP then
      last = 0
      hs.execute("ayin launch", true)   -- `true` = login shell, so PATH has the npm prefix
    else
      last = now
    end
    dirty = false
  end
  return false
end):start()
```

The `true` second argument matters. Without it `hs.execute` uses a non-login shell whose `PATH` will
not contain the npm prefix, and the hotkey silently does nothing.

Karabiner-Elements can do the same double-tap if you would rather not add Hammerspoon.

### Windows — AutoHotkey

```ahk
~LShift::
    if (A_PriorHotkey = "~LShift" and A_TimeSincePriorHotkey < 400)
        Run, ayin launch
    return
```

### Linux

Bind `ayin launch` to a shortcut in the desktop's own keyboard settings. Note the limitation below.

---

## Platform support

| | front-window directory | window |
|---|---|---|
| macOS | Finder, via AppleScript | `open -a Terminal` |
| Windows | Explorer, matched against the **foreground** window handle | Git Bash (`git-bash.exe`) |
| Linux | **not available** | `x-terminal-emulator` / `gnome-terminal` / `konsole` / `xterm` |

On Linux there is no cross-desktop way to ask what the front file manager is showing, and Wayland
forbids the question by design. `ayin launch` there falls back to the current directory, which makes
it useful from a shortcut only if you pass `--dir`.

On Windows the Explorer window is matched against the **foreground window handle**, not "the last
Explorer window" — the one-line version is wrong whenever more than one window is open, and launches
in a folder the operator is not looking at.

> The Windows path (`git-bash.exe` as the opener, and the PowerShell foreground-window match) is
> written against documented behaviour but has **not been exercised on a Windows machine**. If it
> misbehaves, `terminalCommand` below is the fix, and a report is welcome.

---

## The shell is bash everywhere; the window is not portable

Two separable things, and only one of them travels:

- **The shell** is bash on every platform, because the launch script carries a bash shebang. Windows
  resolves it through Git Bash — the same choice `shell.ts` already makes for the `bash` tool.
- **The window** is not portable at all, so the opener is a config template rather than a literal.

```
/set terminal-command <your terminal> -e {{SCRIPT}}
```

Stored as `terminalCommand`. `{{SCRIPT}}` is replaced with the launch script's path; every occurrence
is substituted. Defaults:

| macOS | `open -a Terminal {{SCRIPT}}` |
|---|---|
| Windows | `"<Git install>\git-bash.exe" {{SCRIPT}}` |
| Linux | first of `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`, with `-e` |

Each default is a guess about someone else's machine. An operator on Ghostty, WezTerm, Alacritty or
iTerm replaces one line rather than filing a bug.

---

## Why a temp script rather than one long command

The launcher has to carry a directory it did not choose through a shell it did not write. Interpolate
it into the opener and a folder named `it's a repo (v2)` has to survive shell → AppleScript → shell:
three chances to get quoting wrong on a path the operator picked, and the failure mode is a window
that opens in `$HOME` and looks like the hotkey misfired.

So the command goes into a one-shot script and only the script's own path is interpolated:

```bash
#!/bin/bash
cd '/path/to/repo' || exit 1
exec '/abs/path/to/node' '/abs/path/to/ayin/dist/index.js'
```

Three details in three lines, each of them a bug that was designed out:

- **`cd … || exit 1`** — never proceed from the wrong directory. A silent `cd` failure would start
  ayin against `$HOME` and let it index the wrong tree.
- **`exec`** — the terminal's shell *becomes* ayin rather than hosting it, so closing ayin closes the
  window, which is what someone who opened it with a hotkey expects.
- **absolute node, absolute entry script** — a hotkey daemon spawns with a stripped `PATH` that the
  new window inherits. A bare `ayin` would open a terminal for the sole purpose of printing
  `command not found`, which reads as the hotkey being broken rather than as a `PATH` problem two
  layers away. Both paths are how the launching process itself is running, so neither can be missing.

Scripts land in the system temp directory and are **pruned on the way in** — at the start of a later
launch, never by an exit handler. A handler does not run when the process is killed, and these files
name directories the operator was looking at.

---

## Gate

`npm run check:launch` — no LLM, no network, no window opened. It writes a script for a directory
containing both a space and an apostrophe, **runs it**, and checks where it lands; asserts the wiring
that `tsc` cannot see (`launch` in `NO_TUI_COMMANDS` and `NO_MODEL_NEEDED`, dispatch in `app.ts`,
`terminalCommand` in `KNOWN_CONFIG_KEYS`); proves the config override actually overrides; and checks
that a stale script is pruned by the next launch.
