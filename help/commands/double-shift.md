A double-tap of the Shift key, bound at the OS level, that opens a terminal running ayin at whatever directory your file manager is currently showing.

ayin itself never listens for this — capturing a global key chord means an OS-level input tap that sees every keystroke on the machine, which is keylogger-shaped code no coding agent should ship. Instead the trick is `ayin launch`: a small command that resolves the front Finder/Explorer window (or `--dir`) and opens a terminal there. You bind the double-Shift gesture yourself, in your OS's own hotkey tool (Hammerspoon on macOS, AutoHotkey on Windows), to run `ayin launch`. See `docs/LAUNCH.md` for ready-made binding scripts.

## Examples

    ayin launch
    ayin launch --dir ~/project
    ayin launch --print
