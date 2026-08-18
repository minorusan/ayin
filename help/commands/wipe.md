Deletes ayin's own saved state from disk — sessions, artifacts, logs, or transcripts — after showing exactly what it will remove.

Bare `/wipe` opens a scope picker showing what each currently costs in file count and bytes; a scope argument skips straight to that scope's confirmation. Confirmation is a second, separate dialog stating the exact file count and byte total, defaulting to Cancel — nothing is deleted on the first keystroke. The live session, the live transcript, and this process's own log file are always excluded, so wiping never pulls the rug out from under the run doing the wiping.

## Examples

    /wipe
    /wipe all
    /wipe artifacts
    /wipe logs
    /wipe transcripts
