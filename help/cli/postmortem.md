    ayin --postmortem -p "<task>"

A headless run that is killed leaves nothing behind. Not a partial answer, not a list of what it had already done, not the name of the file it was halfway through writing — you get an exit code and a scrollback that stops mid-sentence. `--postmortem` changes that: **if the run ends without completing its expected exit sequence, it writes down where it got to.**

That matters more now than it used to, because ayin spawns ayin. When a parent cancels a subagent it kills a process nobody was watching, and everything that child had learned dies with it unless it wrote it down first. A subagent inherits this flag from its parent, so cancelling one leaves a note too.

## What counts as unexpected

Everything except a clean finish. A run that completes calls its expected exit sequence on the way out; **anything that reaches an exit without having done so is unexpected by definition** — a `SIGTERM` from a parent, `Ctrl+C`, an uncaught exception, a rejected promise, a bare `process.exit` from somewhere that never considered this.

The inversion is deliberate. A list of "bad" exits is a list you have to keep complete, and the one you forget is the one that loses the work.

## What the note contains

    ## How it ended
    - reason: **killed by SIGTERM**
    - pid, session id, cwd, how long it ran, subagent depth

    ## What was running when it died
    - **bash**(command=sleep 120) — 20s in, last said: sleep 120

    ## Where to resume
    - goal: <the prompt this run was given>
    - plan: <the plan file, when plan mode wrote one>

    ## The tail
    the last 40 events out of the session record, in order

The second section is the one no log reconstructs. Ayin knows what is running, for how long, and the last thing each call narrated (see `runs.ts`), so the note says *"killed during `npm run build`, 43 seconds in"* rather than *"killed"*.

## Where it lands

**Two copies, on purpose.**

    ./ayin-postmortem-<timestamp>-<pid>.md      the working directory
    ~/.ayin-cli/postmortems/                     every run on this machine, plus index.jsonl

A note only in the cache is a note nobody finds; a note only in the work tree is a note that dies with the tree. One line also goes to stderr naming both paths, because a file nobody is told about is a file nobody reads.

`AYIN_POSTMORTEM=1` is the environment equivalent, for a harness that cannot pass flags.
