    ayin --arbiter -p "<task>"

Takes the primitives that invite the top-level agent to do the work itself — `bash`, `grep`, `find_files`, `list_dir`, `write_file`, `str_replace` — and withholds them, leaving it `read_file`, `explore`, and three tools pitched one level up:

    perform_edit(file, edit)        say what to change; a model reads the file and places it
    find_relevant_files(task)       which files this touches, verified against disk
    subagent(task, plan)            hand over a whole stage of the work

**Subagents are unaffected.** At depth ≥ 1 the full primitive set is present, and the three arbitration tools above are withheld instead — a child that could delegate would delegate rather than work.

## Why

Measured on a real five-phase build: the arbitrator delegated all five phases correctly, and the children then made **103 tool calls of which zero were `explore`**. They groped file by file, because `read_file` and `grep` were right there and composing an exact `str_replace` anchor is what an agent does when it has one. The primitives are not wrong; holding them at the *arbitration* level is, because an agent carrying twenty files' exact bytes has no room left to arbitrate.

`perform_edit` is the trade in miniature. `str_replace` demands the file's precise current bytes, so the caller must read it, hold it, and compose an anchor — three rounds and a whole file in context. `perform_edit` takes the change in words, spends one model call that sees the file, writes the result, and returns **the real diff of what changed on disk** — or `NO CHANGE`, which is a fact rather than a claim. A model saying "I made the change" reads exactly like one that did not; a diff does not.

## Off by default

Ayin is not only a builder. *"Read src/log.ts and tell me what it does"* is an ordinary turn, and an arbiter that has to spawn a child to run one shell command has made the common case worse to improve the rare one. Turn it on for a build; leave it off for a conversation.

`AYIN_ARBITER=1` is the environment equivalent.
