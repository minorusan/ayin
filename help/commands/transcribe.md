Records everything for this session — every prompt, every raw model response, every full tool result — to a JSON file on disk, unclipped.

This is deliberately loud and deliberately large: a sticky red banner stays up the whole time it runs, because a recording nobody notices is worse than none at all. Turn it on BEFORE the bug you're chasing happens, not after — once something odd occurs you want the full, unclipped record of what the model actually saw and said, not a chat transcript that already dropped detail. `/transcribe off` (or `/transcribe stop`) closes the file.

## Examples

    /transcribe
    /transcribe off
