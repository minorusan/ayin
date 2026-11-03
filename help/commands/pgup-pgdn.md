Scrolls whichever overlay is currently open — the tool-output browser (Ctrl+O) or the session summary (Ctrl+S) — half a screen per press.

When no overlay is open, the chat pane itself scrolls:

- **PgUp / PgDn** — half a screen (Fn+↑/↓ on a Mac keyboard).
- **Shift+↑ / Shift+↓** — one line.
- **The mouse wheel** — three lines a notch, with mouse tracking still OFF, so the terminal's own text selection keeps working. Most terminals turn the wheel into a burst of ↑/↓ presses in a full-screen app; ayin reads a burst as scrolling and a single press as prompt history. A terminal that sends one arrow per notch cannot be told apart from a key press — use `/set mouse on` there (the wheel is then read directly, at the cost of native selection).

Typing anything jumps back to the bottom.

## Examples

    PgUp
    PgDn
