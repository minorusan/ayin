Inserts a literal newline in the input box without submitting. Ctrl+J does the same thing.

Plain Enter submits, except when the newline arrived as part of a fast paste — pasting multi-line text into the terminal delivers it as ordinary keystrokes, so without this distinction the first newline in a paste would submit only the first line and scatter the rest into whatever ran next. That heuristic is timing-based and keeps a genuine paste intact automatically; Alt+Enter (or Ctrl+J) is for a newline you want on purpose while typing normally.

## Examples

    Alt+Enter
    Ctrl+J
