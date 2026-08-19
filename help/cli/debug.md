Write everything needed to diagnose a session into one directory, with secrets stripped, for someone else to read.

`ayin debug [dir]` collects the session record, the process log, timing data, raw pre-parse model replies where something notable happened to them, and the redacted settings file into `<dir>/ayin-debug-<timestamp>/` (default: a canonical `/tmp/ayin-debug`, not a symlink or per-user tmp path, since a helper process's read allow-list is a plain string-prefix test). Long files are tailed, not copied whole, so the bundle stays small enough to actually open. Any config value whose key name looks like a key, token, secret or password is replaced with its character count, because this bundle is meant to be handed to something else and a leaked credential in a "for help" file does harm nobody notices. It falls back to the newest session record on disk when the invoking process has none of its own yet, since a bundle is usually collected from a second terminal after the first one stopped responding.

This is the same bundle `/debug` writes from inside the TUI, available from a shell for a run nobody was watching. It only reads files that already exist and writes into the destination directory.

`ayin --debug` is the third form — a normal interactive launch that writes the bundle at boot. See `ayin --help "ayin --debug"`.

## Options

    [dir]   destination directory (default: a canonical system temp directory)

## Examples

    ayin debug
    ayin debug ~/shared/ayin-reports
