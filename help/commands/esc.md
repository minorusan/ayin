Closes whatever overlay is open, cancels a running `!` shell command, or interrupts a busy agent — whichever of those applies, in that order. Only when none of them apply does Esc do anything to your typed prompt (see Esc Esc).

This layering means Esc is never dangerous to press: if an overlay is open it just closes it; if a `!` command is mid-run it kills the whole process tree; if the agent is working it interrupts the turn. Nothing here touches what you've typed in the input box.

## Examples

    Esc
