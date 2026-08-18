Runs the C# tests covering a domain, in a Unity project — selection is deterministic (from an asmdef index and matching source files), never a guess by the model.

Give it the area you touched, in plain words, comma-separated for more than one: `/testrun reward service` finds which files those words map to, then which test assemblies cover those files, and runs only those. If nothing matches by file, it falls back to matching assembly names by the words themselves and says so. Reach for it after a change instead of running Unity's full suite — the only interactive part left is confirming Unity may be quit if a run needs it closed. From a plain shell, `ayin testrun "<domain>" --list` shows what would run without running it.

## Examples

    /testrun reward service
    /testrun inventory, crafting
