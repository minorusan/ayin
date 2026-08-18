Open a new terminal window running ayin at the directory a file manager is currently showing.

This exists for a global hotkey, not for typing at a prompt: `ayin` inside a terminal already uses that terminal's directory. The case it solves is a hotkey firing with no terminal open — Finder or Explorer is focused instead. It asks the OS for the frontmost file-manager window's directory (AppleScript on macOS, a Win32 foreground-window lookup on Windows; Linux/Wayland has no cross-desktop way to ask and falls back to the current directory), writes a one-shot bash script that `cd`s there and `exec`s ayin, and opens a new terminal window running it. The script lives under the system temp directory and is pruned after an hour on the next launch, not at exit, so a killed process cannot leave a stale one behind.

Which terminal opens is not portable — `open -a Terminal`, `git-bash.exe`, or a Linux guess — and can be replaced with `/set terminal-command <cmd>` inside ayin. ayin does not listen for the hotkey itself; that belongs to a daemon like Hammerspoon, Karabiner or AutoHotkey that already has the OS permissions a listener needs (docs/LAUNCH.md has the binding).

## Options

    --dir <path>   launch here instead of asking the file manager
    --print        print the directory that would be used, and exit
    --help, -h     print usage and exit

## Examples

    ayin launch
    ayin launch --dir ~/project
    ayin launch --print
