Start a normal interactive session that has already written its debug bundle.

`ayin --debug` opens the TUI exactly as a bare `ayin` does, then runs `/debug` once the session exists — same bundle, same stable directory, no different from typing it yourself. The point is WHEN: the moment you want a bundle is the moment the session stopped answering, which is also the moment there is no prompt left to type into. Launched this way, the path is already on screen and already real before anything goes wrong, so a wedged session is handed over by quoting a directory rather than being killed to get one.

It fires after the session id is established, because the id and the resolved model are what make a bundle worth reading. A dialect probe still in flight is reported by the bundle as provisional rather than guessed at — the bundle tells you which of the three states it caught. Everything else is unchanged: the session runs normally, and `/debug` refreshes the same directory later, as often as you like.

## Options

    --debug   write the bundle at boot, then run normally

## Examples

    ayin --debug
    ayin --debug --dangerously-skip-permissions
