Every `read_file` call also surfaces what an earlier `ayin indulge` run already learned about that file.

This is an exact lookup by path, not a similarity search: chunks from the corpus that cite the file being read (or overlap the exact lines on screen) are attached to the tool result, up to two of them, newest and most-overlapping first. Each chunk is labelled for staleness — the corpus assists an agent that edits code, so an answer can go stale in the very session it is helping, and an unlabelled stale chunk would be a confident lie with a citation attached. This only fires once a corpus exists (`ayin indulge`) and while `/corpus` is on (default ON); turn it off to compare a task with and without retrieval.

## Examples

    read src/auth/session.ts

No special syntax — corpus notes just ride along with the normal file read when a corpus exists.
