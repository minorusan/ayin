Full explanations, **on by default**. `/verbose off` gives you the terse mode instead: the result, and nothing around it.

Verbose is the default because a finished turn has three things worth saying and terse said none of them — what changed and where, what was *not* done (the case skipped, the check that could not run, the assumption made), and what to do next. The old default forbade preamble, which was right, but it forbade the recap and the next step along with it, so a turn ended on "Done." and you had to ask what happened.

Short is a property of preamble, not of a report. Neither mode changes how much ayin verifies — only what it writes down.

Turn it off when you are reading turns out of the corner of your eye while a build runs, and a paragraph where one line would do is a paragraph you skim past. It takes effect on your next message, not retroactively, and it persists across restarts (`~/.ayin-cli/prompts.json`).

## Examples

    /verbose off    # the result, nothing else
    /verbose        # back to the default
