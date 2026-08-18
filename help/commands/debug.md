Writes everything needed to diagnose this session — session record, log tail, timing data, and config — into one directory something else can read.

It exists because diagnosing a run used to mean pasting fragments of terminal output and having the reader guess from what was included; this writes the actual evidence in one place instead. Secrets are stripped by config-key NAME (not by pattern-matching what looks like a key), so a bundle is safe to hand to someone else or drop into a shared folder. Anything unbounded (the log, the session record) is tailed rather than included whole. With no argument it writes to a default location; give it a directory to write there instead. `ayin debug [dir]` does the same thing from a plain shell, for a run nobody was sitting in front of.

## Examples

    /debug
    /debug ~/shared/ayin-debug
