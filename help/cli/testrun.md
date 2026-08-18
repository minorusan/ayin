Run the C#/Unity tests that cover a named domain, without guessing which assembly that means.

`ayin testrun "<domain>"` looks up which files an `ayin indulge` corpus already recorded against that domain, walks each file to its nearest asmdef, and finds which test assemblies reference it — the same domain tagging an indulge build produced, reused as a lookup rather than asked again at test time. With no corpus for the repo, it falls back to matching the domain's words against assembly names and paths, and says plainly in the report that it guessed. It runs against `Library/ScriptAssemblies` when those are current, or offers Unity batch mode when they are not — it never runs a stale compiled assembly silently.

This only makes sense inside a Unity project with NUnit-style test assemblies; it does nothing for other stacks. Use it to run only the tests relevant to what changed, instead of a full suite, when a corpus already exists for the repo.

## Options

    <domain>    the domain to select tests for, e.g. "reward service" or a comma-separated list
    --list      show what would run — files, assemblies — without running anything
    --help, -h  print usage and exit

## Examples

    ayin testrun "reward service"
    ayin testrun "reward service,solitaire streak"
    ayin testrun "checkout" --list
